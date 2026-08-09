/**
 * review.rule → 人工沉淀到 sanity-rules + 实现 + audit 的 promote 清单（FR-22）。
 *
 * 本模块**不改** TypeScript；只生成运营/开发可照着做的清单。
 * 卡在 awaiting_code_settle 时 audit 行为不变。
 */
import type { PlatformKnowledgeCard, ReviewRuleDraft } from "./types.js";

export interface PromoteChecklist {
  cardId: string;
  settleStatus: string | undefined;
  /** 卡本身不会拦交付，直到 settled_in_code */
  auditUnaffectedUntilSettled: true;
  steps: {
    n: number;
    action: string;
    detail: string;
  }[];
  draft: ReviewRuleDraft;
}

export function buildPromoteChecklist(card: PlatformKnowledgeCard): PromoteChecklist {
  if (card.settleTarget !== "review.rule") {
    throw new Error("promote checklist only for review.rule");
  }
  const draft = card.structured?.reviewRule;
  if (!draft) throw new Error("missing structured.reviewRule");

  const id = draft.proposedId ?? "SR-? (assign next free id)";
  const enforcedBy = draft.enforcedBy ?? "audit";
  const impl = draft.implementedInHint ?? "delivery/audit.ts (wire) + domain checker";

  return {
    cardId: card.id,
    settleStatus: card.settleStatus,
    auditUnaffectedUntilSettled: true,
    draft,
    steps: [
      {
        n: 1,
        action: "Register SanityRule",
        detail:
          `Add ${id} to SanityRuleId and SANITY_RULES in src/delivery/sanity-rules.ts ` +
          `(severity=${draft.severity}, enforcedBy=${enforcedBy}). title: ${draft.title}. ` +
          `criterion: ${draft.criterion}. why: ${draft.why}.`,
      },
      {
        n: 2,
        action: "Implement checker",
        detail:
          `Implement the criterion in ${impl}` +
          (draft.suggestedAuditCode
            ? `; map to AuditCode ${draft.suggestedAuditCode}`
            : "; add AuditCode if needed"),
      },
      {
        n: 3,
        action: "Wire auditDeliverable",
        detail:
          "Call the checker from auditDeliverable; push finding with rule id; " +
          "include in checked / checkedRules. Do not re-implement elsewhere.",
      },
      {
        n: 4,
        action: "Regenerate docs + tests",
        detail: "Run `pnpm sanity:doc` and add/extend tests so SR table stays in sync.",
      },
      {
        n: 5,
        action: "Mark settled",
        detail:
          `POST /api/admin/knowledge/${card.id}/mark-settled with note naming the SR id and PR/commit.`,
      },
    ],
  };
}
