/**
 * FR-15 设计就绪检查表。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDesignReadiness } from "../src/design/readiness.js";
import type { Conversation } from "../src/domain/types.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-06-01T00:00:00.000Z";

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "cv_1",
    customerAccountId: "ca_1",
    messages: [],
    designRequirements: "",
    perCompanyThreads: [],
    createdAt: AT,
    ...over,
  };
}

function readyPlan(over: Partial<FloorPlan["parsedGeometry"]> = {}): FloorPlan {
  return {
    id: "fp_1",
    conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: {
      wallRuns: [{
        id: "wr_1", label: "North", length: 144,
        startsAtCorner: false, endsAtCorner: false,
        features: [{ id: "wf_1", kind: "plumbing", offset: 60, width: 24 }],
      }],
      ceilingHeight: 96,
      confidence: 0.9,
      ...over,
    },
    parseConfidence: 0.9,
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("墙长未齐时不能问出设计", () => {
  const r = evaluateDesignReadiness({ conversation: conv(), plan: undefined, language: "en" });
  assert.equal(r.readyToAskDesign, false);
  assert.ok(r.items.find((i) => i.id === "walls_ceiling")?.status === "missing");
});

test("几何齐但缺上下水时不能问出设计（不能猜）", () => {
  const plan = readyPlan({
    wallRuns: [{
      id: "wr_1", label: "North", length: 144,
      startsAtCorner: false, endsAtCorner: false, features: [],
    }],
  });
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements: "Modern style\nBudget CAD $10-20k\nOntario ON",
    }),
    plan,
    language: "en",
  });
  assert.equal(r.readyToAskDesign, false);
  assert.equal(r.items.find((i) => i.id === "plumbing")?.status, "missing");
});

test("关键项齐备时 ready，并给出文字确认复述", () => {
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements:
        "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows\nAppliances later",
    }),
    plan: readyPlan(),
    companyId: "co_1",
    companyName: "Pilot Co",
    language: "en",
  });
  assert.equal(r.readyToAskDesign, true);
  assert.match(r.confirmationText, /Shall I generate a design/i);
  assert.match(r.confirmationText, /Plumbing/i);
  assert.ok(r.sections.some((s) => s.id === "space" && s.status === "locked"));
});

test("推定家电宽度记为 needs_confirm，但仍可进入出图问句（复述里必须写出）", () => {
  const plan = readyPlan();
  plan.appliances = [{
    kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "assumed",
  }];
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements: "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows",
    }),
    plan,
    language: "en",
  });
  assert.equal(r.readyToAskDesign, true);
  assert.equal(r.items.find((i) => i.id === "appliances_sizes")?.status, "needs_confirm");
  assert.match(r.confirmationText, /assumed/i);
});

test("Tab1 sections 未谈及时写 Not discussed，而不是铺满 TBD 字段", () => {
  const r = evaluateDesignReadiness({ conversation: conv(), plan: undefined, language: "en" });
  const site = r.sections.find((s) => s.id === "site");
  assert.ok(site);
  assert.match(site!.body, /Not discussed/i);
});
