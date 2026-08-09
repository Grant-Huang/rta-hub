/**
 * 厂商 L1 学习队列类型（FR-22.2）—— 按 companyId 隔离，禁止写入 L0。
 *
 * 与 PlatformKnowledgeCard 分轨：本队列只沉淀到本公司 draft 规格 /
 * CompanyHandbook / CodingRules 候选，永不 publish 价目、永不进平台 trainer。
 */
import type { CompanyCodingRules } from "../domain/types.js";

/** 信号来源。 */
export type L1LearnSource =
  | "session"
  | "import_unresolved"
  | "capability_pending"
  | "price_matrix_hole"
  | "assembled_unavailable";

/**
 * 确认后可落入的 L1 目标。
 * - handbook / codingRules：写进该公司 ProductSpecVersion **draft**
 * - specDraftNote：仅记候选说明（不改矩阵数字）
 */
export type L1SettleTarget = "handbook" | "codingRules" | "specDraftNote";

export type L1LearnStatus = "draft" | "confirmed" | "applied" | "dismissed";

/** 确认后可合并进 draft 的结构化建议（不含价格数字）。 */
export interface L1LearnProposal {
  /** 追加到 CompanyHandbook.text */
  handbookAppend?: string;
  /** 合并进 CodingRules.prefixGuide / tokens（不覆盖整表除非显式） */
  codingRulesPatch?: {
    prefixGuideAppend?: CompanyCodingRules["prefixGuide"];
    usesBoxDoorSuffixes?: boolean;
    materialTokens?: Record<string, string>;
    finishTokens?: Record<string, string>;
  };
  /** 给人看的待办（矩阵洞、assembled 缺口等）——禁止含伪造价格 */
  note?: string;
  moduleCode?: string;
  field?: string;
}

export interface CompanyLearningItem {
  id: string;
  /** 硬隔离键：列表 / 确认 / 应用必须带同一 companyId。 */
  companyId: string;
  status: L1LearnStatus;
  source: L1LearnSource;
  settleTarget: L1SettleTarget;
  title: string;
  summary: string;
  proposal?: L1LearnProposal;
  /** 去重键片段（如 unresolved field+raw、moduleCode） */
  signalRef?: string;
  createdAt: string;
  updatedAt?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  dismissedBy?: string;
  appliedAt?: string;
  /** 应用目标：必须是本公司 draft ProductSpecVersion.id */
  appliedToSpecVersionId?: string;
}
