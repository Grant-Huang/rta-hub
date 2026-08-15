/**
 * 两处收尾：
 * 1. ollama-vision.ts 的 toRawExtraction 正确解析模型给的 templateGuess；
 * 2. createFloorPlanWithOutcome 的 templateAnchor 注入点——没传时行为不变
 *    （现有全部调用方都没传），传了且模型给出模板猜测时走模板锚定路径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toRawExtraction } from "../src/floorplan/ollama-vision.js";
import { createFloorPlanWithOutcome, type VisionExtractor } from "../src/floorplan/parse.js";
import { matchesKnownTemplate, normalizeExtractionWithTemplate } from "../src/floorplan/template-match.js";

test("toRawExtraction 解析模型给的 templateGuess", () => {
  const raw = toRawExtraction({
    wallRuns: [{ label: "North", length: 144, lengthConfidence: 0.9 }],
    templateGuess: { id: "u-shaped-kitchen", confidence: 0.82 },
  });
  assert.deepEqual(raw.templateGuess, { id: "u-shaped-kitchen", confidence: 0.82 });
});

test("toRawExtraction：templateGuess 缺 id 或缺 confidence 时忽略，不产出半成品字段", () => {
  const noId = toRawExtraction({ wallRuns: [], templateGuess: { confidence: 0.9 } });
  assert.equal(noId.templateGuess, undefined);
  const noConfidence = toRawExtraction({ wallRuns: [], templateGuess: { id: "u-shaped-kitchen" } });
  assert.equal(noConfidence.templateGuess, undefined);
});

test("toRawExtraction：没有 templateGuess 字段时原样不产出（不影响现有行为）", () => {
  const raw = toRawExtraction({ wallRuns: [{ label: "North", length: 144, lengthConfidence: 0.9 }] });
  assert.equal(raw.templateGuess, undefined);
});

const input = {
  conversationId: "c_tpl",
  file: { name: "sketch.png", mimeType: "image/png", sizeBytes: 1024 },
  at: "2026-08-11T00:00:00.000Z",
};
const IMAGE = "data:image/png;base64,iVBORw0KGgo=";
const stub = (impl: VisionExtractor["extract"]): VisionExtractor => ({ extract: impl });

/** server.ts 里真实组装的那个回调，原样复用，验证端到端行为一致。 */
const templateAnchor = (raw: Parameters<typeof matchesKnownTemplate>[0], lang: "en" | "zh") => {
  const template = matchesKnownTemplate(raw);
  return template ? normalizeExtractionWithTemplate(raw!, template, lang) : undefined;
};

test("不传 templateAnchor 时行为与改动前完全一致——现有全部调用方都是这种情况", async () => {
  const { plan } = await createFloorPlanWithOutcome(input, IMAGE, stub(async () => ({
    ceilingHeight: 96, ceilingHeightConfidence: 0.9,
    wallRuns: [{ label: "North wall", length: 144, lengthConfidence: 0.9 }],
    templateGuess: { id: "u-shaped-kitchen", confidence: 0.9 }, // 即使模型给了猜测，不传 anchor 也不会被用上
  })));
  // 自由抽取路径：只有模型真的给出的这一段墙，不会被"补"成 U 型的三段
  assert.equal(plan.parsedGeometry.wallRuns.length, 1);
  assert.equal(plan.parsedGeometry.wallRuns[0]!.label, "North wall");
});

test("传了 templateAnchor 且模型猜中模板时，走模板锚定路径——按 U 型的三段墙框架补齐", async () => {
  const { plan } = await createFloorPlanWithOutcome(input, IMAGE, stub(async () => ({
    ceilingHeight: 96, ceilingHeightConfidence: 0.9,
    wallRuns: [
      { label: "North wall", length: 144, lengthConfidence: 0.9 },
      { label: "East wall", length: 118, lengthConfidence: 0.9 },
    ],
    templateGuess: { id: "u-shaped-kitchen", confidence: 0.9 },
  })), templateAnchor);
  assert.equal(plan.parsedGeometry.wallRuns.length, 3);
  const labels = plan.parsedGeometry.wallRuns.map((r) => r.label);
  assert.deepEqual(labels, ["West", "North", "East"]);
  const west = plan.parsedGeometry.wallRuns.find((r) => r.label === "West")!;
  const north = plan.parsedGeometry.wallRuns.find((r) => r.label === "North")!;
  const east = plan.parsedGeometry.wallRuns.find((r) => r.label === "East")!;
  assert.equal(west.length, 0);
  assert.equal(north.length, 144);
  assert.equal(east.length, 118);
  const pending = plan.unresolvedItems.filter((u) => !u.resolved);
  assert.ok(pending.some((u) => u.target.id === west.id && u.field === "length"));
  assert.ok(pending.some((u) => u.target.id === north.id && u.field === "length"),
    "过阈值的北墙也要确认");
  assert.ok(pending.some((u) => u.target.id === east.id && u.field === "length"));
  assert.ok(pending.some((u) => u.field === "ceilingHeight"));
});

test("传了 templateAnchor 但模型没给模板猜测（或猜错/低置信）时，原样退回自由抽取", async () => {
  const { plan } = await createFloorPlanWithOutcome(input, IMAGE, stub(async () => ({
    wallRuns: [{ label: "Kitchen wall A", length: 137, lengthConfidence: 0.85 }],
    // 没有 templateGuess
  })), templateAnchor);
  assert.equal(plan.parsedGeometry.wallRuns.length, 1);
  assert.equal(plan.parsedGeometry.wallRuns[0]!.label, "Kitchen wall A");
});
