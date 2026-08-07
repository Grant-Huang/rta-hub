/**
 * 全局俯视图 —— 整个厨房拼在一张图上，分地柜层与吊柜层。
 *
 * ## 与已有俯视图的区别
 *
 * `views.ts` 的 `renderTopView` 是**单段墙**的俯视图：一条直线上排一排柜子。
 * 那张图回答不了「L 型的两条边是怎么接的」「U 型中间还剩多宽」这类问题，
 * 而客户在第一眼要判断的恰恰是整体排布。
 *
 * 所以这里把各段墙按走向拼成一个平面。这是**客户第一个看到的图**
 * （`DesignStage.planReview`），也是多轮修改都在上面进行的那一张。
 *
 * ## 墙段的走向是推出来的，不是存的
 *
 * `WallRun` 只有长度和「两端是不是内墙角」，没有绝对方位——户型抽取给不出
 * 可靠的方位，硬要客户填也不现实。所以这里按**厨房的常见拓扑**推：
 * 墙段首尾相接成链，遇到内墙角转 90°。一字型是一条线，L 型转一次，U 型转两次。
 *
 * 推不出来的情况（墙段之间不相接）如实标注为「示意排列」，不假装知道。
 *
 * ## 画法全部交给绘图内核
 *
 * 颜色、线宽、标注、开门弧线都从 `kernel/` 出（RENDERING.md §8）。
 * 这个文件只决定**摆什么、摆在哪**——"怎么画"归内核。以前这里自带一套配色
 * 和一份复制的 `esc`，于是同一个填缝条在这张图上是一个颜色、在正视图上是另一个，
 * 客户看着像两个软件画的。
 */
import type { ParsedGeometry, WallRun } from "../floorplan/types.js";
import type { Placement } from "../layout/generate.js";
import { Canvas, PAD } from "./kernel/canvas.js";
import {
  PALETTE, INK, TYPE, STROKE, elementKindOf, featureKindOf, type ElementKind,
} from "./kernel/palette.js";
import {
  dimension, formatInches, line, polygon, sinkBowl, swingArc, text,
} from "./kernel/primitives.js";
import { annotationFor, fitsText } from "./kernel/annotate.js";
import { renderLegend } from "./kernel/legend.js";

export interface RunPlacement {
  run: WallRun;
  /** 墙段起点在平面上的坐标（英寸）。 */
  origin: { x: number; y: number };
  /** 走向：0=向右，90=向下，180=向左，270=向上。 */
  heading: 0 | 90 | 180 | 270;
}

export interface PlanGeometry {
  runs: RunPlacement[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** 走向是推出来的还是没推出来。 */
  inferred: boolean;
  note?: string;
}

const DIR: Record<0 | 90 | 180 | 270, { dx: number; dy: number }> = {
  0: { dx: 1, dy: 0 }, 90: { dx: 0, dy: 1 },
  180: { dx: -1, dy: 0 }, 270: { dx: 0, dy: -1 },
};

/** 顺时针转 90°——厨房绕着人转，L/U 型都是同一个方向绕。 */
function turnRight(h: 0 | 90 | 180 | 270): 0 | 90 | 180 | 270 {
  return (((h + 90) % 360) as 0 | 90 | 180 | 270);
}

/**
 * 把各段墙拼成平面。
 *
 * 相接的判据是「上一段 `endsAtCorner` 且这一段 `startsAtCorner`」。
 * 不相接就并排画开，并在 `note` 里说明这是示意排列而不是实测方位。
 */
export function layoutPlan(geometry: ParsedGeometry): PlanGeometry {
  const runs: RunPlacement[] = [];
  let cursor = { x: 0, y: 0 };
  let heading: 0 | 90 | 180 | 270 = 0;
  let allConnected = true;

  geometry.wallRuns.forEach((run, i) => {
    const prev = geometry.wallRuns[i - 1];
    if (prev) {
      const connected = prev.endsAtCorner && run.startsAtCorner;
      if (connected) {
        heading = turnRight(heading);
      } else {
        // 拼不上：另起一行画，别假装知道它在哪
        allConnected = false;
        heading = 0;
        cursor = { x: 0, y: cursor.y + 60 };
      }
    }
    runs.push({ run, origin: { ...cursor }, heading });
    const d = DIR[heading];
    cursor = { x: cursor.x + d.dx * run.length, y: cursor.y + d.dy * run.length };
  });

  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of runs) {
    const d = DIR[r.heading];
    xs.push(r.origin.x, r.origin.x + d.dx * r.run.length);
    ys.push(r.origin.y, r.origin.y + d.dy * r.run.length);
  }
  // 柜体进深与**开门弧线**都要算进边界。
  //
  // 只按进深留（26"）的话，向室内伸出去的开门弧线会被画布裁掉半圈——
  // 而弧线正是客户判断"门开了会不会打到别的东西"的依据，裁掉了就白画。
  // 24" 深的地柜 + 0.85 倍门宽的弧线 ≈ 45"，取 48" 留一点余量。
  const DEPTH = 48;
  return {
    runs,
    bounds: {
      minX: Math.min(...xs, 0) - DEPTH, minY: Math.min(...ys, 0) - DEPTH,
      maxX: Math.max(...xs, 0) + DEPTH, maxY: Math.max(...ys, 0) + DEPTH,
    },
    inferred: true,
    ...(allConnected
      ? {}
      : { note: "有墙段无法与相邻墙段相接，图中为示意排列，实际方位请以现场为准。" }),
  };
}

export type PlanLayer = "base" | "wall";

export interface PlanViewStyle {
  pxPerInch: number;
  showDimensions: boolean;
  showLabels: boolean;
  /** 图例。默认画——客户要能看懂每种颜色是什么。 */
  showLegend?: boolean;
}

export const DEFAULT_PLAN_STYLE: PlanViewStyle = {
  pxPerInch: 2.2, showDimensions: true, showLabels: true, showLegend: true,
};

/**
 * 画一层的全局俯视图。
 *
 * 柜体沿墙段方向排开，进深往墙的**右手侧**伸（沿走向看的右边就是室内）。
 */
export function renderPlanView(
  geometry: ParsedGeometry,
  placements: readonly Placement[],
  layer: PlanLayer,
  style: PlanViewStyle = DEFAULT_PLAN_STYLE,
): string {
  const plan = layoutPlan(geometry);
  const title = layer === "base" ? "全局俯视图 · 地柜层" : "全局俯视图 · 吊柜层";
  // 图例先算：它要占多高，得在坐标映射之前定下来，否则会压在第一排柜子上
  const legendKinds = style.showLegend === false
    ? [] : kindsInPlan(geometry, placements, layer);
  const legend = renderLegend(legendKinds, PAD, TITLE_BLOCK, LEGEND_COLUMNS);
  const canvas = new Canvas({
    pxPerInch: style.pxPerInch, title,
    header: legend.height > 0 ? TITLE_BLOCK + legend.height : 0,
  }).extent(plan.bounds);
  const { px, py } = { px: (x: number) => canvas.px(x), py: (y: number) => canvas.py(y) };

  for (const rp of plan.runs) {
    const d = DIR[rp.heading];
    // 右手侧法向：走向向右时室内在下方
    const n = { dx: -d.dy, dy: d.dx };
    const at = (along: number, off = 0) => ({
      x: rp.origin.x + d.dx * along + n.dx * off,
      y: rp.origin.y + d.dy * along + n.dy * off,
    });

    // 墙线
    const end = at(rp.run.length);
    canvas.add(line(px(rp.origin.x), py(rp.origin.y), px(end.x), py(end.y),
      PALETTE.wall.stroke, STROKE.wall), "wall");

    // 墙上的特征（窗 / 上下水 / 燃气 / 门洞…），画在墙线上
    for (const f of rp.run.features) {
      const kind = featureKindOf(f);
      const a = at(f.offset);
      const b = at(f.offset + Math.max(f.width, 2));
      canvas.add(line(px(a.x), py(a.y), px(b.x), py(b.y),
        PALETTE[kind].stroke, PALETTE[kind].strokeWidth), kind);
    }

    // 该段墙这一层的摆放
    const mine = placements
      .filter((p) => p.wallRunId === rp.run.id && p.layer === layer)
      .sort((a, b) => a.x - b.x);

    for (const p of mine) {
      const depth = p.depth || (layer === "wall" ? 12 : 24);
      const kind = elementKindOf(p);
      const corners = [at(p.x), at(p.x + p.width), at(p.x + p.width, depth), at(p.x, depth)]
        .map((c) => ({ x: px(c.x), y: py(c.y) }));
      canvas.add(polygon(corners, PALETTE[kind]), kind);

      // 水槽盆画在水槽柜的柜面上——「水槽落在 SB 柜上面」这件事要在图上看得见，
      // 只换个填充色说明不了盆在哪。墙段可能是竖向的，所以按包围盒画。
      if (kind === "sinkBase") {
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        canvas.add(sinkBowl(
          Math.min(...xs), Math.min(...ys),
          Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys),
          { double: p.width >= 30 }));
      }

      // 开门方向弧线——客户判断"冰箱门开了会不会打到抽屉"靠的就是这个。
      // 以前只有单墙俯视图有，全局俯视图没有：同一个信息一张图有一张没有。
      if (p.kind === "cabinet" && p.width >= 9) {
        const radius = Math.min(p.width, depth) * 0.85;
        const hinge = at(p.x, depth);
        canvas.add(swingArc(
          { x: px(hinge.x), y: py(hinge.y) },
          { dx: d.dx, dy: d.dy },
          { dx: n.dx, dy: n.dy },
          canvas.len(radius)));
      }

      if (style.showLabels) {
        const ann = annotationFor(p);
        if (ann) {
          const mid = at(p.x + p.width / 2, depth / 2);
          const lines = ann.secondary ? 2 : 1;
          if (fitsText(p.width, lines)) {
            canvas.add(text(px(mid.x), py(mid.y) - (lines === 2 ? 5 : 0), ann.primary,
              { size: TYPE.code, fill: INK.code, middle: true }));
            if (ann.secondary) {
              canvas.add(text(px(mid.x), py(mid.y) + 5, ann.secondary,
                { size: TYPE.code, fill: INK.code, middle: true }));
            }
          } else if (fitsText(p.width, 1)) {
            canvas.add(text(px(mid.x), py(mid.y), ann.primary,
              { size: TYPE.code, fill: INK.code, middle: true }));
          }
        }
      }
    }

    // 尺寸链：逐柜宽度标在墙外侧。以前只有一行墙总长——客户没法核对
    // "我家那面墙 168 寸，这些柜子加起来是多少"。
    if (style.showDimensions && mine.length > 0) {
      const OFF = -10; // 墙的外侧（室内在 +n 方向）
      for (const p of mine) {
        const a = at(p.x, OFF);
        const b = at(p.x + p.width, OFF);
        if (p.width >= 9) {
          canvas.add(dimension(
            { x: px(a.x), y: py(a.y) }, { x: px(b.x), y: py(b.y) },
            formatInches(p.width)));
        }
      }
    }

    // 墙段标注：名字 + 总长
    if (style.showDimensions) {
      const mid = at(rp.run.length / 2, -22);
      canvas.add(text(px(mid.x), py(mid.y),
        `${rp.run.label} ${formatInches(rp.run.length)}`,
        { size: TYPE.label, fill: INK.label, middle: true }));
    }
  }

  canvas.heading(title);
  if (legend.svg) canvas.add(legend.svg);
  if (plan.note) canvas.footnote(plan.note);

  return canvas.toSvg();
}

/** 图名占的高度（px）——图例从这里往下画。 */
const TITLE_BLOCK = 34;
const LEGEND_COLUMNS = 3;

/**
 * 这张图上会出现哪些语义元素。
 *
 * 图例要用它算高度，也用它列条目——**同一个来源**。分两处算的话，
 * 图例里会出现图上没有的东西，或者反过来。
 */
export function kindsInPlan(
  geometry: ParsedGeometry,
  placements: readonly Placement[],
  layer: PlanLayer,
): ElementKind[] {
  const kinds = new Set<ElementKind>();
  for (const run of geometry.wallRuns) {
    if (run.length <= 0) continue;
    kinds.add("wall");
    for (const f of run.features) kinds.add(featureKindOf(f));
    for (const p of placements) {
      if (p.wallRunId === run.id && p.layer === layer) kinds.add(elementKindOf(p));
    }
  }
  return [...kinds];
}

export interface PlanViews {
  base: string;
  wall: string;
  note?: string;
}

/** 全局俯视图两张：地柜层 + 吊柜层。 */
export function renderPlanViews(
  geometry: ParsedGeometry,
  placements: readonly Placement[],
  style: PlanViewStyle = DEFAULT_PLAN_STYLE,
): PlanViews {
  const plan = layoutPlan(geometry);
  return {
    base: renderPlanView(geometry, placements, "base", style),
    wall: renderPlanView(geometry, placements, "wall", style),
    ...(plan.note ? { note: plan.note } : {}),
  };
}
