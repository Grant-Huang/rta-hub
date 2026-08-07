/**
 * 交付前审核 —— **在把结果交给客户之前，按约束与规则严格过一遍**。
 *
 * ## 为什么要单独有这么一层
 *
 * 检查散在各处，每一处都只看自己那一块：排布器检查人体工程、BOM 检查缺不缺料、
 * 报价清单检查逐行对不对得上小计、定价引擎检查价格矩阵有没有洞。每一处都对，
 * 但**没有任何一个地方回答「这一份东西现在能不能给客户」**。
 *
 * 于是出现过这样的组合：
 *   - 方案通过了人体工程，但物料清单缺一条踢脚板 → 客户拿到一份装不上的报价；
 *   - 报价算出来了，但逐行合计与小计差 3 分 → 客户拿去跟别家比，比的是个错数；
 *   - 家电尺寸是我们猜的，解释里却没说 → 客户按图订了柜子，冰箱塞不进去。
 *
 * 这三种都不是"某个模块有 bug"，而是**没人在最后一道口子上把它们合起来看**。
 *
 * ## 闸门，不是评分
 *
 * 与 FR-4.1 的三层结构同源：`blocking` 的项**不参与权衡**，一条都不允许放行。
 * 理由和那边一样——任何权重都能被"其他方面都很好"投票压过去，而一份缺料的
 * 报价单不会因为方案好看就变得能用。
 *
 * `advisory` 的项不拦，但**必须显示给客户**。它们不是日志，是交付物的一部分：
 * 「你选的组装方式有几个柜体不提供」如果只写进服务端日志，客户永远不会知道。
 *
 * ## 这层不重新实现任何检查
 *
 * 它调用已有的检查器（`ergonomics`、`bom.missing`、`reconciliationDelta`、
 * `verifySnapshot`…）并把结论汇总。重新实现一遍等于制造第二个真相来源——
 * 两套规则迟早会分叉，而分叉时没人知道该信哪一个。
 */
import type { ModuleSpec, Quote } from "../domain/types.js";
import type { GeneratedLayout, Placement } from "../layout/generate.js";
import type { WallRun } from "../floorplan/types.js";
import type { BomResult } from "../layout/bom.js";
import type { QuoteList } from "../quote/line-items.js";
import type { ApplianceSpec } from "../floorplan/appliances.js";
import { APPLIANCE_LABEL, assumedOnes } from "../floorplan/appliances.js";
import { format } from "../domain/money.js";
import { hasBlockingViolation } from "../layout/ergonomics.js";
import { buildKitchenPlan, depthOf, footprint, overlaps } from "../layout/plan-model.js";
import type { DesignStage } from "../design/stages.js";
import { allowedArtifacts } from "../design/stages.js";

/** 交付物的种类——不同交付物该过的检查不同。 */
export type Deliverable = "planView" | "fourViews" | "quoteList";

export type AuditSeverity =
  /** 一条都不允许放行。 */
  | "blocking"
  /** 可以交付，但**必须显示给客户**。 */
  | "advisory";

export type AuditCode =
  | "ERGONOMICS"            // 人体工程硬约束
  | "BOM_INCOMPLETE"        // 物料清单缺型号
  | "QUOTE_RECONCILIATION"  // 逐行合计与小计对不上
  | "SPEC_MISMATCH"         // 选择里出现规格库外的型号或尺寸
  | "PRICE_SNAPSHOT"        // 报价快照复算不一致
  | "GEOMETRY"              // 柜体超墙 / 同一段墙内重叠
  | "INTERFERENCE"          // 跨墙段干涉：两段墙的柜子占同一块地方
  | "UNDISCLOSED_ASSUMPTION"// 推定值没有在交付物里披露
  | "STAGE"                 // 这个阶段不该出这份东西
  | "UNAPPLIED_PREFERENCE"  // 客户的选择没能全部落实
  | "AESTHETICS";           // 美观分偏低

export interface AuditFinding {
  code: AuditCode;
  severity: AuditSeverity;
  /** 给客户看的话——不是给工程师看的日志。 */
  message: string;
  /** 定位用，可选。 */
  wallRunId?: string;
}

export interface AuditReport {
  /** 能不能交付。有任何 blocking 项即为 false。 */
  ok: boolean;
  findings: AuditFinding[];
  /** 必须随交付物一起展示给客户的那些（advisory）。 */
  notices: AuditFinding[];
  /** 拦住交付的那些（blocking）。 */
  blockers: AuditFinding[];
  /** 实际跑了哪几项检查——「没查」和「查过没问题」不是一回事。 */
  checked: AuditCode[];
}

export interface AuditInput {
  deliverable: Deliverable;
  stage: DesignStage;
  /** 排布结果。planView / fourViews 必给。 */
  layout?: GeneratedLayout;
  wallRuns?: readonly WallRun[];
  /** 该公司已发布规格里的型号，用于核对"只用真实存在的型号与尺寸"。 */
  modules?: readonly ModuleSpec[];
  bom?: BomResult;
  quote?: Quote;
  quoteList?: QuoteList;
  /** 这个厨房的家电——用于核对推定值有没有被披露。 */
  appliances?: readonly ApplianceSpec[];
  /**
   * 将要交给客户的**全部文字**（解释、清单文本、提示）。
   *
   * 用来验证"该说的话真的说了"。只检查数据字段是不够的：
   * `provenance: "assumed"` 存在数据里，但客户读到的是文字。
   */
  customerFacingText?: string;
  /** 客户选了却没能落实的偏好（`unappliedPreferences` 的产出）。 */
  unappliedPreferences?: readonly string[];
  /** 快照复算结论（由调用方跑，因为它需要 PricingContext）。 */
  snapshot?: { ok: boolean; mismatches?: string[] };
}

/** 美观分低于这个值就提醒客户——不拦，但值得他看一眼。 */
const AESTHETICS_ADVISORY_BELOW = 60;

export function auditDeliverable(input: AuditInput): AuditReport {
  const findings: AuditFinding[] = [];
  const checked: AuditCode[] = [];
  const add = (f: AuditFinding) => findings.push(f);
  const ran = (c: AuditCode) => { if (!checked.includes(c)) checked.push(c); };

  // ── 阶段：这个东西现在该不该出 ──
  ran("STAGE");
  if (!allowedArtifacts(input.stage)[input.deliverable]) {
    add({
      code: "STAGE", severity: "blocking",
      message: `当前处于「${stageLabel(input.stage)}」，还不该出${deliverableLabel(input.deliverable)}`,
    });
  }

  // ── 人体工程：硬约束，一条都不放行 ──
  if (input.layout) {
    ran("ERGONOMICS");
    if (hasBlockingViolation(input.layout.ergonomics)) {
      for (const v of input.layout.ergonomics) {
        if (v.severity !== "blocking") continue;
        add({
          code: "ERGONOMICS", severity: "blocking", message: v.message,
          ...(v.wallRunId ? { wallRunId: v.wallRunId } : {}),
        });
      }
    }

    // ── 几何自洽：柜体不超墙、互不重叠 ──
    if (input.wallRuns) {
      ran("GEOMETRY");
      for (const g of geometryProblems(input.layout.placements, input.wallRuns)) add(g);

      // ── 跨墙段干涉 ──
      //
      // 上面那一项**只在单段墙内**查重叠，而墙角与岛台的干涉正好落在它的盲区里：
      // 两个柜子分别属于两段墙，各自都"没超墙"，合起来却占着同一块地方。
      // 客户说的「只有把它们连起来的时候，才会发现干涉的问题」就是这一条。
      ran("INTERFERENCE");
      for (const g of interferenceProblems(input.layout.placements, input.wallRuns)) add(g);
    }

    // ── 美观：不拦，但低到一定程度要让客户知道 ──
    ran("AESTHETICS");
    for (const a of input.layout.aesthetics) {
      if (a.score.total >= AESTHETICS_ADVISORY_BELOW) continue;
      add({
        code: "AESTHETICS", severity: "advisory", wallRunId: a.wallRunId,
        message: `这面墙的排布评分偏低（${a.score.total}/100）——柜宽跳动或有凑数窄柜，` +
          `想更整齐的话可以让我再调一版。`,
      });
    }
  }

  // ── 物料完整：缺一条踢脚板，客户就是装不上 ──
  if (input.bom) {
    ran("BOM_INCOMPLETE");
    for (const m of input.bom.missing) {
      add({
        code: "BOM_INCOMPLETE", severity: "blocking",
        message: `这家公司的规格库里没有「${m}」，这份清单是缺料的——照它下单装不完整`,
      });
    }
  }

  // ── 只用规格库里真实存在的型号与尺寸（FR-8 同源）──
  if (input.modules && input.bom) {
    ran("SPEC_MISMATCH");
    for (const p of specProblems(input.bom, input.modules)) add(p);
  }

  // ── 报价：逐行合计必须与小计对得上 ──
  if (input.quoteList) {
    ran("QUOTE_RECONCILIATION");
    if (input.quoteList.reconciliationDelta !== 0) {
      add({
        code: "QUOTE_RECONCILIATION", severity: "blocking",
        message: `报价清单逐行合计与小计差 ${format(input.quoteList.reconciliationDelta)}——` +
          `说明有行漏了或算重了，这份价格不能拿去比价`,
      });
    }
  }

  // ── 报价快照复算 ──
  if (input.snapshot) {
    ran("PRICE_SNAPSHOT");
    if (!input.snapshot.ok) {
      add({
        code: "PRICE_SNAPSHOT", severity: "blocking",
        message: "报价快照与按规格库复算的结果不一致，这份报价不可信" +
          (input.snapshot.mismatches?.length ? `（${input.snapshot.mismatches[0]}）` : ""),
      });
    }
  }

  // ── 推定值必须披露 ──
  //
  // 数据里有 provenance 不等于客户读到了。**要检查交给客户的文字里真的说了。**
  if (input.appliances?.length) {
    ran("UNDISCLOSED_ASSUMPTION");
    const assumed = assumedOnes(input.appliances);
    const text = input.customerFacingText ?? "";
    for (const a of assumed) {
      const label = APPLIANCE_LABEL[a.kind];
      if (text.includes(label) && (text.includes("推定") || text.includes("预留"))) continue;
      add({
        code: "UNDISCLOSED_ASSUMPTION", severity: "blocking",
        message: `${label}的尺寸是按常见款推定的（${a.width}"），` +
          `但交给你的说明里没有写清这一点——按图订柜可能装不进去`,
      });
    }
  }

  // ── 客户的选择没能全部落实：不拦，但一定要说 ──
  if (input.unappliedPreferences?.length) {
    ran("UNAPPLIED_PREFERENCE");
    for (const u of input.unappliedPreferences) {
      add({ code: "UNAPPLIED_PREFERENCE", severity: "advisory", message: u });
    }
  }

  const blockers = findings.filter((f) => f.severity === "blocking");
  const notices = findings.filter((f) => f.severity === "advisory");
  return { ok: blockers.length === 0, findings, blockers, notices, checked };
}

// ── 各项检查 ──────────────────────────────────────────────────────────────

/**
 * 柜体超墙或互相重叠。
 *
 * 这类问题排布器"不应该"产生，但正因为如此才要在出口查一次：
 * 一个越界的柜子在图上看不出来（SVG 照画不误），到现场才发现装不下。
 */
function geometryProblems(
  placements: readonly Placement[],
  runs: readonly WallRun[],
): AuditFinding[] {
  const out: AuditFinding[] = [];
  const EPS = 0.01;

  for (const run of runs) {
    for (const layer of ["base", "wall", "tall"] as const) {
      const mine = placements
        .filter((p) => p.wallRunId === run.id && p.layer === layer)
        .sort((a, b) => a.x - b.x);

      for (const p of mine) {
        if (p.x < -EPS || p.x + p.width > run.length + EPS) {
          out.push({
            code: "GEOMETRY", severity: "blocking", wallRunId: run.id,
            message: `${run.label}上有构件超出墙长（${p.moduleCode ?? p.label ?? "构件"} ` +
              `占 ${p.x}"–${p.x + p.width}"，墙只有 ${run.length}"）`,
          });
        }
      }
      for (let i = 1; i < mine.length; i++) {
        const prev = mine[i - 1]!;
        const cur = mine[i]!;
        if (cur.x < prev.x + prev.width - EPS) {
          out.push({
            code: "GEOMETRY", severity: "blocking", wallRunId: run.id,
            message: `${run.label}上有构件重叠（${prev.moduleCode ?? prev.label ?? "构件"} 与 ` +
              `${cur.moduleCode ?? cur.label ?? "构件"} 在 ${cur.x}" 处叠在一起）`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * 跨墙段干涉 —— 把每个构件放到**世界坐标**里，两两比足迹。
 *
 * 判定靠 `plan-model.ts` 拼出来的那张连通平面：它同时决定图上怎么画、
 * 排布时墙角让多少位。三处读同一份平面，图上没干涉就是真的没干涉。
 *
 * 只比**竖直方向真的重叠**的那些：地柜与吊柜错开，平面投影重叠是正常的。
 * 但**高柜横跨两层**——它从地面通到吊柜高度，与地柜、吊柜都会撞。
 * 按 `layer` 字符串相等来判的话，高柜与隔壁墙的干涉会被静默放过。
 */
function interferenceProblems(
  placements: readonly Placement[],
  runs: readonly WallRun[],
): AuditFinding[] {
  const out: AuditFinding[] = [];
  const plan = buildKitchenPlan({ wallRuns: [...runs], confidence: 1 });
  const byRunId = new Map(plan.runs.map((rp) => [rp.run.id, rp]));

  const boxes = placements
    .filter((p) => p.kind !== "gap")
    .map((p) => {
      const rp = byRunId.get(p.wallRunId);
      if (!rp) return undefined;
      const depth = p.depth || depthOf(rp, p.layer);
      return { p, rp, box: footprint(rp, p.x, p.width, depth) };
    })
    .filter((b): b is NonNullable<typeof b> => b !== undefined);

  const seen = new Set<string>();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.p.wallRunId === b.p.wallRunId) continue; // 同段墙由 GEOMETRY 管
      if (!sameBand(a.p.layer, b.p.layer)) continue;
      if (!overlaps(a.box, b.box)) continue;
      // 同一对墙段只报一次——墙角撞上了，那一整排都会撞，报十条没有更多信息
      const key = [a.p.wallRunId, b.p.wallRunId].sort().join("|") + a.p.layer;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        code: "INTERFERENCE", severity: "blocking", wallRunId: a.p.wallRunId,
        message: `${a.rp.run.label}的${nameOf(a.p)}与${b.rp.run.label}的${nameOf(b.p)}` +
          `占了同一块地方——这两段在墙角处需要让位或改用转角柜`,
      });
    }
  }
  return out;
}

/** 两个构件在竖直方向上有没有重叠。高柜同时占地柜层和吊柜层。 */
function sameBand(a: Placement["layer"], b: Placement["layer"]): boolean {
  return a === b || a === "tall" || b === "tall";
}

function nameOf(p: Placement): string {
  return p.moduleCode ?? p.label ?? (p.kind === "appliance" ? "家电位" : "构件");
}

/**
 * 清单里的型号与尺寸必须在该公司的规格库里真实存在。
 *
 * FR-4 与 FR-8 都写了这条，但**写在两个模块里各自执行**。这里在出口再核一次：
 * 一个规格库里不存在的尺寸，定价时会在价格矩阵里查不到而整单拒绝——
 * 那时客户看到的只是一句"报价校验未通过"，而根因在几百行之外。
 */
function specProblems(bom: BomResult, modules: readonly ModuleSpec[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  const byId = new Map(modules.map((m) => [m.id, m]));

  for (const line of bom.lines) {
    const spec = byId.get(line.moduleId);
    if (!spec) {
      out.push({
        code: "SPEC_MISMATCH", severity: "blocking",
        message: `清单里的 ${line.moduleCode} 不在这家公司的规格库里`,
      });
      continue;
    }
    const dims: [string, number, number[]][] = [
      ["宽", line.width, spec.widthOptions],
      ["高", line.height, spec.heightOptions],
      ["深", line.depth, spec.depthOptions],
    ];
    for (const [label, value, options] of dims) {
      if (options.length === 0 || options.includes(value)) continue;
      out.push({
        code: "SPEC_MISMATCH", severity: "blocking",
        message: `${line.moduleCode} 的${label} ${value}" 不在这家公司提供的档位里` +
          `（${options.join("/")}）`,
      });
    }
  }
  return out;
}

// ── 呈现 ──────────────────────────────────────────────────────────────────

function stageLabel(stage: DesignStage): string {
  return {
    collecting: "还在收集资料", readyToDraw: "等你确认是否出图",
    planReview: "全局排布评审", fullDrawings: "完整图纸", quoted: "已出报价",
  }[stage];
}

function deliverableLabel(d: Deliverable): string {
  return { planView: "全局俯视图", fourViews: "完整四视图", quoteList: "报价清单" }[d];
}

/**
 * 审核结论写成客户能看懂的一段话。
 *
 * 通过时也要说——「查过了，这几项都过了」比什么都不说更有用，
 * 客户才知道这份东西是被检查过的，而不是随手生成的。
 */
export function renderAuditText(report: AuditReport): string {
  const out: string[] = [];
  if (report.blockers.length > 0) {
    out.push("【这一版还不能用】");
    for (const b of report.blockers) out.push(`  ✗ ${b.message}`);
    out.push("");
  }
  if (report.notices.length > 0) {
    out.push("【需要你知道的几点】");
    for (const n of report.notices) out.push(`  ! ${n.message}`);
    out.push("");
  }
  if (report.ok && report.notices.length === 0) {
    out.push(`【交付前检查】${report.checked.length} 项全部通过：` +
      `${report.checked.map(codeLabel).join("、")}。`);
  } else if (report.ok) {
    out.push(`【交付前检查】${report.checked.length} 项已跑完，无阻断项。`);
  }
  return out.join("\n");
}

export function codeLabel(code: AuditCode): string {
  return {
    ERGONOMICS: "人体工程与安全", BOM_INCOMPLETE: "物料完整性",
    QUOTE_RECONCILIATION: "报价逐行对账", SPEC_MISMATCH: "型号与尺寸同源",
    PRICE_SNAPSHOT: "价格快照复算", GEOMETRY: "几何自洽", INTERFERENCE: "跨墙段干涉",
    UNDISCLOSED_ASSUMPTION: "推定值披露", STAGE: "阶段匹配",
    UNAPPLIED_PREFERENCE: "偏好落实", AESTHETICS: "排布评分",
  }[code];
}
