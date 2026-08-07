/**
 * 配色、线宽、字号 —— **唯一的一份**（RENDERING.md §8.3）。
 *
 * ## 为什么单独抽出来
 *
 * 客户问的是：「全局布局图纸跟后面各向的图纸，是用的不同的工具吗？」
 *
 * 答案是没有——两组图都是本项目拼字符串生成的 SVG，同一种技术。但它们各写了
 * 一套颜色：填缝条在正视图里是 `#e6e0d4`，在全局俯视图里是 `#d8cfa8`；柜体在
 * 一边是 `#f5f1e8`，在另一边是 `#fff`。**客户看的是约定，不是技术**，
 * 于是它们看起来像两个软件画的。
 *
 * 判定标准很直接：同一个东西在两组图里必须是同一个颜色、同一种剖面线、
 * 同一种标注方式。要保证这一点，颜色就只能有一份——**并且"这是什么东西"
 * 的判断也只能有一份**（`elementKindOf`），否则两边各自按 `kind`/`label`
 * 猜一遍，仍然会分叉。
 */
import type { Placement } from "../../layout/generate.js";
import type { WallFeature } from "../../floorplan/types.js";

/** 图上会出现的语义元素。颜色按它分配，不按"在哪张图里"分配。 */
export type ElementKind =
  | "cabinet"           // 普通柜体
  | "sinkBase"          // 水槽柜
  | "applianceCabinet"  // 家电配套柜（冰箱上柜/灶下柜/烤箱高柜）
  | "filler"            // 填缝条
  | "panel"             // 收口板
  | "appliance"         // 家电位（不是我们供的货）
  | "counter"           // 台面（正视图/侧视图里的那一条实心）
  | "counterEdge"       // 台面外沿（俯视图里的那圈轮廓）
  | "toeKick"           // 踢脚
  | "wall"              // 墙线
  | "featureWindow"
  | "featurePlumbing"
  | "featureGas"
  | "featureElectrical"
  | "featureDoor"
  | "featureObstruction";

export interface ElementStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** 虚线样式。家电位是虚线——它不是我们供的货，图上要看得出区别。 */
  dash?: string;
  /** 图例上的名字。中文，客户看的。 */
  legend: string;
}

export const PALETTE: Record<ElementKind, ElementStyle> = {
  cabinet: { fill: "#f5f1e8", stroke: "#333333", strokeWidth: 1, legend: "柜体" },
  // 水槽柜给一个可分辨的浅绿——客户看图第一个找的就是水槽
  sinkBase: { fill: "#dff0e8", stroke: "#333333", strokeWidth: 1, legend: "水槽柜" },
  applianceCabinet: { fill: "#e9eef5", stroke: "#333333", strokeWidth: 1, legend: "家电配套柜" },
  filler: { fill: "#e6e0d4", stroke: "#333333", strokeWidth: 1, legend: "填缝条" },
  panel: { fill: "#ded6c4", stroke: "#333333", strokeWidth: 1, legend: "收口板" },
  // 家电位：灰 + 虚线。虚线表示"这个位置留给你的家电，不在报价里"
  appliance: { fill: "#f0f0f0", stroke: "#999999", strokeWidth: 1, dash: "5 3", legend: "家电位（自备）" },
  counter: { fill: "#3b3b3b", stroke: "#3b3b3b", strokeWidth: 0, legend: "台面" },
  // 俯视图里台面只画一圈外沿：填色会把下面的柜体和水槽盆全盖住。
  // 它比柜体轮廓大出一圈——门洞旁"为什么要让开一点"就在这一圈上看得见。
  counterEdge: { fill: "none", stroke: "#3b3b3b", strokeWidth: 1.1, legend: "台面外沿" },
  toeKick: { fill: "#d9d3c6", stroke: "#333333", strokeWidth: 0.75, legend: "踢脚" },
  wall: { fill: "none", stroke: "#333333", strokeWidth: 2.5, legend: "墙体" },
  featureWindow: { fill: "none", stroke: "#4d9ad7", strokeWidth: 6, legend: "窗" },
  featurePlumbing: { fill: "none", stroke: "#5fb08a", strokeWidth: 6, legend: "上下水" },
  featureGas: { fill: "none", stroke: "#c0714d", strokeWidth: 6, legend: "燃气口" },
  featureElectrical: { fill: "none", stroke: "#c8a33a", strokeWidth: 6, legend: "强电位" },
  featureDoor: { fill: "none", stroke: "#8a8a8a", strokeWidth: 6, legend: "门洞" },
  featureObstruction: { fill: "none", stroke: "#a0522d", strokeWidth: 6, legend: "障碍" },
};

/** 线条与文字的墨色。图纸上只该有这几档，多了就显得杂。 */
export const INK = {
  ground: "#333333",      // 地面线、墙体轮廓
  dimension: "#666666",   // 尺寸线
  dimensionText: "#444444",
  code: "#555555",        // 型号码
  label: "#222222",       // 图名、墙名
  swing: "#aaaaaa",       // 开门方向弧线
  note: "#a06a2a",        // 提示（推定值、示意排列）
} as const;

/** 字号。图纸上的字号是绝对值，不随比例缩放。 */
export const TYPE = {
  code: 8, label: 9, dimension: 9, title: 13, note: 10, legend: 9,
} as const;

/** 线宽。同样是绝对值。 */
export const STROKE = {
  dimension: 0.75, swing: 0.75, ground: 1.5, wall: 2.5,
} as const;

/**
 * 这个构件是什么 —— **唯一的判断入口**。
 *
 * 两个渲染器都从这里问。各自按 `kind`/`label` 再判一遍的话，
 * 颜色表统一了也没用：一边把水槽柜当普通柜体，另一边不当，图上还是不一致。
 */
export function elementKindOf(p: Placement): ElementKind {
  if (p.kind === "appliance") return "appliance";
  if (p.kind === "filler") return "filler";
  if (p.label === "sink") return "sinkBase";
  // 配套柜带着它服务的家电种类——M5-6 给的信息，这里直接用
  if (p.applianceKind !== undefined) return "applianceCabinet";
  return "cabinet";
}

const FEATURE_KIND: Record<WallFeature["kind"], ElementKind> = {
  window: "featureWindow",
  plumbing: "featurePlumbing",
  gas: "featureGas",
  electrical: "featureElectrical",
  door: "featureDoor",
  obstruction: "featureObstruction",
};

export function featureKindOf(f: WallFeature): ElementKind {
  return FEATURE_KIND[f.kind] ?? "featureObstruction";
}
