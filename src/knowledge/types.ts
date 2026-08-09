/**
 * 平台可训练知识（FR-22）—— 类型定义。
 *
 * 会话只是采集通道；权威是 Knowledge Card + overlay / 代码 settle。
 */
export type KnowledgeKind =
  | "domain_fact"
  | "design_heuristic"
  | "dialogue_policy"
  | "process"
  | "correction";

export type KnowledgeScope =
  | "orchestrator"
  | "design"
  | "layout"
  | "explain"
  | "all";

/** 沉淀目标 —— 决定 publish 后谁读、怎么生效。 */
export type SettleTarget =
  | "handbook"
  | "config.appliance"
  | "config.layoutHeuristic"
  | "config.dialogue"
  | "review.rule"
  | "reject";

export type KnowledgeCardStatus = "draft" | "confirmed" | "published" | "deprecated";

export type SettleStatus =
  | "memory_only"
  | "config_active"
  | "awaiting_code_settle"
  | "settled_in_code";

export interface ApplianceDefaultsStructured {
  rangeKind?: "freestanding" | "cooktop+wallOven" | "unknown";
  /** 常见宽度（英寸），如 range → [30] */
  standardWidthsIn?: number[];
  preferNoCooktopBase?: boolean;
  /** 覆盖 APPLIANCE_DEFAULTS 的宽度 */
  defaultWidths?: Partial<Record<
    "refrigerator" | "range" | "cooktop" | "wallOven" | "rangeHood" | "microwave" | "dishwasher",
    number
  >>;
}

export interface DialogueStructured {
  maxQuestionsPerTurn?: number;
  skipIfFloorPlanReady?: string[];
}

/** review.rule 的 promote 草稿字段（尚未进 sanity-rules.ts）。 */
export interface ReviewRuleDraft {
  proposedId?: string;
  title: string;
  severity: "blocking" | "advisory";
  criterion: string;
  why: string;
  enforcedBy?: "audit" | "layout" | "render" | "pricing";
  suggestedAuditCode?: string;
  implementedInHint?: string;
}

export interface PlatformKnowledgeStructured {
  applianceDefaults?: ApplianceDefaultsStructured;
  dialogue?: DialogueStructured;
  layoutHeuristic?: {
    preferNoCooktopBase?: boolean;
  };
  reviewRule?: ReviewRuleDraft;
}

export interface PlatformKnowledgeCard {
  id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope[];
  settleTarget: SettleTarget;
  title: string;
  body: { en: string; zh?: string };
  structured?: PlatformKnowledgeStructured;
  provenance: {
    trainerConversationId: string;
    messageIds?: string[];
    taughtBy: string;
    taughtAt: string;
  };
  status: KnowledgeCardStatus;
  settleStatus?: SettleStatus;
  version: number;
  supersedes?: string;
  createdAt: string;
  updatedAt?: string;
  publishedAt?: string;
  publishedBy?: string;
  deprecatedAt?: string;
  /** review.rule 代码 settle 后的备注（SR id、PR 等） */
  settledNote?: string;
}

export interface TrainerChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  /** 本轮提议的卡 id */
  proposedCardIds?: string[];
}

export interface TrainerConversation {
  id: string;
  messages: TrainerChatMessage[];
  cardIds: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** 运行时合并后的平台配置覆盖（仅白名单字段）。 */
export interface PlatformOverlays {
  appliance?: {
    rangeKind?: ApplianceDefaultsStructured["rangeKind"];
    preferNoCooktopBase?: boolean;
    defaultWidths?: ApplianceDefaultsStructured["defaultWidths"];
    standardWidthsIn?: number[];
  };
  layoutHeuristic?: {
    preferNoCooktopBase?: boolean;
  };
  dialogue?: DialogueStructured;
}
