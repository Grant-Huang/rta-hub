/**
 * 提示词不得带会泄漏进模型输出的数字示例。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { floorPlanVisionPrompt, toRawExtraction } from "../src/floorplan/ollama-vision.js";

test("视觉提示词不含 Kitchen wall A / length:137 这类会泄漏的示例对象", () => {
  const prompt = floorPlanVisionPrompt();
  assert.equal(/Kitchen wall A/i.test(prompt), false);
  assert.equal(/"length"\s*:\s*137/.test(prompt), false);
  assert.match(prompt, /North, East, South, West, or Island/);
  assert.match(prompt, /kind "island"/);
});

test("toRawExtraction 解析 island kind 与 depth", () => {
  const raw = toRawExtraction({
    wallRuns: [{ label: "Island", length: 72, kind: "island", depth: 36, lengthConfidence: 0.9 }],
  });
  assert.equal(raw.wallRuns?.[0]?.kind, "island");
  assert.equal(raw.wallRuns?.[0]?.depth, 36);
});
