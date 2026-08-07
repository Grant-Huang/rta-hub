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
import {
  buildKitchenPlan, depthOf, doorSpan, footprint, overlaps, COUNTERTOP,
} from "../layout/plan-model.js";
import type { SanityRuleId } from "./sanity-rules.js";
import type { ErgonomicCode } from "../layout/ergonomics.js";
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
  | "DOOR_CLEARANCE"        // 门洞旁没留出台面外伸的距离
  | "PLAN_NOTE"             // 平面连不起来却没有如实标注
  | "UNDISCLOSED_ASSUMPTION"// 推定值没有在交付物里披露
  | "STAGE"                 // 这个阶段不该出这份东西
  | "UNAPPLIED_PREFERENCE"  // 客户的选择没能全部落实
  | "AESTHETICS";           // 美观分偏低

export interface AuditFinding {
  code: AuditCode;
  severity: AuditSeverity;
  /**
   * 依据哪条合理性规则（`sanity-rules.ts` / `docs/SANITY_RULES.md`）。
   *
   * 报出来的用处很实在：客户被拦下时能查到依据，运营能核对"这一条到底是
   * 谁规定的"。没有编号的话，审核结论就只是一句系统自己说的话。
   */
  rule: SanityRuleId;
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
  /**
   * 实际跑到的合理性规则编号。
   *
   * 与 `checked` 的区别：`checked` 是内部检查项，这个是**规范里的条目**。
   * 客户与运营看的是后者——「SR-G3 跨墙段干涉：通过」比「INTERFERENCE」有意义。
   */
  checkedRules: SanityRuleId[];
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

/**
 * 人体工程的每一种违规对应规范里的哪一条。
 *
 * 映射写死在这里而不是塞进 `ErgonomicViolation`：`ergonomics.ts` 是**排布层**，
 * 它不该知道交付规范的编号体系。反过来，交付层知道排布层的违规种类是正常的。
 */
const RULE_BY_ERGONOMIC: Record<ErgonomicCode, SanityRuleId> = {
  SINK_LANDING: "SR-E1",
  COOKTOP_LANDING: "SR-E2",
  REFRIGERATOR_LANDING: "SR-E3",
  DISHWASHER_TOO_FAR: "SR-E4",
  DISHWASHER_STANDING: "SR-E4",
  AISLE_TOO_NARROW: "SR-E5",
  WORK_TRIANGLE: "SR-E6",
  UNREACHABLE_BLIND_CORNER: "SR-E7",
  NO_CONTINUOUS_PREP: "SR-E8",
};

const ERGONOMIC_RULES = [...new Set(Object.values(RULE_BY_ERGONOMIC))];

export function auditDeliverable(input: AuditInput): AuditReport {
  const findings: AuditFinding[] = [];
  const checked: AuditCode[] = [];
  const checkedRules: SanityRuleId[] = [];
  const add = (f: AuditFinding) => findings.push(f);
  const ran = (c: AuditCode, ...rules: SanityRuleId[]) => {
    if (!checked.includes(c)) checked.push(c);
    // 规则编号单独记：一个内部检查项可能对应规范里的好几条
    // （GEOMETRY 同时覆盖 SR-G1 超墙与 SR-G2 重叠）
    for (const r of rules) if (!checkedRules.includes(r)) checkedRules.push(r);
  };

  // ── 阶段：这个东西现在该不该出 ──
  ran("STAGE", "SR-D3");
  if (!allowedArtifacts(input.stage)[input.deliverable]) {
    add({
      code: "STAGE", rule: "SR-D3", severity: "blocking",
      message: `当前处于「${stageLabel(input.stage)}」，还不该出${deliverableLabel(input.deliverable)}`,
    });
  }

  // ── 人体工程：硬约束，一条都不放行 ──
  if (input.layout) {
    ran("ERGONOMICS", ...ERGONOMIC_RULES);
    if (hasBlockingViolation(input.layout.ergonomics)) {
      for (const v of input.layout.ergonomics) {
        if (v.severity !== "blocking") continue;
        add({
          code: "ERGONOMICS", rule: RULE_BY_ERGONOMIC[v.code],
          severity: "blocking", message: v.message,
          ...(v.wallRunId ? { wallRunId: v.wallRunId } : {}),
        });
      }
    }

    // ── 几何自洽：柜体不超墙、互不重叠 ──
    if (input.wallRuns) {
      ran("GEOMETRY", "SR-G1", "SR-G2");
      for (const g of geometryProblems(input.layout.placements, input.wallRuns)) add(g);

      // ── 跨墙段干涉 ──
      //
      // 上面那一项**只在单段墙内**查重叠，而墙角与岛台的干涉正好落在它的盲区里：
      // 两个柜子分别属于两段墙，各自都"没超墙"，合起来却占着同一块地方。
      // 客户说的「只有把它们连起来的时候，才会发现干涉的问题」就是这一条。
      ran("INTERFERENCE", "SR-G3");
      for (const g of interferenceProblems(input.layout.placements, input.wallRuns)) add(g);

      // ── 门洞旁的台面外伸（SR-G4）──
      //
      // 台面比柜体箱体两端各多伸 1-1/2"。按柜体判「没超墙」的方案，
      // 现场台面会压在门套线上，门开到一半顶住。排布阶段已经让过位了，
      // 这里是出口复核——`regenerateRun` 之类的路径改过 x 之后同样要过这一关。
      ran("DOOR_CLEARANCE", "SR-G4");
      for (const g of doorClearanceProblems(input.layout.placements, input.wallRuns)) add(g);

      // ── 平面连不起来时要标注（SR-V4）──
      ran("PLAN_NOTE", "SR-V4");
      for (const g of planNoteProblems(input.wallRuns, input.customerFacingText ?? "")) add(g);
    }

    // ── 美观：不拦，但低到一定程度要让客户知道 ──
    ran("AESTHETICS");
    for (const a of input.layout.aesthetics) {
      if (a.score.total >= AESTHETICS_ADVISORY_BELOW) continue;
      add({
        code: "AESTHETICS", rule: "SR-D2", severity: "advisory", wallRunId: a.wallRunId,
        message: `这面墙的排布评分偏低（${a.score.total}/100）——柜宽跳动或有凑数窄柜，` +
          `想更整齐的话可以让我再调一版。`,
      });
    }
  }

  // ── 物料完整：缺一条踢脚板，客户就是装不上 ──
  if (input.bom) {
    ran("BOM_INCOMPLETE", "SR-M1");
    for (const m of input.bom.missing) {
      add({
        code: "BOM_INCOMPLETE", rule: "SR-M1", severity: "blocking",
        message: `这家公司的规格库里没有「${m}」，这份清单是缺料的——照它下单装不完整`,
      });
    }
  }

  // ── 只用规格库里真实存在的型号与尺寸（FR-8 同源）──
  if (input.modules && input.bom) {
    ran("SPEC_MISMATCH", "SR-M2");
    for (const p of specProblems(input.bom, input.modules)) add(p);
  }

  // ── 报价：逐行合计必须与小计对得上 ──
  if (input.quoteList) {
    ran("QUOTE_RECONCILIATION", "SR-Q1");
    if (input.quoteList.reconciliationDelta !== 0) {
      add({
        code: "QUOTE_RECONCILIATION", rule: "SR-Q1", severity: "blocking",
        message: `报价清单逐行合计与小计差 ${format(input.quoteList.reconciliationDelta)}——` +
          `说明有行漏了或算重了，这份价格不能拿去比价`,
      });
    }
  }

  // ── 报价快照复算 ──
  if (input.snapshot) {
    ran("PRICE_SNAPSHOT", "SR-Q2");
    if (!input.snapshot.ok) {
      add({
        code: "PRICE_SNAPSHOT", rule: "SR-Q2", severity: "blocking",
        message: "报价快照与按规格库复算的结果不一致，这份报价不可信" +
          (input.snapshot.mismatches?.length ? `（${input.snapshot.mismatches[0]}）` : ""),
      });
    }
  }

  // ── 推定值必须披露 ──
  //
  // 数据里有 provenance 不等于客户读到了。**要检查交给客户的文字里真的说了。**
  if (input.appliances?.length) {
    ran("UNDISCLOSED_ASSUMPTION", "SR-D1");
    const assumed = assumedOnes(input.appliances);
    const text = input.customerFacingText ?? "";
    for (const a of assumed) {
      const label = APPLIANCE_LABEL[a.kind];
      if (text.includes(label) && (text.includes("推定") || text.includes("预留"))) continue;
      add({
        code: "UNDISCLOSED_ASSUMPTION", rule: "SR-D1", severity: "blocking",
        message: `${label}的尺寸是按常见款推定的（${a.width}"），` +
          `但交给你的说明里没有写清这一点——按图订柜可能装不进去`,
      });
    }
  }

  // ── 客户的选择没能全部落实：不拦，但一定要说 ──
  if (input.unappliedPreferences?.length) {
    ran("UNAPPLIED_PREFERENCE", "SR-M3", "SR-D2");
    for (const u of input.unappliedPreferences) {
      add({ code: "UNAPPLIED_PREFERENCE", rule: "SR-D2", severity: "advisory", message: u });
    }
  }

  const blockers = findings.filter((f) => f.severity === "blocking");
  const notices = findings.filter((f) => f.severity === "advisory");
  return { ok: blockers.length === 0, findings, blockers, notices, checked, checkedRules };
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
            code: "GEOMETRY", rule: "SR-G1", severity: "blocking", wallRunId: run.id,
            message: `${run.label}上有构件超出墙长（${p.moduleCode ?? p.label ?? "构件"} ` +
              `占 ${p.x}"–${p.x + p.width}"，墙只有 ${run.length}"）`,
          });
        }
      }
      // 两两比。**不能只比相邻的**：叠装让同一个 x 位置上有两个构件，
      // 排序后相邻的那一对正是合法的上下段，而真正重叠的可能隔着它们。
      for (let i = 0; i < mine.length; i++) {
        for (let j = i + 1; j < mine.length; j++) {
          const a = mine[i]!;
          const b = mine[j]!;
          if (b.x >= a.x + a.width - EPS || a.x >= b.x + b.width - EPS) continue;
          // 横向压上了，还要看**竖直方向**：叠装吊柜的上下两段共用一个 x 区间，
          // 它们在高度上错开，不是重叠。只比 x 的话，一启用叠装就整片误报。
          if (!verticallyOverlap(a, b, EPS)) continue;
          out.push({
            code: "GEOMETRY", rule: "SR-G2", severity: "blocking", wallRunId: run.id,
            message: `${run.label}上有构件重叠（${nameOf(a)} 与 ${nameOf(b)} ` +
              `在 ${Math.max(a.x, b.x)}" 处叠在一起）`,
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
        code: "INTERFERENCE", rule: "SR-G3", severity: "blocking", wallRunId: a.p.wallRunId,
        message: `${a.rp.run.label}的${nameOf(a.p)}与${b.rp.run.label}的${nameOf(b.p)}` +
          `占了同一块地方——这两段在墙角处需要让位或改用转角柜`,
      });
    }
  }
  return out;
}

/**
 * 同一层内两个构件在**高度上**有没有重叠。
 *
 * 叠装吊柜的上下两段同属 wall 层、共用同一个 x 区间，靠 `stackBase` 错开。
 * 不比高度的话，启用叠装的那一刻整面墙都会被判成"构件重叠"。
 */
function verticallyOverlap(a: Placement, b: Placement, eps: number): boolean {
  const lo = (p: Placement) => p.stackBase ?? 0;
  const hi = (p: Placement) => (p.stackBase ?? 0) + p.height;
  return lo(a) < hi(b) - eps && lo(b) < hi(a) - eps;
}

/** 两个构件在竖直方向上有没有重叠。高柜同时占地柜层和吊柜层。 */
function sameBand(a: Placement["layer"], b: Placement["layer"]): boolean {
  return a === b || a === "tall" || b === "tall";
}

/**
 * 门洞旁的台面外伸（SR-G4）。
 *
 * `doorSpan` 给的是**已经把台面外伸与门套线算进去**的净空区间；柜体箱体
 * 不得侵入它。这里比的是箱体而不是"箱体 + 外伸"——外伸已经在 `doorSpan`
 * 里加过一次了，再加一次就是双重计算，会把排布器刚刚让好位的方案拦下来。
 *
 * 排布阶段已经按同一个 `doorSpan` 切过段，这里是出口复核：
 * `regenerateRun` 这类直接改 x 的路径同样要过这一关，而它走的不是
 * `splitIntoSegments`。两处读同一个函数，才不会一处让 2.5" 另一处判 4"。
 */
function doorClearanceProblems(
  placements: readonly Placement[],
  runs: readonly WallRun[],
): AuditFinding[] {
  const out: AuditFinding[] = [];
  const EPS = 0.01;

  for (const run of runs) {
    const doors = run.features.filter((f) => f.kind === "door");
    if (doors.length === 0) continue;

    for (const p of placements) {
      if (p.wallRunId !== run.id) continue;
      if (p.layer !== "base" && p.layer !== "wall") continue;
      if (p.kind === "appliance") continue; // 家电位是客户自己的，不带我们的台面

      const left = p.x;
      const right = p.x + p.width;

      for (const f of doors) {
        const span = doorSpan(f, p.layer === "base" ? "base" : "wall");
        const doorLeft = span.x;
        const doorRight = span.x + span.width;
        if (right <= doorLeft + EPS || left >= doorRight - EPS) continue;
        out.push({
          code: "DOOR_CLEARANCE", rule: "SR-G4", severity: "blocking", wallRunId: run.id,
          message: `${run.label}上的${nameOf(p)}离门洞太近——` +
            `连台面外伸算进去占到 ${round(left)}"–${round(right)}"，` +
            `而门洞连门套要留出 ${round(doorLeft)}"–${round(doorRight)}"。` +
            `台面会压在门套上，门开不到位。`,
        });
        break; // 一个构件报一次就够
      }
    }
  }
  return out;
}

/**
 * 平面拼不起来时必须如实标注（SR-V4）。
 *
 * 推不出方位就不假装知道——但也不能不说。图上那句「示意排列」必须真的出现在
 * **交给客户的文字**里，与 SR-D1 同一条原则：数据里有标记不等于客户读到了。
 */
function planNoteProblems(
  runs: readonly WallRun[],
  customerFacingText: string,
): AuditFinding[] {
  const plan = buildKitchenPlan({ wallRuns: [...runs], confidence: 1 });
  if (plan.connected || !plan.note) return [];
  if (customerFacingText.includes("示意排列")) return [];
  return [{
    code: "PLAN_NOTE", rule: "SR-V4", severity: "advisory",
    message: "有墙段拼不到一起，图上是示意排列——实际方位要以现场为准，" +
      "这一点需要在给客户的说明里写清楚。",
  }];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
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
        code: "SPEC_MISMATCH", rule: "SR-M2", severity: "blocking",
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
        code: "SPEC_MISMATCH", rule: "SR-M2", severity: "blocking",
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
  // 每条结论都带上规范编号。客户被拦下时能查到依据（docs/SANITY_RULES.md），
  // 运营能核对「这一条到底是谁规定的」——没有编号的话，审核结论就只是
  // 一句系统自己说的话。
  if (report.blockers.length > 0) {
    out.push("【这一版还不能用】");
    for (const b of report.blockers) out.push(`  ✗ [${b.rule}] ${b.message}`);
    out.push("");
  }
  if (report.notices.length > 0) {
    out.push("【需要你知道的几点】");
    for (const n of report.notices) out.push(`  ! [${n.rule}] ${n.message}`);
    out.push("");
  }
  if (report.ok && report.notices.length === 0) {
    out.push(`【交付前检查】按《合理性审查规范》跑了 ${report.checkedRules.length} 条，` +
      `全部通过：${report.checkedRules.join("、")}。`);
  } else if (report.ok) {
    out.push(`【交付前检查】按《合理性审查规范》跑了 ${report.checkedRules.length} 条，无阻断项。`);
  }
  return out.join("\n");
}

export function codeLabel(code: AuditCode): string {
  return {
    ERGONOMICS: "人体工程与安全", BOM_INCOMPLETE: "物料完整性",
    QUOTE_RECONCILIATION: "报价逐行对账", SPEC_MISMATCH: "型号与尺寸同源",
    PRICE_SNAPSHOT: "价格快照复算", GEOMETRY: "几何自洽", INTERFERENCE: "跨墙段干涉",
    DOOR_CLEARANCE: "门洞台面净空", PLAN_NOTE: "平面拼接标注",
    UNDISCLOSED_ASSUMPTION: "推定值披露", STAGE: "阶段匹配",
    UNAPPLIED_PREFERENCE: "偏好落实", AESTHETICS: "排布评分",
  }[code];
}
