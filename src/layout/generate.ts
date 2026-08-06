/**
 * 方案自动生成 —— FR-4、场景 D 第 3 点。
 *
 * 流程（全部确定性，无 AI）：
 *   1. 在每段墙上先划出**家电留空**（冰箱/灶具/洗碗机，规范文档第七节的净空要求）；
 *   2. 上下水位置**必须**放水槽柜；
 *   3. 转角按转角柜/盲角柜处理；
 *   4. 剩余段用 pack.ts 做一维装箱，余量给填缝条；
 *   5. 吊柜层同理，但窗户位置跳过。
 *
 * 只使用该公司 published 规格里**真实存在**的型号与离散尺寸（FR-4、FR-8）。
 */
import type { ModuleSpec, ModuleType } from "../domain/types.js";
import type { ParsedGeometry, WallFeature, WallRun } from "../floorplan/types.js";
import { quantize } from "../floorplan/types.js";
import { allocateFillers, packSegment, type PackCandidate } from "./pack.js";

/** 北美标准家电净空（规范文档第七节）。 */
export const APPLIANCE_CLEARANCE = {
  refrigerator: 36,
  range: 30,
  dishwasher: 24,
  /** 洗碗机通常紧邻水槽。 */
} as const;

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
  applianceKind?: keyof typeof APPLIANCE_CLEARANCE;
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
}

export interface LayoutOptions {
  /** 天花板高度，决定吊柜高度档位。 */
  ceilingHeight?: number;
  /** 是否生成吊柜层。 */
  includeWall?: boolean;
  /** 需要留的家电位。 */
  appliances?: (keyof typeof APPLIANCE_CLEARANCE)[];
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
  /** 该段起点/终点是否靠墙（决定填缝条放哪边）。 */
  atRunStart: boolean;
  atRunEnd: boolean;
}

/**
 * 把一段墙按「家电留空 + 门洞 + 障碍」切成若干可放柜子的子段。
 *
 * 上下水（plumbing）不占空间，但会把它所在的子段标记为「必须放水槽柜」。
 */
export function splitIntoSegments(run: WallRun, appliances: (keyof typeof APPLIANCE_CLEARANCE)[]): {
  segments: Segment[];
  reserved: { x: number; width: number; kind: keyof typeof APPLIANCE_CLEARANCE | "door" | "obstruction" }[];
  warnings: LayoutWarning[];
} {
  const warnings: LayoutWarning[] = [];
  const reserved: { x: number; width: number; kind: keyof typeof APPLIANCE_CLEARANCE | "door" | "obstruction" }[] = [];

  // 门洞与障碍：整段不可用
  for (const f of run.features) {
    if (f.kind === "door" || f.kind === "obstruction") {
      reserved.push({ x: f.offset, width: Math.max(f.width, 1), kind: f.kind });
    }
  }

  // 家电：优先放在对应特征位置（燃气→灶具，强电→冰箱），否则从墙尾往前排
  const featureFor = (kind: keyof typeof APPLIANCE_CLEARANCE): WallFeature | undefined => {
    if (kind === "range") return run.features.find((f) => f.kind === "gas");
    if (kind === "refrigerator") return run.features.find((f) => f.kind === "electrical");
    return undefined;
  };

  for (const appliance of appliances) {
    const need = APPLIANCE_CLEARANCE[appliance];
    const anchor = featureFor(appliance);
    if (!anchor) continue; // 没有对应特征就不在这段墙上放
    // 以特征为中心留空
    const x = quantize(Math.max(0, Math.min(anchor.offset - need / 2, run.length - need)));
    if (need > run.length) {
      warnings.push({
        code: "APPLIANCE_NO_ROOM", wallRunId: run.id,
        message: `${run.label} 只有 ${run.length}"，放不下需要 ${need}" 净空的家电`,
      });
      continue;
    }
    reserved.push({ x, width: need, kind: appliance });
  }

  reserved.sort((a, b) => a.x - b.x);

  // 由 reserved 切出可用子段
  const segments: Segment[] = [];
  let cursor = 0;
  for (const r of reserved) {
    if (r.x > cursor) {
      segments.push({
        start: cursor, length: quantize(r.x - cursor),
        requiresSink: false, atRunStart: cursor === 0, atRunEnd: false,
      });
    }
    cursor = Math.max(cursor, quantize(r.x + r.width));
  }
  if (cursor < run.length) {
    segments.push({
      start: cursor, length: quantize(run.length - cursor),
      requiresSink: false, atRunStart: cursor === 0, atRunEnd: true,
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

/** 从规格库里挑出某类柜体的宽度候选。 */
function candidatesFor(modules: readonly ModuleSpec[], types: ModuleType[]): PackCandidate[] {
  const out: PackCandidate[] = [];
  for (const m of modules) {
    if (!types.includes(m.type)) continue;
    for (const w of m.widthOptions) {
      // 常用宽度（30/36）偏好更高；窄柜留给收尾
      out.push({ width: w, preference: w >= 30 ? 0 : w >= 21 ? 1 : 2 });
    }
  }
  // 同宽度去重，保留偏好最好的
  const byWidth = new Map<number, PackCandidate>();
  for (const c of out) {
    const cur = byWidth.get(c.width);
    if (!cur || (c.preference ?? 0) < (cur.preference ?? 0)) byWidth.set(c.width, c);
  }
  return [...byWidth.values()].sort((a, b) => b.width - a.width);
}

function pickModule(modules: readonly ModuleSpec[], types: ModuleType[], width: number): ModuleSpec | undefined {
  return modules.find((m) => types.includes(m.type) && m.widthOptions.includes(width));
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
  const appliances = opts.appliances ?? ["refrigerator", "range"];

  const baseCandidates = candidatesFor(modules, ["base"]);
  const sinkModules = modules.filter((m) => m.type === "sinkBase");
  const wallCandidates = candidatesFor(modules, ["wall"]);
  const wallHeights = [...new Set(modules.filter((m) => m.type === "wall").flatMap((m) => m.heightOptions))];
  const wallHeight = pickWallCabinetHeight(opts.ceilingHeight, wallHeights);

  for (const run of geometry.wallRuns) {
    if (run.length <= 0) continue;
    const { segments, reserved, warnings: segWarnings } = splitIntoSegments(run, appliances);
    warnings.push(...segWarnings);

    for (const r of reserved) {
      if (r.kind === "door" || r.kind === "obstruction") continue;
      placements.push({
        kind: "appliance", layer: "base", wallRunId: run.id,
        x: r.x, width: r.width, height: HEIGHTS.baseBox, depth: 24,
        applianceKind: r.kind,
        label: { refrigerator: "冰箱位", range: "灶具位", dishwasher: "洗碗机位" }[r.kind],
      });
    }

    // ── 地柜层 ──
    for (const seg of segments) {
      let cursor = seg.start;
      let remaining = seg.length;

      // 水槽柜优先落位
      if (seg.requiresSink) {
        const sink = sinkModules
          .flatMap((m) => m.widthOptions.map((w) => ({ m, w })))
          .filter(({ w }) => w <= remaining)
          .sort((a, b) => b.w - a.w)[0];
        if (sink) {
          placements.push({
            kind: "cabinet", layer: "base", wallRunId: run.id,
            x: cursor, width: sink.w, height: HEIGHTS.baseBox, depth: sink.m.depthOptions[0] ?? 24,
            moduleId: sink.m.id, moduleCode: sink.m.code, faceTemplateId: sink.m.faceTemplateId,
          });
          cursor = quantize(cursor + sink.w);
          remaining = quantize(remaining - sink.w);
        } else {
          warnings.push({
            code: "NO_SINK_BASE", wallRunId: run.id,
            message: `${run.label} 有上下水但这家公司没有宽度 ≤ ${remaining}" 的水槽柜`,
          });
        }
      }

      const packed = packSegment(remaining, baseCandidates);
      if (!packed.feasible && packed.widths.length === 0) {
        warnings.push({
          code: "SEGMENT_UNFILLABLE", wallRunId: run.id,
          message: `${run.label} 的 ${remaining}" 段无法用现有型号填充：${packed.reason ?? ""}`,
        });
        continue;
      }

      const fillers = allocateFillers(packed.leftover, {
        atStart: seg.atRunStart && !seg.requiresSink,
        atEnd: seg.atRunEnd,
      });
      if (!fillers.feasible && packed.leftover > 0) {
        warnings.push({
          code: "FILLER_TOO_WIDE", wallRunId: run.id,
          message: `${run.label} 剩余 ${packed.leftover}"，超出填缝条能吸收的范围，建议调整家电位置`,
        });
      }

      if (fillers.start > 0) {
        placements.push({
          kind: "filler", layer: "base", wallRunId: run.id,
          x: cursor, width: fillers.start, height: HEIGHTS.baseBox, depth: 24, label: "填缝条",
        });
        cursor = quantize(cursor + fillers.start);
      }

      for (const w of packed.widths) {
        const mod = pickModule(modules, ["base"], w);
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

    // ── 吊柜层 ──
    if (opts.includeWall !== false && wallHeight !== undefined && wallCandidates.length > 0) {
      // 窗户位置不放吊柜
      const blockers = run.features
        .filter((f) => f.kind === "window" || f.kind === "door" || f.kind === "obstruction")
        .map((f) => ({ x: f.offset, width: Math.max(f.width, 1) }))
        .sort((a, b) => a.x - b.x);

      const wallSegments: { start: number; length: number }[] = [];
      let c = 0;
      for (const b of blockers) {
        if (b.x > c) wallSegments.push({ start: c, length: quantize(b.x - c) });
        c = Math.max(c, quantize(b.x + b.width));
      }
      if (c < run.length) wallSegments.push({ start: c, length: quantize(run.length - c) });

      for (const seg of wallSegments) {
        if (seg.length < Math.min(...wallCandidates.map((x) => x.width))) continue;
        const packed = packSegment(seg.length, wallCandidates);
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

  return { placements, warnings, moduleCounts: countModules(placements) };
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
  const regenerated = generateLayout(
    { ...geometry, wallRuns: [run] }, modules, opts,
  );
  const placements = [...untouched, ...regenerated.placements];
  return {
    placements,
    warnings: [
      ...current.warnings.filter((w) => w.wallRunId !== wallRunId),
      ...regenerated.warnings,
    ],
    moduleCounts: countModules(placements),
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
