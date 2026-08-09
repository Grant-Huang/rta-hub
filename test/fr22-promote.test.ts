/**
 * FR-22：review.rule 在 settled_in_code 前不影响 audit；promote 清单完整。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromoteChecklist,
  confirmCard,
  createDraftCard,
  markSettledInCode,
  publishCard,
} from "../src/knowledge/index.js";
import { auditDeliverable } from "../src/delivery/audit.js";
import { SANITY_RULES } from "../src/delivery/sanity-rules.js";

test("review.rule awaiting_code_settle does not change SANITY_RULES table", () => {
  const before = SANITY_RULES.length;
  let c = createDraftCard({
    kind: "process",
    scope: ["all"],
    settleTarget: "review.rule",
    title: "Extra disclosure rule",
    body: { en: "Must disclose product scope on every quote." },
    structured: {
      reviewRule: {
        title: "Extra disclosure",
        severity: "advisory",
        criterion: "Quote list includes product scope notice",
        why: "Customers confuse RTA with custom",
        enforcedBy: "audit",
        suggestedAuditCode: "UNDISCLOSED_PRODUCT_SCOPE",
      },
    },
    provenance: {
      trainerConversationId: "t",
      taughtBy: "admin",
      taughtAt: new Date().toISOString(),
    },
  });
  c = publishCard(confirmCard(c), "admin");
  assert.equal(c.settleStatus, "awaiting_code_settle");
  assert.equal(SANITY_RULES.length, before, "cards must not mutate SR table");

  const checklist = buildPromoteChecklist(c);
  assert.equal(checklist.auditUnaffectedUntilSettled, true);
  assert.ok(checklist.steps.some((s) => /sanity-rules/i.test(s.detail)));
  assert.ok(checklist.steps.some((s) => /auditDeliverable/i.test(s.detail)));

  // 空输入 audit 仍可跑（不因卡而多出新 rule id）
  const report = auditDeliverable({
    deliverable: "planView",
    stage: "collecting",
  });
  assert.ok(Array.isArray(report.findings));

  c = markSettledInCode(c, "Would map to existing SR-D2; documented only");
  assert.equal(c.settleStatus, "settled_in_code");
  assert.equal(SANITY_RULES.length, before);
});
