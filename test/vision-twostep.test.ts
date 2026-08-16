/**
 * 视觉两步抽取：先墙后特征。
 * 合并时第二步不能改墙长；特征按 slot 挂到第一步的墙上。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactWallList,
  floorPlanVisionFeaturesPrompt,
  floorPlanVisionPrompt,
  floorPlanVisionWallsPrompt,
  mergeWallsAndFeatures,
  toRawExtraction,
} from "../src/floorplan/ollama-vision.js";
import type { RawExtraction } from "../src/floorplan/parse.js";
import { scoreAgainstTruth } from "./fixtures/l-island-truth.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("墙步提示词不要求 features，特征步才扫图例", () => {
  const walls = floorPlanVisionWallsPrompt();
  const feats = floorPlanVisionFeaturesPrompt({
    wallRuns: [{ label: "NORTH WALL", slot: "North", length: 144 }],
  });
  assert.equal(/Kitchen wall A/i.test(walls), false);
  assert.equal(/Kitchen wall A/i.test(feats), false);
  assert.equal(/"length"\s*:\s*137/.test(walls), false);
  assert.equal(/"length"\s*:\s*137/.test(feats), false);
  assert.match(walls, /kind "island"/);
  assert.doesNotMatch(walls, /empty features/i);
  assert.match(feats, /parallel thin lines/i);
  assert.match(feats, /two circles/i);
  assert.match(feats, /\barc\b/i);
  assert.match(feats, /slot=North/);
  assert.match(feats, /Do not change length/i);
});

test("compactWallList 只列槽位/标签/长度，不带 features", () => {
  const list = compactWallList({
    wallRuns: [{
      label: "NORTH WALL", slot: "North", length: 144,
      features: [{ kind: "window", offset: 48, width: 36 }],
    }],
  });
  assert.match(list, /slot=North/);
  assert.doesNotMatch(list, /window/);
});

test("mergeWallsAndFeatures：特征按 slot 挂上，第二步改不了墙长", () => {
  const walls = toRawExtraction({
    ceilingHeight: 96, ceilingHeightConfidence: 0.9,
    wallRuns: [
      { label: "NORTH WALL", slot: "North", length: 144, lengthConfidence: 0.9 },
      { label: "EAST WALL", slot: "East", length: 120, lengthConfidence: 0.9 },
      { label: "ISLAND", slot: "Island", kind: "island", length: 72, depth: 36, lengthConfidence: 0.9 },
    ],
  });
  const featurePass = toRawExtraction({
    wallRuns: [
      {
        slot: "East", length: 999,
        features: [
          { kind: "plumbing", offset: 36, width: 24, confidence: 0.9 },
          { kind: "door", offset: 88, width: 32, confidence: 0.9 },
        ],
      },
      {
        slot: "North",
        features: [{ kind: "window", offset: 48, width: 36, confidence: 0.9 }],
      },
    ],
  });
  const merged = mergeWallsAndFeatures(walls, featurePass);
  const north = merged.wallRuns?.find((r) => r.slot === "North");
  const east = merged.wallRuns?.find((r) => r.slot === "East");
  assert.equal(north?.length, 144, "第二步不得覆盖墙长");
  assert.equal(east?.length, 120);
  assert.deepEqual(north?.features?.map((f) => f.kind), ["window"]);
  assert.deepEqual(east?.features?.map((f) => f.kind), ["plumbing", "door"]);
  assert.equal(east?.features?.[1]?.offset, 88);
});

test("A/B 夹具：单次抽取把上下水放到北墙；合并后的正确 slot 应计分更高", () => {
  const oneshot = JSON.parse(
    readFileSync(path.join(here, "fixtures", "l-island-qwen2.5vl-oneshot-raw.json"), "utf8"),
  ) as RawExtraction;
  const A = scoreAgainstTruth(oneshot);
  assert.equal(A.wallHits, 3, "单次墙长已经读对");
  assert.equal(A.featureWallHits, 2, "窗、门墙对，上下水墙错");
  assert.equal(oneshot.wallRuns?.find((r) => r.slot === "North")?.features?.some((f) => f.kind === "plumbing"), true);

  const wallsOnly: RawExtraction = {
    ...oneshot,
    wallRuns: oneshot.wallRuns?.map((w) => ({ ...w, features: undefined })),
  };
  const featurePass: RawExtraction = {
    wallRuns: [
      { slot: "North", features: [{ kind: "window", offset: 48, width: 36, confidence: 0.9 }] },
      {
        slot: "East",
        features: [
          { kind: "plumbing", offset: 36, width: 24, confidence: 0.9 },
          { kind: "door", offset: 88, width: 32, confidence: 0.9 },
        ],
      },
    ],
  };
  const B = scoreAgainstTruth(mergeWallsAndFeatures(wallsOnly, featurePass));
  assert.equal(B.wallHits, 3);
  assert.equal(B.featureWallHits, 3, "两步合并后三种特征都应在正确墙上");
  assert.equal(B.featureOffsetHits, 3);
  assert.ok(B.featureWallHits > A.featureWallHits);
});

test("单次完整提示词仍禁止 Kitchen wall A / 137 泄漏", () => {
  const prompt = floorPlanVisionPrompt();
  assert.equal(/Kitchen wall A/i.test(prompt), false);
  assert.equal(/"length"\s*:\s*137/.test(prompt), false);
});

test("实图冻结 A/B：两步把北墙窗 offset 读准，但上下水仍错墙", () => {
  const oneshot = JSON.parse(
    readFileSync(path.join(here, "fixtures", "l-island-qwen2.5vl-oneshot-raw.json"), "utf8"),
  ) as RawExtraction;
  const twostep = JSON.parse(
    readFileSync(path.join(here, "fixtures", "l-island-qwen2.5vl-twostep-raw.json"), "utf8"),
  ) as RawExtraction;
  const A = scoreAgainstTruth(oneshot);
  const B = scoreAgainstTruth(twostep);
  assert.equal(A.wallHits, 3);
  assert.equal(B.wallHits, 3);
  const aWin = oneshot.wallRuns?.find((r) => r.slot === "North")?.features?.find((f) => f.kind === "window");
  const bWin = twostep.wallRuns?.find((r) => r.slot === "North")?.features?.find((f) => f.kind === "window");
  assert.equal(aWin?.offset, 42);
  assert.equal(bWin?.offset, 48, "两步把窗的 offset 从 42 纠正到 48");
  assert.equal(
    twostep.wallRuns?.find((r) => r.slot === "North")?.features?.some((f) => f.kind === "plumbing"),
    true,
    "两步仍把上下水放在北墙",
  );
  assert.equal(B.featureWallHits, A.featureWallHits, "特征墙归属没有比单次更好");
});

test("实图耗时夹具：两步比单次更慢（walls+features 两次调用）", () => {
  const report = JSON.parse(
    readFileSync(path.join(here, "fixtures", "l-island-qwen2.5vl-ab-timing.json"), "utf8"),
  ) as {
    A: { elapsedMs: number; steps: { step: string; elapsedMs: number }[] };
    B: { elapsedMs: number; steps: { step: string; elapsedMs: number }[] };
    deltaMs: number;
    previous?: { A: { elapsedMs: number }; B: { elapsedMs: number }; deltaMs: number }[];
  };
  assert.equal(report.A.steps[0]?.step, "oneshot");
  assert.deepEqual(report.B.steps.map((s) => s.step), ["walls", "features"]);
  assert.ok(report.A.elapsedMs > 0);
  assert.ok(report.B.elapsedMs > report.A.elapsedMs, "两步总耗时应高于单次");
  assert.equal(report.deltaMs, report.B.elapsedMs - report.A.elapsedMs);
  assert.ok(report.previous && report.previous.length >= 1, "应保留上次当场对照");
  for (const prev of report.previous) {
    assert.ok(prev.B.elapsedMs > prev.A.elapsedMs, "上次两步也应更慢");
    assert.equal(prev.deltaMs, prev.B.elapsedMs - prev.A.elapsedMs);
  }
});
