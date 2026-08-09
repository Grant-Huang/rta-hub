/**
 * 风格落库、超时勿重复追问、寒暄勿空转。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingFields, isWaitingForDesignChitchat, isPoliteDesignStall, orchestratorReply } from "../src/agents/orchestrator.js";
import { evaluateDesignReadiness } from "../src/design/readiness.js";
import { interactionProfile } from "../src/trade/interaction.js";
import type { Conversation } from "../src/domain/types.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-06-01T00:00:00.000Z";

test("灰色纹理平板门 / matte laminate 算已答风格", () => {
  assert.equal(missingFields("灰色纹理平板门\nBudget CAD $12k\nOntario ON").includes("style"), false);
  assert.equal(missingFields("Matte white laminate doors\nBudget CAD $12k\nOntario ON").includes("style"), false);
  assert.ok(missingFields("Budget CAD $12k\nOntario ON").includes("style"));
});

test("Confirmed brief 写出灰色纹理平板门", () => {
  const plan: FloorPlan = {
    id: "fp_1", conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: {
      wallRuns: [{
        id: "wr_1", label: "North", length: 132,
        startsAtCorner: false, endsAtCorner: false,
        features: [{ id: "wf_1", kind: "plumbing", offset: 60, width: 24 }],
      }],
      ceilingHeight: 96, confidence: 0.9,
    },
    parseConfidence: 0.9, unresolvedItems: [], createdAt: AT, updatedAt: AT,
    appliances: [{ kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "customer" }],
  };
  const conv: Conversation = {
    id: "cv_1", customerAccountId: "ca_1", messages: [],
    designRequirements: "L-shape\n灰色纹理平板门\nBudget CAD $12–18k\nOntario ON\nNo windows\nassumed widths are fine",
    perCompanyThreads: [], createdAt: AT,
  };
  const r = evaluateDesignReadiness({ conversation: conv, plan, language: "zh" });
  const style = r.items.find((i) => i.id === "style");
  assert.equal(style?.status, "ok");
  assert.match(style!.brief, /灰色|平板/);
  assert.equal(r.sections.find((s) => s.id === "intent")?.status, "locked");
});

test("等设计寒暄视为催出图", () => {
  assert.equal(isWaitingForDesignChitchat("Excited to see it coming together"), true);
  assert.equal(isWaitingForDesignChitchat("Waiting for design overview"), true);
  assert.equal(isWaitingForDesignChitchat("Anticipation is half the fun"), true);
  assert.equal(isWaitingForDesignChitchat("what's the budget range?"), false);
});

test("资料齐 + 等设计寒暄：直接开工确认", async () => {
  const r = await orchestratorReply(
    undefined,
    { conversationId: "c1", requirements: "Modern\nON", history: [] },
    "Excited to see it coming together",
    {
      profile: interactionProfile("consumer"),
      language: "en",
      intakeStatus: {
        missing: [], openAsks: [], confirmedBriefs: [],
        floorPlanReady: true, readyToAskDesign: true,
      },
    },
  );
  assert.match(r.content, /generating a layout/i);
  assert.doesNotMatch(r.content, /please wait|design team/i);
});

test("LLM 请稍候空转被改成出图邀约", async () => {
  const client = {
    async complete() {
      return "Our design team is working on it — please hold tight! Anticipation is half the fun.";
    },
  };
  const r = await orchestratorReply(
    client as never,
    { conversationId: "c1", requirements: "Modern\nON", history: [] },
    "ok thanks",
    {
      profile: interactionProfile("consumer"),
      language: "en",
      intakeStatus: {
        missing: [], openAsks: [], confirmedBriefs: [],
        floorPlanReady: true, readyToAskDesign: true,
      },
    },
  );
  assert.equal(isPoliteDesignStall("please hold tight"), true);
  assert.match(r.content, /Shall I generate/i);
  assert.doesNotMatch(r.content, /please hold|design team is working/i);
});
