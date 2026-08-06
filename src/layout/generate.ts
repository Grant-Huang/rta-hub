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
  /** 需要留的家电位。 */
  appliances?: (keyof typeof APPLIANCE_CLEARANCE)[];
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

/** 有明确功能的窄柜——即使窄也不该被当成"凑数"惩罚。 */
const FUNCTIONAL_NARROW_PREFIX = /^(BPO|TDC|BWB)/i;

/** 从规格库里挑出某类柜体的宽度候选。 */
function candidatesFor(modules: readonly ModuleSpec[], types: ModuleType[]): PackCandidate[] {
  const out: PackCandidate[] = [];
  for (const m of modules) {
    if (!types.includes(m.type)) continue;
    const functional = FUNCTIONAL_NARROW_PREFIX.test(m.code);
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
  const matches = modules.filter((m) => types.includes(m.type) && m.widthOptions.includes(width));
  if (matches.length === 0) return undefined;
  if (preferDrawers) {
    const drawer = matches.find((m) => /^(\d)DB|DRAWER/i.test(m.code) || m.faceTemplateId === "F6_DRAWER_STACK");
    if (drawer) return drawer;
  }
  // 否则优先非抽屉柜（更便宜），避免全屋都上抽屉柜推高造价
  return matches.find((m) => !/^(\d)DB/i.test(m.code)) ?? matches[0];
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

/** 该公司有抽屉柜的宽度集合。 */
function drawerWidths(modules: readonly ModuleSpec[]): Set<number> {
  const out = new Set<number>();
  for (const m of modules) {
    if (m.type !== "base") continue;
    if (!/^(\d)DB/i.test(m.code) && m.faceTemplateId !== "F6_DRAWER_STACK") continue;
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
  const appliances = opts.appliances ?? ["refrigerator", "range"];
  const drawerBias = opts.drawerBias ?? "highUseOnly";

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
          if (appliances.includes("dishwasher")) {
            const dwWidth = APPLIANCE_CLEARANCE.dishwasher;
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
            if (o.x > sc) subSegments.push({ start: sc, length: quantize(o.x - sc), atStart: sc === seg.start && seg.atRunStart, atEnd: false });
            sc = Math.max(sc, quantize(o.x + o.width));
          }
          if (sc < seg.start + seg.length) {
            subSegments.push({
              start: sc, length: quantize(seg.start + seg.length - sc),
              atStart: sc === seg.start && seg.atRunStart, atEnd: seg.atRunEnd,
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
        { start: cursor, length: remaining, atStart: seg.atRunStart, atEnd: seg.atRunEnd },
        run, modules, baseCandidates, highUseAnchors, placements, warnings, drawerBias,
      );
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
        run, placements, hasDishwasher: appliances.includes("dishwasher"),
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
      if (p.label === "sink" || p.moduleCode?.toUpperCase().includes("SB")) {
        points.push({ kind: "sink", ...toPlane(center) });
      } else if (p.applianceKind === "range") {
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
  // 硬约束与美观分要按合并后的整体重算——只重排一段墙也可能破坏工作三角
  const ergonomics: ErgonomicViolation[] = [];
  const aesthetics: { wallRunId: string; score: AestheticScore }[] = [];
  if (!opts.skipErgonomics) {
    for (const r of geometry.wallRuns) {
      if (r.length <= 0) continue;
      ergonomics.push(...checkErgonomics({
        run: r, placements,
        hasDishwasher: (opts.appliances ?? []).includes("dishwasher"),
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
