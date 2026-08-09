/**
 * 意图化修订：#N / near 灶台，禁止写死 B12。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoteMatchesLayout,
  buildCabinetIndex,
  resolveRevisionIntent,
  type CabinetIndexEntry,
} from "../src/layout/revision-intents.js";
import {
  applyFunctionalPulloutHints,
  type Placement,
} from "../src/layout/generate.js";
import type { ModuleSpec } from "../src/domain/types.js";

test("spice_near_cooktop note 使用真实 #N，不含 B12", () => {
  const index: CabinetIndexEntry[] = [
    { no: 2, code: "B18", wallRunId: "w1", layer: "base", x: 0, width: 18, near: "sink" },
    { no: 5, code: "B15", wallRunId: "w1", layer: "base", x: 40, width: 15, near: "range" },
  ];
  const r = resolveRevisionIntent({ intent: "spice_near_cooktop", cabinetIndex: index });
  assert.match(r.note, /#5/);
  assert.doesNotMatch(r.note, /B12/);
  assert.equal(r.changes.layoutHints?.spiceCabinetNo, 5);
  assert.equal(r.changes.layoutHints?.includeSpicePullout, true);
});

test("buildCabinetIndex 标注 near range", () => {
  const placements: Placement[] = [
    {
      kind: "appliance", layer: "base", wallRunId: "w1",
      x: 36, width: 30, height: 34.5, depth: 24, applianceKind: "range",
    },
    {
      kind: "cabinet", layer: "base", wallRunId: "w1",
      x: 12, width: 12, height: 34.5, depth: 24, moduleCode: "B12", cabinetNo: 1,
    },
    {
      kind: "cabinet", layer: "base", wallRunId: "w1",
      x: 66, width: 15, height: 34.5, depth: 24, moduleCode: "B15", cabinetNo: 2,
    },
  ];
  const idx = buildCabinetIndex(placements);
  assert.equal(idx.length, 2);
  assert.ok(idx.some((c) => c.near === "range"));
});

test("assertNoteMatchesLayout：#N 必须存在", () => {
  const index: CabinetIndexEntry[] = [
    { no: 1, wallRunId: "w", layer: "base", x: 0, width: 12 },
  ];
  assert.equal(assertNoteMatchesLayout({
    note: "把 #1 换成调料拉篮", cabinetIndex: index, moduleCodes: ["B09SP"],
  }).ok, true);
  assert.equal(assertNoteMatchesLayout({
    note: "把 #9 换成调料拉篮", cabinetIndex: index, moduleCodes: [],
  }).ok, false);
});

test("拉篮按柜号替换，不依赖写死 B12 源码列表", () => {
  const placements: Placement[] = [
    {
      kind: "appliance", layer: "base", wallRunId: "w1",
      x: 30, width: 30, height: 34.5, depth: 24, applianceKind: "range",
    },
    {
      kind: "cabinet", layer: "base", wallRunId: "w1",
      x: 0, width: 18, height: 34.5, depth: 24,
      moduleId: "m_b18", moduleCode: "B18", cabinetNo: 3,
    },
  ];
  const modules = [
    {
      id: "m_sp", code: "B09SP", type: "base",
      widthOptions: [9], heightOptions: [34.5], depthOptions: [24],
      companyId: "c", specVersionId: "s",
      assemblyOptions: ["RTA"],
    },
    {
      id: "m_b18", code: "B18", type: "base",
      widthOptions: [18], heightOptions: [34.5], depthOptions: [24],
      companyId: "c", specVersionId: "s",
      assemblyOptions: ["RTA"],
    },
  ] as ModuleSpec[];
  applyFunctionalPulloutHints(placements, modules, {
    includeSpicePullout: true,
    spiceCabinetNo: 3,
    spiceNear: "range",
  });
  assert.equal(placements.find((p) => p.cabinetNo === 3)?.moduleCode, "B09SP");
});
