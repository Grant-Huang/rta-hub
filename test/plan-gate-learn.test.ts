/**
 * FR-14 出图闸门叙事 + FR-22 学习闭环（audit → draft，不 publish）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customerMayPreviewDeliverable,
  renderAdjustingNarrative,
} from "../src/delivery/adjusting.js";
import type { AuditReport } from "../src/delivery/audit.js";
import { proposeDraftsFromAudit } from "../src/knowledge/learn.js";

function blockedReport(): AuditReport {
  return {
    ok: false,
    findings: [{
      code: "ERGONOMICS",
      severity: "blocking",
      message: "灶具落台区不足",
      rule: "SR-E2",
    }],
    blockers: [{
      code: "ERGONOMICS",
      severity: "blocking",
      message: "灶具落台区不足",
      rule: "SR-E2",
    }],
    notices: [],
    checked: ["ERGONOMICS"],
    checkedRules: ["SR-E2"],
  };
}

test("audit 未过时不可预览交付；叙事含 SR-*", () => {
  const r = blockedReport();
  assert.equal(customerMayPreviewDeliverable(r), false);
  const narrative = renderAdjustingNarrative(r, "zh", { attempt: 1, maxAttempts: 2 });
  assert.match(narrative, /SR-E2/);
  assert.match(narrative, /正在调整/);
});

test("audit 通过时允许预览", () => {
  const r: AuditReport = {
    ok: true,
    findings: [],
    blockers: [],
    notices: [],
    checked: ["STAGE"],
    checkedRules: ["SR-D3"],
  };
  assert.equal(customerMayPreviewDeliverable(r), true);
});

test("从 audit 阻断自动提议 draft，status=draft 且不 publish", () => {
  const cards = proposeDraftsFromAudit({
    audit: blockedReport(),
    conversationId: "cv_x",
  });
  assert.ok(cards.length >= 1);
  assert.equal(cards[0]!.status, "draft");
  assert.equal(cards[0]!.settleTarget, "review.rule");
  assert.match(cards[0]!.body.en, /not published/i);
});
