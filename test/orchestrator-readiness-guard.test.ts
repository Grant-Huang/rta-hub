/**
 * 编排层：未就绪时禁止谎称可出图。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimsPrematureDesignReady, guardPrematureDesignOffer,
  orchestratorReply, userRequestsDesignGeneration,
} from "../src/agents/orchestrator.js";
import { interactionProfile } from "../src/trade/interaction.js";

const profile = interactionProfile("consumer");
const intakeNotReady = {
  missing: ["kitchen size"],
  openAsks: ['Upload a floor plan (+) or enter each wall length and ceiling height in chat.'],
  confirmedBriefs: ["Style: Modern."],
  floorPlanReady: false,
  readyToAskDesign: false,
};

test("识别客户请求出图", () => {
  assert.equal(userRequestsDesignGeneration("yes please generate the design now"), true);
  assert.equal(userRequestsDesignGeneration("sink on left wall"), false);
});

test("已齐且客户要出图：直接确认开工，不再问要不要出图", async () => {
  const intakeReady = {
    missing: [] as string[],
    openAsks: [] as string[],
    confirmedBriefs: ["Style: Modern."],
    floorPlanReady: true,
    readyToAskDesign: true,
  };
  let called = false;
  const client = {
    async complete() {
      called = true;
      return "Shall I generate again?";
    },
  };
  const r = await orchestratorReply(
    client as never,
    { conversationId: "c1", requirements: "Modern\nBC", history: [] },
    "yes please generate the design now",
    {
      profile: interactionProfile("consumer"),
      language: "en",
      intakeStatus: intakeReady,
    },
  );
  assert.equal(called, false);
  assert.match(r.content, /generating a layout/i);
  assert.doesNotMatch(r.content, /Shall I generate/i);
});

test("识别未就绪时的谎称可出图", () => {
  assert.equal(
    claimsPrematureDesignReady(
      "Everything I need for the floor plan is now confirmed. Shall I go ahead and generate a design?",
    ),
    true,
  );
  assert.equal(claimsPrematureDesignReady("Where is the sink plumbing?"), false);
});

test("guard：未就绪时把邀请出图改回追问缺口", () => {
  const guarded = guardPrematureDesignOffer(
    "Everything I need is confirmed. Shall I generate a design based on what you've shared so far?",
    "Modern style\nBC",
    profile,
    0,
    "en",
    intakeNotReady,
  );
  assert.doesNotMatch(guarded, /Shall I generate/i);
  assert.match(guarded, /wall length|ceiling|Upload a floor plan/i);
});

test("客户未就绪却要求出图：不走 LLM，直接追问缺口", async () => {
  let called = false;
  const client = {
    async complete() {
      called = true;
      return "Shall I generate a design? Any preference for more drawers?";
    },
  };
  const r = await orchestratorReply(
    client as never,
    { conversationId: "c1", requirements: "Modern\nBC", history: [] },
    "yes please generate the design now",
    { profile, language: "en", intakeStatus: intakeNotReady },
  );
  assert.equal(called, false);
  assert.doesNotMatch(r.content, /Shall I generate|drawers/i);
  assert.match(r.content, /wall length|ceiling|Upload a floor plan/i);
});

test("LLM 若仍谎称已齐：输出被 guard 掉", async () => {
  const client = {
    async complete() {
      return "Everything I need for the floor plan is now confirmed. Shall I generate a design?";
    },
  };
  const r = await orchestratorReply(
    client as never,
    { conversationId: "c1", requirements: "Modern\nBC", history: [] },
    "sink on left wall",
    { profile, language: "en", intakeStatus: intakeNotReady },
  );
  assert.doesNotMatch(r.content, /Shall I generate|Everything I need/i);
  assert.match(r.content, /wall length|ceiling|Upload a floor plan/i);
});
