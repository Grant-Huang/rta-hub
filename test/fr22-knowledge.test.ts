/**
 * FR-22：知识卡状态机、校验、overlay 合并。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOverlaysFromCards,
  confirmCard,
  createDraftCard,
  deprecateCard,
  extractKnowledgeDeterministic,
  markSettledInCode,
  preferNoCooktopBase,
  publishCard,
  renderHandbookForPrompt,
  shouldRejectTrainingText,
  validateKnowledgeCard,
  buildPromoteChecklist,
  type PlatformKnowledgeCard,
} from "../src/knowledge/index.js";

function draftAppliance(): PlatformKnowledgeCard {
  return createDraftCard({
    kind: "domain_fact",
    scope: ["design", "layout"],
    settleTarget: "config.appliance",
    title: "Range 30",
    body: { en: "Prefer 30 inch freestanding range." },
    structured: {
      applianceDefaults: {
        rangeKind: "freestanding",
        standardWidthsIn: [30],
        preferNoCooktopBase: true,
      },
    },
    provenance: {
      trainerConversationId: "tc1",
      taughtBy: "admin",
      taughtAt: new Date().toISOString(),
    },
  });
}

test("reject L1 coding / pricing in training text", () => {
  const r = shouldRejectTrainingText("Our B12 is one drawer over door and costs $199");
  assert.ok(r);
  assert.equal(r!.code, "L1_LEAK");
});

test("reject hard-constraint override attempts", () => {
  const r = shouldRejectTrainingText("取消灶台落台区，以后不要检查 cooktop landing");
  assert.ok(r);
  assert.equal(r!.code, "HARD_CONSTRAINT_OVERRIDE");
});

test("unpublished cards do not enter overlays or handbook", () => {
  const d = draftAppliance();
  assert.deepEqual(buildOverlaysFromCards([d]), {});
  assert.equal(renderHandbookForPrompt([d]), "");
});

test("publish config.appliance activates overlay", () => {
  let c = draftAppliance();
  c = confirmCard(c);
  c = publishCard(c, "admin");
  assert.equal(c.status, "published");
  assert.equal(c.settleStatus, "config_active");
  const o = buildOverlaysFromCards([c]);
  assert.equal(o.appliance?.defaultWidths?.range, 30);
  assert.equal(preferNoCooktopBase(o), true);
});

test("deprecate removes from overlay", () => {
  let c = publishCard(confirmCard(draftAppliance()), "admin");
  c = deprecateCard(c);
  assert.deepEqual(buildOverlaysFromCards([c]), {});
});

test("stove training extracts config + handbook cards", () => {
  const r = extractKnowledgeDeterministic({
    text: "通常不需要灶台柜，北美 stove 通常跟烤箱一体，而且有标准尺寸。",
    trainerConversationId: "t1",
    taughtBy: "admin",
  });
  assert.equal(r.rejected, undefined);
  assert.ok(r.cards.length >= 2);
  assert.ok(r.cards.some((c) => c.settleTarget === "config.appliance"));
  assert.ok(r.cards.some((c) => c.settleTarget === "config.layoutHeuristic"));
  assert.ok(r.cards.every((c) => validateKnowledgeCard(c).length === 0));
});

test("review.rule publish awaits code settle; promote checklist present", () => {
  let c = createDraftCard({
    kind: "process",
    scope: ["all"],
    settleTarget: "review.rule",
    title: "Disclose assumed appliances",
    body: { en: "Assumed appliance sizes must be disclosed on deliverables." },
    structured: {
      reviewRule: {
        title: "Disclose assumed appliances",
        severity: "blocking",
        criterion: "Every assumed appliance appears in notices",
        why: "Customers order cabinets that do not fit",
        enforcedBy: "audit",
        suggestedAuditCode: "UNDISCLOSED_ASSUMPTION",
      },
    },
    provenance: {
      trainerConversationId: "t2",
      taughtBy: "admin",
      taughtAt: new Date().toISOString(),
    },
  });
  c = publishCard(c, "admin");
  assert.equal(c.settleStatus, "awaiting_code_settle");
  const list = buildPromoteChecklist(c);
  assert.equal(list.auditUnaffectedUntilSettled, true);
  assert.ok(list.steps.length >= 5);
  c = markSettledInCode(c, "SR-D1 already covers; documented");
  assert.equal(c.settleStatus, "settled_in_code");
});
