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

/** 一段直墙。厨房通常是 1-3 段（一字/L 型/U 型）。 */
export interface WallRun {
  id: string;
  label: string;
  /** 可用长度（英寸）。 */
  length: number;
  /** 起点是否是内墙角（与上一段相接）。 */
  startsAtCorner: boolean;
  endsAtCorner: boolean;
  features: WallFeature[];
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
