/**
 * 户型模板的标准几何 —— FR-17.4。
 *
 * `catalog.ts` 里的 5 张 floorplan 示例图原本只是"照着手绘"的参考；这里给每张图
 * 配一份结构化尺寸（抄自 `README.md` 的标注要求），客户选"我家像这个"时可以
 * 直接预填，不用从空白开始手绘。
 *
 * 这些数字是模板给的标准值，不是客户量的——套用方（`server.ts` 的
 * `applyFloorplanTemplate`）必须给每一段墙、每一处门窗都留一条待确认项，
 * 不能因为填了数字就当成已确认（FR-15.5）。
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
      { label: "Island", length: 72, kind: "island", depth: 36 },
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
