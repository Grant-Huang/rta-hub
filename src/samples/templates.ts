/**
 * 户型模板的标准几何 —— FR-17.4。
 *
 * `walls` 里的 `label`/`kind`/`startsAtCorner`（墙面**结构**：几段墙、罗盘
 * 方位、是否转角相接、是否岛台）是客户选"我家像这个"这个动作本身就确认过
 * 的事实，`server.ts` 的 `applyFloorplanTemplate` 会用它们建墙壳。
 *
 * `length`/`depth`/`features`/`ceilingHeight` 这几个**数值**字段不是客户
 * 量的，也不允许被 `applyFloorplanTemplate` 拿去预填客户的户型数据——没有
 * 图、只凭客户点了个形状名，系统对这些数字没有任何依据，不能因为"常见"
 * 就替客户填一个默认值（哪怕标成"待确认"也不行，那样客户容易把"系统猜的"
 * 误当成"系统读到的"）。这几个数值字段目前**只**被视觉识图对齐模块
 * （`src/floorplan/template-match.ts`）使用——客户真的上传了图、但某个字段
 * 模型没能读出来时，用作待确认提示文案里的参考建议值，绝不直接写入已确认
 * 数据。
 */
import type { WallFeatureKind } from "../floorplan/types.js";

export interface FloorplanTemplateWall {
  label: string;
  length: number;
  kind?: "wall" | "island";
  depth?: number;
  /** 缺省沿用 `addWallRun` 的"接上一段"默认值；两墙不相接（如走廊型）需显式传 false。 */
  startsAtCorner?: boolean;
}

export interface FloorplanTemplateFeature {
  /** 落在 `walls` 数组里的第几段（0 起）。 */
  wall: number;
  kind: WallFeatureKind;
  offset: number;
  width: number;
}

export interface FloorplanTemplate {
  id: string;
  walls: FloorplanTemplateWall[];
  features: FloorplanTemplateFeature[];
  ceilingHeight: number;
  /** 客户看得懂的一句话说明，用于套用后的复述。 */
  noteEn: string;
  noteZh: string;
}

export const FLOORPLAN_TEMPLATES: Readonly<Record<string, FloorplanTemplate>> = {
  "one-wall-kitchen": {
    id: "one-wall-kitchen",
    walls: [{ label: "Wall", length: 144 }],
    features: [
      { wall: 0, kind: "door", offset: 0, width: 32 },
      { wall: 0, kind: "window", offset: 48, width: 36 },
      { wall: 0, kind: "plumbing", offset: 72, width: 24 },
    ],
    ceilingHeight: 96,
    noteEn: "One-wall layout, 144\" wall.",
    noteZh: "单壁型布局，一段 144\" 的墙。",
  },
  "u-shaped-kitchen": {
    id: "u-shaped-kitchen",
    walls: [
      { label: "West", length: 120 },
      { label: "North", length: 144 },
      { label: "East", length: 120 },
    ],
    features: [
      { wall: 1, kind: "window", offset: 48, width: 48 },
      { wall: 2, kind: "plumbing", offset: 36, width: 24 },
      { wall: 2, kind: "door", offset: 88, width: 32 },
    ],
    ceilingHeight: 96,
    noteEn: "U-shape: West 120\", North 144\", East 120\".",
    noteZh: "U型：西墙 120\"、北墙 144\"、东墙 120\"。",
  },
  "l-island-kitchen": {
    id: "l-island-kitchen",
    walls: [
      { label: "North", length: 144 },
      { label: "East", length: 120 },
      { label: "Island", length: 72, kind: "island", depth: 36, startsAtCorner: false },
    ],
    features: [
      { wall: 0, kind: "window", offset: 48, width: 36 },
      { wall: 1, kind: "plumbing", offset: 36, width: 24 },
      { wall: 1, kind: "door", offset: 88, width: 32 },
    ],
    ceilingHeight: 96,
    noteEn: "L-shape (North 144\", East 120\") + 72×36\" island.",
    noteZh: "L型（北墙 144\"、东墙 120\"）+ 72×36\" 岛台。",
  },
  "galley-kitchen": {
    id: "galley-kitchen",
    walls: [
      { label: "North", length: 144 },
      // 两墙面对面留过道，不是转角相接——必须显式声明，否则会被当成默认相接。
      { label: "South", length: 144, startsAtCorner: false },
    ],
    features: [
      { wall: 0, kind: "door", offset: 0, width: 32 },
      { wall: 0, kind: "window", offset: 48, width: 36 },
      { wall: 0, kind: "plumbing", offset: 96, width: 24 },
    ],
    ceilingHeight: 96,
    noteEn: "Galley: two facing 144\" walls (not corner-joined).",
    noteZh: "走廊型：两段面对面的 144\" 墙（不是转角相接）。",
  },
  "floorplan-minimal": {
    id: "floorplan-minimal",
    walls: [
      { label: "North", length: 144 },
      { label: "East", length: 120 },
    ],
    features: [
      { wall: 0, kind: "window", offset: 48, width: 36 },
      { wall: 1, kind: "plumbing", offset: 36, width: 24 },
      { wall: 1, kind: "door", offset: 88, width: 32 },
    ],
    ceilingHeight: 96,
    noteEn: "L-shape: North 144\", East 120\".",
    noteZh: "L型：北墙 144\"、东墙 120\"。",
  },
} as const;

export function floorplanTemplateById(id: string): FloorplanTemplate | undefined {
  return FLOORPLAN_TEMPLATES[id];
}

/**
 * 客户用文字报出的户型名 → 已知模板 id。
 *
 * L型+岛台必须排在纯 L 型前面：两者的文本都会命中"L型"，先判定更具体的那个。
 */
const SHAPE_PATTERNS: { id: string; re: RegExp }[] = [
  {
    id: "l-island-kitchen",
    re: /l\s*[- ]?shape.{0,10}island|l\s*型.{0,6}(岛台|中岛)|(?:带|加)\s*岛台.{0,6}l\s*型|岛台.{0,6}l\s*型/i,
  },
  { id: "u-shaped-kitchen", re: /u\s*[- ]?shape|u\s*型/i },
  { id: "galley-kitchen", re: /galley|走廊型|双排型|两排型|通道型/i },
  { id: "one-wall-kitchen", re: /one[- ]?wall|单壁型|一字型|一字\s*厨房/i },
  { id: "floorplan-minimal", re: /l\s*[- ]?shape|l\s*型/i },
];

/** 文字里点名的是哪个已知户型模板；没点名任何一个则 undefined。 */
export function matchKnownShape(text: string): string | undefined {
  for (const { id, re } of SHAPE_PATTERNS) {
    if (re.test(text)) return id;
  }
  return undefined;
}

/**
 * 每种户型的墙名讲解——客户选完形状后，同一句回复里解释"北墙/西墙/东墙"
 * 这类罗盘方位对应到日常怎么称呼（主墙/左墙/右墙），方便后续沟通与画图标注。
 * 不改 WallRun.label 本身（仍是罗盘词，几何/渲染大量代码依赖这个），
 * 只在这句解释文案里搭一次桥。
 */
export const SHAPE_WALL_EXPLANATION: Readonly<Record<string, { en: string; zh: string }>> = {
  "one-wall-kitchen": {
    en: "One wall to work with — we'll just call it \"the wall\".",
    zh: "单壁型只有一段墙，后面就直接叫「这面墙」。",
  },
  "u-shaped-kitchen": {
    en: "Three walls: the one facing you as you walk in (labeled \"North\") is the main wall; "
      + "your left (\"West\") is the left wall, your right (\"East\") is the right wall.",
    zh: "U型三段墙：正对着你走进来的那面（系统里标「North / 北墙」）是主墙；"
      + "左手边（「West / 西墙」）是左墙，右手边（「East / 东墙」）是右墙。",
  },
  "l-island-kitchen": {
    en: "Two walls meeting in an L (\"North\" and \"East\"), plus an island in the middle of the room.",
    zh: "L型两段墙首尾相接（「North / 北墙」和「East / 东墙」），中间是岛台。",
  },
  "galley-kitchen": {
    en: "Two walls facing each other across an aisle (\"North\" and \"South\") — not corner-joined.",
    zh: "走廊型是两段面对面的墙（「North / 北墙」和「South / 南墙」），中间是过道，两段墙不是转角相接。",
  },
  "floorplan-minimal": {
    en: "Two walls meeting in an L (\"North\" and \"East\").",
    zh: "L型两段墙首尾相接（「North / 北墙」和「East / 东墙」）。",
  },
};

/**
 * 户型形状的短名——供"已确认"面板展示"客户说的是哪种户型"用（区别于
 * `noteEn`/`noteZh`，那两个是带墙长数字的完整句子，跟原子事实行的墙长
 * 数值重复；这里只要一个词）。
 */
export const SHAPE_SHORT_LABEL: Readonly<Record<string, { en: string; zh: string }>> = {
  "one-wall-kitchen": { en: "One-wall", zh: "一字型" },
  "u-shaped-kitchen": { en: "U-shape", zh: "U型" },
  "l-island-kitchen": { en: "L-shape + island", zh: "L型+岛台" },
  "galley-kitchen": { en: "Galley", zh: "走廊型" },
  "floorplan-minimal": { en: "L-shape", zh: "L型" },
};
