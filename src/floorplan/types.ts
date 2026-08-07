/**
 * 户型几何 —— FR-3。
 *
 * 设计原则：**完整性优先于精度**（REQUIREMENTS FR-3、场景 D 第 2 点）。
 * 精度 1/4 英寸就够，但不允许因为"猜不准"就悄悄跳过某一段墙——
 * 拿不准的地方必须显式进入 `unresolved`，由对话核对或客户手填补齐。
 */

/** 精度：1/4 英寸。所有长度在写入前按此量化。 */
export const PRECISION_INCHES = 0.25;

export function quantize(inches: number): number {
  return Math.round(inches / PRECISION_INCHES) * PRECISION_INCHES;
}

/** 墙面上的特征——决定哪些位置不能放柜子、或必须放特定柜子。 */
export type WallFeatureKind =
  | "window"      // 窗：其下方不能放吊柜，通常也不放高柜
  | "door"        // 门洞：整段不可用
  | "plumbing"    // 上下水：水槽柜必须落在这里
  | "gas"         // 燃气：灶具位置
  | "electrical"  // 强电：冰箱/烤箱位置
  | "obstruction";// 柱子/管井等障碍
import type { ApplianceSpec } from "./appliances.js";


export interface WallFeature {
  id: string;
  kind: WallFeatureKind;
  /** 距该墙起点的距离（英寸）。 */
  offset: number;
  /** 特征宽度（英寸）。点状特征（如上下水）可为 0。 */
  width: number;
  /** 离地高度，窗台高度等；用于判断是否影响吊柜。 */
  sillHeight?: number;
  note?: string;
}

/**
 * 一列柜子占的一段直线。默认是一段直墙，厨房通常是 1-3 段（一字/L 型/U 型）。
 *
 * **岛台也是这个类型**（`kind: "island"`）。岛台在几何上就是"一段直的柜列"，
 * 只是不靠墙：装箱、物料、报价、审核对它的处理与靠墙的那几段一模一样。
 * 另开一个平行的 `islands` 数组的话，上面这一串每一处都要多写一遍循环，
 * 而"忘了给岛台也跑一遍"是不会报错的——它只会在报价单上少一段柜子。
 *
 * 真正需要分开处理的只有三处，都显式判 `isIsland`：不生成吊柜层、
 * 四面都是外露面（收口板）、落位靠围合区而不是墙线。
 */
export interface WallRun {
  id: string;
  label: string;
  /** 可用长度（英寸）。 */
  length: number;
  /** 起点是否是内墙角（与上一段相接）。 */
  startsAtCorner: boolean;
  endsAtCorner: boolean;
  features: WallFeature[];
  /** 靠墙的一段，还是岛台。缺省是靠墙。 */
  kind?: "wall" | "island";
  /**
   * 进深（英寸）。**只有岛台需要**——靠墙的段按层取标准进深（地柜 24"、吊柜 12"）。
   *
   * 单排柜的岛台约 25"（柜体 24" + 背板收口），背靠背两排约 48"。
   */
  depth?: number;
}

/** 这一段是不是岛台。判断只有这一处，别在调用方各自比字符串。 */
export function isIsland(run: WallRun): boolean {
  return run.kind === "island";
}

export interface ParsedGeometry {
  wallRuns: WallRun[];
  /** 天花板高度，决定吊柜与高柜的高度档位（规范文档第一节）。 */
  ceilingHeight?: number;
  /** 整体置信度 0-1。 */
  confidence: number;
}

/** 抽取不确定的项——必须由人处理，系统不自己猜。 */
export interface FloorPlanUnresolved {
  id: string;
  /** 关联的墙段/特征。 */
  target: { kind: "wallRun" | "feature" | "global"; id?: string };
  field: string;
  reason: string;
  /** 系统的猜测值——仅供参考展示，**不会被自动采用**。 */
  suggestion?: number;
  resolved: boolean;
}

export interface FloorPlan {
  id: string;
  conversationId: string;
  sourceFile: { name: string; mimeType: string; sizeBytes: number };
  parsedGeometry: ParsedGeometry;
  parseConfidence: number;
  unresolvedItems: FloorPlanUnresolved[];
  /**
   * 这个厨房里的家电（`floorplan/appliances.ts`）。
   *
   * 放在户型上而不是偏好上：家电是**这个厨房的物理事实**，不是对某家公司的选择。
   * 贸易账号一个人有多个项目，每个项目的家电各不相同——挂在偏好上就串了。
   */
  appliances?: ApplianceSpec[];
  createdAt: string;
  updatedAt: string;
}

/** 户型是否已经可以用于排布：没有未解决项，且至少有一段有效墙。 */
export function isLayoutReady(plan: FloorPlan): boolean {
  return (
    plan.unresolvedItems.every((u) => u.resolved) &&
    plan.parsedGeometry.wallRuns.length > 0 &&
    plan.parsedGeometry.wallRuns.every((r) => r.length > 0)
  );
}

/** 总墙长（英寸）——用于粗估与向客户复述。 */
export function totalRunLength(geometry: ParsedGeometry): number {
  return geometry.wallRuns.reduce((sum, r) => sum + r.length, 0);
}
