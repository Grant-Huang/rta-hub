/**
 * 方案的持久化形态 —— MVP-3。
 *
 * 之前排布结果只在内存里，刷新就丢。报价快照不受影响（那是独立冻结的），
 * 但客户改了几轮设计后关掉页面，方案就没了。
 *
 * 与 `Quote` 的快照语义不同：
 *   - `Quote` 一经确认即**不可变**，是对外承诺的凭据；
 *   - `StoredLayout` 是**工作态**，会随对话反复重算，每次重算追加一条
 *     `DesignRevision`（§3.6 的修订链）。
 */
import type { DesignLayout, DesignRevision } from "../domain/types.js";
import type { GeneratedLayout, Placement } from "./generate.js";
import type { ErgonomicViolation } from "./ergonomics.js";
import type { AestheticScore } from "./aesthetics.js";

export interface StoredLayout {
  /** `${floorPlanId}|${companyId}`，同时作为 id 与唯一键。 */
  id: string;
  floorPlanId: string;
  companyId: string;
  conversationId: string;
  /** 关联的 DesignLayout（承载 specVersionId 与修订号）。 */
  designLayoutId: string;
  currentRevisionNo: number;
  placements: Placement[];
  ergonomics: ErgonomicViolation[];
  aesthetics: { wallRunId: string; score: AestheticScore }[];
  acceptable: boolean;
  moduleCounts: GeneratedLayout["moduleCounts"];
  createdAt: string;
  updatedAt: string;
}

export function layoutKey(floorPlanId: string, companyId: string): string {
  return `${floorPlanId}|${companyId}`;
}

export interface PersistInput {
  floorPlanId: string;
  companyId: string;
  conversationId: string;
  designLayoutId: string;
  revisionNo: number;
  layout: GeneratedLayout;
  at: string;
  createdAt?: string;
}

export function toStoredLayout(input: PersistInput): StoredLayout {
  return {
    id: layoutKey(input.floorPlanId, input.companyId),
    floorPlanId: input.floorPlanId,
    companyId: input.companyId,
    conversationId: input.conversationId,
    designLayoutId: input.designLayoutId,
    currentRevisionNo: input.revisionNo,
    placements: input.layout.placements,
    ergonomics: input.layout.ergonomics,
    aesthetics: input.layout.aesthetics,
    acceptable: input.layout.acceptable,
    moduleCounts: input.layout.moduleCounts,
    createdAt: input.createdAt ?? input.at,
    updatedAt: input.at,
  };
}

/** 从存储形态还原成引擎用的结构。 */
export function toGeneratedLayout(stored: StoredLayout): GeneratedLayout {
  return {
    placements: stored.placements,
    warnings: [],
    moduleCounts: stored.moduleCounts,
    ergonomics: stored.ergonomics,
    aesthetics: stored.aesthetics,
    acceptable: stored.acceptable,
  };
}

/**
 * 为一次重算生成修订记录。
 *
 * `DesignRevision` 不覆盖历史——客户改了三轮就是三条记录，
 * 这是 §3.6「可追溯」的一部分，也是事后复盘"当时给的是哪一版"的依据。
 */
export function buildRevision(input: {
  designLayoutId: string;
  revisionNo: number;
  layout: GeneratedLayout;
  triggeredBy: DesignRevision["triggeredBy"];
  changeSummary: string;
  at: string;
}): DesignRevision {
  return {
    id: `dr_${input.designLayoutId}_${input.revisionNo}`,
    designLayoutId: input.designLayoutId,
    revisionNo: input.revisionNo,
    selections: input.layout.moduleCounts.map((m) => ({
      moduleId: m.moduleId,
      qty: m.qty,
      width: m.width,
      height: m.height,
      depth: m.depth,
      assembly: "RTA" as const,
      hardwareOptionIds: [],
      accessoryOptionIds: [],
    })),
    createdAt: input.at,
    triggeredBy: input.triggeredBy,
    changeSummary: input.changeSummary,
  };
}

export function buildDesignLayout(input: {
  id: string;
  companyId: string;
  conversationId: string;
  specVersionId: string;
  floorPlanId: string;
  revisionNo: number;
}): DesignLayout {
  return {
    id: input.id,
    companyId: input.companyId,
    conversationId: input.conversationId,
    specVersionId: input.specVersionId,
    floorPlanId: input.floorPlanId,
    currentRevisionNo: input.revisionNo,
    status: "draft",
  };
}
