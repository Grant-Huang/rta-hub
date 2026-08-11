/**
 * 草图 → 5 种标准布局的锚定归一化（template-match.ts）。
 * 桥接"自由视觉抽取"与"FR-17.4 模板快选"两条本来互不相干的路径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesKnownTemplate, normalizeExtractionWithTemplate, TEMPLATE_GUESS_THRESHOLD,
} from "../src/floorplan/template-match.js";
import type { RawExtraction } from "../src/floorplan/parse.js";
import { FLOORPLAN_TEMPLATES } from "../src/samples/templates.js";

test("没有 templateGuess 时不匹配任何模板", () => {
  assert.equal(matchesKnownTemplate(undefined), undefined);
  assert.equal(matchesKnownTemplate({ wallRuns: [] }), undefined);
});

test("置信度低于阈值时不采用，即使 id 是合法模板", () => {
  const raw: RawExtraction = {
    wallRuns: [],
    templateGuess: { id: "u-shaped-kitchen", confidence: TEMPLATE_GUESS_THRESHOLD - 0.01 },
  };
  assert.equal(matchesKnownTemplate(raw), undefined);
});

test("id 不是已知模板时不匹配（比如模型给了个瞎编的id）", () => {
  const raw: RawExtraction = {
    wallRuns: [],
    templateGuess: { id: "some-made-up-shape", confidence: 0.9 },
  };
  assert.equal(matchesKnownTemplate(raw), undefined);
});

test("置信度够、id 合法时返回对应模板", () => {
  const raw: RawExtraction = {
    wallRuns: [],
    templateGuess: { id: "u-shaped-kitchen", confidence: 0.8 },
  };
  const t = matchesKnownTemplate(raw);
  assert.ok(t);
  assert.equal(t!.id, "u-shaped-kitchen");
});

test("按标签模糊匹配对齐：图上读到的 North/East 落到 U 型模板对应槎位", () => {
  const template = FLOORPLAN_TEMPLATES["u-shaped-kitchen"]!; // West, North, East
  const raw: RawExtraction = {
    ceilingHeight: 96, ceilingHeightConfidence: 0.9,
    wallRuns: [
      { label: "North wall", length: 150, lengthConfidence: 0.9 },
      { label: "East wall", length: 118, lengthConfidence: 0.85 },
    ],
  };
  const { geometry, unresolved } = normalizeExtractionWithTemplate(raw, template, "en");
  assert.equal(geometry.wallRuns.length, 3);
  const byLabel = Object.fromEntries(geometry.wallRuns.map((r) => [r.label, r.length]));
  assert.equal(byLabel.North, 150);
  assert.equal(byLabel.East, 118);
  // West 没被读到 → 长度 0，且进待确认，reason 里点名了具体墙+布局
  assert.equal(byLabel.West, 0);
  const westPending = unresolved.find((u) =>
    u.target.kind === "wallRun"
    && geometry.wallRuns.find((r) => r.id === u.target.id)?.label === "West");
  assert.ok(westPending, "西墙没读到应该进待确认");
  assert.match(westPending!.reason, /West/);
  assert.match(westPending!.reason, /U-shape/i);
});

test("标签完全对不上时按剩余出现顺序位置对齐——图上量出来的东西不能因为标签不对就丢", () => {
  const template = FLOORPLAN_TEMPLATES["u-shaped-kitchen"]!; // West, North, East（3段）
  const raw: RawExtraction = {
    wallRuns: [
      { label: "Wall A", length: 120, lengthConfidence: 0.9 },
      { label: "Wall B", length: 144, lengthConfidence: 0.9 },
      { label: "Wall C", length: 118, lengthConfidence: 0.9 },
    ],
  };
  const { geometry } = normalizeExtractionWithTemplate(raw, template, "en");
  assert.deepEqual(geometry.wallRuns.map((r) => r.length), [120, 144, 118]);
  assert.deepEqual(geometry.wallRuns.map((r) => r.label), ["West", "North", "East"]);
});

test("置信度不够的墙长视为没读到——不能拿低置信度的数直接采信", () => {
  const template = FLOORPLAN_TEMPLATES["floorplan-minimal"]!; // North, East
  const raw: RawExtraction = {
    wallRuns: [
      { label: "North", length: 144, lengthConfidence: 0.3 }, // 低于 CONFIDENCE_THRESHOLD
    ],
  };
  const { geometry, unresolved } = normalizeExtractionWithTemplate(raw, template, "en");
  const north = geometry.wallRuns.find((r) => r.label === "North")!;
  assert.equal(north.length, 0);
  const pending = unresolved.find((u) => u.target.id === north.id);
  assert.ok(pending);
  // 低置信但有值时，suggestion 仍带上模型的猜测供参考（不自动采用）
  assert.equal(pending!.suggestion, 144);
});

test("特征（窗/门/上下水）按对齐后的墙段带过去，同样过置信度门槛", () => {
  const template = FLOORPLAN_TEMPLATES["floorplan-minimal"]!; // North, East
  const raw: RawExtraction = {
    wallRuns: [
      {
        label: "North", length: 144, lengthConfidence: 0.9,
        features: [
          { kind: "window", offset: 48, width: 36, confidence: 0.8 },
          { kind: "door", offset: 0, width: 32, confidence: 0.2 }, // 置信度不够，应被丢弃
        ],
      },
    ],
  };
  const { geometry } = normalizeExtractionWithTemplate(raw, template, "en");
  const north = geometry.wallRuns.find((r) => r.label === "North")!;
  assert.equal(north.features.length, 1);
  assert.equal(north.features[0]!.kind, "window");
});

test("岛台槎位（L型+岛台模板）保留 kind/depth", () => {
  const template = FLOORPLAN_TEMPLATES["l-island-kitchen"]!; // North, East, Island
  const raw: RawExtraction = { wallRuns: [] };
  const { geometry } = normalizeExtractionWithTemplate(raw, template, "en");
  const island = geometry.wallRuns.find((r) => r.label === "Island")!;
  assert.equal(island.kind, "island");
  assert.equal(island.depth, 36);
});

test("走廊型两段墙不相接——模板的 startsAtCorner:false 要保留下来", () => {
  const template = FLOORPLAN_TEMPLATES["galley-kitchen"]!;
  const raw: RawExtraction = { wallRuns: [] };
  const { geometry } = normalizeExtractionWithTemplate(raw, template, "en");
  const south = geometry.wallRuns.find((r) => r.label === "South")!;
  assert.equal(south.startsAtCorner, false);
});

test("层高读到且置信度够时采用；没读到时进待确认并带模板默认值当 suggestion", () => {
  const template = FLOORPLAN_TEMPLATES["one-wall-kitchen"]!;
  const withCeiling = normalizeExtractionWithTemplate(
    { ceilingHeight: 108, ceilingHeightConfidence: 0.9, wallRuns: [] }, template, "en",
  );
  assert.equal(withCeiling.geometry.ceilingHeight, 108);

  const noCeiling = normalizeExtractionWithTemplate({ wallRuns: [] }, template, "en");
  assert.equal(noCeiling.geometry.ceilingHeight, undefined);
  const ceilPending = noCeiling.unresolved.find((u) => u.field === "ceilingHeight");
  assert.ok(ceilPending);
  assert.equal(ceilPending!.suggestion, template.ceilingHeight);
});
