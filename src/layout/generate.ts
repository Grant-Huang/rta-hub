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
import type { ModuleSpec, ModuleType, SharedPreferences } from "../domain/types.js";
import type { ParsedGeometry, WallFeature, WallRun } from "../floorplan/types.js";
import { isIsland, quantize } from "../floorplan/types.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";
import { resolveModuleSellUnit } from "../spec/sku-semantics.js";
import {
  buildKitchenPlan, doorSpan, toPlane, usableSpan, type KitchenPlan,
} from "./plan-model.js";
import { allocateFillers, packSegment, type PackCandidate } from "./pack.js";
import {
  checkErgonomics, checkWorkTriangle, hasBlockingViolation,
  checkAisles, type ErgonomicViolation, type TrianglePoint, CLEARANCE,
} from "./ergonomics.js";
import { compareCandidates, scoreAesthetics, type AestheticScore } from "./aesthetics.js";
import { solveStack, stackCandidates, STACK_SEAM_LOSS } from "./stacking.js";
import { capabilitiesFor, hasRole } from "../spec/capabilities.js";
import {
  cornerModulesFor, preferredCornerFootprint, rematchCornerModuleHeight,
} from "./corner-reserve.js";
import { planAppliances, type AppliancePlan, type PlacedAppliance } from "./appliance-plan.js";
import {
  APPLIANCE_DEFAULTS, APPLIANCE_LABEL, applianceLabel, applianceFrom, defaultAssumedAppliances,
  reservedWidth, type ApplianceKind, type ApplianceSpec,
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

/** FR-22：解析本轮家电列表（overlay 默认宽度 + preferNoCooktopBase）。 */
export function resolveLayoutAppliances(opts: LayoutOptions): ApplianceSpec[] {
  let list = opts.appliances
    ? [...opts.appliances]
    : defaultAssumedAppliances(opts.applianceDefaultWidths);
  if (opts.layoutHeuristic?.preferNoCooktopBase) {
    // 推定的 cooktop 不排；客户明示的 cooktop 仍要灶下柜
    list = list.filter((a) => a.kind !== "cooktop" || a.provenance === "customer");
  }
  return list;
}

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
  /**
   * 叠装吊柜里这一段的**底边**，从吊柜基准线（54"）往上量。
   *
   * 单柜为 0 或不填。有第二段时它的 `stackBase` 就是第一段的高度——
   * 正视图靠它把两段画在正确的高度上，并在中间画出那条**横向接缝**：
   * 客户看到的成品上那是一条实实在在的线，图上没有就是图画错了
   * （RENDERING.md §8.5）。
   */
  stackBase?: number;
  label?: string;
  /**
   * 稳定柜号（从 1 起）。客户可说「把 #12 改成双抽」——
   * 编号在一次排布结果内稳定，重排后重新编号。
   */
  cabinetNo?: number;
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
  /**
   * 预先拼好的平面（`buildKitchenPlan`）。
   *
   * 与 `appliancePlan` 同一个道理，而且更要命：`regenerateRun` 只把**一段墙**
   * 交进来，那一段单独看是没有墙角的——不传的话，重排一段墙会让它的柜子
   * 一直排到墙角，正好压在隔壁那段墙的柜子上。改一面墙，撞坏另一面墙。
   */
  plan?: KitchenPlan;
  /** 关闭人体工程硬约束（仅用于调试/对比，正常路径不应关）。 */
  skipErgonomics?: boolean;
  /**
   * 抽屉倾向 —— 来自客户的储物偏好（`preferences/questions.ts` 的 `storage` 题）。
   *
   * 默认 `highUseOnly`：只在灶台/水槽附近优先抽屉。这个选择必须真的改变排布，
   * 而不是记下来给人看——所以它进的是装箱候选的 `preference` 项。
   */
  drawerBias?: "always" | "highUseOnly" | "never";
  /**
   * 客户语言偏好。人体工程 message / 美观 notes 跟它走；默认英文。
   */
  language?: UiLanguage;
  /** 排布提示：调料拉篮 / 垃圾桶 / 岛台加长等 */
  layoutHints?: SharedPreferences["layoutHints"];
  /**
   * FR-22 平台布局启发式（来自已发布 knowledge overlay）。
   * `preferNoCooktopBase`：推定/未声明 cooktop 时不排灶下柜。
   */
  layoutHeuristic?: {
    preferNoCooktopBase?: boolean;
  };
  /** FR-22：覆盖默认家电宽度（英寸）。 */
  applianceDefaultWidths?: Partial<Record<ApplianceKind, number>>;
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
  return sorted.find((h) => h <= budget - CROWN_ALLOWANCE) ?? sorted.find((h) => h <= budget) ?? sorted[sorted.length - 1];
}

/** 吊柜顶上给顶线留的高度。叠装求解与单柜选档共用同一个值。 */
export const CROWN_ALLOWANCE = 6;

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

export type ReservedKind = ApplianceKind | "door" | "obstruction" | "corner";

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
 *
 * `usable` 是这一段**让过墙角之后**能放柜子的区间（`plan-model.ts` 的
 * `usableSpan`）。不传就是整段可用——只有单段墙的户型才是这样。
 */
export function splitIntoSegments(
  run: WallRun,
  placed: readonly PlacedAppliance[] = [],
  usable: { start: number; end: number } = { start: 0, end: run.length },
): {
  segments: Segment[];
  reserved: ReservedSpan[];
  warnings: LayoutWarning[];
} {
  const warnings: LayoutWarning[] = [];
  const reserved: ReservedSpan[] = [];

  // 墙角让位：相邻那段墙的柜子占着这里，本段从 usable.start 才开始。
  // 当成一个占位而不是"把段裁短"——图上要看得见这块地方是被让出去的。
  if (usable.start > 0) {
    reserved.push({ x: 0, width: usable.start, kind: "corner" });
  }
  if (usable.end < run.length) {
    reserved.push({ x: usable.end, width: run.length - usable.end, kind: "corner" });
  }

  // 门洞与障碍：整段不可用。
  //
  // 门洞要按**台面外伸之后**的宽度让（`doorSpan`）：台面比柜体箱体宽出一圈，
  // 柜子贴着门洞边站的话，台面会压在门套线上，门开到一半就顶住。
  // 以前这里只让门洞本身的宽度，图上看着不挤，现场装不上。
  for (const f of run.features) {
    if (f.kind === "door") {
      const span = doorSpan(f, "base");
      reserved.push({ x: span.x, width: span.width, kind: "door" });
    } else if (f.kind === "obstruction") {
      reserved.push({ x: f.offset, width: Math.max(f.width, 1), kind: "obstruction" });
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

/**
 * 排布只选 combo / standalone（及未声明但启发式为 combo 的逻辑柜型）。
 * 真实 BOX/DOOR SKU 是目录拆卖行，不能被装箱器当成「又一个地柜宽度」。
 */
function isLayoutSku(m: ModuleSpec): boolean {
  const u = resolveModuleSellUnit(m).sellUnit;
  return u === "combo" || u === "standalone";
}

/** 从规格库里挑出某类柜体的宽度候选。 */
function candidatesFor(modules: readonly ModuleSpec[], types: ModuleType[]): PackCandidate[] {
  const out: PackCandidate[] = [];
  for (const m of modules) {
    if (!types.includes(m.type) || isDedicatedFitting(m) || !isLayoutSku(m)) continue;
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
  preferDrawers: boolean | { height: number } = false,
): ModuleSpec | undefined {
  // 叠装时高度是硬条件：上段要 12"、下段要 36"，随便挑一个"有这个宽度的吊柜"
  // 会排出一个 36" 的柜子去当 12" 的上段，正视图上直接顶穿天花板。
  const wantHeight = typeof preferDrawers === "object" ? preferDrawers.height : undefined;
  const matches = modules.filter(
    (m) => types.includes(m.type) && m.widthOptions.includes(width) && !isDedicatedFitting(m)
      && isLayoutSku(m)
      && (wantHeight === undefined || m.heightOptions.includes(wantHeight)));
  if (matches.length === 0) return undefined;
  if (typeof preferDrawers === "object") return matches[0];
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
  const lang = opts.language ?? DEFAULT_LANGUAGE;
  const hints = opts.layoutHints;
  // 家电落位**先于分层**统一决定——烟机在吊柜层，位置却由地柜层的灶台定
  const appliances = resolveLayoutAppliances(opts);
  const appliancePlan = opts.appliancePlan ?? planAppliances(geometry, appliances, lang, {
    modules,
  });
  for (const w of appliancePlan.warnings) {
    warnings.push({ code: "APPLIANCE_NO_ROOM", message: w.message });
  }
  const drawerBias = opts.drawerBias ?? "highUseOnly";

  const baseCandidates = candidatesFor(modules, ["base"]);
  // 水槽柜按能力挑：有的商家把水槽柜归在 base 类里，只靠 type 会漏
  const sinkModules = modules.filter((m) => hasRole(m, "sinkBase") && isLayoutSku(m));
  const wallCandidates = candidatesFor(modules, ["wall"]);
  const wallHeights = [...new Set(modules.filter((m) => m.type === "wall").flatMap((m) => m.heightOptions))];
  const wallHeight = pickWallCabinetHeight(opts.ceilingHeight, wallHeights);

  // ── 叠装吊柜的可用高度（CATALOG_MODEL §3）──
  //
  // 「现在的房子都比较高，如果上柜高度达到 51 寸，那么肯定需要拼。」
  // 可用高度 = 层高 − 吊柜底边 54" − 顶线预留 6"。
  // 具体解成几段**按宽度分别求**——高度档位是随宽度变的（见 stackCandidates），
  // 但接缝高度要在整面墙上统一，所以流程是「先各解一遍 → 定缝 → 按缝重解」。
  const stackAvailable = opts.ceilingHeight !== undefined
    ? quantize(opts.ceilingHeight - HEIGHTS.wallBaseline - CROWN_ALLOWANCE)
    : undefined;
  const solveFor = (widths: readonly number[]) =>
    stackAvailable === undefined || widths.length === 0 ? undefined
      : solveStack(stackAvailable, stackCandidates(modules, widths), { language: lang });

  // 平面先拼出来：墙角要让多少位是**相邻墙段之间的事**，一段一段单独排布看不见它。
  // 这是「全局视图要把几个墙连起来」这条要求在排布器一侧的落点——不连起来，
  // 两段墙的柜子就会在墙角占同一块地方，而每一段各自都"没超墙"。
  const plan = opts.plan ?? buildKitchenPlan(geometry, lang);
  const byRunId = new Map(plan.runs.map((rp) => [rp.run.id, rp]));
  // 哪一段的哪一头要放转角柜。一段墙可能两头都拥有墙角（L 型中间没有，
  // 但 U 型的长墙一头是墙角、另一头可能又接一段）
  const cornerEnds = new Map<string, ("start" | "end")[]>();
  for (const c of plan.corners) {
    const ends = cornerEnds.get(c.ownerRunId) ?? [];
    ends.push(c.ownerEnd);
    cornerEnds.set(c.ownerRunId, ends);
  }
  const cornerCandidates = cornerModulesFor(modules, "base");

  for (const run of geometry.wallRuns) {
    if (run.length <= 0) continue;
    const rp = byRunId.get(run.id);
    const forThisRun = appliancePlan.byRun.get(run.id) ?? [];
    const usable = rp ? usableSpan(rp, "base") : { start: 0, end: run.length };
    const { segments, reserved, warnings: segWarnings } =
      splitIntoSegments(run, forThisRun, usable);
    warnings.push(...segWarnings);

    for (const r of reserved) {
      // 墙角让位不画成"家电位"——它是隔壁那段墙的柜子，不是这段墙上的构件
      if (r.kind === "door" || r.kind === "obstruction" || r.kind === "corner") continue;
      // 嵌入式灶台**下面有柜子**——它是掉进台面的一个洞，不是一段没有柜子的空当。
      // 那个柜子由 planApplianceCabinets 排（它有特殊要求：上层抽屉要避让灶体），
      // 这里跳过，免得同一段墙上既有"灶台位"又有"灶下柜"，两者叠在一起。
      if (r.kind === "cooktop") continue;
      placements.push({
        kind: "appliance", layer: "base", wallRunId: run.id,
        x: r.x, width: r.width, height: HEIGHTS.baseBox, depth: 24,
        applianceKind: r.kind,
        // 标签带上实际宽度——图上要能看出"这是 33 寸的冰箱位"（FR-5.2）
        label: `${r.label ?? applianceLabel(r.kind, lang)} opening ${formatWidth(r.spec?.width ?? r.width)}`,
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
        label: `${applianceLabel(p.spec.kind, lang)} opening ${formatWidth(p.spec.width)}`,
        applianceSpec: p.spec,
      });
    }

    // 高频取放区：灶具与水槽两侧优先用抽屉柜
    const highUseAnchors: { start: number; end: number }[] = reserved
      .filter((r) => r.kind === "range")
      .map((r) => ({ start: r.x, end: r.x + r.width }));

    // ── 转角柜 ──
    //
    // 拥有墙角的那一段，末尾那块 24"×24" 是从两个方向都够不着的死角。
    // 目录里本来就有转角柜（BBC/LSB/CW），但通用装箱按 `type` 取候选，
    // `corner` 不在 `["base"]` 里——于是这些型号进了规格库却**一次也没被排进去过**，
    // 墙角要么空着要么被两面墙的柜子重复占用。这里把它排上。
    for (const end of cornerEnds.get(run.id) ?? []) {
      const pick = reserveCornerCabinet(run, segments, cornerCandidates, end, "base");
      if (pick) placeReservedCabinet(pick, run, "base", placements, [undefined]);
    }

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
          const sinkX = snapToFillable(
            quantize(Math.max(lo, Math.min(desiredCenter - sink.w / 2, hi))),
            { lo, hi, seg, width: sink.w, candidates: baseCandidates },
          );

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
                applianceKind: "dishwasher",
                label: msg(lang, "Dishwasher opening", "洗碗机位"),
              });
            } else {
              warnings.push({
                code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
                message: msg(lang,
                  `${run.label}: neither side of the sink fits a ${dwWidth}" dishwasher`,
                  `${run.label} 水槽两侧都放不下 ${dwWidth}" 的洗碗机`),
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
              placements, warnings, drawerBias, lang);
          }
          continue; // 本段已处理完
        }

        warnings.push({
          code: "NO_SINK_BASE", wallRunId: run.id,
          message: msg(lang,
            `${run.label} has plumbing but this catalog has no sink base ≤ ${remaining}" wide`,
            `${run.label} 有上下水但这家公司没有宽度 ≤ ${remaining}" 的水槽柜`),
        });
      }

      fillBaseSegment(
        { start: cursor, length: remaining, atStart: seg.fillerAtStart, atEnd: seg.fillerAtEnd },
        run, modules, baseCandidates, highUseAnchors, placements, warnings, drawerBias, lang,
      );
    }

    // ── 家电配套柜 ──
    //
    // **先于吊柜装箱算好**：冰箱上柜可能比冰箱位本身宽（36" 的柜盖 35" 的冰箱位），
    // 只按冰箱宽度留空的话，上柜会与旁边的普通吊柜叠在一起。
    // 它要占多宽，就得先算出来再让开。
    const serving = planApplianceCabinets(run, forThisRun, modules, {
      includeWall: opts.includeWall !== false, usable, language: lang,
      ceilingHeight: opts.ceilingHeight,
    });
    warnings.push(...serving.warnings);
    placements.push(...serving.placements);

    // ── 吊柜层 ──
    //
    // 岛台没有吊柜层——它头顶上没有墙。以前几何里没有岛台这个概念，
    // 所以这句判断也不存在；加进来的话，岛台上方会凭空长出一排吊柜。
    if (
      !isIsland(run) && opts.includeWall !== false
      && wallHeight !== undefined && wallCandidates.length > 0
    ) {
      const wallUsable = rp ? usableSpan(rp, "wall") : { start: 0, end: run.length };
      // 窗户位置不放吊柜；**吊柜层的家电（抽油烟机）也占位**——
      // 不排除的话会在烟机正上方排一个普通吊柜，两者物理上打架
      const blockers = [
        // 墙角让位：吊柜比地柜浅，让 12"+3" 就够，不必按地柜的 27" 让
        ...(wallUsable.start > 0 ? [{ x: 0, width: wallUsable.start }] : []),
        ...(wallUsable.end < run.length
          ? [{ x: wallUsable.end, width: run.length - wallUsable.end }] : []),
        ...run.features
          .filter((f) => f.kind === "window" || f.kind === "obstruction")
          .map((f) => ({ x: f.offset, width: Math.max(f.width, 1) })),
        // 门洞按门套线让开——吊柜没有台面，但柜体侧板同样不能压在门套上
        ...run.features
          .filter((f) => f.kind === "door")
          .map((f) => doorSpan(f, "wall")),
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

      // ── 转角柜先占位 ──
      //
      // 顺序很要紧：**先把转角那一块从可用段里划掉，再装箱**。反过来的话，
      // 通用装箱会把整段填满，转角柜再放上去就压在别人身上。
      // 但它排成几段（叠装）要等整面墙的高度解出来，所以这里只占位、不落位。
      const cornerPicks = (cornerEnds.get(run.id) ?? []).flatMap((end) => {
        const pick = reserveCornerCabinet(
          run, wallSegments, cornerModulesFor(modules, "wall"), end, "wall");
        return pick ? [pick] : [];
      });

      // ── 装箱：把这面墙每一段排成几个宽度 ──
      const packedByStart = new Map<number, ReturnType<typeof packSegment>>();
      for (const seg of wallSegments) {
        if (seg.length < Math.min(...wallCandidates.map((x) => x.width))) continue;
        packedByStart.set(seg.start, packSegment(seg.length, wallCandidates, {
          preferredSeams: baseSeams
            .map((abs) => abs - seg.start)
            .filter((rel) => rel > 0 && rel < seg.length),
          language: lang,
        }));
      }
      const widths = [...new Set([
        ...[...packedByStart.values()].flatMap((p) => p.widths),
        // 转角吊柜的宽度也要算进来。它和别的上柜同处一面墙，**柜顶必须齐**——
        // 不算进来的话，通用列拼到 60"、转角那一列停在 42"，正视图上缺一块，
        // 而这比接缝不对齐更显眼。
        ...cornerPicks.map((c) => c.width),
      ])];

      // ── 叠装：**整面墙解一次**，用这面墙上所有宽度都支持的高度档位 ──
      //
      // 逐柜各解各的话，48" 的这个柜解成 30+18、旁边那个解成 36+12，两条横缝
      // 差 6"，正视图上是一条锯齿线；更糟的情况是某几列拼到 60"、另几列只到
      // 42"，柜顶高低不齐（CATALOG_MODEL §3.2 最后一条）。所以档位取**交集**，
      // 一面墙一套解。
      const runStack = solveFor(widths);
      if (runStack?.note) {
        // 顶上留了空当、或者解不出贴合的组合，都要如实说（§3.3）
        warnings.push({ code: "NO_WALL_CABINETS", wallRunId: run.id, message: runStack.note });
      }

      // 转角柜落位：按叠装高度换同款分型号（LC/CW2430 等），再落一段
      const wallCornerPool = cornerModulesFor(modules, "wall");
      for (const pick of cornerPicks) {
        const wantHeights = (runStack?.heights ?? [wallHeight]).filter(
          (h): h is number => typeof h === "number",
        );
        const module = rematchCornerModuleHeight(
          pick.module, pick.width, wantHeights, wallCornerPool, "wall",
        );
        const h = module.heightOptions.find((x) => wantHeights.includes(x))
          ?? module.heightOptions[0];
        placeReservedCabinet(
          { ...pick, module },
          run,
          "wall",
          placements,
          [h],
        );
      }

      for (const seg of wallSegments) {
        const packed = packedByStart.get(seg.start);
        if (!packed) continue;
        let cursor = seg.start;
        for (const w of packed.widths) {
          // 一个位置可能是叠起来的两段，各自是一个真实型号、各自有一扇门
          const heights = runStack?.heights ?? [wallHeight];
          let base = 0;
          for (const h of heights) {
            const mod = pickModule(modules, ["wall"], w, { height: h });
            if (!mod) break;
            placements.push({
              kind: "cabinet", layer: "wall", wallRunId: run.id,
              x: cursor, width: w, height: h, depth: mod.depthOptions[0] ?? 12,
              moduleId: mod.id, moduleCode: mod.code, faceTemplateId: mod.faceTemplateId,
              ...(base > 0 ? { stackBase: base } : {}),
            });
            base = quantize(base + h + STACK_SEAM_LOSS);
          }
          cursor = quantize(cursor + w);
        }
        if (packed.leftover > 0) {
          placements.push({
            kind: "filler", layer: "wall", wallRunId: run.id,
            x: cursor, width: packed.leftover,
            height: runStack?.filled ?? wallHeight, depth: 12, label: "Filler",
          });
        }
      }
    } else if (opts.includeWall !== false && wallCandidates.length === 0) {
      warnings.push({
        code: "NO_WALL_CABINETS",
        message: msg(lang,
          "This catalog has no wall-cabinet modules",
          "这家公司规格库里没有吊柜型号"),
      });
    }
  }

  // ── 硬约束与美观评分 ──
  const ergonomics: ErgonomicViolation[] = [];
  const aesthetics: { wallRunId: string; score: AestheticScore }[] = [];
  if (!opts.skipErgonomics) {
    for (const run of geometry.wallRuns) {
      if (run.length <= 0) continue;
      ergonomics.push(...checkErgonomics({
        run, placements, language: lang,
        hasDishwasher: appliances.some((a) => a.kind === "dishwasher"),
      }));
    }
    ergonomics.push(...checkWorkTriangle(trianglePoints(plan, placements), lang));
    // 过道净空是**跨墙段**的：岛台与哪一列柜子挨得太近，一段一段单独看不出来
    ergonomics.push(...checkAisles(plan, lang));
  }
  for (const run of geometry.wallRuns) {
    if (run.length <= 0) continue;
    aesthetics.push({ wallRunId: run.id, score: scoreAesthetics({ run, placements, modules, language: lang }) });
  }

  // 修订提示：调料拉篮 / 垃圾桶 / 按柜号改双抽 —— 先编号再改，改完再重编号
  assignCabinetNumbers(placements);
  applyFunctionalPulloutHints(placements, modules, hints);
  assignCabinetNumbers(placements);

  return {
    placements,
    warnings,
    moduleCounts: countModules(placements),
    ergonomics,
    aesthetics,
    // 家电放不下 = 硬闸门：不得假装可出图/报价
    acceptable: !hasBlockingViolation(ergonomics)
      && !warnings.some((w) => w.code === "APPLIANCE_NO_ROOM"),
  };
}

/**
 * 把水槽柜挪到一个**两侧都填得满**的位置。
 *
 * 对准窗中心是软性偏好；两侧各剩 9" 这种填不上的口子是硬伤——现有型号最窄
 * 12"，填缝条最多吸收 6"，于是 9" 会原样留在那儿变成一条真实的缝，台面断开，
 * 随后人体工程检查判「水槽左侧台面 0"」。方案被自己的检查器否掉，
 * 而根因是几十行之外的一次取整。
 *
 * 做法：在允许区间里按 1" 步长找**离理想位置最近、且两侧余量都能被吸收**的位置。
 * 一个都找不到就退回理想位置——不假装解决，让检查器如实报出来。
 */
function snapToFillable(
  ideal: number,
  ctx: {
    lo: number; hi: number;
    seg: { start: number; length: number };
    width: number;
    candidates: readonly PackCandidate[];
  },
): number {
  const absorbable = (len: number): boolean => {
    if (len <= 0.26) return true;
    return packSegment(len, ctx.candidates).feasible;
  };
  const segEnd = ctx.seg.start + ctx.seg.length;
  if (absorbable(ideal - ctx.seg.start) && absorbable(segEnd - ideal - ctx.width)) return ideal;

  let best: { x: number; away: number } | undefined;
  for (let x = Math.ceil(ctx.lo); x <= ctx.hi + 1e-6; x += 1) {
    const pos = quantize(Math.min(x, ctx.hi));
    if (!absorbable(pos - ctx.seg.start)) continue;
    if (!absorbable(segEnd - pos - ctx.width)) continue;
    const away = Math.abs(pos - ideal);
    if (!best || away < best.away) best = { x: pos, away };
  }
  return best?.x ?? ideal;
}

/**
 * 在拥有墙角的那一段的末尾放一个转角柜，并把对应的子段缩短。
 *
 * 挑不到（这家公司没有转角柜、或者末尾那段太短）就什么都不做——末尾会由
 * 通用装箱填上普通柜体，而墙角的死角由 `UNREACHABLE_BLIND_CORNER` 提示客户。
 * **不静默塞一个装不下的**。
 */
interface CornerPick {
  module: ModuleSpec;
  /** 箱体宽（BOM / 图上标注）。 */
  width: number;
  /** 沿墙占用（盲角=虚拟尺寸）。 */
  occupy: number;
  /** 箱体沿墙落位起点（盲角已含墙角侧 gap）。 */
  x: number;
}

/**
 * 给转角柜**占位**：从可用段里划掉虚位，返回选中的型号与箱体落点。
 *
 * 占位与落位分开，是因为它排成几段（叠装）要等整面墙的高度解出来，
 * 而"这一块归转角柜"必须在通用装箱之前就定下来——反过来的话，
 * 通用装箱会把整段填满，转角柜再放上去就压在别人身上。
 *
 * 盲角（BBC42 / BBC45）：码宽即沿墙占用，左右通装；箱体贴墙角落位。
 * 选型与 `corner-reserve.ts` / 家电角区预留同源，避免「家电让开了、装箱却挑了别的宽」。
 */
function reserveCornerCabinet(
  run: WallRun,
  segments: { start: number; length: number }[],
  candidates: readonly ModuleSpec[],
  end: "start" | "end",
  layer: "base" | "wall",
): CornerPick | undefined {
  const seg = end === "end"
    ? segments.find((s) => Math.abs(s.start + s.length - run.length) < 0.26)
    : segments.find((s) => Math.abs(s.start) < 0.26);
  if (!seg) return undefined;

  const foot = preferredCornerFootprint(candidates, seg.length, layer);
  if (!foot) return undefined;

  const x = end === "end"
    ? quantize(run.length - foot.occupy + foot.gap)
    : quantize(seg.start + foot.gap);

  seg.length = quantize(seg.length - foot.occupy);
  if (end === "start") seg.start = quantize(seg.start + foot.occupy);
  return { module: foot.module, width: foot.boxWidth, occupy: foot.occupy, x };
}

/** 把占好位的柜子按给定的高度序列落位（单柜就是一段）。 */
function placeReservedCabinet(
  pick: CornerPick,
  run: WallRun,
  layer: "base" | "wall",
  placements: Placement[],
  heights: readonly (number | undefined)[],
): void {
  let stackBase = 0;
  for (const want of heights) {
    const h = want !== undefined && pick.module.heightOptions.includes(want)
      ? want : pick.module.heightOptions[0] ?? HEIGHTS.baseBox;
    placements.push({
      kind: "cabinet", layer, wallRunId: run.id,
      x: pick.x, width: pick.width, height: h,
      depth: pick.module.depthOptions[0] ?? (layer === "wall" ? 12 : 24),
      moduleId: pick.module.id, moduleCode: pick.module.code,
      faceTemplateId: pick.module.faceTemplateId,
      ...(stackBase > 0 ? { stackBase } : {}),
      label: "corner",
    });
    stackBase = quantize(stackBase + h + STACK_SEAM_LOSS);
    // 该型号没有这个高度档就只放一段——**不为了对齐而排一个不存在的型号**
    if (want !== undefined && !pick.module.heightOptions.includes(want)) break;
  }
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
  language: UiLanguage = DEFAULT_LANGUAGE,
): void {
  if (seg.length <= 0) return;

  // 装箱阶段就偏向有抽屉柜的宽度。`always` 全段偏向，`highUseOnly` 只在灶台/水槽附近，
  // `never` 完全不偏（客户明确选了以门板柜为主）。
  const wantDrawers = drawerBias === "always"
    || (drawerBias === "highUseOnly" && isHighUseZone(seg.start, seg.length, highUseAnchors));
  const segCandidates = wantDrawers
    ? biasTowardDrawers(candidates, drawerWidths(modules))
    : candidates;

  const packed = packSegment(seg.length, segCandidates, { language });
  if (!packed.feasible && packed.widths.length === 0) {
    warnings.push({
      code: "SEGMENT_UNFILLABLE", wallRunId: run.id,
      message: msg(language,
        `${run.label}: ${seg.length}" segment cannot be filled with available modules: ${packed.reason ?? ""}`,
        `${run.label} 的 ${seg.length}" 段无法用现有型号填充：${packed.reason ?? ""}`),
    });
    return;
  }

  const fillers = allocateFillers(packed.leftover, { atStart: seg.atStart, atEnd: seg.atEnd });
  if (!fillers.feasible && packed.leftover > 0) {
    warnings.push({
      code: "FILLER_TOO_WIDE", wallRunId: run.id,
      message: msg(language,
        `${run.label}: leftover ${packed.leftover}" exceeds what fillers can absorb — adjust appliance placement`,
        `${run.label} 剩余 ${packed.leftover}"，超出填缝条能吸收的范围，建议调整家电位置`),
    });
  }

  let cursor = seg.start;
  if (fillers.start > 0) {
    placements.push({
      kind: "filler", layer: "base", wallRunId: run.id,
      x: cursor, width: fillers.start, height: HEIGHTS.baseBox, depth: 24, label: "Filler",
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
      x: cursor, width: fillers.end, height: HEIGHTS.baseBox, depth: 24, label: "Filler",
    });
  }
}

/**
 * 把「沿墙坐标」换算成平面坐标，供工作三角计算。
 *
 * 简化模型：墙段首尾相接、依次转 90 度（一字/L/U 型厨房的常见情形）。
 */
function trianglePoints(
  plan: KitchenPlan, placements: readonly Placement[],
): TrianglePoint[] {
  const points: TrianglePoint[] = [];

  // 坐标从平面模型出。这里以前自带一份"每段右转 90°"的串联逻辑——它连
  // `startsAtCorner` 都不看，于是同一个户型在图上是一种拼法、在工作三角里是另一种。
  // 两份实现算出来的距离不一样，而没有任何一处会报错。
  for (const rp of plan.runs) {
    for (const p of placements.filter((q) => q.wallRunId === rp.run.id && q.layer === "base")) {
      const center = p.x + p.width / 2;
      // 先认家电：**灶下柜可能就是一个水槽柜箱体**（假抽面、顶部开放，见
      // capabilities.ts 的 F7）。按 SB 码先判水槽的话，工作三角会出现两个水槽点、
      // 一个灶点都没有——而且不报错。
      if (p.applianceKind === "range" || p.applianceKind === "cooktop") {
        points.push({ kind: "cooktop", ...toPlane(rp, center) });
      } else if (p.applianceKind === "refrigerator") {
        points.push({ kind: "refrigerator", ...toPlane(rp, center) });
      } else if (p.label === "sink") {
        // 水槽点以前根本没进过工作三角——三角只有两个顶点，`WORK_TRIANGLE`
        // 那几条检查因此在多数方案上静默跳过
        points.push({ kind: "sink", ...toPlane(rp, center) });
      }
    }
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
  opts: {
    includeWall: boolean;
    usable?: { start: number; end: number };
    language?: UiLanguage;
    ceilingHeight?: number;
  },
): { placements: Placement[]; warnings: LayoutWarning[] } {
  const placements: Placement[] = [];
  const warnings: LayoutWarning[] = [];
  const lang = opts.language ?? DEFAULT_LANGUAGE;
  // 配套柜可能比它服务的家电还宽（36" 的柜盖 33" 的冰箱位），家电本身没进
  // 让位区不代表它的上柜也没进。夹的是**让过墙角之后**的区间，不是整面墙。
  const usable = opts.usable ?? { start: 0, end: run.length };
  const clamp = (x: number, width: number) =>
    quantize(Math.max(usable.start, Math.min(x, usable.end - width)));

  for (const p of placed) {
    const over = modules.find(
      (m) => capabilitiesFor(m).capabilities.servesAppliance === p.spec.kind);

    if (p.spec.kind === "refrigerator") {
      // 只出地柜层时不排冰箱上柜（它在吊柜层），但下面的灶下柜仍要排
      if (!opts.includeWall) continue;
      if (!over) {
        warnings.push({
          code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
          message: msg(lang,
            `This catalog has no fridge upper; the top of the fridge on ${run.label} will be an open gap`,
            `这家公司没有冰箱上柜型号，${run.label}的冰箱顶部会留一个空当`),
        });
        continue;
      }
      // 宽度取该型号能覆盖冰箱位的最小档位——比冰箱窄会露出缝
      const width = [...over.widthOptions].sort((a, b) => a - b)
        .find((w) => w >= p.width);
      if (width === undefined) {
        warnings.push({
          code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
          message: msg(lang,
            `Fridge opening ${p.width}" is wider than this catalog's widest fridge upper (` +
              `${Math.max(...over.widthOptions)}") — the top won't cover`,
            `冰箱位 ${p.width}" 比这家最宽的冰箱上柜（` +
              `${Math.max(...over.widthOptions)}"）还宽，顶部盖不满`),
        });
        continue;
      }
      // 上柜能占多高，取决于冰箱本体有多高：层高减掉冰箱高度、再留顶线（与
      // pickWallCabinetHeight 同一条算法，只是锚点从台面高度换成了冰箱顶）。
      // 冰箱高度不明时按常见档位算——同一条 provenance 披露链路，
      // 见 ApplianceSpec.heightProvenance；provenanceNote 会说这是推定的。
      const fridgeHeight = p.spec.height ?? APPLIANCE_DEFAULTS.refrigerator.height ?? 70;
      const sortedHeights = [...over.heightOptions].sort((a, b) => b - a);
      const available = opts.ceilingHeight !== undefined
        ? opts.ceilingHeight - fridgeHeight - CROWN_ALLOWANCE
        : undefined;
      const chosenHeight = available === undefined
        ? sortedHeights[0]
        : sortedHeights.find((h) => h <= available);
      if (chosenHeight === undefined) {
        warnings.push({
          code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
          message: msg(lang,
            `Fridge on ${run.label} is ${fridgeHeight}" tall — with a ${opts.ceilingHeight}" ceiling ` +
              `there's no room for any fridge upper in this catalog (shortest is ` +
              `${Math.min(...over.heightOptions)}"). Consider putting the fridge in a separate pantry ` +
              `instead of on this cabinet wall.`,
            `${run.label}的冰箱高 ${fridgeHeight}"，层高 ${opts.ceilingHeight}" 下装不进这家最矮的` +
              `冰箱上柜（最矮 ${Math.min(...over.heightOptions)}"）。可以考虑把冰箱放进单独的` +
              `餐边柜/pantry，而不是排在这面橱柜墙上。`),
        });
        continue;
      }
      const x = clamp(p.x + p.width / 2 - width / 2, width);
      placements.push({
        kind: "cabinet", layer: "wall", wallRunId: run.id,
        x, width,
        height: chosenHeight,
        // 冰箱上柜与冰箱齐深，不是普通吊柜的 12"
        depth: over.depthOptions[0] ?? 24,
        moduleId: over.id, moduleCode: over.code,
        ...(over.faceTemplateId ? { faceTemplateId: over.faceTemplateId } : {}),
        // 带上它配的是哪台家电——渲染层据此归类上色（kernel/palette.ts）
        applianceKind: "refrigerator",
        label: msg(lang, "Fridge upper", "冰箱上柜"),
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
          message: msg(lang,
            `This catalog has no cooktop base ≤${p.width}" (nor a matching door base) — ` +
              `a cooktop needs a cabinet underneath; a regular drawer base's top drawer hits the cooktop body`,
            `这家公司没有宽度 ≤${p.width}" 的灶下柜（也没有同宽的门板柜）——` +
              `嵌入式灶台下面必须有柜子，普通抽屉柜的上层抽屉会顶到灶体`),
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
        label: msg(lang,
          `Cooktop base (counter cutout ${formatWidth(p.spec.width)})`,
          `灶下柜（台面开孔 ${formatWidth(p.spec.width)}）`),
      });
      if (width < p.width) {
        placements.push({
          kind: "filler", layer: "base", wallRunId: run.id,
          x: quantize(p.x + width), width: quantize(p.width - width),
          height: HEIGHTS.baseBox, depth: 24, label: "Filler",
        });
      }
      if (!exact) {
        warnings.push({
          code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
          message: msg(lang,
            `This catalog has no dedicated cooktop base; under the cooktop on ${run.label} ` +
              `we used ${mod.code} (door base) — it fits, but you lose one drawer of storage`,
            `这家公司没有专门的灶下柜型号，${run.label}的灶台下面用 ${mod.code} ` +
              `（门板柜）代替——能装，但抽屉储物会少一格`),
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
      const x = clamp(p.x + p.width / 2 - width / 2, width);
      placements.push({
        kind: "cabinet", layer: "tall", wallRunId: run.id,
        x, width,
        height: over.heightOptions[0] ?? 84,
        depth: over.depthOptions[0] ?? 24,
        moduleId: over.id, moduleCode: over.code,
        ...(over.faceTemplateId ? { faceTemplateId: over.faceTemplateId } : {}),
        applianceKind: "wallOven",
        label: msg(lang, "Oven tall cabinet", "烤箱高柜"),
      });
      continue;
    }
    if (p.spec.kind === "wallOven" && !over) {
      warnings.push({
        code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
        message: msg(lang,
          "This catalog has no oven tall cabinet — nowhere to install a wall oven",
          "这家公司没有烤箱高柜型号，独立烤箱没有地方嵌装"),
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
    ?? planAppliances(geometry, resolveLayoutAppliances(opts), opts.language ?? DEFAULT_LANGUAGE, {
      modules,
    });
  // 平面同理，而且更要命：单独一段墙看不见自己的墙角，重排出来的柜子会一直
  // 排到墙角，压在隔壁那段墙的柜子上——**改一面墙，撞坏另一面墙**
  const plan = opts.plan ?? buildKitchenPlan(geometry, opts.language ?? DEFAULT_LANGUAGE);
  const regenerated = generateLayout(
    { ...geometry, wallRuns: [run] }, modules, { ...opts, appliancePlan, plan },
  );
  const placements = [...untouched, ...regenerated.placements];
  // 硬约束与美观分要按合并后的整体重算——只重排一段墙也可能破坏工作三角
  const lang = opts.language ?? DEFAULT_LANGUAGE;
  const ergonomics: ErgonomicViolation[] = [];
  const aesthetics: { wallRunId: string; score: AestheticScore }[] = [];
  if (!opts.skipErgonomics) {
    for (const r of geometry.wallRuns) {
      if (r.length <= 0) continue;
      ergonomics.push(...checkErgonomics({
        run: r, placements, language: lang,
        hasDishwasher: (opts.appliances ?? []).some((a) => a.kind === "dishwasher"),
      }));
    }
    ergonomics.push(...checkWorkTriangle(trianglePoints(plan, placements), lang));
    ergonomics.push(...checkAisles(plan, lang));
  }
  for (const r of geometry.wallRuns) {
    if (r.length <= 0) continue;
    aesthetics.push({ wallRunId: r.id, score: scoreAesthetics({ run: r, placements, modules, language: lang }) });
  }

  assignCabinetNumbers(placements);

  return {
    placements,
    warnings: [
      ...current.warnings.filter((w) => w.wallRunId !== wallRunId),
      ...regenerated.warnings,
    ],
    moduleCounts: countModules(placements),
    ergonomics,
    aesthetics,
    acceptable: !hasBlockingViolation(ergonomics)
      && ![...current.warnings.filter((w) => w.wallRunId !== wallRunId), ...regenerated.warnings]
        .some((w) => w.code === "APPLIANCE_NO_ROOM"),
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

/**
 * 给柜体编稳定序号（按墙段顺序、再按沿墙 x、再按层 base→wall→tall）。
 * 客户可用「#12」指代；filler / appliance 不编号。
 */
export function assignCabinetNumbers(placements: Placement[]): void {
  const order = { base: 0, wall: 1, tall: 2 } as const;
  const cabinets = placements
    .filter((p) => p.kind === "cabinet")
    .sort((a, b) =>
      a.wallRunId.localeCompare(b.wallRunId)
      || a.x - b.x
      || order[a.layer] - order[b.layer]
      || (a.stackBase ?? 0) - (b.stackBase ?? 0));
  cabinets.forEach((p, i) => { p.cabinetNo = i + 1; });
}

/** 同墙距某参照（家电/水槽）最近的可换地柜。 */
function findBaseNearRef(
  placements: readonly Placement[],
  near: "range" | "cooktop" | "sink",
): Placement | undefined {
  const refs = placements.filter((p) =>
    near === "sink"
      ? p.label === "sink"
      : p.applianceKind === near
        || (near === "range" && p.applianceKind === "cooktop"));
  if (!refs.length) return undefined;
  let best: { p: Placement; dist: number } | undefined;
  for (const p of placements) {
    if (p.kind !== "cabinet" || p.layer !== "base") continue;
    if (p.applianceKind || p.label === "sink") continue;
    for (const r of refs) {
      if (r.wallRunId !== p.wallRunId) continue;
      const dist = Math.abs((r.x + r.width / 2) - (p.x + p.width / 2));
      if (!best || dist < best.dist) best = { p, dist };
    }
  }
  return best?.p;
}

/** 按修订提示把普通柜换成调料拉篮 / 垃圾桶柜（按 #N 或 near，不写死 B12）。 */
export function applyFunctionalPulloutHints(
  placements: Placement[],
  modules: readonly ModuleSpec[],
  hints: SharedPreferences["layoutHints"] | undefined,
): void {
  if (!hints) return;
  const swapAt = (
    hit: Placement | undefined,
    wantCode: string,
    preferredWidth: number,
  ) => {
    if (!hit) return;
    const target = modules.find((m) => m.code === wantCode && isLayoutSku(m));
    if (!target) return;
    const w = target.widthOptions.includes(preferredWidth)
      ? preferredWidth
      : (target.widthOptions[0] ?? preferredWidth);
    if (hit.moduleCode === wantCode) return;
    // 目标柜宽不够时，退到同墙任意够宽的 base（仍不依赖具体旧型号码）
    let use = hit;
    if (use.width < w) {
      const wider = placements.find((p) =>
        p.kind === "cabinet" && p.layer === "base"
        && !p.applianceKind && p.label !== "sink"
        && p.moduleCode !== wantCode
        && p.width >= w);
      if (!wider) return;
      use = wider;
    }
    const leftover = quantize(use.width - w);
    use.width = w;
    use.moduleId = target.id;
    use.moduleCode = target.code;
    use.faceTemplateId = target.faceTemplateId;
    if (leftover > 0.26) {
      placements.push({
        kind: "filler", layer: "base", wallRunId: use.wallRunId,
        x: quantize(use.x + w), width: leftover,
        height: use.height, depth: use.depth, label: "Filler",
      });
    }
  };
  const pickHit = (
    cabinetNo: number | undefined,
    near: "range" | "cooktop" | "sink" | undefined,
    preferredWidth: number,
  ): Placement | undefined => {
    if (cabinetNo !== undefined) {
      const byNo = placements.find((p) =>
        p.cabinetNo === cabinetNo && p.kind === "cabinet" && p.layer === "base");
      if (byNo) return byNo;
    }
    if (near) {
      const byNear = findBaseNearRef(placements, near);
      if (byNear) return byNear;
    }
    // 最后按宽度选任意可换 base，绝不按写死的旧型号码列表
    return placements.find((p) =>
      p.kind === "cabinet" && p.layer === "base"
      && !p.applianceKind && p.label !== "sink"
      && (p.width === preferredWidth || p.width >= preferredWidth));
  };
  if (hints.includeSpicePullout) {
    swapAt(pickHit(hints.spiceCabinetNo, hints.spiceNear ?? "range", 9), "B09SP", 9);
  }
  if (hints.includeTrashPullout) {
    swapAt(pickHit(hints.trashCabinetNo, hints.trashNear ?? "sink", 18), "BTC18", 18);
  }

  // 「改成双抽」：按柜号换成同宽 2DB/3DB
  for (const no of hints.doubleDrawerNos ?? []) {
    const p = placements.find((x) => x.cabinetNo === no && x.kind === "cabinet");
    if (!p || p.width === undefined) continue;
    const drawer = modules.find((m) =>
      isLayoutSku(m) && m.type === "base"
      && m.widthOptions.includes(p.width)
      && hasRole(m, "drawerStorage") && !hasRole(m, "doorStorage"));
    if (!drawer) continue;
    p.moduleId = drawer.id;
    p.moduleCode = drawer.code;
    p.faceTemplateId = drawer.faceTemplateId;
  }

  // 「改成一样宽」：把列出的柜号统一到其中最常见/最大宽度
  const matchNos = hints.matchCabinetNos ?? [];
  if (matchNos.length >= 2) {
    const group = matchNos
      .map((n) => placements.find((p) => p.cabinetNo === n && p.kind === "cabinet"))
      .filter((p): p is Placement => !!p);
    if (group.length >= 2) {
      const width = Math.max(...group.map((p) => p.width));
      for (const p of group) {
        if (p.width === width) continue;
        const mod = pickModule(modules, [p.layer === "wall" ? "wall" : "base"], width, false);
        if (!mod) continue;
        const delta = width - p.width;
        p.width = width;
        p.moduleId = mod.id;
        p.moduleCode = mod.code;
        p.faceTemplateId = mod.faceTemplateId;
        // 简单处理：同墙后续柜子右移，超出墙长的留给检查器报
        for (const other of placements) {
          if (other.wallRunId !== p.wallRunId || other.layer !== p.layer) continue;
          if (other.x > p.x) other.x = quantize(other.x + delta);
        }
      }
    }
  }
}
