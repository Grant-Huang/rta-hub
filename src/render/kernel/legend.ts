/**
 * 图例 —— **从实际画出来的元素生成，不写死**（RENDERING.md §8.3）。
 *
 * 写死一张表会有两种错法，而且都很难发现：图上有的东西图例里没有（客户看到
 * 一个不认识的颜色），图例里有的东西图上没有（客户在图上找一个根本不存在的
 * 构件）。`Canvas` 记录了每个语义元素有没有真的被画出来，图例只列那些。
 */
import { PALETTE, type ElementKind } from "./palette.js";
import { INK, TYPE } from "./palette.js";
import { esc, r, styleAttrs } from "./primitives.js";

/** 图例条目的顺序：柜体类在前，家电与墙面特征在后。图上找东西的顺序。 */
const ORDER: ElementKind[] = [
  "cabinet", "sinkBase", "applianceCabinet", "filler", "panel", "toeKick",
  "counter", "appliance",
  "featureWindow", "featurePlumbing", "featureGas", "featureElectrical",
  "featureDoor", "featureObstruction", "wall",
];

const SWATCH = 11;
const ROW = 16;

export interface LegendBox {
  svg: string;
  width: number;
  height: number;
}

/**
 * 画一块图例。
 *
 * `columns` 让调用方按图纸形状决定排成几列——竖长的图排一列，
 * 横宽的图排两三列，不然图例会顶出画布。
 */
export function renderLegend(
  kinds: readonly ElementKind[],
  x: number,
  y: number,
  columns = 1,
): LegendBox {
  const shown = ORDER.filter((k) => kinds.includes(k));
  if (shown.length === 0) return { svg: "", width: 0, height: 0 };

  const rows = Math.ceil(shown.length / columns);
  const colWidth = 108;
  const parts: string[] = [];

  shown.forEach((kind, i) => {
    const style = PALETTE[kind];
    const col = Math.floor(i / rows);
    const row = i % rows;
    const sx = x + col * colWidth;
    const sy = y + row * ROW;

    // 墙体与特征是线不是面，色块画成一条粗线才对得上图上的样子
    const isLine = style.fill === "none";
    parts.push(isLine
      ? `<line x1="${r(sx)}" y1="${r(sy + SWATCH / 2)}" x2="${r(sx + SWATCH)}" y2="${r(sy + SWATCH / 2)}" ` +
        `stroke="${style.stroke}" stroke-width="${Math.min(style.strokeWidth, 4)}"/>`
      : `<rect x="${r(sx)}" y="${r(sy)}" width="${SWATCH}" height="${SWATCH}" ${styleAttrs(style)}/>`);
    parts.push(
      `<text x="${r(sx + SWATCH + 5)}" y="${r(sy + SWATCH / 2)}" font-size="${TYPE.legend}" ` +
      `fill="${INK.code}" text-anchor="start" dominant-baseline="middle" ` +
      `font-family="sans-serif">${esc(style.legend)}</text>`);
  });

  return {
    svg: parts.join(""),
    width: Math.min(columns, Math.ceil(shown.length / rows)) * colWidth,
    height: rows * ROW,
  };
}
