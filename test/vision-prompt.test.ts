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
  assert.match(prompt, /North, East, South, West, Island, or Wall/);
  assert.match(prompt, /kind "island"/);
});

test("视觉提示词要求按图例扫窗/门/上下水，并用 slot 映射系统墙名", () => {
  const prompt = floorPlanVisionPrompt();
  assert.match(prompt, /window/);
  assert.match(prompt, /door/);
  assert.match(prompt, /plumbing/);
  assert.match(prompt, /parallel thin lines/i);
  assert.match(prompt, /\barc\b/i);
  assert.match(prompt, /two circles/i);
  assert.match(prompt, /- slot:/);
  assert.match(prompt, /slots:/);
  assert.match(prompt, /l-island-kitchen/);
  assert.match(prompt, /empty features/i);
});

test("toRawExtraction 解析 island kind 与 depth", () => {
  const raw = toRawExtraction({
    wallRuns: [{ label: "Island", length: 72, kind: "island", depth: 36, lengthConfidence: 0.9 }],
  });
  assert.equal(raw.wallRuns?.[0]?.kind, "island");
  assert.equal(raw.wallRuns?.[0]?.depth, 36);
});

test("toRawExtraction 解析 slot（图上 A/B/C → 系统罗盘槽位）", () => {
  const raw = toRawExtraction({
    wallRuns: [{ label: "Wall A", slot: "North", length: 144, lengthConfidence: 0.9 }],
  });
  assert.equal(raw.wallRuns?.[0]?.label, "Wall A");
  assert.equal(raw.wallRuns?.[0]?.slot, "North");
});
