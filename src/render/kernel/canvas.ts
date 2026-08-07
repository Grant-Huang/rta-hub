/**
 * 画布 —— 英寸 → px 的映射与 SVG 外壳，**唯一的一份**（RENDERING.md §8.3）。
 *
 * 以前两个渲染器各写了一套：一个用 `<g transform="translate(PAD,PAD)">` 包起来
 * 内部按 0 起算，另一个把 padding 加在每个坐标上；边距 44 vs 52；
 * 背景 `fill="#ffffff"` vs `fill="#fff"`；一个有 `<title>` 一个有 `aria-label`。
 * 单看每一条都无所谓，合起来就是"两个软件"。
 *
 * ## 坐标约定
 *
 * `Canvas` 只做一件事：把**英寸坐标**乘以固定的 px/inch 再加边距。
 * 不缩放（RENDERING.md §4.1）——门缝、线宽、字号都是绝对量。
 *
 * 记录用到了哪些语义元素（`used`），图例据此生成——**图例是画出来的东西的
 * 索引，不是写死的一张表**，否则图上没有的东西会出现在图例里。
 */
import type { ElementKind } from "./palette.js";
import { INK, TYPE } from "./palette.js";
import { r, text } from "./primitives.js";

export interface CanvasOptions {
  pxPerInch: number;
  /** 四周边距（px）。 */
  pad?: number;
  /**
   * 图名与图例占的高度（px）。
   *
   * 必须**先于坐标映射**记进来：图例画在图上方，如果只是"画上去"而不给它
   * 腾地方，它会压在第一排柜子上。腾地方与画东西是同一件事的两半，
   * 分开做迟早忘一半。
   */
  header?: number;
  title: string;
}

/** 图纸边距。两组图用同一个值——不同的边距会让并排看的两张图对不齐。 */
export const PAD = 48;

export class Canvas {
  readonly pxPerInch: number;
  readonly pad: number;
  readonly header: number;
  readonly title: string;
  private readonly parts: string[] = [];
  private readonly kinds = new Set<ElementKind>();
  private minX = 0;
  private minY = 0;
  private widthIn = 0;
  private heightIn = 0;

  constructor(opts: CanvasOptions) {
    this.pxPerInch = opts.pxPerInch;
    this.pad = opts.pad ?? PAD;
    this.header = opts.header ?? 0;
    this.title = opts.title;
  }

  /** 设定图纸覆盖的英寸范围。原点可以是负的（全局俯视图会向上/向左展开）。 */
  extent(bounds: { minX: number; minY: number; maxX: number; maxY: number }): this {
    this.minX = bounds.minX;
    this.minY = bounds.minY;
    this.widthIn = bounds.maxX - bounds.minX;
    this.heightIn = bounds.maxY - bounds.minY;
    return this;
  }

  /** 英寸 → px（横向）。 */
  px(xIn: number): number { return this.pad + (xIn - this.minX) * this.pxPerInch; }
  /** 英寸 → px（纵向）。图名与图例的高度已经让开。 */
  py(yIn: number): number { return this.pad + this.header + (yIn - this.minY) * this.pxPerInch; }
  /** 长度换算（不含偏移）。 */
  len(inches: number): number { return inches * this.pxPerInch; }

  get widthPx(): number { return this.widthIn * this.pxPerInch + this.pad * 2; }
  get heightPx(): number { return this.heightIn * this.pxPerInch + this.pad * 2 + this.header; }

  /** 放一段 SVG。`kind` 非空时同时记进图例。 */
  add(svg: string, kind?: ElementKind): this {
    this.parts.push(svg);
    if (kind) this.kinds.add(kind);
    return this;
  }

  /** 只登记图例，不画东西（脸型文法自己画的柜体走这条）。 */
  note(kind: ElementKind): this {
    this.kinds.add(kind);
    return this;
  }

  /** 这张图上实际出现过的元素——图例据此生成。 */
  usedKinds(): ElementKind[] { return [...this.kinds]; }

  /** 图名，画在左上角。 */
  heading(label: string): this {
    this.parts.push(text(this.pad, 24, label, {
      size: TYPE.title, fill: INK.label, anchor: "start", weight: 600,
    }));
    return this;
  }

  /** 底部的提示（推定值、示意排列这类）。 */
  footnote(message: string): this {
    this.parts.push(text(this.pad, this.heightPx - 14, message, {
      size: TYPE.note, fill: INK.note, anchor: "start",
    }));
    return this;
  }

  toSvg(): string {
    const w = r(this.widthPx);
    const h = r(this.heightPx);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
      `width="${w}" height="${h}" role="img" aria-label="${escAttr(this.title)}">` +
      `<title>${escAttr(this.title)}</title>` +
      `<rect width="${w}" height="${h}" fill="#ffffff"/>` +
      this.parts.join("") +
      `</svg>`;
  }
}

/** 属性值里引号也要转义——与文本节点的规则不同。 */
function escAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
