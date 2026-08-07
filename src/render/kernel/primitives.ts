/**
 * SVG 图元 —— 两个渲染器共用的那几个形状（RENDERING.md §8.3）。
 *
 * 这里**只管怎么画**，不管画什么：坐标一律是已经算好的 px。
 * 英寸 → px 的换算在 `canvas.ts`，语义 → 颜色的换算在 `palette.ts`。
 *
 * 与 RENDERING.md §4.1 同一条铁律：**绝不输出 `transform="scale()"`**。
 * 缩放会把门缝、线宽、字号这些绝对量一起放大。图元收到的都是绝对 px，
 * 平移（translate）是允许的，它是纯加法。
 */
import { INK, STROKE, TYPE, type ElementStyle } from "./palette.js";

/** 坐标保留两位小数——再多是噪音，SVG 里也看不出来。 */
export function r(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * XML **文本节点**转义。
 *
 * 只处理 `&`、`<`、`>`：文本里的引号无需转义，而尺寸标注里到处是英寸符号
 * （`36"`），转成 `&quot;` 只会让输出难读。
 *
 * 以前 `views.ts` 与 `plan-view.ts` 各有一份复制的实现——两份同样的东西
 * 迟早会分叉，这是本轮要消灭的那一类重复。
 */
export function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

/** 把语义样式摊成 SVG 属性。虚线、线宽、填充都从这里出，两组图必然一致。 */
export function styleAttrs(s: ElementStyle): string {
  return `fill="${s.fill}" stroke="${s.stroke}" stroke-width="${s.strokeWidth}"` +
    (s.dash ? ` stroke-dasharray="${s.dash}"` : "");
}

export function rect(x: number, y: number, w: number, h: number, s: ElementStyle): string {
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" ${styleAttrs(s)}/>`;
}

export function polygon(points: readonly { x: number; y: number }[], s: ElementStyle): string {
  const pts = points.map((p) => `${r(p.x)},${r(p.y)}`).join(" ");
  return `<polygon points="${pts}" ${styleAttrs(s)}/>`;
}

export function line(
  x1: number, y1: number, x2: number, y2: number,
  stroke: string, width: number, dash?: string,
): string {
  return `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" ` +
    `stroke="${stroke}" stroke-width="${width}"` +
    (dash ? ` stroke-dasharray="${dash}"` : "") +
    ` stroke-linecap="butt"/>`;
}

export interface TextOpts {
  size?: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  /** 垂直居中。放在方块中央的文字要用。 */
  middle?: boolean;
  weight?: number;
}

export function text(x: number, y: number, content: string, opts: TextOpts = {}): string {
  const parts = [
    `x="${r(x)}"`, `y="${r(y)}"`,
    `font-size="${opts.size ?? TYPE.label}"`,
    `fill="${opts.fill ?? INK.label}"`,
    `text-anchor="${opts.anchor ?? "middle"}"`,
    `font-family="sans-serif"`,
  ];
  if (opts.middle) parts.push(`dominant-baseline="middle"`);
  if (opts.weight) parts.push(`font-weight="${opts.weight}"`);
  return `<text ${parts.join(" ")}>${esc(content)}</text>`;
}

/**
 * 开门方向弧线。
 *
 * 客户判断"冰箱门开了会不会打到抽屉"靠的就是这个。以前只有单墙俯视图画，
 * 全局俯视图没有——同一个信息在两张图里一张有一张没有，正是"像两个软件"的来源。
 *
 * `from` 是铰链点，`toward` 是门开出去的方向（单位向量），`radius` 是门宽。
 */
export function swingArc(
  from: { x: number; y: number },
  along: { dx: number; dy: number },
  outward: { dx: number; dy: number },
  radius: number,
): string {
  const end = {
    x: from.x + outward.dx * radius,
    y: from.y + outward.dy * radius,
  };
  // 扫掠方向由 along × outward 的手性决定——两个渲染器传的是各自的方向向量，
  // 这里算出来，免得各自猜一个 sweep-flag 然后画反
  const cross = along.dx * outward.dy - along.dy * outward.dx;
  const sweep = cross > 0 ? 1 : 0;
  return `<path d="M ${r(from.x + along.dx * radius)} ${r(from.y + along.dy * radius)} ` +
    `A ${r(radius)} ${r(radius)} 0 0 ${sweep} ${r(end.x)} ${r(end.y)}" ` +
    `fill="none" stroke="${INK.swing}" stroke-width="${STROKE.swing}" stroke-dasharray="3 2"/>`;
}

/**
 * 水槽盆的轮廓 —— 画在**水槽柜的柜面上**（APPLIANCES.md §4.2）。
 *
 * 客户提的原话：「水槽应该是落在 SB 的柜子上面」。图上只把水槽柜涂成另一个
 * 颜色是不够的——那只能说明"这个柜子跟别的不一样"，说明不了"水槽在这儿"。
 * 盆的轮廓画出来，客户一眼就能确认位置对不对。
 *
 * 双盆（宽度 ≥30"）画中间那道分隔，单盆不画：这是客户能在图上核对的信息。
 * 传进来的是柜面在图上的矩形（px），盆按比例内缩。
 */
export function sinkBowl(
  x: number, y: number, w: number, h: number,
  opts: { double: boolean },
): string {
  const inset = Math.min(w, h) * 0.16;
  const bx = x + inset;
  const by = y + inset;
  const bw = w - inset * 2;
  const bh = h - inset * 2;
  const out = [
    `<rect x="${r(bx)}" y="${r(by)}" width="${r(bw)}" height="${r(bh)}" rx="${r(Math.min(4, bw / 6))}" ` +
    `fill="none" stroke="${INK.code}" stroke-width="0.9"/>`,
  ];
  if (opts.double) {
    out.push(line(bx + bw / 2, by, bx + bw / 2, by + bh, INK.code, 0.9));
  }
  // 龙头：靠墙那一侧的一个小圆
  out.push(`<circle cx="${r(x + w / 2)}" cy="${r(y + inset * 0.55)}" r="${r(Math.min(2.5, inset * 0.4))}" ` +
    `fill="none" stroke="${INK.code}" stroke-width="0.9"/>`);
  return out.join("");
}

/**
 * 尺寸标注：带端点短线的标注线 + 中间的文字。
 *
 * 只支持水平与垂直——图上出现的尺寸链全是这两种，斜的尺寸线在厨房图里
 * 没有意义（所有柜子都平行于墙）。
 */
export function dimension(
  a: { x: number; y: number },
  b: { x: number; y: number },
  label: string,
): string {
  const horizontal = Math.abs(a.y - b.y) < 0.01;
  const out: string[] = [
    line(a.x, a.y, b.x, b.y, INK.dimension, STROKE.dimension),
    tick(a.x, a.y, horizontal), tick(b.x, b.y, horizontal),
  ];
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  out.push(horizontal
    ? text(mx, my - 3, label, { size: TYPE.dimension, fill: INK.dimensionText })
    : text(mx - 4, my, label, { size: TYPE.dimension, fill: INK.dimensionText, anchor: "end", middle: true }));
  return out.join("");
}

function tick(x: number, y: number, horizontal: boolean): string {
  return horizontal
    ? line(x, y - 3, x, y + 3, INK.dimension, STROKE.dimension)
    : line(x - 3, y, x + 3, y, INK.dimension, STROKE.dimension);
}

/** 把英寸格式化成行业写法：34.5 → 34-1/2"。 */
export function formatInches(value: number): string {
  const whole = Math.floor(value);
  const frac = value - whole;
  if (frac < 1e-6) return `${whole}"`;
  for (const d of [2, 4, 8, 16]) {
    const n = Math.round(frac * d);
    if (Math.abs(frac - n / d) < 1e-6) {
      return n === d ? `${whole + 1}"` : `${whole}-${n}/${d}"`;
    }
  }
  return `${r(value)}"`;
}
