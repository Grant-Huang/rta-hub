/**
 * 知识卡状态机：confirm / publish / deprecate / markSettled（FR-22）。
 */
import { randomUUID } from "node:crypto";
import type {
  KnowledgeCardStatus,
  PlatformKnowledgeCard,
  SettleStatus,
  SettleTarget,
} from "./types.js";
import { validateKnowledgeCard } from "./validate.js";

export class KnowledgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function settleStatusForPublish(target: SettleTarget): SettleStatus {
  if (target === "handbook") return "memory_only";
  if (target.startsWith("config.")) return "config_active";
  if (target === "review.rule") return "awaiting_code_settle";
  throw new KnowledgeError(`cannot publish settleTarget ${target}`, "BAD_TARGET");
}

export function createDraftCard(
  partial: Omit<PlatformKnowledgeCard, "id" | "status" | "version" | "createdAt"> & {
    id?: string;
  },
): PlatformKnowledgeCard {
  const card: PlatformKnowledgeCard = {
    ...partial,
    id: partial.id ?? randomUUID(),
    status: "draft",
    version: 1,
    createdAt: nowIso(),
  };
  const issues = validateKnowledgeCard(card);
  if (issues.length) {
    throw new KnowledgeError(issues.map((i) => i.message).join("; "), issues[0]!.code);
  }
  return card;
}

const ALLOWED: Record<KnowledgeCardStatus, KnowledgeCardStatus[]> = {
  draft: ["confirmed", "deprecated"],
  confirmed: ["published", "draft", "deprecated"],
  published: ["deprecated"],
  deprecated: [],
};

export function confirmCard(card: PlatformKnowledgeCard): PlatformKnowledgeCard {
  assertTransition(card.status, "confirmed");
  const issues = validateKnowledgeCard({ ...card, status: "confirmed" });
  if (issues.length) {
    throw new KnowledgeError(issues.map((i) => i.message).join("; "), issues[0]!.code);
  }
  return { ...card, status: "confirmed", updatedAt: nowIso() };
}

export function publishCard(
  card: PlatformKnowledgeCard,
  publishedBy: string,
): PlatformKnowledgeCard {
  // 允许 confirmed 或 draft 一键发布（draft 经校验，等同 confirm+publish）
  if (card.status !== "confirmed" && card.status !== "draft") {
    throw new KnowledgeError(`cannot publish from ${card.status}`, "BAD_STATUS");
  }
  const issues = validateKnowledgeCard({ ...card, status: "published" });
  if (issues.length) {
    throw new KnowledgeError(issues.map((i) => i.message).join("; "), issues[0]!.code);
  }
  if (card.settleTarget === "reject") {
    throw new KnowledgeError("cannot publish reject", "REJECT_TARGET");
  }
  return {
    ...card,
    status: "published",
    settleStatus: settleStatusForPublish(card.settleTarget),
    publishedAt: nowIso(),
    publishedBy,
    version: card.version + 1,
    updatedAt: nowIso(),
  };
}

export function deprecateCard(card: PlatformKnowledgeCard): PlatformKnowledgeCard {
  assertTransition(card.status, "deprecated");
  return {
    ...card,
    status: "deprecated",
    deprecatedAt: nowIso(),
    updatedAt: nowIso(),
    version: card.version + 1,
  };
}

/** review.rule：代码接线完成后标记。 */
export function markSettledInCode(
  card: PlatformKnowledgeCard,
  note: string,
): PlatformKnowledgeCard {
  if (card.settleTarget !== "review.rule") {
    throw new KnowledgeError("only review.rule can be mark-settled", "BAD_TARGET");
  }
  if (card.status !== "published") {
    throw new KnowledgeError("publish before marking settled", "BAD_STATUS");
  }
  if (card.settleStatus !== "awaiting_code_settle" && card.settleStatus !== "settled_in_code") {
    throw new KnowledgeError(`unexpected settleStatus ${card.settleStatus}`, "BAD_STATUS");
  }
  return {
    ...card,
    settleStatus: "settled_in_code",
    settledNote: note,
    updatedAt: nowIso(),
  };
}

function assertTransition(from: KnowledgeCardStatus, to: KnowledgeCardStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw new KnowledgeError(`cannot move ${from} → ${to}`, "BAD_STATUS");
  }
}

export function patchCard(
  card: PlatformKnowledgeCard,
  patch: Partial<Pick<
    PlatformKnowledgeCard,
    "title" | "body" | "kind" | "scope" | "settleTarget" | "structured" | "supersedes"
  >>,
): PlatformKnowledgeCard {
  if (card.status === "published" || card.status === "deprecated") {
    throw new KnowledgeError("edit only draft/confirmed cards", "BAD_STATUS");
  }
  const next = { ...card, ...patch, updatedAt: nowIso() };
  const issues = validateKnowledgeCard(next);
  if (issues.length) {
    throw new KnowledgeError(issues.map((i) => i.message).join("; "), issues[0]!.code);
  }
  return next;
}
