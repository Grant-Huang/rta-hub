/**
 * 物料清单（BOM）—— 从排布结果得出**完整**的一份要买的东西。
 *
 * ## 为什么单独一个模块
 *
 * 原来的 `toSelections` 只输出柜体（它读 `moduleCounts`，而那只统计柜体）。
 * 但一套厨房装起来还需要：
 *
 *   - **填缝条**：墙长不可能刚好等于柜体宽度之和，差额要有东西补；
 *   - **踢脚**：整体底座的一条整长踢脚板，或者塑料地脚 + 扣板；
 *   - **收口板**：外露的柜体侧面要贴一块与门板同色的板。
 *
 * 排布器已经算出了填缝条的位置和宽度，但它们**从来没进过报价单**——
 * 客户拿到的是一份缺料的价格，装到一半才发现少东西。这个模块把缺口补上。
 *
 * ## 塑料地脚 vs 整体底座
 *
 * 这不是同一份清单的两种叫法，是**两份不同的清单**：
 *
 * | | 整体底座 `plywoodPanel` | 塑料地脚 `plasticLegs` |
 * |---|---|---|
 * | 支撑 | 柜体自带底座 | 每柜 4–6 条可调地脚 |
 * | 踢脚 | 整长踢脚板贴面 | 扣板夹在腿上 |
 * | 优点 | 件数少 | 逐个调平（旧房地面很少平），运输体积小 |
 *
 * 选错做法，报价单上就会少几十条腿或者多一条用不上的底座。
 */
import type { ModuleSpec, ModuleType, ToeKickSystem } from "../domain/types.js";
import type { WallRun } from "../floorplan/types.js";
import type { GeneratedLayout, Placement } from "./generate.js";

/** 宽度超过这个值的地柜要 6 条腿而不是 4 条——中间会塌。 */
const SIX_LEG_WIDTH = 30;
/** 一根踢脚板/扣板的标称长度（英寸）。 */
const TOE_KICK_STOCK = 96;

export interface BomLine {
  moduleId: string;
  moduleCode: string;
  qty: number;
  width: number;
  height: number;
  depth: number;
  /** 归类用——报价清单按这个分区。 */
  category: BomCategory;
  /** 这一行是怎么来的，用于解释。 */
  reason?: string;
}

export type BomCategory = "cabinet" | "filler" | "toeKick" | "leg" | "panel";

const TYPE_CATEGORY: Partial<Record<ModuleType, BomCategory>> = {
  base: "cabinet", wall: "cabinet", tall: "cabinet",
  corner: "cabinet", sinkBase: "cabinet",
  filler: "filler", toeKick: "toeKick", leg: "leg", panel: "panel",
};

export interface BomInput {
  layout: GeneratedLayout;
  wallRuns: readonly WallRun[];
  modules: readonly ModuleSpec[];
  toeKickSystem: ToeKickSystem;
}

export interface BomResult {
  lines: BomLine[];
  /** 这家公司缺哪些辅料型号——如实报出来，不静默漏掉。 */
  missing: string[];
}

/**
 * 生成完整 BOM。
 *
 * 缺什么辅料型号就**如实报出来**，不静默跳过：客户按这份清单下单，
 * 少一条踢脚板就是装不上。
 */
export function buildBom(input: BomInput): BomResult {
  const lines: BomLine[] = [];
  const missing: string[] = [];

  // ── 柜体：沿用排布器的统计 ──
  for (const m of input.layout.moduleCounts) {
    const spec = input.modules.find((x) => x.id === m.moduleId);
    lines.push({
      moduleId: m.moduleId, moduleCode: m.moduleCode, qty: m.qty,
      width: m.width, height: m.height, depth: m.depth,
      category: (spec && TYPE_CATEGORY[spec.type]) ?? "cabinet",
    });
  }

  // ── 填缝条：排布器已经算好了宽度与位置，这里换成可下单的型号 ──
  const fillers = input.layout.placements.filter((p) => p.kind === "filler");
  for (const [layer, group] of groupBy(fillers, (p) => p.layer)) {
    if (group.length === 0) continue;
    const spec = pickFiller(input.modules, layer);
    if (!spec) {
      missing.push(`${layer === "wall" ? "吊柜" : "地柜"}层填缝条`);
      continue;
    }
    // 填缝条按需裁切，所以按**条数**下单，宽度取型号的标称宽度
    lines.push({
      moduleId: spec.id, moduleCode: spec.code, qty: group.length,
      width: spec.widthOptions[0] ?? 3,
      height: spec.heightOptions[0] ?? 34.5,
      depth: spec.depthOptions[0] ?? 0.75,
      category: "filler",
      reason: `${group.length} 处需要填缝（墙长与柜体宽度之和的差额，现场裁切）`,
    });
  }

  // ── 踢脚：两套做法，两份清单 ──
  const baseCabinets = input.layout.placements.filter(
    (p) => p.layer === "base" && p.kind === "cabinet");
  const runLength = input.wallRuns.reduce((s, r) => s + r.length, 0);

  if (input.toeKickSystem === "plasticLegs") {
    const legs = baseCabinets.reduce(
      (n, p) => n + (p.width > SIX_LEG_WIDTH ? 6 : 4), 0);
    const legSpec = input.modules.find((m) => m.type === "leg");
    if (legSpec && legs > 0) {
      lines.push({
        moduleId: legSpec.id, moduleCode: legSpec.code, qty: legs,
        width: legSpec.widthOptions[0] ?? 2,
        height: legSpec.heightOptions[0] ?? 4.5,
        depth: legSpec.depthOptions[0] ?? 2,
        category: "leg",
        reason: `${baseCabinets.length} 个地柜，宽于 ${SIX_LEG_WIDTH}" 的用 6 条腿、其余 4 条`,
      });
    } else if (legs > 0) {
      missing.push("塑料可调地脚");
    }
  }

  if (runLength > 0) {
    const spec = pickToeKick(input.modules, input.toeKickSystem);
    if (spec) {
      const sticks = Math.ceil(runLength / TOE_KICK_STOCK);
      lines.push({
        moduleId: spec.id, moduleCode: spec.code, qty: sticks,
        width: spec.widthOptions[0] ?? TOE_KICK_STOCK,
        height: spec.heightOptions[0] ?? 4.5,
        depth: spec.depthOptions[0] ?? 0.25,
        category: "toeKick",
        reason: input.toeKickSystem === "plasticLegs"
          ? `踢脚扣板，夹在地脚上；共 ${Math.round(runLength)}" 墙长，每根 ${TOE_KICK_STOCK}"`
          : `整长踢脚板；共 ${Math.round(runLength)}" 墙长，每根 ${TOE_KICK_STOCK}"`,
      });
    } else {
      missing.push(input.toeKickSystem === "plasticLegs" ? "踢脚扣板" : "踢脚板");
    }
  }

  // ── 收口板：外露的柜体侧面 ──
  const exposed = countExposedEnds(input.layout.placements, input.wallRuns);
  for (const [layer, count] of Object.entries(exposed) as ["base" | "wall", number][]) {
    if (count === 0) continue;
    const spec = pickPanel(input.modules, layer);
    if (!spec) { missing.push(`${layer === "wall" ? "吊柜" : "地柜"}收口板`); continue; }
    lines.push({
      moduleId: spec.id, moduleCode: spec.code, qty: count,
      width: spec.widthOptions[0] ?? 24,
      height: spec.heightOptions[0] ?? 34.5,
      depth: spec.depthOptions[0] ?? 0.25,
      category: "panel",
      reason: `${count} 个外露侧面需要与门板同色的收口板`,
    });
  }

  return { lines, missing };
}

/**
 * 外露的柜体端面。
 *
 * 墙段起点/终点不是内墙角时，那一头的柜体侧板会露在外面，
 * 需要贴一块与门板同色的收口板——否则看到的是白色刨花板边。
 */
function countExposedEnds(
  placements: readonly Placement[],
  runs: readonly WallRun[],
): Record<"base" | "wall", number> {
  const out = { base: 0, wall: 0 };
  for (const run of runs) {
    for (const layer of ["base", "wall"] as const) {
      const mine = placements
        .filter((p) => p.wallRunId === run.id && p.layer === layer && p.kind === "cabinet")
        .sort((a, b) => a.x - b.x);
      if (mine.length === 0) continue;
      if (!run.startsAtCorner) out[layer]++;
      if (!run.endsAtCorner) out[layer]++;
    }
  }
  return out;
}

function pickFiller(modules: readonly ModuleSpec[], layer: string): ModuleSpec | undefined {
  const fillers = modules.filter((m) => m.type === "filler");
  // 吊柜填缝条更矮；按高度选，不靠型号码猜（公司命名各不相同）
  return layer === "wall"
    ? fillers.find((m) => (m.heightOptions[0] ?? 0) < 34) ?? fillers[0]
    : fillers.find((m) => (m.heightOptions[0] ?? 0) >= 34) ?? fillers[0];
}

/**
 * 选踢脚型号。
 *
 * 配塑料地脚时要的是**扣板**（更薄，夹在腿上），不是整体底座的贴面板。
 * 按厚度区分：扣板明显更薄。分不出来时退回第一个，并在 reason 里说清是哪种做法。
 */
function pickToeKick(modules: readonly ModuleSpec[], system: ToeKickSystem): ModuleSpec | undefined {
  const kicks = modules.filter((m) => m.type === "toeKick");
  if (kicks.length <= 1) return kicks[0];
  const byThickness = [...kicks].sort(
    (a, b) => (a.depthOptions[0] ?? 0) - (b.depthOptions[0] ?? 0));
  return system === "plasticLegs" ? byThickness[0] : byThickness[byThickness.length - 1];
}

function pickPanel(modules: readonly ModuleSpec[], layer: string): ModuleSpec | undefined {
  const panels = modules.filter((m) => m.type === "panel");
  return layer === "wall"
    ? panels.find((m) => (m.heightOptions[0] ?? 0) < 34) ?? panels[0]
    : panels.find((m) => (m.heightOptions[0] ?? 0) >= 34) ?? panels[0];
}

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** BOM → 定价引擎要的选择结构。辅料一律 RTA（它们本来就是板材）。 */
export function bomToSelections(
  bom: BomResult,
  opts: { hardwareOptionIds?: string[]; accessoryOptionIds?: string[] } = {},
) {
  return bom.lines.map((l) => ({
    moduleId: l.moduleId,
    qty: l.qty,
    width: l.width,
    height: l.height,
    depth: l.depth,
    assembly: "RTA" as const,
    // 五金/配件只加在柜体上——给填缝条配 soft-close 铰链是没有意义的
    hardwareOptionIds: l.category === "cabinet" ? (opts.hardwareOptionIds ?? []) : [],
    accessoryOptionIds: l.category === "cabinet" ? (opts.accessoryOptionIds ?? []) : [],
  }));
}
