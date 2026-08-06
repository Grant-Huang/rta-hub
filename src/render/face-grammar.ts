/**
 * 脸型文法 —— docs/RENDERING.md 第 3、4 节。
 *
 * 核心：RTA 柜子的正视图 = 把一个矩形按行/列递归切开，每个叶子是门/抽屉面/
 * 假抽面/开放格/盲板。15 种脸型是 15 条**数据**，不是 15 张图。
 *
 * ⚠️ 关键实现约束（RENDERING.md 4.1）：门缝与留边是**绝对尺寸**（全覆盖露 1/4"、
 * 嵌入式缝 3/32"），不随柜宽缩放。因此这里**计算绝对英寸坐标**，
 * 而不是「归一化模板 + transform scale」——后者会把 36" 柜的门缝画成 12" 柜的 3 倍。
 */

export type LeafKind =
  | "door" | "drawer" | "falseFront" | "open" | "blind" | "applianceOpening" | "panel";

export interface Leaf {
  kind: LeafKind;
  hinge?: "L" | "R";
  label?: string;
}

export interface Split {
  dir: "rows" | "cols";
  children: { size: number | "*"; node: FaceSpec }[];
}

export type FaceSpec = Split | Leaf;

function isSplit(node: FaceSpec): node is Split {
  return (node as Split).dir !== undefined;
}

/** 门板覆盖方式决定留边（REQUIREMENTS 3.3 第 5 点）。单位英寸。 */
export type OverlayStyle = "full" | "partial" | "inset";

export interface RenderStyle {
  overlay: OverlayStyle;
  construction: "framed" | "frameless";
  /** 面框宽度，仅 framed 有效。行业标准 1-1/2"。 */
  faceFrameWidth: number;
}

export const DEFAULT_STYLE: RenderStyle = {
  overlay: "full",
  construction: "framed",
  faceFrameWidth: 1.5,
};

/** 相邻门/抽屉面之间的缝隙（绝对英寸）。 */
export function revealFor(style: RenderStyle): number {
  switch (style.overlay) {
    case "full": return 0.25;      // 全覆盖：露 1/4" 面框
    case "partial": return 1.0;    // 半覆盖：露 1"-1.5"，取下限
    case "inset": return 3 / 32;   // 嵌入式：固定 3/32" 缝
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedLeaf extends Rect {
  kind: LeafKind;
  hinge?: "L" | "R";
  label?: string;
}

export interface LayoutResult {
  /** 整个柜面的外框（含面框，若 framed）。 */
  outer: Rect;
  /** 面框内的可用区域；frameless 时等于 outer。 */
  inner: Rect;
  leaves: PlacedLeaf[];
}

export class FaceLayoutError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "FaceLayoutError";
  }
}

/**
 * 把脸型文法展开成绝对坐标的矩形列表。
 *
 * @param width  柜体宽（英寸）
 * @param height 柜面可用高（英寸）——地柜请传 34.5 − 4.5 踢脚 = 30
 */
export function layoutFace(
  spec: FaceSpec,
  width: number,
  height: number,
  style: RenderStyle = DEFAULT_STYLE,
): LayoutResult {
  if (width <= 0 || height <= 0) {
    throw new FaceLayoutError(`柜面尺寸必须为正：${width} × ${height}`, "INVALID_SIZE");
  }
  const outer: Rect = { x: 0, y: 0, w: width, h: height };
  const frame = style.construction === "framed" ? style.faceFrameWidth : 0;
  const inner: Rect = {
    x: frame,
    y: frame,
    w: width - frame * 2,
    h: height - frame * 2,
  };
  if (inner.w <= 0 || inner.h <= 0) {
    throw new FaceLayoutError(
      `面框（${frame}"×2）占满了 ${width}"×${height}" 的柜面`,
      "FRAME_TOO_WIDE",
    );
  }

  const leaves: PlacedLeaf[] = [];
  place(spec, inner, revealFor(style), leaves);
  return { outer, inner, leaves };
}

function place(node: FaceSpec, box: Rect, reveal: number, out: PlacedLeaf[]): void {
  if (!isSplit(node)) {
    out.push({ ...box, kind: node.kind, hinge: node.hinge, label: node.label });
    return;
  }

  const n = node.children.length;
  if (n === 0) return;

  const isRows = node.dir === "rows";
  const total = isRows ? box.h : box.w;
  // 缝隙是绝对量，先从可分配空间里扣掉，剩下的才按 size 分配
  const gaps = (n - 1) * reveal;
  const available = total - gaps;
  if (available <= 0) {
    throw new FaceLayoutError(
      `${n} 个分格需要 ${gaps}" 缝隙，超过可用的 ${total}"`,
      "NO_ROOM_FOR_GAPS",
    );
  }

  const fixed = node.children.reduce(
    (sum, c) => sum + (typeof c.size === "number" ? c.size : 0), 0,
  );
  const starCount = node.children.filter((c) => c.size === "*").length;
  const starPool = available - fixed;

  if (starCount > 0 && starPool < 0) {
    throw new FaceLayoutError(
      `固定分格合计 ${fixed}" 已超过可用的 ${available}"`,
      "FIXED_EXCEEDS_AVAILABLE",
    );
  }

  // "*" 均分剩余空间；用整数分配余数的方式保证各段之和恰好等于 starPool，
  // 不因浮点除法产生累积误差（与 money.allocate 同思路）。
  const starSizes = allocateEvenly(starPool, starCount);

  let cursor = isRows ? box.y : box.x;
  let starIdx = 0;
  for (const child of node.children) {
    const size = typeof child.size === "number" ? child.size : starSizes[starIdx++]!;
    const childBox: Rect = isRows
      ? { x: box.x, y: cursor, w: box.w, h: size }
      : { x: cursor, y: box.y, w: size, h: box.h };
    if (size > 0) place(child.node, childBox, reveal, out);
    cursor += size + reveal;
  }
}

/** 把 total 均分成 parts 份，各份之和精确等于 total（余数按 1/64" 粒度分配）。 */
function allocateEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const GRAIN = 64; // 1/64 英寸，远细于业务要求的 1/4 英寸精度
  const units = Math.round(total * GRAIN);
  const base = Math.floor(units / parts);
  const remainder = units - base * parts;
  const out: number[] = [];
  for (let i = 0; i < parts; i++) {
    out.push((base + (i < remainder ? 1 : 0)) / GRAIN);
  }
  return out;
}

// ── SVG 输出 ──────────────────────────────────────────────────────────────

const FILL: Record<LeafKind, string> = {
  door: "#f5f1e8",
  drawer: "#efe9dc",
  falseFront: "#e8e2d4",
  open: "#ffffff",
  blind: "#d8d3c8",
  applianceOpening: "#cfcfcf",
  panel: "#ece7db",
};

export interface SvgOptions {
  /** 每英寸多少像素。 */
  pxPerInch?: number;
  /** 是否画开门方向示意。 */
  showHinges?: boolean;
  title?: string;
}

/**
 * 输出 SVG。
 *
 * 线宽固定为常量（不随缩放变化），坐标已是绝对英寸——这两点共同避免了
 * RENDERING.md 4.2 说的非等比缩放导致的线宽失真。
 */
export function toSvg(layout: LayoutResult, opts: SvgOptions = {}): string {
  const s = opts.pxPerInch ?? 8;
  const pad = 8;
  const w = layout.outer.w * s + pad * 2;
  const h = layout.outer.h * s + pad * 2;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(w)} ${round(h)}" width="${round(w)}" height="${round(h)}">`,
  );
  if (opts.title) parts.push(`<title>${escapeXml(opts.title)}</title>`);
  parts.push(`<g transform="translate(${pad},${pad})" stroke="#333" stroke-width="1" fill="none">`);

  // 柜体外框
  parts.push(rect(layout.outer, s, "#fbf9f4"));

  for (const leaf of layout.leaves) {
    parts.push(rect(leaf, s, FILL[leaf.kind]));
    if (leaf.kind === "drawer" || leaf.kind === "falseFront") {
      // 抽屉把手示意：横向短线
      const cy = (leaf.y + leaf.h / 2) * s;
      const x1 = (leaf.x + leaf.w * 0.35) * s;
      const x2 = (leaf.x + leaf.w * 0.65) * s;
      parts.push(`<line x1="${round(x1)}" y1="${round(cy)}" x2="${round(x2)}" y2="${round(cy)}" stroke-width="2"/>`);
    }
    if (leaf.kind === "door" && opts.showHinges !== false && leaf.hinge) {
      // 门把手示意：竖向短线，画在铰链的对侧
      const cx = leaf.hinge === "L" ? (leaf.x + leaf.w * 0.88) * s : (leaf.x + leaf.w * 0.12) * s;
      const y1 = (leaf.y + leaf.h * 0.42) * s;
      const y2 = (leaf.y + leaf.h * 0.58) * s;
      parts.push(`<line x1="${round(cx)}" y1="${round(y1)}" x2="${round(cx)}" y2="${round(y2)}" stroke-width="2"/>`);
    }
    if (leaf.kind === "blind") {
      // 盲板用斜线填充示意
      parts.push(
        `<line x1="${round(leaf.x * s)}" y1="${round((leaf.y + leaf.h) * s)}" x2="${round((leaf.x + leaf.w) * s)}" y2="${round(leaf.y * s)}" stroke-dasharray="4 3"/>`,
      );
    }
  }

  parts.push("</g></svg>");
  return parts.join("");
}

function rect(r: Rect, s: number, fill: string): string {
  return `<rect x="${round(r.x * s)}" y="${round(r.y * s)}" width="${round(r.w * s)}" height="${round(r.h * s)}" fill="${fill}"/>`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}
