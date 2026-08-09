/**
 * 转角柜预留 —— 角区先于家电占位，避免灶具/冰箱直接坐进墙角。
 *
 * 与 `generate.ts` 的 `reserveCornerCabinet` 共用同一套候选与虚位规则。
 */
import type { ModuleSpec } from "../domain/types.js";
import { resolveModuleSellUnit } from "../spec/sku-semantics.js";
import { cornerOccupyWidth, cornerStyleOf, hasRole, type CornerStyle } from "../spec/capabilities.js";
import { quantize } from "../floorplan/types.js";
import {
  buildKitchenPlan, usableSpan, type KitchenPlan,
} from "./plan-model.js";
import type { ParsedGeometry } from "../floorplan/types.js";

function isLayoutSku(m: ModuleSpec): boolean {
  const u = resolveModuleSellUnit(m).sellUnit;
  return u === "combo" || u === "standalone";
}

/** 某一层的转角柜候选（按 cornerAccess + 进深）。 */
export function cornerModulesFor(
  modules: readonly ModuleSpec[], layer: "base" | "wall",
): ModuleSpec[] {
  const maxDepth = layer === "wall" ? 14 : 30;
  const minDepth = layer === "wall" ? 0 : 15;
  return modules.filter((m) => {
    if (!hasRole(m, "cornerAccess") || !isLayoutSku(m)) return false;
    const d = m.depthOptions[0] ?? 24;
    return d > minDepth && d <= maxDepth;
  });
}

/** 地柜：盲角优先；LSB 与钻石地柜同档可互换。吊柜：L 形与钻石同档可互换。 */
export function cornerStyleRank(style: CornerStyle | undefined, layer: "base" | "wall"): number {
  if (layer === "base") {
    switch (style) {
      case "blind": return 0;
      case "lazySusan":
      case "diagonal": return 1; // LSB ↔ DC
      case "lShape": return 2;
      default: return 9;
    }
  }
  switch (style) {
    case "lShape":
    case "diagonal": return 0; // LC ↔ CW
    case "blind": return 1;
    case "lazySusan": return 2;
    default: return 9;
  }
}

/**
 * 同尺寸可互换的转角做法集合。
 * 地柜：lazySusan ↔ diagonal；吊柜：lShape ↔ diagonal。
 */
export function cornerInterchangePeers(
  style: CornerStyle | undefined,
  layer: "base" | "wall",
): ReadonlySet<CornerStyle | undefined> {
  if (layer === "base" && (style === "lazySusan" || style === "diagonal")) {
    return new Set<CornerStyle | undefined>(["lazySusan", "diagonal"]);
  }
  if (layer === "wall" && (style === "lShape" || style === "diagonal")) {
    return new Set<CornerStyle | undefined>(["lShape", "diagonal"]);
  }
  return new Set<CornerStyle | undefined>([style]);
}

/** 可互换组内的稳定默认：地柜偏 LSB，吊柜偏 LC（仍可换同尺寸另一款）。 */
function cornerStyleDefaultBias(style: CornerStyle | undefined, layer: "base" | "wall"): number {
  if (layer === "base") {
    if (style === "lazySusan") return 0;
    if (style === "diagonal") return 1;
  } else {
    if (style === "lShape") return 0;
    if (style === "diagonal") return 1;
  }
  return 0;
}

export interface CornerFootprint {
  module: ModuleSpec;
  boxWidth: number;
  occupy: number;
  gap: number;
}

/**
 * 在不超过 maxOccupy 的前提下，按选型优先级挑一个转角占位。
 */
export function preferredCornerFootprint(
  candidates: readonly ModuleSpec[],
  maxOccupy: number,
  layer: "base" | "wall",
): CornerFootprint | undefined {
  const options = candidates
    .flatMap((m) => m.widthOptions.map((boxW) => {
      const occupy = cornerOccupyWidth(m, boxW);
      const gap = Math.max(0, occupy - boxW);
      return { module: m, boxWidth: boxW, occupy, gap, style: cornerStyleOf(m) };
    }))
    .filter(({ occupy }) => occupy <= maxOccupy + 0.01)
    .sort((a, b) => {
      const ra = cornerStyleRank(a.style, layer);
      const rb = cornerStyleRank(b.style, layer);
      if (ra !== rb) return ra - rb;
      if (a.occupy !== b.occupy) return a.occupy - b.occupy;
      if (a.boxWidth !== b.boxWidth) return a.boxWidth - b.boxWidth;
      // 同宽同款多高度型号时，占位阶段先偏向常用墙柜高（避开 12"）
      const hScore = (m: ModuleSpec) => {
        const h = m.heightOptions[0] ?? 0;
        if (h === 12) return 100;
        return Math.abs(h - 30);
      };
      const hs = hScore(a.module) - hScore(b.module);
      if (hs !== 0) return hs;
      // 同档可互换：稳定默认偏 LSB / LC
      const ba = cornerStyleDefaultBias(a.style, layer);
      const bb = cornerStyleDefaultBias(b.style, layer);
      if (ba !== bb) return ba - bb;
      return a.module.code.localeCompare(b.module.code);
    });
  const pick = options[0];
  if (!pick) return undefined;
  return {
    module: pick.module,
    boxWidth: pick.boxWidth,
    occupy: pick.occupy,
    gap: pick.gap,
  };
}

/**
 * 吊柜转角按高度分型号（LC/CW 2412/2430/…）时：占位只用宽，落位再按高度换型。
 * 同尺寸可互换：LC ↔ CW、LSB ↔ DC，缺档时可跨款补齐。
 */
export function rematchCornerModuleHeight(
  module: ModuleSpec,
  boxWidth: number,
  heights: readonly number[],
  candidates: readonly ModuleSpec[],
  layer: "base" | "wall" = "wall",
): ModuleSpec {
  const style = cornerStyleOf(module);
  const peers = cornerInterchangePeers(style, layer);
  const pool = candidates.filter((m) =>
    peers.has(cornerStyleOf(m)) && m.widthOptions.includes(boxWidth),
  );
  if (pool.length === 0 || heights.length === 0) return module;

  const prefer = (hits: ModuleSpec[]): ModuleSpec | undefined => {
    if (hits.length === 0) return undefined;
    const same = hits.filter((m) => cornerStyleOf(m) === style);
    const ranked = (same.length > 0 ? same : hits)
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code));
    return ranked[0];
  };

  const total = heights.reduce((a, b) => a + b, 0);
  const byTotal = prefer(pool.filter((m) =>
    m.heightOptions.length === 1 && m.heightOptions[0] === total,
  ));
  if (byTotal) return byTotal;

  const first = heights[0]!;
  const byFirst = prefer(pool.filter((m) => m.heightOptions.includes(first)));
  if (byFirst) return byFirst;

  // 取不超过叠装总高、且最接近的一档（可互换组内）
  const ranked = [...pool]
    .map((m) => ({ m, h: m.heightOptions[0] ?? 0 }))
    .filter(({ h }) => h > 0 && h <= total + 0.01)
    .sort((a, b) => {
      if (b.h !== a.h) return b.h - a.h;
      const sa = cornerStyleOf(a.m) === style ? 0 : 1;
      const sb = cornerStyleOf(b.m) === style ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.m.code.localeCompare(b.m.code);
    });
  return ranked[0]?.m ?? module;
}

export interface CornerKeepOutSpan {
  runId: string;
  x: number;
  width: number;
}

/**
 * 拥有墙角的那段墙，在墙角侧预留转角柜虚位——家电不得占用。
 *
 * 让位侧已由 `usableSpan` 挡住；这里挡的是**拥有侧**末端/起点，
 * 否则灶具会先占满墙角，转角柜再排就只剩 24" 装不下 BBC/LSB。
 */
export function ownerCornerKeepOuts(
  geometry: ParsedGeometry,
  modules: readonly ModuleSpec[],
  layer: "base" | "wall" = "base",
  plan: KitchenPlan = buildKitchenPlan(geometry),
): CornerKeepOutSpan[] {
  const candidates = cornerModulesFor(modules, layer);
  if (candidates.length === 0 || plan.corners.length === 0) return [];

  const byId = new Map(plan.runs.map((rp) => [rp.run.id, rp]));
  const out: CornerKeepOutSpan[] = [];

  for (const c of plan.corners) {
    const rp = byId.get(c.ownerRunId);
    if (!rp) continue;
    const run = rp.run;
    const usable = usableSpan(rp, layer);
    const maxOccupy = usable.end - usable.start;
    if (maxOccupy < 12) continue;

    const foot = preferredCornerFootprint(candidates, maxOccupy, layer);
    if (!foot) continue;

    if (c.ownerEnd === "end") {
      // 贴墙末端：占用 [length - occupy, length)
      const x = quantize(run.length - foot.occupy);
      if (x + foot.occupy > usable.end + 0.01) continue;
      if (x < usable.start - 0.01) continue;
      out.push({ runId: run.id, x, width: foot.occupy });
    } else {
      // 贴墙起点
      const x = quantize(usable.start);
      if (x + foot.occupy > usable.end + 0.01) continue;
      out.push({ runId: run.id, x, width: foot.occupy });
    }
  }

  return out;
}
