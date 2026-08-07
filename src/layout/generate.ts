/**
 * 方案自动生成 —— FR-4、场景 D 第 3 点。
 *
 * 流程（全部确定性，无 AI）：
 *   1. 在每段墙上先划出**家电留空**（冰箱/灶具/洗碗机，规范文档第七节的净空要求）；
 *   2. 水槽柜优先**对齐窗中心**（有窗时），否则落在上下水位置；
 *   3. 洗碗机紧邻水槽（NKBA 要求 ≤36"）；
 *   4. 灶具/水槽两侧优先放**抽屉柜**（锅具与餐具的常用位置）；
 *   5. 剩余段用 pack.ts 装箱——目标函数含宽度节奏与窄柜惩罚，不只是填满；
 *   6. 吊柜层同理，但避开窗户，且**柜缝对齐地柜**。
 *
 * 三类约束分工明确：
 *   - **硬约束**（人体工程与安全）→ `ergonomics.ts`，违反即否决，不参与权衡；
 *   - **软约束**（美观）→ `aesthetics.ts`，进目标函数；
 *   - **成本**（柜数、浪费）→ `pack.ts` 的代价项。
 *
 * 只使用该公司 published 规格里**真实存在**的型号与离散尺寸（FR-4、FR-8）。
 */
import type { ModuleSpec, ModuleType } from "../domain/types.js";
import type { ParsedGeometry, WallFeature, WallRun } from "../floorplan/types.js";
import { quantize } from "../floorplan/types.js";
import { allocateFillers, packSegment, type PackCandidate } from "./pack.js";
import {
  checkErgonomics, checkWorkTriangle, hasBlockingViolation,
  type ErgonomicViolation, type TrianglePoint, CLEARANCE,
} from "./ergonomics.js";
import { compareCandidates, scoreAesthetics, type AestheticScore } from "./aesthetics.js";
import { capabilitiesFor, hasRole } from "../spec/capabilities.js";
import { planAppliances, type AppliancePlan, type PlacedAppliance } from "./appliance-plan.js";
import {
  APPLIANCE_LABEL, applianceFrom, reservedWidth,
  type ApplianceKind, type ApplianceSpec,
} from "../floorplan/appliances.js";

/**
 * 北美标准家电净空（规范文档第七节）。
 *
 * ⚠️ 这些**只是**洗碗机这类"由排布过程带着走、客户没单独声明"的家电的兜底宽度。
 * 客户声明过的家电一律按 `ApplianceSpec` 的实际尺寸 + 通风间隙留空
 * （`reservedWidth`）——写死常数会让 33" 的冰箱浪费 3"、36" 的对开门装不进去。
 */
export const APPLIANCE_CLEARANCE = {
  refrigerator: 36,
  range: 30,
  dishwasher: 24,
} as const;

/**
 * 没有家电信息时的兜底。
 *
 * 一律标 `provenance: "assumed"`，好让下游如实告诉客户「这是按常见尺寸猜的」
 * （FR-3.2）。以前这里是两个字符串，猜了也不留痕。
 */
const DEFAULT_APPLIANCES: readonly ApplianceSpec[] = [
  applianceFrom({ kind: "refrigerator" }),
  applianceFrom({ kind: "range" }),
];

/** 宽度写成可读的样子，用于图上的家电标签。 */
function formatWidth(inches: number): string {
  return Number.isInteger(inches) ? `${inches}"` : `${inches}"`;
}

/** 建筑高度基线（规范文档第一节，已核实自洽）。 */
export const HEIGHTS = {
  baseBox: 34.5,
  counterThickness: 1.5,
  counterTop: 36,
  toeKick: 4.5,
  backsplash: 18,
  wallBaseline: 54,
} as const;

export type PlacementKind = "cabinet" | "filler" | "appliance" | "gap";

export interface Placement {
  kind: PlacementKind;
  /** 层：地柜层 / 吊柜层 / 高柜。 */
  layer: "base" | "wall" | "tall";
  wallRunId: string;
  /** 沿墙方向的起点（英寸，从该墙起点算）。 */
  x: number;
  width: number;
  height: number;
  depth: number;
  /** cabinet 时必填，指向该公司规格里真实存在的型号。 */
  moduleId?: string;
  moduleCode?: string;
  /**
   * 该型号的脸型模板 id，**从规格库带过来**。
   *
   * 渲染时必须用这个值，不能从 SKU 码重新推导——公司可能用自有命名体系
   * （靠覆盖表映射）或在模板里显式指定过脸型，重新推导会丢掉这些信息
   * （见 RENDERING.md 第 5 节）。
   */
  faceTemplateId?: string;
  /** appliance 时标注是什么家电。 */
  applianceKind?: ApplianceKind;
  /**
   * 家电的原始规格。渲染与解释都要读它——尤其是 `provenance`：
   * 「冰箱位 33"」与「冰箱位 33"（推定）」对客户是两句话。
   */
  applianceSpec?: ApplianceSpec;
  label?: string;
}

export interface LayoutWarning {
  code: "FILLER_TOO_WIDE" | "NO_SINK_BASE" | "SEGMENT_UNFILLABLE" | "NO_WALL_CABINETS" | "APPLIANCE_NO_ROOM";
  message: string;
  wallRunId?: string;
}

export interface GeneratedLayout {
  placements: Placement[];
  warnings: LayoutWarning[];
  /** 各层用到的型号数量统计，直接可转成报价行。 */
  moduleCounts: { moduleId: string; moduleCode: string; qty: number; width: number; height: number; depth: number }[];
  /** 人体工程与安全检查结果。含 blocking 项时方案不应出图（FR-4）。 */
  ergonomics: ErgonomicViolation[];
  /** 每段墙的美观评分，便于向客户解释"为什么这么排"。 */
  aesthetics: { wallRunId: string; score: AestheticScore }[];
  /** 是否通过硬约束。 */
  acceptable: boolean;
}

export interface LayoutOptions {
  /** 天花板高度，决定吊柜高度档位。 */
  ceilingHeight?: number;
  /** 是否生成吊柜层。 */
  includeWall?: boolean;
  /**
   * 这个厨房里的家电（来自 `FloorPlan.appliances`）。
   *
   * 不传就用 `DEFAULT_APPLIANCES`（冰箱 + 灶具，标为推定值）。
   */
  appliances?: readonly ApplianceSpec[];
  /**
   * 预先算好的家电落位。
   *
   * `regenerateRun` 必须传：它只把**一段墙**交给 `generateLayout`，而家电落位
   * 是**全局**决定的（冰箱可能在另一段墙上）。不传的话，重排一段墙会让家电
   * 整体重新分配——"局部重算"就变成了"全局重排"，而且客户看不出来为什么
   * 另一面墙的冰箱不见了。
   */
  appliancePlan?: AppliancePlan;
  /** 关闭人体工程硬约束（仅用于调试/对比，正常路径不应关）。 */
  skipErgonomics?: boolean;
  /**
   * 抽屉倾向 —— 来自客户的储物偏好（`preferences/questions.ts` 的 `storage` 题）。
   *
   * 默认 `highUseOnly`：只在灶台/水槽附近优先抽屉。这个选择必须真的改变排布，
   * 而不是记下来给人看——所以它进的是装箱候选的 `preference` 项。
   */
  drawerBias?: "always" | "highUseOnly" | "never";
}

/**
 * 按天花板高度选吊柜高度（规范文档第一节的匹配表）。
 *
 * 规则：**取仍能留出 6" 顶线空间的最高档位**。吊柜顶边 = 54 + h。
 *   96"  层高 → 42"（顶边 96）放不下顶线，取 36"（顶边 90，留 6" 贴标准顶线）
 *   102" 层高 → 42"（顶边 96，留 6"）
 *   108" 层高 → 42"（顶边 96，留 12"，或做双层叠装通顶）
 * 规范表里 96" 层高同时列了 30" 与 36" 两种做法，这里取储物量更大的 36"。
 */
export function pickWallCabinetHeight(ceilingHeight: number | undefined, available: number[]): number | undefined {
  const sorted = [...available].sort((a, b) => b - a);
  if (!ceilingHeight) return sorted.find((h) => h === 30) ?? sorted[sorted.length - 1];
  const budget = ceilingHeight - HEIGHTS.wallBaseline;
  const CROWN_ALLOWANCE = 6;
  return sorted.find((h) => h <= budget - CROWN_ALLOWANCE) ?? sorted.find((h) => h <= budget) ?? sorted[sorted.length - 1];
}

interface Segment {
  start: number;
  length: number;
  /** 该段是否必须放水槽柜。 */
  requiresSink: boolean;
  /** 该段起点/终点是否就是整面墙的两头。 */
  atRunStart: boolean;
  atRunEnd: boolean;
  /**
   * 这一头能不能放填缝条。
   *
   * 原来的规则是「填缝条只放墙角」，理由是夹在柜子中间会打断门缝节奏。
   * 但**紧挨家电的那一头也是合法的填缝位**：那里的门缝节奏本来就被家电打断了，
   * 再多一条 1" 的填缝条不会更难看。
   *
   * 不放开这一条的话，夹在冰箱与灶台之间的那段墙**一条填缝条都放不了**——
   * 装箱剩下的 1" 就成了一个真实的缝，台面连续性被打断，随后人体工程检查
   * 会判「灶具左侧落台区 0"」。方案被自己的检查器否掉，而根因在几十行之外。
   */
  fillerAtStart: boolean;
  fillerAtEnd: boolean;
}

export type ReservedKind = ApplianceKind | "door" | "obstruction";

export interface ReservedSpan {
  x: number;
  width: number;
  kind: ReservedKind;
  /** 家电时带上原始规格——下游要读 provenance 与实际宽度。 */
  spec?: ApplianceSpec;
  label?: string;
}

/**
 * 把一段墙按「家电留空 + 门洞 + 障碍」切成若干可放柜子的子段。
 *
 * 上下水（plumbing）不占空间，但会把它所在的子段标记为「必须放水槽柜」。
 *
 * **家电落位不在这里决定**——它是全局问题（跨墙段、跨层、互相牵制），
 * 由 `planAppliances` 先算好再传进来（见 appliance-plan.ts 的模块注释）。
 * 这个函数只负责"把已经定好的占位切成可用子段"。
 */
export function splitIntoSegments(run: WallRun, placed: readonly PlacedAppliance[] = []): {
  segments: Segment[];
  reserved: ReservedSpan[];
  warnings: LayoutWarning[];
} {
  const warnings: LayoutWarning[] = [];
  const reserved: ReservedSpan[] = [];

  // 门洞与障碍：整段不可用
  for (const f of run.features) {
    if (f.kind === "door" || f.kind === "obstruction") {
      reserved.push({ x: f.offset, width: Math.max(f.width, 1), kind: f.kind });
    }
  }

  // 地柜层的家电占位。抽油烟机在吊柜层，不占地柜的地方
  for (const p of placed) {
    if (p.layer !== "base") continue;
    reserved.push({
      x: p.x, width: p.width, kind: p.spec.kind,
      spec: p.spec, label: APPLIANCE_LABEL[p.spec.kind],
    });
  }

  reserved.sort((a, b) => a.x - b.x);

  // 由 reserved 切出可用子段。
  // 每一段的两头要么是墙角，要么紧挨一个占位（家电/门洞）——两种都能放填缝条。
  const segments: Segment[] = [];
  let cursor = 0;
  for (const r of reserved) {
    if (r.x > cursor) {
      segments.push({
        start: cursor, length: quantize(r.x - cursor),
        requiresSink: false, atRunStart: cursor === 0, atRunEnd: false,
        fillerAtStart: true, fillerAtEnd: true,
      });
    }
    cursor = Math.max(cursor, quantize(r.x + r.width));
  }
  if (cursor < run.length) {
    segments.push({
      start: cursor, length: quantize(run.length - cursor),
      requiresSink: false, atRunStart: cursor === 0, atRunEnd: true,
      fillerAtStart: true, fillerAtEnd: true,
    });
  }

  // 标记水槽段
  const plumbing = run.features.find((f) => f.kind === "plumbing");
  if (plumbing) {
    const seg = segments.find((s) => plumbing.offset >= s.start && plumbing.offset <= s.start + s.length);
    if (seg) seg.requiresSink = true;
  }

  return { segments: segments.filter((s) => s.length > 0), reserved, warnings };
}

/**
 * 有明确功能的窄柜——即使窄也不该被当成"凑数"惩罚。
 *
 * 判据是**能力**（开放格/酒格/抽拉件这类本来就窄的功能件），不是型号码前缀。
 * 前缀判断在第二家公司（`NW-` 命名）上一个也命不中，于是"功能性窄柜不罚分"
 * 这条规则在那家公司上静默失效——见 spec/capabilities.ts 的模块注释。
 */
function isFunctionalNarrow(m: ModuleSpec): boolean {
  const roles = capabilitiesFor(m).capabilities.roles;
  return roles.includes("openDisplay") || roles.includes("applianceHousing");
}

/**
 * 配套柜不参与通用装箱。
 *
 * 冰箱上柜的 `type` 也是 `wall`，但它是 24" 深、15" 高的一块专用件——
 * 当成普通吊柜排到别处去，正视图上会突兀地凸出一块，报价单上还会多算几个。
 * 它只在**它配套的那台家电**上方出现，由 `planApplianceCabinets` 单独排。
 */
function isDedicatedFitting(m: ModuleSpec): boolean {
  return capabilitiesFor(m).capabilities.servesAppliance !== undefined;
}

/** 从规格库里挑出某类柜体的宽度候选。 */
function candidatesFor(modules: readonly ModuleSpec[], types: ModuleType[]): PackCandidate[] {
  const out: PackCandidate[] = [];
  for (const m of modules) {
    if (!types.includes(m.type) || isDedicatedFitting(m)) continue;
    const functional = isFunctionalNarrow(m);
    for (const w of m.widthOptions) {
      out.push({
        width: w,
        // 常用宽度（30/36）偏好更高
        preference: w >= 30 ? 0 : w >= 21 ? 1 : 2,
        ...(functional ? { functionalNarrow: true } : {}),
      });
    }
  }
  const byWidth = new Map<number, PackCandidate>();
  for (const c of out) {
    const cur = byWidth.get(c.width);
    if (!cur || (c.preference ?? 0) < (cur.preference ?? 0)) byWidth.set(c.width, c);
  }
  return [...byWidth.values()].sort((a, b) => b.width - a.width);
}

/**
 * 选型号。
 *
 * `preferDrawers` 为真时优先选抽屉柜——灶台旁放锅具、水槽旁放餐具，
 * 是厨房里最高频的取放动作。同宽度下抽屉柜贵 20-30%，但便利性提升明显
 * （规范文档「替代逻辑」第五节把它称为"免费升级/溢价升级"的替代选项）。
 */
function pickModule(
  modules: readonly ModuleSpec[],
  types: ModuleType[],
  width: number,
  preferDrawers = false,
): ModuleSpec | undefined {
  const matches = modules.filter(
    (m) => types.includes(m.type) && m.widthOptions.includes(width) && !isDedicatedFitting(m));
  if (matches.length === 0) return undefined;
  // 「是不是抽屉柜」问能力，不问型号码——见 spec/capabilities.ts
  const isDrawer = (m: ModuleSpec) => hasRole(m, "drawerStorage") && !hasRole(m, "doorStorage");
  if (preferDrawers) {
    const drawer = matches.find(isDrawer);
    if (drawer) return drawer;
  }
  // 否则优先非抽屉柜（更便宜），避免全屋都上抽屉柜推高造价
  return matches.find((m) => !isDrawer(m)) ?? matches[0];
}

/** 该位置是否紧邻灶具或水槽——决定要不要优先用抽屉柜。 */
function isHighUseZone(
  x: number,
  width: number,
  anchors: readonly { start: number; end: number }[],
): boolean {
  const ZONE = 24; // 紧邻 = 两侧各 24" 内
  return anchors.some((a) => x < a.end + ZONE && x + width > a.start - ZONE);
}

/** 该公司有抽屉柜的宽度集合。同样按能力挑，不按型号码。 */
function drawerWidths(modules: readonly ModuleSpec[]): Set<number> {
  const out = new Set<number>();
  for (const m of modules) {
    if (m.type !== "base") continue;
    if (!hasRole(m, "drawerStorage") || hasRole(m, "doorStorage")) continue;
    for (const w of m.widthOptions) out.add(w);
  }
  return out;
}

/**
 * 高频区的候选宽度偏好调整。
 *
 * 光在**选型**阶段挑抽屉柜是不够的——如果装箱先定下 21"，而这家公司的抽屉柜只有
 * 24"/30"，那再怎么挑也挑不出抽屉柜。所以偏好必须进**装箱**阶段。
 */
function biasTowardDrawers(
  candidates: readonly PackCandidate[],
  drawerCapable: ReadonlySet<number>,
): PackCandidate[] {
  if (drawerCapable.size === 0) return [...candidates];
  const NON_DRAWER_PENALTY = 3;
  return candidates.map((c) => ({
    ...c,
    preference: (c.preference ?? 0) + (drawerCapable.has(c.width) ? 0 : NON_DRAWER_PENALTY),
  }));
}

/**
 * 生成一版完整方案。
 *
 * 只使用 `modules` 里真实存在的型号与离散尺寸——这是 FR-8 校验能通过的前提。
 */
export function generateLayout(
  geometry: ParsedGeometry,
  modules: readonly ModuleSpec[],
  opts: LayoutOptions = {},
): GeneratedLayout {
  const placements: Placement[] = [];
  const warnings: LayoutWarning[] = [];
  // 家电落位**先于分层**统一决定——烟机在吊柜层，位置却由地柜层的灶台定
  const appliances = opts.appliances ?? DEFAULT_APPLIANCES;
  const appliancePlan = opts.appliancePlan ?? planAppliances(geometry, appliances);
  for (const w of appliancePlan.warnings) {
    warnings.push({ code: "APPLIANCE_NO_ROOM", message: w.message });
  }
  const drawerBias = opts.drawerBias ?? "highUseOnly";

  const baseCandidates = candidatesFor(modules, ["base"]);
  // 水槽柜按能力挑：有的商家把水槽柜归在 base 类里，只靠 type 会漏
  const sinkModules = modules.filter((m) => hasRole(m, "sinkBase"));
  const wallCandidates = candidatesFor(modules, ["wall"]);
  const wallHeights = [...new Set(modules.filter((m) => m.type === "wall").flatMap((m) => m.heightOptions))];
  const wallHeight = pickWallCabinetHeight(opts.ceilingHeight, wallHeights);

  for (const run of geometry.wallRuns) {
    if (run.length <= 0) continue;
    const forThisRun = appliancePlan.byRun.get(run.id) ?? [];
    const { segments, reserved, warnings: segWarnings } = splitIntoSegments(run, forThisRun);
    warnings.push(...segWarnings);

    for (const r of reserved) {
      if (r.kind === "door" || r.kind === "obstruction") continue;
      // 嵌入式灶台**下面有柜子**——它是掉进台面的一个洞，不是一段没有柜子的空当。
      // 那个柜子由 planApplianceCabinets 排（它有特殊要求：上层抽屉要避让灶体），
      // 这里跳过，免得同一段墙上既有"灶台位"又有"灶下柜"，两者叠在一起。
      if (r.kind === "cooktop") continue;
      placements.push({
        kind: "appliance", layer: "base", wallRunId: run.id,
        x: r.x, width: r.width, height: HEIGHTS.baseBox, depth: 24,
        applianceKind: r.kind,
        // 标签带上实际宽度——图上要能看出"这是 33 寸的冰箱位"（FR-5.2）
        label: `${r.label ?? APPLIANCE_LABEL[r.kind]}位 ${formatWidth(r.spec?.width ?? r.width)}`,
        ...(r.spec ? { applianceSpec: r.spec } : {}),
      });
    }

    // 吊柜层的家电（抽油烟机）：位置由地柜层的灶台决定，这里直接落位
    for (const p of forThisRun) {
      if (p.layer !== "wall") continue;
      placements.push({
        kind: "appliance", layer: "wall", wallRunId: run.id,
        x: p.x, width: p.width, height: wallHeight ?? 30, depth: 12,
        applianceKind: p.spec.kind,
        label: `${APPLIANCE_LABEL[p.spec.kind]}位 ${formatWidth(p.spec.width)}`,
        applianceSpec: p.spec,
      });
    }

    // 高频取放区：灶具与水槽两侧优先用抽屉柜
    const highUseAnchors: { start: number; end: number }[] = reserved
      .filter((r) => r.kind === "range")
      .map((r) => ({ start: r.x, end: r.x + r.width }));

    // ── 地柜层 ──
    for (const seg of segments) {
      let cursor = seg.start;
      let remaining = seg.length;

      // 水槽柜优先落位，且**尽量对齐窗中心**——水槽在窗下是厨房的默认做法，
      // 偏出去几英寸在正视图上会很明显（aesthetics 的 symmetry 项）
      if (seg.requiresSink) {
        const sink = sinkModules
          .flatMap((m) => m.widthOptions.map((w) => ({ m, w })))
          .filter(({ w }) => w <= remaining)
          .sort((a, b) => b.w - a.w)[0];

        if (sink) {
          const window = run.features.find((f) => f.kind === "window");
          const desiredCenter = window
            ? window.offset + window.width / 2
            : (run.features.find((f) => f.kind === "plumbing")?.offset ?? cursor + sink.w / 2);
          // 夹在本段范围内 ——**再夹进人体工程可行区间**。
          //
          // 「水槽对准窗」是软性偏好（aesthetics 的 symmetry 项），「水槽两侧要留出
          // 足够的操作台面」是硬性约束（NKBA，见 ergonomics.ts）。窗靠墙角时这两条
          // 会打架：把水槽推到窗中心就意味着一侧台面为 0。
          //
          // 之前只夹了墙段边界，于是生成器会排出一个**它自己随后就会判为不合格**的方案：
          // 客户看到图，点报价，被 409 拒掉，却没有任何一版能用。硬约束在排布阶段就要
          // 参与决策，而不是只在事后打分——否则等于用检查器代替设计。
          const room = seg.length - sink.w;
          const [lo, hi] = room >= CLEARANCE.sinkLandingPrimary + CLEARANCE.sinkLandingSecondary
            // 两侧各留够：左侧取 [secondary, room-secondary]，此时较宽一侧必 ≥primary
            ? [seg.start + CLEARANCE.sinkLandingSecondary, seg.start + room - CLEARANCE.sinkLandingSecondary]
            // 这面墙本来就摆不下合格的水槽区——不假装能解决，交给检查器如实报出来
            : [seg.start, seg.start + room];
          const sinkX = quantize(Math.max(lo, Math.min(desiredCenter - sink.w / 2, hi)));

          placements.push({
            kind: "cabinet", layer: "base", wallRunId: run.id,
            x: sinkX, width: sink.w, height: HEIGHTS.baseBox, depth: sink.m.depthOptions[0] ?? 24,
            moduleId: sink.m.id, moduleCode: sink.m.code, faceTemplateId: sink.m.faceTemplateId,
            label: "sink",
          });
          highUseAnchors.push({ start: sinkX, end: sinkX + sink.w });

          // 洗碗机紧邻水槽（NKBA：距水槽最近边 ≤36"）
          const dishwasher = appliances.find((a) => a.kind === "dishwasher");
          if (dishwasher) {
            // 洗碗机由水槽带着走（NKBA 要求紧邻），所以它的位置不在
            // planAppliances 里定，但**宽度按客户给的算**
            const dwWidth = reservedWidth(dishwasher);
            const leftRoom = sinkX - seg.start;
            const rightRoom = seg.start + seg.length - (sinkX + sink.w);
            const dwX = leftRoom >= dwWidth
              ? quantize(sinkX - dwWidth)
              : rightRoom >= dwWidth ? quantize(sinkX + sink.w) : undefined;
            if (dwX !== undefined) {
              placements.push({
                kind: "appliance", layer: "base", wallRunId: run.id,
                x: dwX, width: dwWidth, height: HEIGHTS.baseBox, depth: 24,
                applianceKind: "dishwasher", label: "洗碗机位",
              });
            } else {
              warnings.push({
                code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
                message: `${run.label} 水槽两侧都放不下 ${dwWidth}" 的洗碗机`,
              });
            }
          }

          // 水槽（含洗碗机）左右两段分别装箱，保证水槽居中不被挤走
          const occupied = placements
            .filter((p) => p.wallRunId === run.id && p.layer === "base"
              && p.x >= seg.start - 0.01 && p.x + p.width <= seg.start + seg.length + 0.01)
            .sort((a, b) => a.x - b.x);
          const subSegments: { start: number; length: number; atStart: boolean; atEnd: boolean }[] = [];
          let sc = seg.start;
          for (const o of occupied) {
            // 子段的两头要么是本段边界、要么紧挨水槽柜/洗碗机——都能放填缝条
            if (o.x > sc) {
              subSegments.push({
                start: sc, length: quantize(o.x - sc),
                atStart: sc !== seg.start || seg.fillerAtStart, atEnd: true,
              });
            }
            sc = Math.max(sc, quantize(o.x + o.width));
          }
          if (sc < seg.start + seg.length) {
            subSegments.push({
              start: sc, length: quantize(seg.start + seg.length - sc),
              atStart: sc !== seg.start || seg.fillerAtStart, atEnd: seg.fillerAtEnd,
            });
          }
          for (const sub of subSegments) {
            fillBaseSegment(sub, run, modules, baseCandidates, highUseAnchors,
              placements, warnings, drawerBias);
          }
          continue; // 本段已处理完
        }

        warnings.push({
          code: "NO_SINK_BASE", wallRunId: run.id,
          message: `${run.label} 有上下水但这家公司没有宽度 ≤ ${remaining}" 的水槽柜`,
        });
      }

      fillBaseSegment(
        { start: cursor, length: remaining, atStart: seg.fillerAtStart, atEnd: seg.fillerAtEnd },
        run, modules, baseCandidates, highUseAnchors, placements, warnings, drawerBias,
      );
    }

    // ── 家电配套柜 ──
    //
    // **先于吊柜装箱算好**：冰箱上柜可能比冰箱位本身宽（36" 的柜盖 35" 的冰箱位），
    // 只按冰箱宽度留空的话，上柜会与旁边的普通吊柜叠在一起。
    // 它要占多宽，就得先算出来再让开。
    const serving = planApplianceCabinets(run, forThisRun, modules, {
      includeWall: opts.includeWall !== false,
    });
    warnings.push(...serving.warnings);
    placements.push(...serving.placements);

    // ── 吊柜层 ──
    if (opts.includeWall !== false && wallHeight !== undefined && wallCandidates.length > 0) {
      // 窗户位置不放吊柜；**吊柜层的家电（抽油烟机）也占位**——
      // 不排除的话会在烟机正上方排一个普通吊柜，两者物理上打架
      const blockers = [
        ...run.features
          .filter((f) => f.kind === "window" || f.kind === "door" || f.kind === "obstruction")
          .map((f) => ({ x: f.offset, width: Math.max(f.width, 1) })),
        ...forThisRun
          .filter((p) => p.layer === "wall")
          .map((p) => ({ x: p.x, width: p.width })),
        // 配套柜（冰箱上柜等）已经占好的位置——按**它实际的宽度**让开，
        // 而不是按家电本身的宽度。只挡吊柜层的那些：灶下柜在地柜层，
        // 它上方本来就该有吊柜（或烟机）。
        ...serving.placements
          .filter((p) => p.layer !== "base")
          .map((p) => ({ x: p.x, width: p.width })),
      ].sort((a, b) => a.x - b.x);

      const wallSegments: { start: number; length: number }[] = [];
      let c = 0;
      for (const b of blockers) {
        if (b.x > c) wallSegments.push({ start: c, length: quantize(b.x - c) });
        c = Math.max(c, quantize(b.x + b.width));
      }
      if (c < run.length) wallSegments.push({ start: c, length: quantize(run.length - c) });

      // 地柜的柜缝位置——吊柜尽量对齐，正视图上上下分隔线成一条线才整齐
      const baseSeams = placements
        .filter((p) => p.wallRunId === run.id && p.layer === "base" && p.kind !== "appliance")
        .sort((a, b) => a.x - b.x)
        .map((p) => p.x + p.width);

      for (const seg of wallSegments) {
        if (seg.length < Math.min(...wallCandidates.map((x) => x.width))) continue;
        const packed = packSegment(seg.length, wallCandidates, {
          preferredSeams: baseSeams.map((abs) => abs - seg.start).filter((rel) => rel > 0 && rel < seg.length),
        });
        let cursor = seg.start;
        for (const w of packed.widths) {
          const mod = pickModule(modules, ["wall"], w);
          if (!mod) continue;
          const h = mod.heightOptions.includes(wallHeight) ? wallHeight : mod.heightOptions[0]!;
          placements.push({
            kind: "cabinet", layer: "wall", wallRunId: run.id,
            x: cursor, width: w, height: h, depth: mod.depthOptions[0] ?? 12,
            moduleId: mod.id, moduleCode: mod.code, faceTemplateId: mod.faceTemplateId,
          });
          cursor = quantize(cursor + w);
        }
        if (packed.leftover > 0) {
          placements.push({
            kind: "filler", layer: "wall", wallRunId: run.id,
            x: cursor, width: packed.leftover, height: wallHeight, depth: 12, label: "填缝条",
          });
        }
      }
    } else if (opts.includeWall !== false && wallCandidates.length === 0) {
      warnings.push({ code: "NO_WALL_CABINETS", message: "这家公司规格库里没有吊柜型号" });
    }
  }

  // ── 硬约束与美观评分 ──
  const ergonomics: ErgonomicViolation[] = [];
  const aesthetics: { wallRunId: string; score: AestheticScore }[] = [];
  if (!opts.skipErgonomics) {
    for (const run of geometry.wallRuns) {
      if (run.length <= 0) continue;
      ergonomics.push(...checkErgonomics({
        run, placements, hasDishwasher: appliances.some((a) => a.kind === "dishwasher"),
      }));
    }
    ergonomics.push(...checkWorkTriangle(trianglePoints(geometry, placements)));
  }
  for (const run of geometry.wallRuns) {
    if (run.length <= 0) continue;
    aesthetics.push({ wallRunId: run.id, score: scoreAesthetics({ run, placements }) });
  }

  return {
    placements,
    warnings,
    moduleCounts: countModules(placements),
    ergonomics,
    aesthetics,
    acceptable: !hasBlockingViolation(ergonomics),
  };
}

/**
 * 填充一个子段。
 *
 * 抽出来是因为水槽段会被切成左右两半分别填——水槽要居中，不能被装箱算法挤走。
 */
function fillBaseSegment(
  seg: { start: number; length: number; atStart: boolean; atEnd: boolean },
  run: WallRun,
  modules: readonly ModuleSpec[],
  candidates: readonly PackCandidate[],
  highUseAnchors: readonly { start: number; end: number }[],
  placements: Placement[],
  warnings: LayoutWarning[],
  drawerBias: "always" | "highUseOnly" | "never" = "highUseOnly",
): void {
  if (seg.length <= 0) return;

  // 装箱阶段就偏向有抽屉柜的宽度。`always` 全段偏向，`highUseOnly` 只在灶台/水槽附近，
  // `never` 完全不偏（客户明确选了以门板柜为主）。
  const wantDrawers = drawerBias === "always"
    || (drawerBias === "highUseOnly" && isHighUseZone(seg.start, seg.length, highUseAnchors));
  const segCandidates = wantDrawers
    ? biasTowardDrawers(candidates, drawerWidths(modules))
    : candidates;

  const packed = packSegment(seg.length, segCandidates);
  if (!packed.feasible && packed.widths.length === 0) {
    warnings.push({
      code: "SEGMENT_UNFILLABLE", wallRunId: run.id,
      message: `${run.label} 的 ${seg.length}" 段无法用现有型号填充：${packed.reason ?? ""}`,
    });
    return;
  }

  const fillers = allocateFillers(packed.leftover, { atStart: seg.atStart, atEnd: seg.atEnd });
  if (!fillers.feasible && packed.leftover > 0) {
    warnings.push({
      code: "FILLER_TOO_WIDE", wallRunId: run.id,
      message: `${run.label} 剩余 ${packed.leftover}"，超出填缝条能吸收的范围，建议调整家电位置`,
    });
  }

  let cursor = seg.start;
  if (fillers.start > 0) {
    placements.push({
      kind: "filler", layer: "base", wallRunId: run.id,
      x: cursor, width: fillers.start, height: HEIGHTS.baseBox, depth: 24, label: "填缝条",
    });
    cursor = quantize(cursor + fillers.start);
  }

  for (const w of packed.widths) {
    // 灶台/水槽两侧优先抽屉柜——放锅具与餐具的常用位置
    const preferDrawers = drawerBias === "always"
      || (drawerBias === "highUseOnly" && isHighUseZone(cursor, w, highUseAnchors));
    const mod = pickModule(modules, ["base"], w, preferDrawers);
    if (!mod) continue;
    placements.push({
      kind: "cabinet", layer: "base", wallRunId: run.id,
      x: cursor, width: w, height: HEIGHTS.baseBox, depth: mod.depthOptions[0] ?? 24,
      moduleId: mod.id, moduleCode: mod.code, faceTemplateId: mod.faceTemplateId,
    });
    cursor = quantize(cursor + w);
  }

  if (fillers.end > 0) {
    placements.push({
      kind: "filler", layer: "base", wallRunId: run.id,
      x: cursor, width: fillers.end, height: HEIGHTS.baseBox, depth: 24, label: "填缝条",
    });
  }
}

/**
 * 把「沿墙坐标」换算成平面坐标，供工作三角计算。
 *
 * 简化模型：墙段首尾相接、依次转 90 度（一字/L/U 型厨房的常见情形）。
 */
function trianglePoints(geometry: ParsedGeometry, placements: readonly Placement[]): TrianglePoint[] {
  const points: TrianglePoint[] = [];
  let originX = 0;
  let originY = 0;
  let dirX = 1;
  let dirY = 0;

  for (const run of geometry.wallRuns) {
    const toPlane = (along: number) => ({
      x: originX + dirX * along,
      y: originY + dirY * along,
    });
    for (const p of placements.filter((q) => q.wallRunId === run.id && q.layer === "base")) {
      const center = p.x + p.width / 2;
      // 先认家电：**灶下柜可能就是一个水槽柜箱体**（假抽面、顶部开放，见
      // capabilities.ts 的 F7）。按 SB 码先判水槽的话，工作三角会出现两个水槽点、
      // 一个灶点都没有——而且不报错。
      if (p.applianceKind === "range" || p.applianceKind === "cooktop") {
        points.push({ kind: "cooktop", ...toPlane(center) });
      } else if (p.applianceKind === "refrigerator") {
        points.push({ kind: "refrigerator", ...toPlane(center) });
      }
    }
    originX += dirX * run.length;
    originY += dirY * run.length;
    // 下一段右转 90 度
    [dirX, dirY] = [-dirY, dirX];
  }
  return points;
}


function countModules(placements: readonly Placement[]) {
  const map = new Map<string, { moduleId: string; moduleCode: string; qty: number; width: number; height: number; depth: number }>();
  for (const p of placements) {
    if (p.kind !== "cabinet" || !p.moduleId) continue;
    const key = `${p.moduleId}|${p.width}|${p.height}|${p.depth}`;
    const cur = map.get(key);
    if (cur) cur.qty++;
    else map.set(key, {
      moduleId: p.moduleId, moduleCode: p.moduleCode ?? "", qty: 1,
      width: p.width, height: p.height, depth: p.depth,
    });
  }
  return [...map.values()].sort((a, b) => a.moduleCode.localeCompare(b.moduleCode));
}

/**
 * 家电配套柜 —— 家电不只是一段"不可用"的空白（APPLIANCES.md §3）。
 *
 * 真实厨房里家电周围有专门的柜子：
 *
 *   - **冰箱上柜**：比普通吊柜深（与冰箱齐平）、矮。不做的话冰箱顶上是一个
 *     积灰的空当，客户看得见。
 *   - **冰箱两侧收口板**：通高、与柜体同深。不贴的话露出白色刨花板边。
 *   - **烟机上柜**：烟机占了吊柜层，它上方那一小截仍可做柜。
 *   - **烤箱高柜**：中间开洞的通高柜，烤箱嵌进去。
 *   - **灶下柜**：嵌入式灶台是掉进台面的一个洞，**下面有柜子**——而且不能是
 *     普通抽屉柜，最上面那个抽屉会顶到灶体。
 *
 * ## 按能力查，不按型号码猜
 *
 * 找的是「`servesAppliance === "refrigerator"` 的吊柜型号」，不是
 * `code.startsWith("RFW")`——与 M5-2 同一条原则（`spec/capabilities.ts`）。
 *
 * ## 没有对应型号时**报出来**，不静默跳过
 *
 * 冰箱顶上留一个空当是客户会**看见**的真实结果。这家做不了，就让客户知道，
 * 由他决定是接受还是换一家。与 BOM 缺辅料时的处理一致（`bom.ts` 的 `missing`）。
 */
function planApplianceCabinets(
  run: WallRun,
  placed: readonly PlacedAppliance[],
  modules: readonly ModuleSpec[],
  opts: { includeWall: boolean },
): { placements: Placement[]; warnings: LayoutWarning[] } {
  const placements: Placement[] = [];
  const warnings: LayoutWarning[] = [];

  for (const p of placed) {
    const over = modules.find(
      (m) => capabilitiesFor(m).capabilities.servesAppliance === p.spec.kind);

    if (p.spec.kind === "refrigerator") {
      // 只出地柜层时不排冰箱上柜（它在吊柜层），但下面的灶下柜仍要排
      if (!opts.includeWall) continue;
      if (!over) {
        warnings.push({
          code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
          message: `这家公司没有冰箱上柜型号，${run.label}的冰箱顶部会留一个空当`,
        });
        continue;
      }
      // 宽度取该型号能覆盖冰箱位的最小档位——比冰箱窄会露出缝
      const width = [...over.widthOptions].sort((a, b) => a - b)
        .find((w) => w >= p.width);
      if (width === undefined) {
        warnings.push({
          code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
          message: `冰箱位 ${p.width}" 比这家最宽的冰箱上柜（` +
            `${Math.max(...over.widthOptions)}"）还宽，顶部盖不满`,
        });
        continue;
      }
      const x = quantize(Math.max(0, Math.min(p.x + p.width / 2 - width / 2, run.length - width)));
      placements.push({
        kind: "cabinet", layer: "wall", wallRunId: run.id,
        x, width,
        height: over.heightOptions[0] ?? 15,
        // 冰箱上柜与冰箱齐深，不是普通吊柜的 12"
        depth: over.depthOptions[0] ?? 24,
        moduleId: over.id, moduleCode: over.code,
        ...(over.faceTemplateId ? { faceTemplateId: over.faceTemplateId } : {}),
        label: "冰箱上柜",
      });
      continue;
    }

    if (p.spec.kind === "cooktop") {
      // 灶下柜：**普通三抽柜装不了**——最上面那个抽屉会顶到灶体。
      // 优先用商家声明的灶下柜；没有就退到同宽的门板柜，并说明这是替代方案。
      const fits = (m: ModuleSpec) =>
        (m.type === "base" || m.type === "sinkBase") && m.widthOptions.some((w) => w <= p.width);
      const exact = modules.find((m) => fits(m) && hasRole(m, "cooktopBase"));
      // 退而求其次：没有抽屉的门板柜。装得上，只是少一格抽屉储物
      const doorBase = modules.find(
        (m) => fits(m) && hasRole(m, "doorStorage") && !hasRole(m, "drawerStorage"));
      const mod = exact ?? doorBase;
      if (!mod) {
        warnings.push({
          code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
          message: `这家公司没有宽度 ≤${p.width}" 的灶下柜（也没有同宽的门板柜）——` +
            `嵌入式灶台下面必须有柜子，普通抽屉柜的上层抽屉会顶到灶体`,
        });
        continue;
      }
      // 取能放进这个空当的最宽一档；剩下的差额由填缝条补（下面一并排出）
      const width = [...mod.widthOptions].filter((w) => w <= p.width)
        .sort((a, b) => b - a)[0]!;
      placements.push({
        kind: "cabinet", layer: "base", wallRunId: run.id,
        x: p.x, width,
        height: mod.heightOptions[0] ?? HEIGHTS.baseBox,
        depth: mod.depthOptions[0] ?? 24,
        moduleId: mod.id, moduleCode: mod.code,
        ...(mod.faceTemplateId ? { faceTemplateId: mod.faceTemplateId } : {}),
        applianceKind: "cooktop",
        applianceSpec: p.spec,
        label: `灶下柜（台面开孔 ${formatWidth(p.spec.width)}）`,
      });
      if (width < p.width) {
        placements.push({
          kind: "filler", layer: "base", wallRunId: run.id,
          x: quantize(p.x + width), width: quantize(p.width - width),
          height: HEIGHTS.baseBox, depth: 24, label: "填缝条",
        });
      }
      if (!exact) {
        warnings.push({
          code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
          message: `这家公司没有专门的灶下柜型号，${run.label}的灶台下面用 ${mod.code} ` +
            `（门板柜）代替——能装，但抽屉储物会少一格`,
        });
      }
      continue;
    }

    if (p.spec.kind === "wallOven" && over) {
      if (!opts.includeWall) continue; // 通高柜要占到吊柜层
      // 烤箱高柜：通高，占地柜层到吊柜层的整段
      const width = [...over.widthOptions].sort((a, b) => a - b)
        .find((w) => w >= p.width) ?? over.widthOptions[0];
      if (width === undefined) continue;
      const x = quantize(Math.max(0, Math.min(p.x + p.width / 2 - width / 2, run.length - width)));
      placements.push({
        kind: "cabinet", layer: "tall", wallRunId: run.id,
        x, width,
        height: over.heightOptions[0] ?? 84,
        depth: over.depthOptions[0] ?? 24,
        moduleId: over.id, moduleCode: over.code,
        ...(over.faceTemplateId ? { faceTemplateId: over.faceTemplateId } : {}),
        label: "烤箱高柜",
      });
      continue;
    }
    if (p.spec.kind === "wallOven" && !over) {
      warnings.push({
        code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
        message: "这家公司没有烤箱高柜型号，独立烤箱没有地方嵌装",
      });
    }
  }
  return { placements, warnings };
}

/**
 * 局部重新生成 —— 场景 D 第 4 点：「系统重新计算受影响的那部分，不是每次全部推倒重来」。
 *
 * 只重算指定墙段，其余墙段的摆放原样保留。
 */
export function regenerateRun(
  current: GeneratedLayout,
  geometry: ParsedGeometry,
  modules: readonly ModuleSpec[],
  wallRunId: string,
  opts: LayoutOptions = {},
): GeneratedLayout {
  const run = geometry.wallRuns.find((r) => r.id === wallRunId);
  if (!run) return current;

  const untouched = current.placements.filter((p) => p.wallRunId !== wallRunId);
  // 家电落位按**完整户型**算一次再传进去——只把一段墙交给 generateLayout
  // 会让它以为整个厨房只有这一面墙，冰箱就跑过来了
  const appliancePlan = opts.appliancePlan
    ?? planAppliances(geometry, opts.appliances ?? DEFAULT_APPLIANCES);
  const regenerated = generateLayout(
    { ...geometry, wallRuns: [run] }, modules, { ...opts, appliancePlan },
  );
  const placements = [...untouched, ...regenerated.placements];
  // 硬约束与美观分要按合并后的整体重算——只重排一段墙也可能破坏工作三角
  const ergonomics: ErgonomicViolation[] = [];
  const aesthetics: { wallRunId: string; score: AestheticScore }[] = [];
  if (!opts.skipErgonomics) {
    for (const r of geometry.wallRuns) {
      if (r.length <= 0) continue;
      ergonomics.push(...checkErgonomics({
        run: r, placements,
        hasDishwasher: (opts.appliances ?? []).some((a) => a.kind === "dishwasher"),
      }));
    }
    ergonomics.push(...checkWorkTriangle(trianglePoints(geometry, placements)));
  }
  for (const r of geometry.wallRuns) {
    if (r.length <= 0) continue;
    aesthetics.push({ wallRunId: r.id, score: scoreAesthetics({ run: r, placements }) });
  }

  return {
    placements,
    warnings: [
      ...current.warnings.filter((w) => w.wallRunId !== wallRunId),
      ...regenerated.warnings,
    ],
    moduleCounts: countModules(placements),
    ergonomics,
    aesthetics,
    acceptable: !hasBlockingViolation(ergonomics),
  };
}

/** 把方案转成报价所需的「选择」列表（FR-8 只接受这种结构）。 */
export function toSelections(
  layout: GeneratedLayout,
  opts: { hardwareOptionIds?: string[]; accessoryOptionIds?: string[] } = {},
) {
  return layout.moduleCounts.map((m) => ({
    moduleId: m.moduleId,
    qty: m.qty,
    width: m.width,
    height: m.height,
    depth: m.depth,
    assembly: "RTA" as const,
    hardwareOptionIds: opts.hardwareOptionIds ?? [],
    accessoryOptionIds: opts.accessoryOptionIds ?? [],
  }));
}
