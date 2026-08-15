/**
 * Phase 3：燃气/强电接口位置 + 岛台空间——补齐必备信息清单里此前完全缺失的三项。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyChatIslandAnswer, applyChatSiteAnswers, isDeferElectrical, isDeferGas, isDeferIsland,
  parseElectricalFromChat, parseGasFromChat, wantsIsland,
} from "../src/design/chat-site-answers.js";
import { isIsland, type FloorPlan } from "../src/floorplan/types.js";
import { evaluateDesignReadiness } from "../src/design/readiness.js";
import type { Conversation } from "../src/domain/types.js";

const AT = "2026-08-08T12:00:00.000Z";

function plan(): FloorPlan {
  return {
    id: "fp_test",
    conversationId: "c1",
    sourceFile: { name: "x.png", mimeType: "image/png", sizeBytes: 1 },
    parseConfidence: 0.9,
    parsedGeometry: {
      wallRuns: [
        {
          id: "wr_n", label: "North", length: 144,
          startsAtCorner: true, endsAtCorner: true, features: [],
        },
        {
          id: "wr_w", label: "West", length: 96,
          startsAtCorner: true, endsAtCorner: true, features: [],
        },
      ],
      confidence: 0.9,
    },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

function conv(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    accountId: "acc_1",
    messages: [],
    perCompanyThreads: [],
    designRequirements: "",
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  } as Conversation;
}

// —— 燃气 ——

test("解析燃气接口到指定墙", () => {
  const g = parseGasFromChat("Q: gas line on the North wall, about 40\" from the corner", plan());
  assert.ok(g);
  assert.equal(g!.wallRunId, "wr_n");
  assert.equal(g!.offset, 40);
});

test("isDeferGas：客户明确说没有燃气/用电灶", () => {
  assert.ok(isDeferGas("no gas, electric range"));
  assert.ok(isDeferGas("没有燃气，用电磁炉"));
  assert.ok(isDeferGas("全电厨房"));
  assert.ok(!isDeferGas("gas line on North wall"));
});

test("客户说没有燃气时不落 gas feature", () => {
  assert.equal(parseGasFromChat("no gas, we'll go electric", plan()), undefined);
});

// —— 强电 ——

test("解析强电接口到指定墙", () => {
  const e = parseElectricalFromChat("electrical outlet on West wall, 20\" from corner", plan());
  assert.ok(e);
  assert.equal(e!.wallRunId, "wr_w");
  assert.equal(e!.offset, 20);
});

test("isDeferElectrical：客户说强电位置后定", () => {
  assert.ok(isDeferElectrical("electrical later"));
  assert.ok(isDeferElectrical("强电后定"));
  assert.ok(!isDeferElectrical("electrical on North wall"));
});

// —— 岛台 ——

test("wantsIsland / isDeferIsland 互斥", () => {
  assert.ok(wantsIsland("we'd like an island"));
  assert.ok(wantsIsland("想要一个中岛"));
  assert.ok(!wantsIsland("no room for an island"));
  assert.ok(isDeferIsland("no room for an island"));
  assert.ok(isDeferIsland("没有空间做岛台"));
});

test("客户明确要岛台且给了尺寸——建岛台墙壳", () => {
  const next = applyChatIslandAnswer(plan(), "we want an island, about 60x36", AT);
  assert.ok(next);
  const run = next!.parsedGeometry.wallRuns.find((r) => isIsland(r));
  assert.ok(run);
  assert.equal(run!.length, 60);
  assert.equal(run!.depth, 36);
});

test("客户要岛台但没给尺寸——先建壳，长度留 0 等追问，不凭空编尺寸", () => {
  const next = applyChatIslandAnswer(plan(), "yes, we want an island", AT);
  assert.ok(next);
  const run = next!.parsedGeometry.wallRuns.find((r) => isIsland(r));
  assert.ok(run);
  assert.equal(run!.length, 0);
});

test("已有岛台时不重复建", () => {
  const withIsland = applyChatIslandAnswer(plan(), "island 60x36", AT)!;
  assert.equal(applyChatIslandAnswer(withIsland, "another island 48x24", AT), undefined);
});

test("客户说没有岛台——不建墙壳", () => {
  assert.equal(applyChatIslandAnswer(plan(), "no room for an island", AT), undefined);
});

// —— applyChatSiteAnswers 综合 ——

test("applyChatSiteAnswers：一句话里燃气/强电/岛台都记下", () => {
  const result = applyChatSiteAnswers(
    plan(),
    "gas line on North wall 40\"; electrical on West wall 20\"; island 60x36",
    AT,
  );
  assert.ok(result);
  assert.ok(result!.applied.includes("gas"));
  assert.ok(result!.applied.includes("electrical"));
  assert.ok(result!.applied.includes("island"));
});

// —— readiness.ts 接入 ——

test("readiness：燃气/强电/岛台缺失时标 missing，且不进 confirmedFacts", () => {
  const r = evaluateDesignReadiness({ conversation: conv(), plan: plan(), language: "en" });
  assert.equal(r.items.find((i) => i.id === "gas")?.status, "missing");
  assert.equal(r.items.find((i) => i.id === "electrical")?.status, "missing");
  assert.equal(r.items.find((i) => i.id === "island")?.status, "missing");
});

test("readiness：客户明确说没有燃气/没有岛台——算已确认，不阻断 requiredIntakeComplete", () => {
  const r = evaluateDesignReadiness({
    conversation: conv({ designRequirements: "no gas, electric range\nno island" }),
    plan: plan(),
    language: "en",
  });
  assert.equal(r.items.find((i) => i.id === "gas")?.status, "ok");
  assert.equal(r.items.find((i) => i.id === "island")?.status, "ok");
});

test("readiness：燃气/强电/岛台缺失挡 requiredIntakeComplete，但不挡 readyToAskDesign", () => {
  let p = plan();
  const withFeatures = applyChatSiteAnswers(
    p,
    "ceiling 96\"; plumbing on North wall 40\"; fridge 33\"",
    AT,
  );
  p = withFeatures ? withFeatures.plan : p;
  p = { ...p, appliances: [{ kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "customer" }] };

  const r = evaluateDesignReadiness({
    conversation: conv({ designRequirements: "Modern style\nBudget CAD $10-20k\nOntario ON" }),
    plan: p,
    language: "en",
  });
  // 燃气/强电/岛台都还没答——必备信息清单没收完
  assert.equal(r.requiredIntakeComplete, false);
  // 但不挡真正出图：上下水/家电齐了就该能问是否出图
  assert.equal(r.readyToAskDesign, true);
});

test("readiness：已建岛台但尺寸未定——island 状态仍是 missing（不能拿 0 冒充已确认）", () => {
  const withIsland = applyChatIslandAnswer(plan(), "we want an island", AT)!;
  const r = evaluateDesignReadiness({ conversation: conv(), plan: withIsland, language: "en" });
  assert.equal(r.items.find((i) => i.id === "island")?.status, "missing");
});

test("readiness：岛台尺寸给全后 island 状态转 ok", () => {
  const withIsland = applyChatIslandAnswer(plan(), "island 60x36", AT)!;
  const r = evaluateDesignReadiness({ conversation: conv(), plan: withIsland, language: "en" });
  assert.equal(r.items.find((i) => i.id === "island")?.status, "ok");
});
