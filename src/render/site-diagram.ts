/**
 * 现场块图（讨论用）—— FR-19 / 柜列统一画法。
 *
 * 用户上传草图后，不立刻出完整设计俯视图，而是用与柜体同一套平面模型
 *（`buildKitchenPlan` + 地柜进深块）拼出可讨论的户型图：
 *   - 每段墙 = 一串可改尺寸的 base 进深块（默认 24" 模块视觉）
 *   - 墙长尺寸链、窗/门/上下水特征、岛台块、层高、Q#
 *
 * 与最终 `plan-view` 共用 palette / primitives / plan-model，避免「两套软件」感。
 */
import type { ParsedGeometry, WallFeature } from "../floorplan/types.js";
import { isIsland } from "../floorplan/types.js";
import {
  DEFAULT_ISLAND_DEPTH, LAYER_DEPTH, buildKitchenPlan, footprint, toPlane,
  type PlacedRun,
} from "../layout/plan-model.js";
import type { SiteQuestion } from "../design/site-questions.js";
import { Canvas, PAD } from "./kernel/canvas.js";
import { PALETTE, INK, TYPE, STROKE, featureKindOf } from "./kernel/palette.js";
import {
  dimension, formatInches, line, polygon, rect, text,
} from "./kernel/primitives.js";
import { renderLegend } from "./kernel/legend.js";

const TITLE_BLOCK = 36;
const Q_COLOR = "#b45309";
/** 讨论图上地柜块的视觉模块宽（英寸）——便于看出「块可改」。 */
const BLOCK_MODULE = 24;

export interface SiteDiagramResult {
  svg: string;
  /** 出现在 SVG 文本节点里的墙标签（验收用）。 */
  wallLabels: string[];
  questionMarks: string[];
}

/**
 * 画现场块图。无墙段时返回占位说明。
 */
export function renderSiteDiagram(
  geometry: ParsedGeometry,
  siteQuestions: readonly SiteQuestion[] = [],
): SiteDiagramResult {
  const wallLabels = geometry.wallRuns.map((r) => r.label);
  const questionMarks = siteQuestions.map((q) => `Q${q.q}`);

  if (geometry.wallRuns.length === 0) {
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="88" viewBox="0 0 360 88">`,
      `<rect width="360" height="88" fill="#fff"/>`,
      `<text x="16" y="40" fill="${INK.note}" font-size="13">No walls read — upload a clearer sketch or enter walls in chat</text>`,
      `<text x="16" y="62" fill="${INK.code}" font-size="11">See /samples/sample-floorplan-minimal.png</text>`,
      `</svg>`,
    ].join("");
    return { svg, wallLabels, questionMarks };
  }

  const plan = buildKitchenPlan(geometry);
  const legendKinds = ["cabinet", "wall"] as import("./kernel/palette.js").ElementKind[];
  for (const run of geometry.wallRuns) {
    for (const f of run.features) legendKinds.push(featureKindOf(f));
  }
  const legendProbe = renderLegend(legendKinds, PAD, TITLE_BLOCK, 3);
  const header = TITLE_BLOCK + Math.max(legendProbe.height, 20) + 8;

  const canvas = new Canvas({
    pxPerInch: 2.2,
    title: "Site blocks · discuss",
    header,
  }).extent({
    minX: plan.bounds.minX - 16,
    minY: plan.bounds.minY - 16,
    maxX: plan.bounds.maxX + 28,
    maxY: plan.bounds.maxY + 20,
  });

  const px = (x: number) => canvas.px(x);
  const py = (y: number) => canvas.py(y);

  canvas.heading("Site blocks · discuss");
  canvas.add(text(PAD, 34, "Editable run blocks · confirm dims & openings · answer Q# in chat", {
    size: TYPE.note, fill: INK.note, anchor: "start",
  }));
  const legend = renderLegend(legendKinds, PAD, TITLE_BLOCK + 6, 3);
  if (legend.svg) canvas.add(legend.svg);

  for (const rp of plan.runs) {
    drawRunBlocks(canvas, rp, px, py);
    drawWallLine(canvas, rp, px, py);
    drawFeatures(canvas, rp, px, py);
    drawRunDimension(canvas, rp, px, py);
    drawRunLabel(canvas, rp, px, py);
  }

  if (geometry.ceilingHeight != null) {
    canvas.add(text(
      px(plan.bounds.minX),
      py(plan.bounds.maxY) + 18,
      `Ceiling ${formatInches(geometry.ceilingHeight)}`,
      { size: TYPE.label, fill: INK.label, anchor: "start", weight: 600 },
    ));
  }

  if (!plan.connected) {
    canvas.footnote("Schematic arrangement — corners not chained; confirm which walls meet.");
  }

  let orphanY = plan.bounds.minY;
  for (const q of siteQuestions) {
    const mark = `Q${q.q}`;
    const run = q.wallRunId
      ? plan.runs.find((r) => r.run.id === q.wallRunId)
      : undefined;
    if (run) {
      const at = toPlane(run, run.run.length * 0.35, (run.island ? 0 : LAYER_DEPTH.base) + 10);
      canvas.add(text(px(at.x), py(at.y), mark, {
        size: TYPE.label, fill: Q_COLOR, anchor: "middle", weight: 700,
      }));
    } else {
      canvas.add(text(
        px(plan.bounds.maxX + 6),
        py(orphanY),
        `${mark} ${q.mark}`,
        { size: TYPE.note, fill: Q_COLOR, anchor: "start" },
      ));
      orphanY += 8;
    }
  }

  return { svg: canvas.toSvg(), wallLabels, questionMarks };
}

function drawWallLine(
  canvas: Canvas,
  rp: PlacedRun,
  px: (n: number) => number,
  py: (n: number) => number,
): void {
  const end = toPlane(rp, rp.run.length);
  canvas.add(line(
    px(rp.origin.x), py(rp.origin.y),
    px(end.x), py(end.y),
    PALETTE.wall.stroke, STROKE.wall,
  ), "wall");
}

/** 沿墙拼地柜进深块（或岛台块）。 */
function drawRunBlocks(
  canvas: Canvas,
  rp: PlacedRun,
  px: (n: number) => number,
  py: (n: number) => number,
): void {
  const depth = rp.island
    ? (rp.run.depth ?? DEFAULT_ISLAND_DEPTH)
    : LAYER_DEPTH.base;
  const len = rp.run.length;
  if (len <= 0) return;

  let along = 0;
  while (along < len - 1e-6) {
    const w = Math.min(BLOCK_MODULE, len - along);
    const box = footprint(rp, along, w, depth);
    canvas.add(rect(
      px(box.minX), py(box.minY),
      canvas.len(box.maxX - box.minX), canvas.len(box.maxY - box.minY),
      PALETTE.cabinet,
    ), "cabinet");
    // 块缝——强调可拆改
    if (along > 0) {
      const a = toPlane(rp, along, 0);
      const b = toPlane(rp, along, depth);
      canvas.add(line(px(a.x), py(a.y), px(b.x), py(b.y), "#cfc8b8", 0.7));
    }
    along += w;
  }

  if (rp.island) {
    const mid = toPlane(rp, len / 2, depth / 2);
    canvas.add(text(px(mid.x), py(mid.y), `Island ${formatInches(len)}×${formatInches(depth)}`, {
      size: TYPE.code, fill: INK.code, middle: true, weight: 600,
    }));
  }
}

function drawFeatures(
  canvas: Canvas,
  rp: PlacedRun,
  px: (n: number) => number,
  py: (n: number) => number,
): void {
  for (const f of rp.run.features) {
    drawFeature(canvas, rp, f, px, py);
  }
}

function drawFeature(
  canvas: Canvas,
  rp: PlacedRun,
  f: WallFeature,
  px: (n: number) => number,
  py: (n: number) => number,
): void {
  const kind = featureKindOf(f);
  const style = PALETTE[kind];
  const width = Math.max(f.width, f.kind === "plumbing" ? 18 : 6);
  const a = toPlane(rp, f.offset, 0);
  const b = toPlane(rp, f.offset + width, 0);
  canvas.add(line(px(a.x), py(a.y), px(b.x), py(b.y), style.stroke, style.strokeWidth), kind);

  const labelAt = toPlane(rp, f.offset + width / 2, -6);
  const short = featureShort(f);
  canvas.add(text(px(labelAt.x), py(labelAt.y), short, {
    size: TYPE.code, fill: style.stroke, anchor: "middle", weight: 600,
  }));

  if (f.kind === "door") {
    const clear = footprint(rp, f.offset, Math.max(f.width, 1), 4);
    canvas.add(polygon([
      { x: px(clear.minX), y: py(clear.minY) },
      { x: px(clear.maxX), y: py(clear.minY) },
      { x: px(clear.maxX), y: py(clear.maxY) },
      { x: px(clear.minX), y: py(clear.maxY) },
    ], {
      fill: "none", stroke: style.stroke, strokeWidth: 0.8, dash: "2 2", legend: "",
    }));
  }
}

function featureShort(f: WallFeature): string {
  const w = f.width > 0 ? formatInches(f.width) : "";
  switch (f.kind) {
    case "window": return w ? `W ${w}` : "W";
    case "door": return w ? `Door ${w}` : "Door";
    case "plumbing": return w ? `Sink ${w}` : "Sink";
    case "gas": return "Gas";
    case "electrical": return "Elec";
    default: return f.kind;
  }
}

function drawRunDimension(
  canvas: Canvas,
  rp: PlacedRun,
  px: (n: number) => number,
  py: (n: number) => number,
): void {
  if (rp.run.length <= 0) return;
  const depth = rp.island
    ? (rp.run.depth ?? DEFAULT_ISLAND_DEPTH)
    : LAYER_DEPTH.base;
  // 尺寸线放在墙外侧（负 offset）
  const a = toPlane(rp, 0, rp.island ? depth + 8 : -10);
  const b = toPlane(rp, rp.run.length, rp.island ? depth + 8 : -10);
  canvas.add(dimension(
    { x: px(a.x), y: py(a.y) },
    { x: px(b.x), y: py(b.y) },
    formatInches(rp.run.length),
  ));
}

function drawRunLabel(
  canvas: Canvas,
  rp: PlacedRun,
  px: (n: number) => number,
  py: (n: number) => number,
): void {
  if (isIsland(rp.run)) return;
  const depth = LAYER_DEPTH.base;
  const mid = toPlane(rp, rp.run.length / 2, depth / 2);
  canvas.add(text(px(mid.x), py(mid.y), rp.run.label, {
    size: TYPE.label, fill: INK.label, anchor: "middle", weight: 600,
  }));
}
