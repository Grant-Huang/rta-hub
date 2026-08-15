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
import { exportDesignInput } from "../src/floorplan/design-input.js";
import type { FloorPlan } from "../src/floorplan/types.js";

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
  assert.equal(byLabel.West, 0);
  const westPending = unresolved.find((u) =>
    u.target.kind === "wallRun"
    && geometry.wallRuns.find((r) => r.id === u.target.id)?.label === "West");
  assert.ok(westPending, "西墙没读到应该进待确认");
  assert.match(westPending!.reason, /West/);
  assert.match(westPending!.reason, /U-shape/i);
  // 过阈值的北墙/东墙/层高仍要确认，不能标成已确认
  assert.ok(unresolved.some((u) =>
    u.field === "length" && geometry.wallRuns.find((r) => r.id === u.target.id)?.label === "North"));
  assert.ok(unresolved.some((u) => u.field === "ceilingHeight"));
});

test("北墙/岛台等中文标签也能对上罗盘槽位", () => {
  const template = FLOORPLAN_TEMPLATES["l-island-kitchen"]!;
  const raw: RawExtraction = {
    wallRuns: [
      { label: "北墙", length: 144, lengthConfidence: 0.9 },
      { label: "东墙", length: 120, lengthConfidence: 0.9 },
      { label: "岛台", length: 72, lengthConfidence: 0.9, kind: "island", depth: 36 },
    ],
  };
  const { geometry, unresolved } = normalizeExtractionWithTemplate(raw, template, "zh");
  const byLabel = Object.fromEntries(geometry.wallRuns.map((r) => [r.label, r.length]));
  assert.equal(byLabel.North, 144);
  assert.equal(byLabel.East, 120);
  assert.equal(byLabel.Island, 72);
  assert.equal(unresolved.filter((u) => u.field === "note").length, 0, "标签对得上就不应再报多余墙段");
});

test("标签完全对不上时槽位空着，不按出现顺序硬套；多出来的墙进待确认", () => {
  const template = FLOORPLAN_TEMPLATES["u-shaped-kitchen"]!; // West, North, East（3段）
  const raw: RawExtraction = {
    wallRuns: [
      { label: "Wall A", length: 120, lengthConfidence: 0.9 },
      { label: "Wall B", length: 144, lengthConfidence: 0.9 },
      { label: "Wall C", length: 118, lengthConfidence: 0.9 },
    ],
  };
  const { geometry, unresolved } = normalizeExtractionWithTemplate(raw, template, "en");
  assert.deepEqual(geometry.wallRuns.map((r) => r.length), [0, 0, 0]);
  assert.deepEqual(geometry.wallRuns.map((r) => r.label), ["West", "North", "East"]);
  const extras = unresolved.filter((u) => u.field === "note");
  assert.equal(extras.length, 3);
  assert.ok(extras.some((u) => /Wall A/.test(u.reason) && u.suggestion === 120));
  assert.ok(extras.some((u) => /Wall C/.test(u.reason) && u.suggestion === 118));
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

test("特征（窗/门/上下水）按对齐后的墙段带过去；低置信进待确认，过阈值也要确认", () => {
  const template = FLOORPLAN_TEMPLATES["floorplan-minimal"]!; // North, East
  const raw: RawExtraction = {
    wallRuns: [
      {
        label: "North", length: 144, lengthConfidence: 0.9,
        features: [
          { kind: "window", offset: 48, width: 36, confidence: 0.8 },
          { kind: "door", offset: 0, width: 32, confidence: 0.2 }, // 置信度不够，不写入几何
        ],
      },
    ],
  };
  const { geometry, unresolved } = normalizeExtractionWithTemplate(raw, template, "en");
  const north = geometry.wallRuns.find((r) => r.label === "North")!;
  assert.equal(north.features.length, 1);
  assert.equal(north.features[0]!.kind, "window");
  assert.ok(unresolved.some((u) => u.field === "feature.door.offset"), "低置信门应进待确认，不能静默丢掉");
  assert.ok(unresolved.some((u) =>
    u.target.kind === "feature" && u.target.id === north.features[0]!.id),
  "过阈值的窗也要确认");
});

test("岛台槎位（L型+岛台模板）保留 kind/depth，且不接墙", () => {
  const template = FLOORPLAN_TEMPLATES["l-island-kitchen"]!; // North, East, Island
  const raw: RawExtraction = { wallRuns: [] };
  const { geometry } = normalizeExtractionWithTemplate(raw, template, "en");
  const island = geometry.wallRuns.find((r) => r.label === "Island")!;
  const east = geometry.wallRuns.find((r) => r.label === "East")!;
  assert.equal(island.kind, "island");
  assert.equal(island.depth, 36);
  assert.equal(island.startsAtCorner, false);
  assert.equal(island.endsAtCorner, false);
  assert.equal(east.endsAtCorner, false, "东墙后面是岛台，不是转角相接");
});

test("slot 优先于图上 A/B/C 标签：对齐到罗盘槽位，features 跟着走；岛台长宽进导出 JSON", () => {
  const template = FLOORPLAN_TEMPLATES["l-island-kitchen"]!;
  const raw: RawExtraction = {
    ceilingHeight: 96, ceilingHeightConfidence: 0.9, overallConfidence: 0.9,
    wallRuns: [
      {
        label: "Wall A", slot: "North", length: 144, lengthConfidence: 0.9,
        features: [{ kind: "window", offset: 48, width: 36, confidence: 0.9 }],
      },
      {
        label: "Wall B", slot: "East", length: 120, lengthConfidence: 0.9,
        features: [
          { kind: "plumbing", offset: 36, width: 24, confidence: 0.9 },
          { kind: "door", offset: 88, width: 32, confidence: 0.9 },
        ],
      },
      {
        label: "hatched island", slot: "Island", kind: "island",
        length: 72, depth: 40, lengthConfidence: 0.9,
      },
    ],
  };
  const { geometry, unresolved } = normalizeExtractionWithTemplate(raw, template, "en");
  const north = geometry.wallRuns.find((r) => r.label === "North")!;
  const east = geometry.wallRuns.find((r) => r.label === "East")!;
  const island = geometry.wallRuns.find((r) => r.label === "Island")!;
  assert.equal(north.length, 144);
  assert.deepEqual(north.features.map((f) => f.kind), ["window"]);
  assert.equal(north.features[0]!.offset, 48);
  assert.equal(east.length, 120);
  assert.deepEqual(east.features.map((f) => f.kind), ["plumbing", "door"]);
  assert.equal(east.features[1]!.offset, 88);
  assert.equal(island.length, 72);
  assert.equal(island.kind, "island");
  assert.equal(island.depth, 40, "图上读到的岛台进深覆盖模板默认 36");
  assert.equal(unresolved.filter((u) => u.field === "note").length, 0, "slot 对得上就不应再报多余墙段");

  const plan: FloorPlan = {
    id: "fp_slot",
    conversationId: "c_slot",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: geometry,
    parseConfidence: 0.9,
    unresolvedItems: unresolved,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
  const exported = exportDesignInput(plan);
  const expIsland = exported.geometry.wallRuns.find((r) => r.label === "Island")!;
  assert.equal(expIsland.kind, "island");
  assert.equal(expIsland.depth, 40);
  assert.equal(expIsland.length, 72);
  assert.equal(expIsland.provenance, "assumed");
  assert.equal(exported.geometry.wallRuns.find((r) => r.label === "North")?.features[0]?.kind, "window");
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
  assert.ok(withCeiling.unresolved.some((u) => u.field === "ceilingHeight"),
    "层高过阈值写入几何，仍要确认");

  const noCeiling = normalizeExtractionWithTemplate({ wallRuns: [] }, template, "en");
  assert.equal(noCeiling.geometry.ceilingHeight, undefined);
  const ceilPending = noCeiling.unresolved.find((u) => u.field === "ceilingHeight");
  assert.ok(ceilPending);
  assert.equal(ceilPending!.suggestion, template.ceilingHeight);
});
