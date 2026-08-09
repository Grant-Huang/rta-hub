/**
 * 四视图渲染 —— FR-5、REQUIREMENTS 3.3、docs/RENDERING.md。
 *
 * 正视图 / 俯视图-地柜层 / 俯视图-吊柜层 / 侧视图。
 *
 * 与脸型文法同一条原则（RENDERING.md 4.1/4.2）：
 *   **一律计算绝对英寸坐标后再乘以固定的 px/inch，绝不用 transform="scale()"**。
 *   缩放会把门缝、面框、标注线宽这些绝对量一起放大。
 *
 * 颜色、线宽、字号、尺寸标注、转义都来自 `kernel/`（RENDERING.md §8）——
 * 这个文件与 `plan-view.ts` 共用同一套绘图约定，客户并排看两组图时
 * 同一个东西是同一个样子。
 */
import { HEIGHTS, type Placement } from "../layout/generate.js";
import type { WallRun } from "../floorplan/types.js";
import { layoutFace, toSvg as faceToSvg, type RenderStyle } from "./face-grammar.js";
import { buildFace, matchFaceTemplate, type FaceTemplateId } from "./templates.js";
import { PALETTE, INK, TYPE, STROKE, elementKindOf, featureKindOf } from "./kernel/palette.js";
import {
  dimension as kDimension, esc, formatInches as kFormatInches, line as kLine,
  r as kRound, rect as kRect, styleAttrs, swingArc, text as kText,
} from "./kernel/primitives.js";
import { annotationFor, fitsText } from "./kernel/annotate.js";

/** 英寸格式化——内核那一份的再导出，调用方不必知道它搬了家。 */
export const formatInches = kFormatInches;

export interface ViewStyle extends RenderStyle {
  pxPerInch: number;
  showDimensions: boolean;
}

export const DEFAULT_VIEW_STYLE: ViewStyle = {
  overlay: "full",
  construction: "framed",
  faceFrameWidth: 1.5,
  pxPerInch: 6,
  showDimensions: true,
};

/** 给标注留的边距（px）。与全局俯视图同值——并排看时两张图才对得齐。 */
const PAD = 48;

interface Ctx {
  s: number;           // px per inch
  parts: string[];
  style: ViewStyle;
}

/**
 * 左边距要另算。
 *
 * 「台面 36"」这类竖向尺寸标注写在图的左侧，文字往左伸出去——按四边等距留边，
 * 它会被画布裁掉半截。裁掉的恰恰是尺寸，而尺寸是这张图的主要内容。
 */
const PAD_LEFT_WITH_DIMENSION = 68;

function open(
  widthIn: number, heightIn: number, style: ViewStyle, title: string,
  opts: { padLeft?: number; padBottom?: number } = {},
): Ctx {
  const s = style.pxPerInch;
  const padLeft = opts.padLeft ?? PAD;
  const padBottom = opts.padBottom ?? PAD;
  const w = widthIn * s + padLeft + PAD;
  const h = heightIn * s + PAD + padBottom;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(w)} ${r(h)}" width="${r(w)}" ` +
    `height="${r(h)}" role="img" aria-label="${escAttr(title)}">`,
    `<title>${escAttr(title)}</title>`,
    `<rect width="${r(w)}" height="${r(h)}" fill="#ffffff"/>`,
    `<g transform="translate(${padLeft},${PAD})">`,
  ];
  return { s, parts, style };
}

function close(ctx: Ctx): string {
  ctx.parts.push("</g></svg>");
  return ctx.parts.join("");
}

const r = kRound;

function escAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

/**
 * 尺寸标注 —— 画法归内核，这里只把英寸坐标换算成 px 并让开一个偏移。
 *
 * `offset` 是标注线离被标注对象的距离（px）：水平标注往下让，垂直标注往右让。
 */
function dimension(
  ctx: Ctx,
  a: { x: number; y: number },
  b: { x: number; y: number },
  label: string,
  offset = 0,
): void {
  const { s } = ctx;
  const horizontal = Math.abs(a.y - b.y) < 1e-9;
  const dy = horizontal ? offset : 0;
  const dx = horizontal ? 0 : offset;
  ctx.parts.push(kDimension(
    { x: a.x * s + dx, y: a.y * s + dy },
    { x: b.x * s + dx, y: b.y * s + dy },
    label,
  ));
}

// ── 正视图 ────────────────────────────────────────────────────────────────

/**
 * 正视图：一段墙的立面。
 *
 * 每个柜体调用脸型文法算出门/抽屉的绝对坐标，再平移到它在墙上的位置。
 * 平移是纯加法，不涉及缩放，所以门缝仍是绝对的 1/4"。
 *
 * 脸型取自 `Placement.faceTemplateId`（规格库带过来的）；`faceTemplateOf` 只是
 * 没有该字段时的兜底。
 */
export function renderFrontElevation(
  run: WallRun,
  placements: readonly Placement[],
  style: ViewStyle = DEFAULT_VIEW_STYLE,
  faceTemplateOf: (code: string) => FaceTemplateId | undefined = (code) => matchFaceTemplate(code)?.templateId,
): string {
  const mine = placements.filter((p) => p.wallRunId === run.id);
  const wallTop = Math.max(
    // 叠装的上段要按它的底边算总高，否则画布顶边会裁掉最上面那一段
    ...mine.filter((p) => p.layer === "wall")
      .map((p) => HEIGHTS.wallBaseline + (p.stackBase ?? 0) + p.height),
    HEIGHTS.counterTop,
  );
  const viewHeight = wallTop + 6;
  const ctx = open(run.length, viewHeight, style, `${run.label} — Front elevation`, {
    // 左侧要放「台面 36"」，底下要放两行柜体标注 + 一条总长尺寸线
    padLeft: style.showDimensions ? PAD_LEFT_WITH_DIMENSION : PAD,
    padBottom: PAD + 24,
  });

  // 地面与墙体轮廓
  ctx.parts.push(kLine(0, viewHeight * ctx.s, run.length * ctx.s, viewHeight * ctx.s,
    INK.ground, STROKE.ground));

  const yOf = (topInches: number) => (viewHeight - topInches) * ctx.s;

  for (const p of mine) {
    if (p.layer === "base") {
      const top = p.kind === "cabinet" || p.kind === "filler" ? HEIGHTS.baseBox : HEIGHTS.baseBox;
      drawBox(ctx, p, p.x, yOf(top), p.width, p.height - (p.kind === "cabinet" ? HEIGHTS.toeKick : 0), faceTemplateOf, style, HEIGHTS.toeKick);
    } else if (p.layer === "wall") {
      // `stackBase` 是这一段的底边（从吊柜基准线往上量）。叠装的上段落在
      // 下段顶上，两段各自是一个真实型号、各自有一扇门
      const top = HEIGHTS.wallBaseline + (p.stackBase ?? 0) + p.height;
      drawBox(ctx, p, p.x, yOf(top), p.width, p.height, faceTemplateOf, style, 0);
    } else {
      drawBox(ctx, p, p.x, yOf(p.height), p.width, p.height, faceTemplateOf, style, HEIGHTS.toeKick);
    }
  }

  // ── 叠装的横向接缝 ──
  //
  // 客户看到的成品上那是一条**实实在在的线**，图上没有就是图画错了
  // （RENDERING.md §8.5）。同一面墙的横缝高度一致是软约束（CATALOG_MODEL §3.2），
  // 不一致时这里会画出一条锯齿线——**那正是要让它在图上可验证**。
  for (const p of mine) {
    if (p.layer !== "wall" || !p.stackBase) continue;
    const seam = HEIGHTS.wallBaseline + p.stackBase;
    ctx.parts.push(kLine(
      p.x * ctx.s, yOf(seam), (p.x + p.width) * ctx.s, yOf(seam),
      INK.ground, STROKE.ground));
  }

  // 台面
  const counterY = yOf(HEIGHTS.counterTop);
  ctx.parts.push(kRect(0, counterY, run.length * ctx.s, HEIGHTS.counterThickness * ctx.s,
    PALETTE.counter));

  if (style.showDimensions) {
    // 总长尺寸线让到柜体标注下面——压在标注上等于两行字叠着，谁也读不出来
    dimension(ctx, { x: 0, y: viewHeight }, { x: run.length, y: viewHeight }, formatInches(run.length), 46);
    dimension(ctx, { x: 0, y: viewHeight }, { x: 0, y: viewHeight - HEIGHTS.counterTop }, `Counter ${formatInches(HEIGHTS.counterTop)}`, -14);
    const wallCab = mine.find((p) => p.layer === "wall");
    if (wallCab) {
      dimension(ctx, { x: run.length, y: viewHeight - HEIGHTS.counterTop },
        { x: run.length, y: viewHeight - HEIGHTS.wallBaseline }, `Clearance ${formatInches(HEIGHTS.backsplash)}`, 16);
    }
  }

  return close(ctx);
}

function drawBox(
  ctx: Ctx,
  p: Placement,
  xIn: number,
  yPx: number,
  wIn: number,
  hIn: number,
  faceTemplateOf: (code: string) => FaceTemplateId | undefined,
  style: ViewStyle,
  toeKick: number,
): void {
  const { s } = ctx;
  const x = xIn * s;
  const kind = elementKindOf(p);

  if (p.kind === "appliance") {
    const ann = annotationFor(p);
    ctx.parts.push(kRect(x, yPx, wIn * s, hIn * s, PALETTE.appliance));
    if (ann) {
      const cx = x + (wIn * s) / 2;
      const cy = yPx + (hIn * s) / 2;
      const two = ann.secondary !== undefined && fitsText(wIn, 2);
      ctx.parts.push(kText(cx, two ? cy - 6 : cy, ann.primary,
        { size: TYPE.label, fill: INK.code, middle: true }));
      if (two) {
        ctx.parts.push(kText(cx, cy + 7, ann.secondary!,
          { size: TYPE.code, fill: INK.code, middle: true }));
      }
    }
    return;
  }

  if (p.kind === "filler") {
    ctx.parts.push(kRect(x, yPx, wIn * s, hIn * s, PALETTE.filler));
    return;
  }

  // 柜体：用脸型文法生成门/抽屉分格，再平移过来。
  // **优先用规格库带过来的 faceTemplateId**——公司可能用自有命名或显式指定过脸型，
  // 从 SKU 码重新推导会丢掉覆盖表的映射（RENDERING.md 第 5 节）。
  const templateId = (p.faceTemplateId as FaceTemplateId | undefined)
    ?? (p.moduleCode ? faceTemplateOf(p.moduleCode) : undefined);
  if (templateId) {
    const layout = layoutFace(buildFace(templateId, {}), wIn, hIn, style);
    const inner = faceToSvg(layout, { pxPerInch: s, title: p.moduleCode ?? "" });
    // 抽出内层 <g> 的内容并平移到位（不缩放）
    const body = inner.slice(inner.indexOf("<g "), inner.lastIndexOf("</g>") + 4)
      .replace(/^<g transform="translate\([^)]*\)"/, `<g transform="translate(${r(x)},${r(yPx)})"`);
    ctx.parts.push(body);
    // 水槽柜与配套柜在脸型之外再叠一层淡色，与全局俯视图用的是同一个颜色——
    // 客户在两张图上找同一个柜子时，认的就是这个颜色
    if (kind === "sinkBase" || kind === "applianceCabinet") {
      ctx.parts.push(
        `<rect x="${r(x)}" y="${r(yPx)}" width="${r(wIn * s)}" height="${r(hIn * s)}" ` +
        `fill="${PALETTE[kind].fill}" fill-opacity="0.45" stroke="none"/>`);
    }
  } else {
    ctx.parts.push(kRect(x, yPx, wIn * s, hIn * s, PALETTE[kind]));
  }

  // 踢脚线：与柜体同宽对齐。此前左侧缩进 3" 只缩宽度、不缩进深，
  // 正视图上踢脚与柜脚错位（客户看到的「地脚偏差」）。
  if (toeKick > 0) {
    const kickY = yPx + hIn * s;
    ctx.parts.push(kRect(x, kickY, wIn * s, toeKick * s, PALETTE.toeKick));
  }

  // 标注：水槽写"水槽"、配套柜写它配的是哪台家电，普通柜体写型号码。
  // 以前一律只写 moduleCode——客户在图上找不到水槽在哪。
  const ann = annotationFor(p);
  if (ann) {
    const baseY = yPx + hIn * s + toeKick * s + 11;
    ctx.parts.push(kText(x + (wIn * s) / 2, baseY, ann.primary,
      { size: TYPE.code, fill: INK.code }));
    if (ann.secondary && fitsText(wIn, 2)) {
      ctx.parts.push(kText(x + (wIn * s) / 2, baseY + 10, ann.secondary,
        { size: TYPE.code, fill: INK.code }));
    }
  }
}

// ── 俯视图 ────────────────────────────────────────────────────────────────

export type TopLayer = "base" | "wall";

/**
 * 俯视图（地柜层 / 吊柜层分开出图）。
 *
 * 模板只有三种形状（RENDERING.md 3.3）：矩形、转角斜切、盲角 L。
 * 再叠一层开门弧线示意——弧线是等比图元，可以安全缩放。
 */
export function renderTopView(
  run: WallRun,
  placements: readonly Placement[],
  layer: TopLayer,
  style: ViewStyle = DEFAULT_VIEW_STYLE,
): string {
  const mine = placements.filter((p) => p.wallRunId === run.id && p.layer === layer);
  const depth = Math.max(...mine.map((p) => p.depth), layer === "base" ? 24 : 12);
  const ctx = open(run.length, depth + 4, style, `${run.label} — Plan (${layer === "base" ? "base" : "wall"})`);
  const { s } = ctx;

  // 墙线
  ctx.parts.push(kLine(0, 0, run.length * s, 0, PALETTE.wall.stroke, STROKE.wall));

  // 墙上的特征——全局俯视图一直画着，单墙俯视图以前没有。
  // 客户在两张图上看同一面墙，一张标了窗一张没标，就会怀疑哪张是错的。
  for (const f of run.features) {
    const kind = featureKindOf(f);
    ctx.parts.push(kLine(f.offset * s, 0, (f.offset + Math.max(f.width, 2)) * s, 0,
      PALETTE[kind].stroke, PALETTE[kind].strokeWidth));
  }

  for (const p of mine) {
    const x = p.x * s;
    const w = p.width * s;
    const d = p.depth * s;
    const kind = elementKindOf(p);
    ctx.parts.push(kRect(x, 0, w, d, PALETTE[kind]));

    // 开门弧线示意（只对柜体画）。≥24" 双门各半宽，与全局俯视图一致。
    if (p.kind === "cabinet" && p.width >= 9) {
      const leaf = p.width >= 24 ? p.width / 2 : p.width;
      const radius = Math.min(leaf, p.depth) * 0.85 * s;
      ctx.parts.push(swingArc({ x, y: d }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, radius));
      if (p.width >= 24) {
        ctx.parts.push(swingArc(
          { x: x + w, y: d }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, radius));
      }
    }

    const ann = annotationFor(p);
    if (ann && fitsText(p.width, 1)) {
      const two = ann.secondary !== undefined && fitsText(p.width, 2);
      ctx.parts.push(kText(x + w / 2, d / 2 - (two ? 5 : 0), ann.primary,
        { size: TYPE.code, fill: INK.code, middle: true }));
      if (two) {
        ctx.parts.push(kText(x + w / 2, d / 2 + 6, ann.secondary!,
          { size: TYPE.code, fill: INK.code, middle: true }));
      }
    }
  }

  if (style.showDimensions) {
    dimension(ctx, { x: 0, y: depth + 2 }, { x: run.length, y: depth + 2 }, formatInches(run.length), 12);
    dimension(ctx, { x: 0, y: 0 }, { x: 0, y: depth }, formatInches(depth), -12);
  }
  return close(ctx);
}

// ── 侧视图 ────────────────────────────────────────────────────────────────

export type SideSection = "base" | "wall" | "tall" | "deepWall";

/**
 * 侧视图截面。
 *
 * 与脸型完全解耦——同一趟柜子复用同一个截面（RENDERING.md 第 2 节已核实）。
 * 标注的是规范文档第一节的标准建筑高度。
 */
export function renderSideView(
  section: SideSection,
  style: ViewStyle = DEFAULT_VIEW_STYLE,
  opts: { wallCabinetHeight?: number; tallHeight?: number } = {},
): string {
  const wallH = opts.wallCabinetHeight ?? 30;
  const tallH = opts.tallHeight ?? 84;

  const spec = {
    base: { depth: 24, top: HEIGHTS.counterTop },
    wall: { depth: 12, top: HEIGHTS.wallBaseline + wallH },
    tall: { depth: 24, top: tallH },
    deepWall: { depth: 24, top: HEIGHTS.wallBaseline + wallH },
  }[section];

  const ctx = open(spec.depth + 6, spec.top + 6, style, `Side section (${section})`);
  const { s } = ctx;
  const H = spec.top + 6;
  const yOf = (topIn: number) => (H - topIn) * s;

  // 地面与墙
  ctx.parts.push(
    kLine(0, H * s, (spec.depth + 6) * s, H * s, INK.ground, STROKE.ground),
    kLine(0, 0, 0, H * s, PALETTE.wall.stroke, STROKE.wall),
  );

  if (section === "base" || section === "tall") {
    const boxTop = section === "base" ? HEIGHTS.baseBox : tallH;
    // 踢脚线内缩 3"（规范文档：4-1/2"H × 3"D）
    ctx.parts.push(
      kRect(0, yOf(boxTop), spec.depth * s, (boxTop - HEIGHTS.toeKick) * s, PALETTE.cabinet),
      kRect(0, yOf(HEIGHTS.toeKick), (spec.depth - 3) * s, HEIGHTS.toeKick * s, PALETTE.toeKick),
    );
    if (section === "base") {
      // 台面外延 1"（规范文档第二节）
      ctx.parts.push(kRect(0, yOf(HEIGHTS.counterTop), (spec.depth + 1) * s,
        HEIGHTS.counterThickness * s, PALETTE.counter));
    }
  } else {
    ctx.parts.push(kRect(0, yOf(HEIGHTS.wallBaseline + wallH), spec.depth * s,
      wallH * s, PALETTE.cabinet));
  }

  if (style.showDimensions) {
    if (section === "base") {
      dimension(ctx, { x: spec.depth + 4, y: H }, { x: spec.depth + 4, y: H - HEIGHTS.toeKick }, formatInches(HEIGHTS.toeKick), 0);
      dimension(ctx, { x: spec.depth + 4, y: H }, { x: spec.depth + 4, y: H - HEIGHTS.counterTop }, formatInches(HEIGHTS.counterTop), 30);
      dimension(ctx, { x: 0, y: H }, { x: spec.depth, y: H }, formatInches(spec.depth), 16);
    } else if (section === "wall" || section === "deepWall") {
      dimension(ctx, { x: spec.depth + 4, y: H - HEIGHTS.wallBaseline }, { x: spec.depth + 4, y: H - HEIGHTS.wallBaseline - wallH }, formatInches(wallH), 0);
      dimension(ctx, { x: spec.depth + 4, y: H }, { x: spec.depth + 4, y: H - HEIGHTS.wallBaseline }, `Bottom ${formatInches(HEIGHTS.wallBaseline)}`, 30);
      dimension(ctx, { x: 0, y: H }, { x: spec.depth, y: H }, formatInches(spec.depth), 16);
    } else {
      dimension(ctx, { x: spec.depth + 4, y: H }, { x: spec.depth + 4, y: H - tallH }, formatInches(tallH), 0);
    }
  }

  return close(ctx);
}

// ── 四视图打包 ────────────────────────────────────────────────────────────

export interface FourViews {
  front: string;
  topBase: string;
  topWall: string;
  side: string;
}

/** 生成一段墙的四张图（FR-5）。 */
export function renderFourViews(
  run: WallRun,
  placements: readonly Placement[],
  style: ViewStyle = DEFAULT_VIEW_STYLE,
): FourViews {
  const wallCab = placements.find((p) => p.wallRunId === run.id && p.layer === "wall");
  return {
    front: renderFrontElevation(run, placements, style),
    topBase: renderTopView(run, placements, "base", style),
    topWall: renderTopView(run, placements, "wall", style),
    side: renderSideView("base", style, wallCab ? { wallCabinetHeight: wallCab.height } : {}),
  };
}
