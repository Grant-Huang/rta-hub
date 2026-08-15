/**
 * Phase 5：已确认面板去重 + 补全缺失项。
 *
 * `confirmedFacts`（原子、可编辑）与 `sections`（叙事分组卡片）以前各自独立
 * 把同一批墙长/特征数字复述一遍；现在 sections 里 ok/assumed 的条目只给一句
 * 简短确认，具体数字只在 confirmedFacts 里出现一次。另外补齐了此前完全没有
 * 行的必备项：户型形状、燃气/强电/岛台被明确回绝时的确认状态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDesignReadiness } from "../src/design/readiness.js";
import { applyChatIslandAnswer, applyChatSiteAnswers } from "../src/design/chat-site-answers.js";
import type { Conversation } from "../src/domain/types.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-08-15T12:00:00.000Z";

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

function readyPlan(): FloorPlan {
  return {
    id: "fp_1",
    conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: {
      wallRuns: [{
        id: "wr_1", label: "North", length: 168,
        startsAtCorner: false, endsAtCorner: false,
        features: [{ id: "wf_1", kind: "plumbing", offset: 24, width: 24 }],
      }],
      ceilingHeight: 96,
      confidence: 0.9,
    },
    parseConfidence: 0.9,
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("已确认的墙长数字只在 confirmedFacts 里出现，section 卡片只给简短确认", () => {
  const plan = readyPlan();
  plan.appliances = [{ kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer" }];
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements: "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows\nFridge 36\"",
    }),
    plan,
    language: "en",
  });
  const wallFact = r.confirmedFacts.find((f) => f.key === "wall:wr_1");
  assert.ok(wallFact, "墙长应该出现在原子事实行里");
  assert.match(wallFact!.value, /168/);

  const space = r.sections.find((s) => s.id === "space");
  assert.ok(space);
  assert.doesNotMatch(space!.body, /168/, "section 卡片不该重复贴墙长数字——已经在上面的明细里了");
  assert.match(space!.body, /confirmed/i, "但仍要给一句简短确认，不能什么都不说");
});

test("待确认/缺失项仍保留完整 brief/askHint——去重只影响已确认的条目", () => {
  const r = evaluateDesignReadiness({ conversation: conv(), plan: undefined, language: "en" });
  const space = r.sections.find((s) => s.id === "space");
  assert.ok(space);
  assert.match(space!.body, /Not discussed/i);
});

test("户型形状：客户文字确认过的模板出现在已确认面板", () => {
  const plan = readyPlan();
  (plan as FloorPlan & { shapeTemplateId?: string }).shapeTemplateId = "u-shaped-kitchen";
  const r = evaluateDesignReadiness({ conversation: conv(), plan, language: "en" });
  const shape = r.confirmedFacts.find((f) => f.key === "shape");
  assert.ok(shape, "确认过形状的户型应该有一行「Kitchen shape」");
  assert.match(shape!.value, /U-shape/);
});

test("没有 shapeTemplateId（自由手输/识图）时不显示户型形状行——不能编一个", () => {
  const r = evaluateDesignReadiness({ conversation: conv(), plan: readyPlan(), language: "en" });
  assert.ok(!r.confirmedFacts.some((f) => f.key === "shape"));
});

test("客户明确说没有燃气/没有岛台——即便没有落成 feature/墙段，也要在已确认面板里看到这条回答", () => {
  const plan = readyPlan();
  const r = evaluateDesignReadiness({
    conversation: conv({ designRequirements: "no gas, electric range\nno room for an island" }),
    plan,
    language: "en",
  });
  const gasFact = r.confirmedFacts.find((f) => f.key === "gas:chat");
  assert.ok(gasFact, "「没有燃气」应该在已确认面板留下一行，不能像没问过一样");
  const islandFact = r.confirmedFacts.find((f) => f.key === "island:chat");
  assert.ok(islandFact, "「没有岛台」也应该留下一行");
});

test("岛台真的建了墙段时，不要既有 wall 行又有 island:chat 行——只留一行", () => {
  const withIsland = applyChatIslandAnswer(readyPlan(), "island 60x36", AT)!;
  const r = evaluateDesignReadiness({ conversation: conv(), plan: withIsland, language: "en" });
  assert.ok(r.confirmedFacts.some((f) => f.key.startsWith("wall:") && /Island/i.test(f.label)));
  assert.ok(!r.confirmedFacts.some((f) => f.key === "island:chat"), "已经有墙段那一行了，不该重复");
});

test("燃气接口真的落了 feature 时，不要既有 gas 特征行又有 gas:chat 行", () => {
  const withGas = applyChatSiteAnswers(readyPlan(), "gas line on North wall 40\"", AT)!.plan;
  const r = evaluateDesignReadiness({ conversation: conv(), plan: withGas, language: "en" });
  assert.ok(r.confirmedFacts.some((f) => f.key.startsWith("gas:") && f.key !== "gas:chat"));
  assert.ok(!r.confirmedFacts.some((f) => f.key === "gas:chat"));
});
