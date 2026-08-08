/**
 * 全局俯视图 —— 整个厨房拼在**一张连通的平面**上，分地柜层与吊柜层。
 *
 * ## 与已有俯视图的区别
 *
 * `views.ts` 的 `renderTopView` 是**单段墙**的俯视图：一条直线上排一排柜子。
 * 那张图回答不了「L 型的两条边是怎么接的」「U 型中间还剩多宽」这类问题，
 * 而客户在第一眼要判断的恰恰是整体排布。
 *
 * 客户的原话：「全局视图要把几个墙围起来、连起来，不能像四个单独的视图那样，
 * 把南墙、北墙、东墙分开写。只有把它们连起来的时候，才会发现开关门的问题、
 * 干涉的问题，以及一些边角柜等细节。」
 *
 * ## 平面从哪来
 *
 * 从 `layout/plan-model.ts`——**唯一的一份**。墙段怎么串、墙角归谁、岛台落在哪，
 * 排布器、净空检查、交付前审核和这张图读的是同一个模型。以前这里自带一份串联
 * 逻辑，`generate.ts` 的工作三角又自带另一份，两份对同一个户型给出不同的平面。
 *
 * ## 这张图上必须看得见的三件事
 *
 *   1. **墙角**：两段墙的柜子不能占同一块地方，让位与转角柜都要画出来；
 *   2. **台面外沿**：台面比柜体大出一圈，门洞旁让开的那一点距离就在这一圈上；
 *   3. **过道**：岛台到四周柜列的净空，标成尺寸让客户自己核对。
 *
 * ## 画法全部交给绘图内核
 *
 * 颜色、线宽、标注、开门弧线都从 `kernel/` 出（RENDERING.md §8）。
 * 这个文件只决定**摆什么、摆在哪**——"怎么画"归内核。
 */
import type { ParsedGeometry } from "../floorplan/types.js";
import type { Placement } from "../layout/generate.js";
import {
  buildKitchenPlan, depthOf, doorSpan, hasContinuousCounter, toPlane, usableSpan,
  headingVector, interiorNormal, COUNTERTOP,
  type KitchenPlan, type PlacedRun, type Rect,
} from "../layout/plan-model.js";
import { Canvas, PAD } from "./kernel/canvas.js";
import {
  PALETTE, INK, TYPE, STROKE, elementKindOf, featureKindOf, type ElementKind,
} from "./kernel/palette.js";
import {
  dimension, formatInches, line, polygon, sinkBowl, swingArc, text,
} from "./kernel/primitives.js";
import { annotationFor, fitsText } from "./kernel/annotate.js";
import { renderLegend } from "./kernel/legend.js";

export type { KitchenPlan } from "../layout/plan-model.js";

/**
 * 平面拼装 —— 转调 `plan-model.ts`。
 *
 * 保留这个名字是因为它已经是这张图的入口概念；实现搬走了，**这里不再有第二份**。
 */
export function layoutPlan(geometry: ParsedGeometry): KitchenPlan {
  return buildKitchenPlan(geometry);
}

export type PlanLayer = "base" | "wall";

export interface PlanViewStyle {
  pxPerInch: number;
  showDimensions: boolean;
  showLabels: boolean;
  /** 图例。默认画——客户要能看懂每种颜色是什么。 */
  showLegend?: boolean;
  /** 台面外沿。地柜层默认画，吊柜层没有台面。 */
  showCountertop?: boolean;
}

export const DEFAULT_PLAN_STYLE: PlanViewStyle = {
  pxPerInch: 2.2, showDimensions: true, showLabels: true, showLegend: true,
};

/**
 * 画一层的全局俯视图。
 *
 * 柜体沿墙段方向排开，进深往墙的**右手侧**伸（沿走向看的右边就是室内）。
 * 岛台四周都是室内，进深往同一侧伸，另一侧就是它的背面。
 */
export function renderPlanView(
  geometry: ParsedGeometry,
  placements: readonly Placement[],
  layer: PlanLayer,
  style: PlanViewStyle = DEFAULT_PLAN_STYLE,
): string {
  const plan = buildKitchenPlan(geometry);
  const title = layer === "base" ? "Overall plan · Base" : "Overall plan · Wall";
  const withCounter = style.showCountertop ?? layer === "base";

  // 图例先算：它要占多高，得在坐标映射之前定下来，否则会压在第一排柜子上
  const legendKinds = style.showLegend === false
    ? [] : kindsInPlan(geometry, placements, layer, withCounter);
  const legend = renderLegend(legendKinds, PAD, TITLE_BLOCK, LEGEND_COLUMNS);
  const canvas = new Canvas({
    pxPerInch: style.pxPerInch, title,
    header: legend.height > 0 ? TITLE_BLOCK + legend.height : 0,
  }).extent(plan.bounds);
  const px = (x: number) => canvas.px(x);
  const py = (y: number) => canvas.py(y);

  for (const rp of plan.runs) {
    const d = headingVector(rp.heading);
    const n = interiorNormal(rp.heading);
    const at = (along: number, off = 0) => toPlane(rp, along, off);

    if (rp.island) {
      drawIslandOutline(canvas, rp, px, py);
    } else {
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

      // 墙角：让位那一侧画一条界线。让出来的那块地方**不是空的**——
      // 它被相邻那段墙的柜子占着，图上本来就看得见，再画一个方块只会盖住它。
      // 界线的作用是说明"这段墙的柜子为什么从这里才开始"。
      drawCornerLine(canvas, rp, layer, px, py);

      // 门洞旁台面让位：门洞两侧各让出台面端头外伸 + 门套线
      if (withCounter) drawDoorClearance(canvas, rp, px, py);
    }

    // 该段这一层的摆放
    const mine = placements
      .filter((p) => p.wallRunId === rp.run.id && p.layer === layer)
      .sort((a, b) => a.x - b.x);

    for (const p of mine) {
      const depth = p.depth || depthOf(rp, layer);
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

      // 开门方向弧线——客户判断"冰箱门开了会不会打到抽屉"靠的就是这个
      if (p.kind === "cabinet" && p.width >= 9) {
        const radius = Math.min(p.width, depth) * 0.85;
        const hinge = at(p.x, depth);
        canvas.add(swingArc(
          { x: px(hinge.x), y: py(hinge.y) },
          { dx: d.dx, dy: d.dy }, { dx: n.dx, dy: n.dy },
          canvas.len(radius)));
      }

      if (style.showLabels) drawLabel(canvas, p, at, depth, px, py);
    }

    // 台面外沿。**画在柜体之后**——它是一圈轮廓，压在柜体上才看得出哪里伸出去了
    if (withCounter && mine.length > 0) {
      for (const span of counterSpans(mine)) {
        drawCounterEdge(canvas, rp, span, px, py);
      }
      canvas.note("counterEdge");
    }

    if (style.showDimensions) drawRunDimensions(canvas, rp, mine, px, py);
  }

  // 过道尺寸：岛台到四周柜列的净空。**这是连起来才画得出的东西**。
  // 只画在地柜层：过道量的是台面外沿之间的距离，吊柜层上没有台面，
  // 把地柜层的数字标到吊柜图上，客户会以为那是吊柜之间的净空。
  if (style.showDimensions && withCounter) drawAisles(canvas, plan, px, py);

  canvas.heading(title);
  if (legend.svg) canvas.add(legend.svg);
  if (plan.note) canvas.footnote(plan.note);

  return canvas.toSvg();
}

type Mapper = (v: number) => number;

/** 图名占的高度（px）——图例从这里往下画。 */
const TITLE_BLOCK = 34;
const LEGEND_COLUMNS = 3;

function drawLabel(
  canvas: Canvas, p: Placement,
  at: (along: number, off?: number) => { x: number; y: number },
  depth: number, px: Mapper, py: Mapper,
): void {
  const ann = annotationFor(p);
  if (!ann) return;
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

/**
 * 墙角界线：这段墙的柜子从哪里开始。
 *
 * 让出来的那一块归相邻那段墙的柜子，图上已经画着它们了。这里只画一条虚线 +
 * 一个「转角」字样，说明这段墙的柜子为什么不是从墙角起排的——**没有这条线，
 * 让位看起来就像一个漏排的 bug。**
 */
function drawCornerLine(
  canvas: Canvas, rp: PlacedRun, layer: PlanLayer, px: Mapper, py: Mapper,
): void {
  const depth = depthOf(rp, layer);
  for (const [along, side] of cornerCuts(rp, layer)) {
    const a = toPlane(rp, along, 0);
    const b = toPlane(rp, along, depth);
    canvas.add(line(px(a.x), py(a.y), px(b.x), py(b.y), INK.note, 0.8, "3 3"));
    const label = toPlane(rp, along + (side === "start" ? -3 : 3), depth + 7);
    canvas.add(text(px(label.x), py(label.y), "Corner",
      { size: TYPE.code, fill: INK.note, middle: true }));
  }
}

/** 这一段这一层在哪几处被墙角切了一刀。 */
function cornerCuts(rp: PlacedRun, layer: PlanLayer): [number, "start" | "end"][] {
  const usable = usableSpan(rp, layer);
  const cuts: [number, "start" | "end"][] = [];
  if (usable.start > 0) cuts.push([usable.start, "start"]);
  if (usable.end < rp.run.length) cuts.push([usable.end, "end"]);
  return cuts;
}

/**
 * 门洞两侧的台面让位。
 *
 * 门洞本身由 `featureDoor` 画在墙线上；这里画的是**柜子必须再往后退的那一点**。
 * 客户说的「至少要让出一点点距离」，让的就是这一段：台面端头伸出 1-1/2"，
 * 加上门套线，柜子贴着门洞站的话台面会压在门套上。
 */
function drawDoorClearance(canvas: Canvas, rp: PlacedRun, px: Mapper, py: Mapper): void {
  for (const f of rp.run.features) {
    if (f.kind !== "door") continue;
    const span = doorSpan(f, "base");
    const depth = COUNTERTOP.frontOverhang + 2;
    const pts = [
      toPlane(rp, span.x, 0), toPlane(rp, span.x + span.width, 0),
      toPlane(rp, span.x + span.width, depth), toPlane(rp, span.x, depth),
    ].map((c) => ({ x: px(c.x), y: py(c.y) }));
    canvas.add(polygon(pts, {
      fill: "none", stroke: PALETTE.featureDoor.stroke, strokeWidth: 0.8,
      dash: "2 2", legend: "",
    }));
  }
}

/** 一段连续台面（段内坐标）。 */
interface CounterSpan { start: number; end: number; openStart: boolean; openEnd: boolean }

/** 把一层的构件并成若干段连续台面。 */
function counterSpans(mine: readonly Placement[]): CounterSpan[] {
  const spans: CounterSpan[] = [];
  let cur: CounterSpan | undefined;
  for (const p of mine) {
    if (!hasContinuousCounter(p)) { cur = undefined; continue; }
    if (cur && Math.abs(p.x - cur.end) < 0.26) {
      cur.end = p.x + p.width;
    } else {
      cur = { start: p.x, end: p.x + p.width, openStart: true, openEnd: true };
      spans.push(cur);
    }
  }
  return spans;
}

/**
 * 台面外沿轮廓。
 *
 * 前沿比柜体多伸 1-1/2"；两端如果是外露端头（不是顶着墙角/家电），也多伸
 * 1-1/2"。这一圈就是"台面到底占多大地方"的答案。
 */
function drawCounterEdge(
  canvas: Canvas, rp: PlacedRun, span: CounterSpan, px: Mapper, py: Mapper,
): void {
  const usable = usableSpan(rp, "base");
  // 顶着墙角的那一头不外伸——台面到墙就到头了
  const a = span.start - (span.start <= usable.start + 0.26 ? 0 : COUNTERTOP.endOverhang);
  const b = span.end + (span.end >= usable.end - 0.26 ? 0 : COUNTERTOP.endOverhang);
  const depth = depthOf(rp, "base") + COUNTERTOP.frontOverhang;
  const pts = [
    toPlane(rp, a, 0), toPlane(rp, b, 0), toPlane(rp, b, depth), toPlane(rp, a, depth),
  ].map((c) => ({ x: px(c.x), y: py(c.y) }));
  canvas.add(polygon(pts, PALETTE.counterEdge));
}

/** 岛台的外框：一圈实线 + 名字。岛台没有墙线，只有它自己的轮廓。 */
function drawIslandOutline(canvas: Canvas, rp: PlacedRun, px: Mapper, py: Mapper): void {
  const depth = depthOf(rp, "base");
  const pts = [
    toPlane(rp, 0, 0), toPlane(rp, rp.run.length, 0),
    toPlane(rp, rp.run.length, depth), toPlane(rp, 0, depth),
  ].map((c) => ({ x: px(c.x), y: py(c.y) }));
  canvas.add(polygon(pts, PALETTE.wall), "wall");
}

/** 逐柜宽度 + 墙段总长。客户要能核对"我家那面墙 168 寸，这些柜子加起来是多少"。 */
function drawRunDimensions(
  canvas: Canvas, rp: PlacedRun, mine: readonly Placement[], px: Mapper, py: Mapper,
): void {
  const OFF = -10; // 墙的外侧（室内在 +n 方向）
  for (const p of mine) {
    if (p.width < 9) continue;
    const a = toPlane(rp, p.x, OFF);
    const b = toPlane(rp, p.x + p.width, OFF);
    canvas.add(dimension({ x: px(a.x), y: py(a.y) }, { x: px(b.x), y: py(b.y) },
      formatInches(p.width)));
  }
  const mid = toPlane(rp, rp.run.length / 2, -22);
  canvas.add(text(px(mid.x), py(mid.y),
    `${rp.run.label} ${formatInches(rp.run.length)}`,
    { size: TYPE.label, fill: INK.label, middle: true }));
}

/**
 * 过道尺寸 —— 岛台到四周柜列的净空。
 *
 * 量的是**台面外沿之间**的距离，与 `ergonomics.ts` 的 `checkAisles` 同一个口径：
 * 图上标 42"、检查里判 42"，客户拿尺子量图也是 42"。三处不一致的话，
 * 客户会拿着图来问哪个数是真的。
 */
function drawAisles(canvas: Canvas, plan: KitchenPlan, px: Mapper, py: Mapper): void {
  const islands = plan.runs.filter((r) => r.island);
  if (islands.length === 0) return;

  for (const island of islands) {
    const a = counterRect(island);
    for (const other of plan.runs) {
      if (other === island || other.island) continue;
      const b = counterRect(other);
      const seg = aisleSegment(a, b);
      if (!seg) continue;
      canvas.add(dimension(
        { x: px(seg.from.x), y: py(seg.from.y) },
        { x: px(seg.to.x), y: py(seg.to.y) },
        `Aisle ${formatInches(seg.gap)}`));
    }
  }
}

function counterRect(rp: PlacedRun): Rect {
  const depth = depthOf(rp, "base") + COUNTERTOP.frontOverhang;
  const front = rp.island ? COUNTERTOP.frontOverhang : 0;
  const p1 = toPlane(rp, 0, -front);
  const p2 = toPlane(rp, rp.run.length, depth);
  return {
    minX: Math.min(p1.x, p2.x), maxX: Math.max(p1.x, p2.x),
    minY: Math.min(p1.y, p2.y), maxY: Math.max(p1.y, p2.y),
  };
}

/**
 * 两块台面之间那条过道的标注线。
 *
 * 只在两者**正对着**的时候画：错开的两列之间没有"过道"可言，硬标一条尺寸线
 * 只会让客户以为那里有条走不通的路。
 */
function aisleSegment(
  a: Rect, b: Rect,
): { from: { x: number; y: number }; to: { x: number; y: number }; gap: number } | undefined {
  const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);

  if (overlapX > 0 && overlapY <= 0) {
    const x = (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2;
    const [lo, hi] = a.maxY <= b.minY ? [a.maxY, b.minY] : [b.maxY, a.minY];
    return { from: { x, y: lo }, to: { x, y: hi }, gap: hi - lo };
  }
  if (overlapY > 0 && overlapX <= 0) {
    const y = (Math.max(a.minY, b.minY) + Math.min(a.maxY, b.maxY)) / 2;
    const [lo, hi] = a.maxX <= b.minX ? [a.maxX, b.minX] : [b.maxX, a.minX];
    return { from: { x: lo, y }, to: { x: hi, y }, gap: hi - lo };
  }
  return undefined;
}

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
  withCounter = layer === "base",
): ElementKind[] {
  const kinds = new Set<ElementKind>();
  for (const run of geometry.wallRuns) {
    if (run.length <= 0) continue;
    kinds.add("wall");
    for (const f of run.features) kinds.add(featureKindOf(f));
    for (const p of placements) {
      if (p.wallRunId === run.id && p.layer === layer) {
        kinds.add(elementKindOf(p));
        if (withCounter && hasContinuousCounter(p)) kinds.add("counterEdge");
      }
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
  const plan = buildKitchenPlan(geometry);
  return {
    base: renderPlanView(geometry, placements, "base", style),
    wall: renderPlanView(geometry, placements, "wall", style),
    ...(plan.note ? { note: plan.note } : {}),
  };
}
