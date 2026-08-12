/**
 * 家电落位 —— **在分层排布之前统一决定**（APPLIANCES.md §3.2、§5）。
 *
 * ## 为什么必须先于分层
 *
 * 抽油烟机在**吊柜层**，但它的位置由**地柜层的灶台**决定。改造前两层各排各的，
 * 吊柜层根本不知道灶在哪——于是烟机要么排不出来，要么排到别处。
 *
 * 家电位置本来就是**全局约束**：它跨墙段（冰箱靠近入口 = 靠近第一段墙的起点）、
 * 跨层（烟机跟着灶台）、还互相牵制（洗碗机必须挨着水槽）。放进"逐墙段、逐层"
 * 的循环里去决定，等于让一个全局问题被局部地解四遍。
 *
 * ## 落位规则
 *
 * 优先级从高到低：
 *   1. **户型图上的对应特征**——燃气口在哪，灶就在哪；强电口在哪，冰箱就在哪。
 *      这是现场事实，压过一切偏好。
 *   2. **客户说的位置偏好**（`preferredZone`）。
 *   3. **默认摆法**：冰箱放在第一段墙的起点（多数厨房入口在那一头），
 *      其余从最长那段墙的末端往前排。
 *
 * 硬挡还包括：门洞、障碍、让位侧墙角、**拥有侧转角柜虚位**（`corner-reserve.ts`，
 * 传入 modules 时生效）——家电不得直接坐进墙角，否则转角柜无处可排。
 *
 * 放不下就**如实报出来**，不静默丢掉——「你说冰箱要靠近入口，但那面墙放不下
 * 35 寸的冰箱位」对客户是有用的信息。
 */
import type { ParsedGeometry, WallFeature, WallRun } from "../floorplan/types.js";
import { quantize } from "../floorplan/types.js";
import {
  applianceLabel, reservedWidth, type ApplianceKind, type ApplianceSpec,
} from "../floorplan/appliances.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";
import type { ModuleSpec } from "../domain/types.js";
import { buildKitchenPlan, doorSpan, usableSpan } from "./plan-model.js";
import { ownerCornerKeepOuts } from "./corner-reserve.js";

/** 高柜类家电：箱体顶到吊柜高度，不能压在窗洞下。 */
const TALL_APPLIANCE: ReadonlySet<ApplianceKind> = new Set(["refrigerator", "wallOven"]);

/**
 * 给水槽**连同它两侧台面**预留的宽度。
 *
 * 36"（常见水槽柜）+ 24" + 18"（NKBA 要求的两侧台面工作区）。
 *
 * 只留 36" 是不够的：家电紧贴着水槽柜放，水槽柜本身放下了，但两侧没有台面，
 * 随后人体工程检查会判 `SINK_LANDING` 不足——**方案被自己的检查器否掉，
 * 而根因在几十行之外的家电落位里**。水槽的净空需求必须和家电自己的净空
 * 一样，在落位阶段就参与决策。
 *
 * 墙太短放不下这一整块时按墙长截断——那种厨房本来就装不下"冰箱 + 合规水槽区"，
 * 家电会因为找不到位置而被如实报出来，而不是硬塞进去再让检查器否掉。
 */
const SINK_ZONE = 36 + 24 + 18;

/** 一台家电在某段墙上的落位。 */
export interface PlacedAppliance {
  spec: ApplianceSpec;
  wallRunId: string;
  x: number;
  width: number;
  /** 在地柜层占位，还是在吊柜层（抽油烟机）。 */
  layer: "base" | "wall";
  /** 为什么落在这儿——进解释，客户能看懂为什么冰箱在这一头。 */
  reason: string;
}

export interface AppliancePlanWarning {
  kind: ApplianceKind;
  message: string;
}

export interface AppliancePlan {
  placed: PlacedAppliance[];
  warnings: AppliancePlanWarning[];
  /** 按墙段索引，供 `splitIntoSegments` 直接取用。 */
  byRun: Map<string, PlacedAppliance[]>;
}

/** 户型特征 → 哪种家电该锚在它上面。这是现场事实，压过客户的位置偏好。 */
const ANCHOR_FEATURE: Partial<Record<ApplianceKind, WallFeature["kind"]>> = {
  range: "gas",
  cooktop: "gas",
  refrigerator: "electrical",
  wallOven: "electrical",
};

/**
 * 抽油烟机在吊柜层，紧跟灶台。
 *
 * 它不是"另一台需要找位置的家电"，而是灶台位置的**从属结果**——所以单独处理，
 * 不进通用的找位置流程。
 */
const HOOD_FOLLOWS: ApplianceKind[] = ["range", "cooktop"];

/**
 * 洗碗机由水槽位置决定（NKBA：距水槽最近边 ≤36"）。
 *
 * 但水槽柜是排布阶段才定下来的，所以这里**不给洗碗机定位**——它仍由
 * `generate.ts` 在排出水槽柜之后紧邻安放。这里只把它的宽度传下去。
 */
const PLACED_WITH_SINK: ApplianceKind[] = ["dishwasher"];

/**
 * 家电两侧必须留出的台面（NKBA，与 ergonomics.ts 的常数同源）。
 *
 * **这是硬约束，必须在落位阶段就参与决策。** 只在事后打分的话，排布器会把
 * 灶台顶到墙角，然后自己判自己不合格——这与 v0.6 修水槽落位时是同一个教训：
 * 只做事后检查等于用检查器代替设计，它能告诉你方案不合格，却永远给不出
 * 一个合格的方案。
 */
const LANDING: Partial<Record<ApplianceKind, { primary: number; secondary: number }>> = {
  // 灶具两侧要能放刚端下来的热锅——这条是安全要求
  range: { primary: 15, secondary: 12 },
  cooktop: { primary: 15, secondary: 12 },
  // 冰箱把手那一侧要有地方放刚拿出来的东西
  refrigerator: { primary: 15, secondary: 0 },
  wallOven: { primary: 15, secondary: 0 },
};

/**
 * 这个位置两侧**连续的台面**够不够。
 *
 * 量的是到最近一个断点的距离，不是到墙尽头——中间隔着一个门洞的话，
 * 门那边的台面帮不上忙。只看墙长会得出「左侧有 129 寸」这种结论，
 * 而实际上灶台左边 1 寸就是门洞。
 */
function landingOk(
  run: WallRun, x: number, need: number, kind: ApplianceKind,
  blockers: readonly Span[],
): boolean {
  const req = LANDING[kind];
  if (!req) return true;

  let leftEdge = 0;
  let rightEdge = run.length;
  for (const b of blockers) {
    const bEnd = b.x + b.width;
    if (bEnd <= x + 0.01) leftEdge = Math.max(leftEdge, bEnd);
    if (b.x >= x + need - 0.01) rightEdge = Math.min(rightEdge, b.x);
  }
  const left = x - leftEdge;
  const right = rightEdge - (x + need);
  const [big, small] = left >= right ? [left, right] : [right, left];
  return big >= req.primary && small >= req.secondary;
}

export function planAppliances(
  geometry: ParsedGeometry,
  appliances: readonly ApplianceSpec[],
  language: UiLanguage = DEFAULT_LANGUAGE,
  opts: { modules?: readonly ModuleSpec[] } = {},
): AppliancePlan {
  const lang = language ?? DEFAULT_LANGUAGE;
  const placed: PlacedAppliance[] = [];
  const warnings: AppliancePlanWarning[] = [];
  const runs = geometry.wallRuns.filter((r) => r.length > 0);
  if (runs.length === 0) return { placed, warnings, byRun: new Map() };

  /**
   * 每段墙上已被占掉的区间。分两类，因为它们对**台面连续性**的影响不同：
   *
   *   - `hard`：门洞、障碍、其他家电——**台面在这里断掉**。落台区不能跨过它。
   *   - `soft`：给水槽柜留的那一块——家电不能占，但它上面**就是台面**，
   *     落台区可以延伸过去。
   *
   * 混作一谈会得出错误结论：把水槽区当成断点，灶台旁边明明有一整条台面
   * 却被判为落台区不足。
   */
  const hard = new Map<string, Span[]>();
  const soft = new Map<string, Span[]>();
  const push = (m: Map<string, Span[]>, runId: string, x: number, width: number) => {
    const list = m.get(runId) ?? [];
    list.push({ x, width });
    m.set(runId, list);
  };
  const occupy = (runId: string, x: number, width: number) => push(hard, runId, x, width);
  const overlaps = (runId: string, x: number, width: number) =>
    [...(hard.get(runId) ?? []), ...(soft.get(runId) ?? [])]
      .some((t) => x < t.x + t.width && x + width > t.x);

  // 门洞（含门套/台面让位）与障碍不能压——与 splitIntoSegments / SR-G4 同一套 doorSpan
  for (const run of runs) {
    for (const f of run.features) {
      if (f.kind === "door") {
        const span = doorSpan(f, "base");
        occupy(run.id, span.x, span.width);
      } else if (f.kind === "obstruction") {
        occupy(run.id, f.offset, Math.max(f.width, 1));
      }
    }
  }

  /** 窗洞占位：仅对高柜类家电硬挡（冰箱/壁炉式烤箱不能塞进窗下）。 */
  const windowSpans = (runId: string): Span[] => {
    const run = runs.find((r) => r.id === runId);
    if (!run) return [];
    return run.features
      .filter((f) => f.kind === "window")
      .map((f) => ({ x: f.offset, width: Math.max(f.width, 1) }));
  };

  // **内墙角让出去的那一段也不能压。**
  //
  // 那块地方归相邻墙段的柜子（`plan-model.ts` 的 `usableSpan`）。不占掉的话，
  // 燃气口离墙角近时灶具位会落在让位区里，然后与隔壁那面墙的柜子撞在一起——
  // 而且是在交付前审核那一步才被拦下，客户看到的是"方案生成失败"，
  // 没有任何一版能用。让位是几何事实，找位置的时候就要知道。
  const plan = buildKitchenPlan(geometry);
  for (const rp of plan.runs) {
    const span = usableSpan(rp, "base");
    if (span.start > 0) occupy(rp.run.id, 0, span.start);
    if (span.end < rp.run.length) occupy(rp.run.id, span.end, rp.run.length - span.end);
  }

  // **拥有墙角的那一侧也要先留给转角柜**（盲角虚位 / LSB / L 形）。
  //
  // 以前只挡了让位侧：拥有侧末端空着，灶具默认「从最长墙末端往前排」就会
  // 直接坐进墙角，转角柜再排只剩 24"——BBC/LSB 都塞不进。角区先于家电。
  if (opts.modules && opts.modules.length > 0) {
    for (const k of ownerCornerKeepOuts(geometry, opts.modules, "base", plan)) {
      occupy(k.runId, k.x, k.width);
    }
  }

  // **上下水那一段要给水槽柜留着。**
  //
  // 不留的话，冰箱会大大方方压在上下水上——然后排布器发现"这段墙没有需要放
  // 水槽的子段"，整套厨房就没有水槽了，而且不报错。这类错最难发现：
  // 每一步都成功，结果是错的。
  //
  // 这块占位只用于**给家电找位置**，不进 splitIntoSegments 的 reserved——
  // 水槽柜正是要排到这里来。
  //
  // 洗碗机紧邻水槽落位，但挨左还是挨右是 generate.ts 后面才决定的事（由那时候
  // 两侧实际剩多少空决定）——这里不预判、不占位，避免两侧都留一份「可能用不上
  // 的洗碗机宽度」白白吃掉墙长（真实测过：这么留会让本来放得下的第四台家电
  // 判定放不下）。真正的修法在 generate.ts 洗碗机落位那段：挑边时避开会顶掉
  // 灶具落台区的那一侧。
  for (const run of runs) {
    const plumbing = run.features.find((f) => f.kind === "plumbing");
    if (!plumbing) continue;
    const w = Math.min(run.length, Math.max(SINK_ZONE, plumbing.width));
    const x = quantize(Math.max(0, Math.min(plumbing.offset + plumbing.width / 2 - w / 2, run.length - w)));
    push(soft, run.id, x, w); // 家电不能占，但它是台面——落台区可以延伸过去
  }

  for (const spec of appliances) {
    if (PLACED_WITH_SINK.includes(spec.kind)) continue; // 由水槽带着走
    if (spec.kind === "rangeHood") continue;            // 跟着灶台，最后处理

    const need = reservedWidth(spec);
    const name = applianceLabel(spec.kind, lang);
    const tall = TALL_APPLIANCE.has(spec.kind);
    const overlapsHere = (runId: string, x: number, width: number) =>
      overlaps(runId, x, width)
      || (tall && windowSpans(runId).some((t) => x < t.x + t.width && x + width > t.x));
    const blockersHere = (runId: string) => [
      ...(hard.get(runId) ?? []),
      ...(tall ? windowSpans(runId) : []),
    ];
    const spot = findSpot(runs, spec, need, overlapsHere, blockersHere, lang, placed);
    if (!spot) {
      warnings.push({
        kind: spec.kind,
        message: msg(lang,
          `${name} needs ${need}" but no wall run can fit it` +
            ` (excluding entry openings${tall ? ", windows" : ""}, obstructions, and other appliances)`,
          `${name}需要 ${need}" 的位置，` +
            `但没有一段墙能放下（已排除出入口${tall ? "、窗洞" : ""}、障碍与其他家电占位）`),
      });
      continue;
    }
    occupy(spot.runId, spot.x, need);
    placed.push({
      spec, wallRunId: spot.runId, x: spot.x, width: need,
      layer: "base", reason: spot.reason,
    });
  }

  // 抽油烟机：吊柜层，正对灶台
  const hood = appliances.find((a) => a.kind === "rangeHood");
  if (hood) {
    const cooktop = placed.find((p) => HOOD_FOLLOWS.includes(p.spec.kind));
    if (cooktop) {
      const width = Math.max(reservedWidth(hood), cooktop.width);
      // 与灶台同中心；夹在墙内
      const run = runs.find((r) => r.id === cooktop.wallRunId)!;
      const center = cooktop.x + cooktop.width / 2;
      // 夹进**让过墙角之后**的区间：烟机比灶台宽，贴着墙角的灶台会把烟机推进让位区
      const rp = plan.runs.find((r) => r.run.id === cooktop.wallRunId);
      const span = rp ? usableSpan(rp, "wall") : { start: 0, end: run.length };
      const x = quantize(Math.max(span.start, Math.min(center - width / 2, span.end - width)));
      const cookName = applianceLabel(cooktop.spec.kind, lang);
      placed.push({
        spec: hood, wallRunId: cooktop.wallRunId, x, width,
        layer: "wall",
        reason: msg(lang,
          `Range hood on the wall layer, centered over the ${cookName}`,
          `抽油烟机在吊柜层，正对${cookName}`),
      });
    } else {
      warnings.push({
        kind: "rangeHood",
        message: msg(lang,
          "Range hood is present but no cooktop/range was placed — confirm the cooking appliance first",
          "有抽油烟机但没有排出灶台位，烟机无处安放——请先确认灶具的位置"),
      });
    }
  }

  const byRun = new Map<string, PlacedAppliance[]>();
  for (const p of placed) {
    const list = byRun.get(p.wallRunId) ?? [];
    list.push(p);
    byRun.set(p.wallRunId, list);
  }
  for (const list of byRun.values()) list.sort((a, b) => a.x - b.x);

  return { placed, warnings, byRun };
}

interface Span { x: number; width: number }
interface Spot { runId: string; x: number; reason: string }

/**
 * 给一台家电找位置。
 *
 * 三档优先级见模块注释。每一档都要**检查放不放得下**——找到了锚点但那段墙
 * 不够宽，就退到下一档，而不是硬塞。
 */
function findSpot(
  runs: readonly WallRun[],
  spec: ApplianceSpec,
  need: number,
  overlaps: (runId: string, x: number, width: number) => boolean,
  blockers: (runId: string) => readonly Span[],
  lang: UiLanguage,
  placed: readonly PlacedAppliance[],
): Spot | undefined {
  // landingOk 只检查**这台新家电自己**的落台区够不够——它不知道旁边那个
  // 已经落位、自己也有落台区要求的家电（比如灶具）。一台对落台区要求宽松的
  // 家电（比如 wallOven 的 secondary=0）完全可能贴着灶具落位，自己的检查
  // 全过，却把灶具原本满足的落台区顶没了——这正是「排布器把方案排出来，
  // 又被自己的检查器否掉」那类 bug，只是这次是家电挤家电，不是家电挤水槽。
  // 所以候选位置还要反过来验证：加上这台新家电当 blocker 之后，
  // 之前已经落位、且有落台区要求的家电是否仍然满足自己的要求。
  const fits = (run: WallRun, x: number) => {
    if (x < 0 || x + need > run.length) return false;
    if (overlaps(run.id, x, need)) return false;
    const blockersHere = blockers(run.id);
    if (!landingOk(run, x, need, spec.kind, blockersHere)) return false;
    const withThis = [...blockersHere, { x, width: need }];
    for (const p of placed) {
      if (p.wallRunId !== run.id || !LANDING[p.spec.kind]) continue;
      if (!landingOk(run, p.x, p.width, p.spec.kind, withThis)) return false;
    }
    return true;
  };
  const name = applianceLabel(spec.kind, lang);

  // ① 户型上的对应特征——现场事实，压过偏好
  const anchorKind = ANCHOR_FEATURE[spec.kind];
  if (anchorKind) {
    for (const run of runs) {
      const f = run.features.find((x) => x.kind === anchorKind);
      if (!f) continue;
      const x = quantize(Math.max(0, Math.min(f.offset - need / 2, run.length - need)));
      if (fits(run, x)) {
        const utility = anchorKind === "gas"
          ? msg(lang, "a gas line", "燃气口")
          : msg(lang, "a hardwired outlet", "强电位");
        return {
          runId: run.id, x,
          reason: msg(lang,
            `${run.label} has ${utility}; ${name} follows the site utility`,
            `${run.label}上有${utility}，${name}按现场管线落位`),
        };
      }
    }
  }

  // ② 客户说的位置偏好
  const zone = spec.preferredZone;
  if (zone === "nearSink" || zone === "nearWindow") {
    const target: WallFeature["kind"] = zone === "nearSink" ? "plumbing" : "window";
    for (const run of runs) {
      const f = run.features.find((x) => x.kind === target);
      if (!f) continue;
      // 挨着放，不压在特征上——水槽/窗那块地方另有用处
      for (const x of [quantize(f.offset + f.width), quantize(f.offset - need)]) {
        if (fits(run, x)) {
          const near = zone === "nearSink"
            ? msg(lang, "the sink", "水槽")
            : msg(lang, "the window", "窗户");
          return {
            runId: run.id, x,
            reason: msg(lang,
              `Placed per your preference near ${near}`,
              `按你说的「靠近${near}」落位`),
          };
        }
      }
    }
  }
  if (zone === "nearEntry") {
    const first = runs[0]!;
    if (fits(first, 0)) {
      return {
        runId: first.id, x: 0,
        reason: msg(lang,
          "Placed at the start of the first wall run per your “near entry” preference",
          "按你说的「靠近入口」放在第一段墙的起点"),
      };
    }
  }

  // ③ 默认：从最宽裕的墙开始，找第一个**两侧台面都够**的位置。
  //
  // 注意不是"贴墙角放"——贴墙角一侧台面为 0，随后就会被人体工程检查否掉。
  // 靠墙的那一侧留出所需的落台区，本身就是最省地方的合法位置。
  //
  // 灶具额外：不要贴着内墙角让位区外侧落——那会看起来像「灶坐在转角上」，
  // 且开门/转角柜会打架。让位区已在 hard blockers 里；这里再加一段 keep-out。
  const req = LANDING[spec.kind];
  const startAt = req ? req.secondary : 0;
  const cornerKeepOut = (spec.kind === "range" || spec.kind === "cooktop") ? 24 : 0;
  const longest = [...runs].sort((a, b) => b.length - a.length);

  for (const run of longest) {
    // 先试贴着"最小合法边距"的两头——那是对整条台面打断最少的位置
    const candidates = [
      quantize(Math.max(startAt, cornerKeepOut)),
      quantize(run.length - need - Math.max(startAt, cornerKeepOut)),
      quantize(run.length - need - startAt),
      quantize(startAt),
    ];
    for (const x of candidates) {
      if (fits(run, x)) {
        return {
          runId: run.id, x,
          reason: req
            ? msg(lang,
              `Placed near the end of ${run.label}, leaving required landing on both sides`,
              `放在${run.label}靠边处，同时给两侧留出所需的台面`)
            : msg(lang,
              `Placed on ${run.label} (the roomiest run)`,
              `放在${run.label}上（这段墙最宽裕）`),
        };
      }
    }
    // 两头都不行就整段扫一遍（跳过贴转角 keep-out）
    for (let probe = cornerKeepOut; probe + need <= run.length - cornerKeepOut; probe = quantize(probe + 3)) {
      if (fits(run, probe)) {
        return {
          runId: run.id, x: probe,
          reason: msg(lang,
            `Placed in the remaining gap on ${run.label}`,
            `放在${run.label}上剩余的空当里`),
        };
      }
    }
  }
  return undefined;
}
