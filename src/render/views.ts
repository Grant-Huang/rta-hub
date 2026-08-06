/**
 * 四视图渲染 —— FR-5、REQUIREMENTS 3.3、docs/RENDERING.md。
 *
 * 正视图 / 俯视图-地柜层 / 俯视图-吊柜层 / 侧视图。
 *
 * 与脸型文法同一条原则（RENDERING.md 4.1/4.2）：
 *   **一律计算绝对英寸坐标后再乘以固定的 px/inch，绝不用 transform="scale()"**。
 *   缩放会把门缝、面框、标注线宽这些绝对量一起放大。
 */
import { HEIGHTS, type Placement } from "../layout/generate.js";
import type { WallRun } from "../floorplan/types.js";
import { layoutFace, toSvg as faceToSvg, type RenderStyle } from "./face-grammar.js";
import { buildFace, matchFaceTemplate, type FaceTemplateId } from "./templates.js";

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

const PAD = 44; // 给标注留的边距（px）

interface Ctx {
  s: number;           // px per inch
  parts: string[];
  style: ViewStyle;
}

function open(widthIn: number, heightIn: number, style: ViewStyle, title: string): Ctx {
  const s = style.pxPerInch;
  const w = widthIn * s + PAD * 2;
  const h = heightIn * s + PAD * 2;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(w)} ${r(h)}" width="${r(w)}" height="${r(h)}">`,
    `<title>${esc(title)}</title>`,
    `<rect width="${r(w)}" height="${r(h)}" fill="#ffffff"/>`,
    `<g transform="translate(${PAD},${PAD})">`,
  ];
  return { s, parts, style };
}

function close(ctx: Ctx): string {
  ctx.parts.push("</g></svg>");
  return ctx.parts.join("");
}

function r(n: number): number { return Math.round(n * 100) / 100; }

/**
 * XML **文本节点**转义。只处理 `&`、`<`、`>`——文本里的引号无需转义，
 * 而尺寸标注里到处是英寸符号（`36"`），转成 `&quot;` 只会让输出难读。
 */
function esc(str: string): string {
  return str.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}

/** 尺寸标注：带箭头端点的水平/垂直标注线。线宽固定，不随比例变化。 */
function dimension(
  ctx: Ctx,
  a: { x: number; y: number },
  b: { x: number; y: number },
  label: string,
  offset = 0,
): void {
  const { s } = ctx;
  const horizontal = a.y === b.y;
  const x1 = a.x * s, y1 = a.y * s + (horizontal ? offset : 0);
  const x2 = b.x * s, y2 = b.y * s + (horizontal ? offset : 0);
  const ox = horizontal ? 0 : offset;

  ctx.parts.push(
    `<line x1="${r(x1 + ox)}" y1="${r(y1)}" x2="${r(x2 + ox)}" y2="${r(y2)}" stroke="#666" stroke-width="0.75"/>`,
    tick(x1 + ox, y1, horizontal), tick(x2 + ox, y2, horizontal),
  );
  const mx = (x1 + x2) / 2 + ox;
  const my = (y1 + y2) / 2;
  ctx.parts.push(
    horizontal
      ? `<text x="${r(mx)}" y="${r(my - 3)}" font-size="9" fill="#444" text-anchor="middle" font-family="sans-serif">${esc(label)}</text>`
      : `<text x="${r(mx - 4)}" y="${r(my)}" font-size="9" fill="#444" text-anchor="end" dominant-baseline="middle" font-family="sans-serif">${esc(label)}</text>`,
  );
}

function tick(x: number, y: number, horizontal: boolean): string {
  return horizontal
    ? `<line x1="${r(x)}" y1="${r(y - 3)}" x2="${r(x)}" y2="${r(y + 3)}" stroke="#666" stroke-width="0.75"/>`
    : `<line x1="${r(x - 3)}" y1="${r(y)}" x2="${r(x + 3)}" y2="${r(y)}" stroke="#666" stroke-width="0.75"/>`;
}

/** 把英寸格式化成行业写法：34.5 → 34-1/2"。 */
export function formatInches(value: number): string {
  const whole = Math.floor(value);
  const frac = value - whole;
  if (frac < 1e-6) return `${whole}"`;
  const denominators = [2, 4, 8, 16];
  for (const d of denominators) {
    const n = Math.round(frac * d);
    if (Math.abs(frac - n / d) < 1e-6) {
      return n === d ? `${whole + 1}"` : `${whole}-${n}/${d}"`;
    }
  }
  return `${r(value)}"`;
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
    ...mine.filter((p) => p.layer === "wall").map((p) => HEIGHTS.wallBaseline + p.height),
    HEIGHTS.counterTop,
  );
  const viewHeight = wallTop + 6;
  const ctx = open(run.length, viewHeight, style, `${run.label} 正视图`);

  // 地面与墙体轮廓
  ctx.parts.push(
    `<line x1="0" y1="${r(viewHeight * ctx.s)}" x2="${r(run.length * ctx.s)}" y2="${r(viewHeight * ctx.s)}" stroke="#333" stroke-width="1.5"/>`,
  );

  const yOf = (topInches: number) => (viewHeight - topInches) * ctx.s;

  for (const p of mine) {
    if (p.layer === "base") {
      const top = p.kind === "cabinet" || p.kind === "filler" ? HEIGHTS.baseBox : HEIGHTS.baseBox;
      drawBox(ctx, p, p.x, yOf(top), p.width, p.height - (p.kind === "cabinet" ? HEIGHTS.toeKick : 0), faceTemplateOf, style, HEIGHTS.toeKick);
    } else if (p.layer === "wall") {
      drawBox(ctx, p, p.x, yOf(HEIGHTS.wallBaseline + p.height), p.width, p.height, faceTemplateOf, style, 0);
    } else {
      drawBox(ctx, p, p.x, yOf(p.height), p.width, p.height, faceTemplateOf, style, HEIGHTS.toeKick);
    }
  }

  // 台面
  const counterY = yOf(HEIGHTS.counterTop);
  ctx.parts.push(
    `<rect x="0" y="${r(counterY)}" width="${r(run.length * ctx.s)}" height="${r(HEIGHTS.counterThickness * ctx.s)}" fill="#3b3b3b"/>`,
  );

  if (style.showDimensions) {
    dimension(ctx, { x: 0, y: viewHeight }, { x: run.length, y: viewHeight }, formatInches(run.length), 26);
    dimension(ctx, { x: 0, y: viewHeight }, { x: 0, y: viewHeight - HEIGHTS.counterTop }, `台面 ${formatInches(HEIGHTS.counterTop)}`, -14);
    const wallCab = mine.find((p) => p.layer === "wall");
    if (wallCab) {
      dimension(ctx, { x: run.length, y: viewHeight - HEIGHTS.counterTop },
        { x: run.length, y: viewHeight - HEIGHTS.wallBaseline }, `净空 ${formatInches(HEIGHTS.backsplash)}`, 16);
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

  if (p.kind === "appliance") {
    ctx.parts.push(
      `<rect x="${r(x)}" y="${r(yPx)}" width="${r(wIn * s)}" height="${r(hIn * s)}" fill="#f0f0f0" stroke="#999" stroke-width="1" stroke-dasharray="5 3"/>`,
      `<text x="${r(x + (wIn * s) / 2)}" y="${r(yPx + (hIn * s) / 2)}" font-size="9" fill="#777" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${esc(p.label ?? "家电位")}</text>`,
    );
    return;
  }

  if (p.kind === "filler") {
    ctx.parts.push(
      `<rect x="${r(x)}" y="${r(yPx)}" width="${r(wIn * s)}" height="${r(hIn * s)}" fill="#e6e0d4" stroke="#333" stroke-width="1"/>`,
    );
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
  } else {
    ctx.parts.push(
      `<rect x="${r(x)}" y="${r(yPx)}" width="${r(wIn * s)}" height="${r(hIn * s)}" fill="#f5f1e8" stroke="#333" stroke-width="1"/>`,
    );
  }

  // 踢脚线
  if (toeKick > 0) {
    const kickY = yPx + hIn * s;
    ctx.parts.push(
      `<rect x="${r(x + 3 * s)}" y="${r(kickY)}" width="${r((wIn - 3) * s)}" height="${r(toeKick * s)}" fill="#d9d3c6" stroke="#333" stroke-width="0.75"/>`,
    );
  }

  if (p.moduleCode) {
    ctx.parts.push(
      `<text x="${r(x + (wIn * s) / 2)}" y="${r(yPx + hIn * s + toeKick * s + 11)}" font-size="8" fill="#555" text-anchor="middle" font-family="sans-serif">${esc(p.moduleCode)}</text>`,
    );
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
  const ctx = open(run.length, depth + 4, style, `${run.label} 俯视图（${layer === "base" ? "地柜层" : "吊柜层"}）`);
  const { s } = ctx;

  // 墙线
  ctx.parts.push(`<line x1="0" y1="0" x2="${r(run.length * s)}" y2="0" stroke="#333" stroke-width="2.5"/>`);

  for (const p of mine) {
    const x = p.x * s;
    const w = p.width * s;
    const d = p.depth * s;
    const fill = p.kind === "appliance" ? "#f0f0f0" : p.kind === "filler" ? "#e6e0d4" : "#f5f1e8";
    const dash = p.kind === "appliance" ? ' stroke-dasharray="5 3"' : "";
    ctx.parts.push(`<rect x="${r(x)}" y="0" width="${r(w)}" height="${r(d)}" fill="${fill}" stroke="#333" stroke-width="1"${dash}/>`);

    // 开门弧线示意（只对柜体画）
    if (p.kind === "cabinet" && p.width >= 9) {
      const radius = Math.min(w, d) * 0.85;
      ctx.parts.push(
        `<path d="M ${r(x + 1)} ${r(d)} A ${r(radius)} ${r(radius)} 0 0 0 ${r(x + 1 + radius)} ${r(d + radius)}" fill="none" stroke="#aaa" stroke-width="0.75" stroke-dasharray="3 2"/>`,
      );
    }
    if (p.moduleCode) {
      ctx.parts.push(
        `<text x="${r(x + w / 2)}" y="${r(d / 2)}" font-size="8" fill="#555" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${esc(p.moduleCode)}</text>`,
      );
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

  const ctx = open(spec.depth + 6, spec.top + 6, style, `侧视图（${section}）`);
  const { s } = ctx;
  const H = spec.top + 6;
  const yOf = (topIn: number) => (H - topIn) * s;

  // 地面与墙
  ctx.parts.push(
    `<line x1="0" y1="${r(H * s)}" x2="${r((spec.depth + 6) * s)}" y2="${r(H * s)}" stroke="#333" stroke-width="1.5"/>`,
    `<line x1="0" y1="0" x2="0" y2="${r(H * s)}" stroke="#333" stroke-width="2.5"/>`,
  );

  if (section === "base" || section === "tall") {
    const boxTop = section === "base" ? HEIGHTS.baseBox : tallH;
    // 踢脚线内缩 3"（规范文档：4-1/2"H × 3"D）
    ctx.parts.push(
      `<rect x="0" y="${r(yOf(boxTop))}" width="${r(spec.depth * s)}" height="${r((boxTop - HEIGHTS.toeKick) * s)}" fill="#f5f1e8" stroke="#333" stroke-width="1"/>`,
      `<rect x="0" y="${r(yOf(HEIGHTS.toeKick))}" width="${r((spec.depth - 3) * s)}" height="${r(HEIGHTS.toeKick * s)}" fill="#d9d3c6" stroke="#333" stroke-width="1"/>`,
    );
    if (section === "base") {
      // 台面外延 1"（规范文档第二节）
      ctx.parts.push(
        `<rect x="0" y="${r(yOf(HEIGHTS.counterTop))}" width="${r((spec.depth + 1) * s)}" height="${r(HEIGHTS.counterThickness * s)}" fill="#3b3b3b"/>`,
      );
    }
  } else {
    ctx.parts.push(
      `<rect x="0" y="${r(yOf(HEIGHTS.wallBaseline + wallH))}" width="${r(spec.depth * s)}" height="${r(wallH * s)}" fill="#f5f1e8" stroke="#333" stroke-width="1"/>`,
    );
  }

  if (style.showDimensions) {
    if (section === "base") {
      dimension(ctx, { x: spec.depth + 4, y: H }, { x: spec.depth + 4, y: H - HEIGHTS.toeKick }, formatInches(HEIGHTS.toeKick), 0);
      dimension(ctx, { x: spec.depth + 4, y: H }, { x: spec.depth + 4, y: H - HEIGHTS.counterTop }, formatInches(HEIGHTS.counterTop), 30);
      dimension(ctx, { x: 0, y: H }, { x: spec.depth, y: H }, formatInches(spec.depth), 16);
    } else if (section === "wall" || section === "deepWall") {
      dimension(ctx, { x: spec.depth + 4, y: H - HEIGHTS.wallBaseline }, { x: spec.depth + 4, y: H - HEIGHTS.wallBaseline - wallH }, formatInches(wallH), 0);
      dimension(ctx, { x: spec.depth + 4, y: H }, { x: spec.depth + 4, y: H - HEIGHTS.wallBaseline }, `底边 ${formatInches(HEIGHTS.wallBaseline)}`, 30);
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
