/**
 * 测试用户 Agent 领域类型 —— 与生产会话隔离（origin=test），便于上线切割。
 * 全部实现放在 `src/testing/`，不依赖生产编排私有逻辑。
 */
import type { CritiqueReview, SessionOrigin, Timestamp } from "../domain/types.js";

export type TestPointCategory =
  | "dialogue"
  | "routing"
  | "geometry"
  | "appliances"
  | "design"
  | "quote"
  | "sanity"
  | "fr";

/** 运营可选的「倾向性验证点」。用户 agent 据此挑选/植入场景。 */
export interface TestPoint {
  id: string;
  title: string;
  category: TestPointCategory;
  /** 对应 SANITY / FR / 场景 covers */
  refs: string[];
  description: string;
  /** 跑通需要的能力标签 */
  needs: {
    mentionCompany?: boolean;
    floorPlan?: boolean;
    island?: boolean;
    appliances?: boolean;
    tradeAccount?: boolean;
    planView?: boolean;
    fourViews?: boolean;
    quote?: boolean;
    revision?: boolean;
  };
  /** 建议权重：选题时优先 */
  weight: number;
  suggested?: boolean;
}

export type TestCaseStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface TestCaseResult {
  id: string;
  pointIds: string[];
  conversationId?: string;
  title: string;
  status: TestCaseStatus;
  /** beginner | familiar | trade_pro */
  persona?: string;
  userAgentSource?: "llm" | "deterministic";
  notes: string[];
  errors: string[];
  critiqueId?: string;
  startedAt: Timestamp;
  endedAt?: Timestamp;
}

export type TestUserRunStatus = "queued" | "running" | "completed" | "failed";

/** 一次 Admin 触发的测试套件。 */
export interface TestUserRun {
  id: string;
  origin: SessionOrigin; // 恒为 "test"
  status: TestUserRunStatus;
  requestedCount: number;
  selectedPointIds: string[];
  runCritic: boolean;
  sessionRunId: string;
  accountId: string;
  cases: TestCaseResult[];
  critiqueSummary?: string;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  error?: string;
}

export interface StartTestUserRunInput {
  count?: number;
  pointIds?: string[];
  runCritic?: boolean;
  accountId?: string;
}

export interface TestUserRunView {
  run: TestUserRun;
  critiques?: CritiqueReview[];
}
