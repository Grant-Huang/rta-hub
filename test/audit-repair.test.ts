/**
 * FR-14：按阻断 SR 定向修复策略。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRepairStrategy, blockingRules, repairStrategiesFor,
} from "../src/layout/audit-repair.js";
import type { AuditReport } from "../src/delivery/audit.js";
import type { ParsedGeometry } from "../src/floorplan/types.js";

function report(rules: string[]): AuditReport {
  return {
    ok: false,
    findings: [],
    notices: [],
    blockers: rules.map((rule) => ({
      code: "ERGONOMICS" as const,
      severity: "blocking" as const,
      rule: rule as AuditReport["blockers"][number]["rule"],
      message: rule,
    })),
    checked: [],
    checkedRules: [],
  };
}

test("SR-E5 优先给出缩岛台策略", () => {
  const strategies = repairStrategiesFor(report(["SR-E5"]));
  assert.ok(strategies.some((s) => s.kind === "shrinkIsland"));
  assert.equal(strategies[0]?.kind, "shrinkIsland");
});

test("SR-E2 给出 preferNoCooktopBase", () => {
  const strategies = repairStrategiesFor(report(["SR-E2"]));
  assert.ok(strategies.some((s) => s.kind === "preferNoCooktopBase"));
});

test("SR-G3 给出 drawerBias 转角向修复", () => {
  const strategies = repairStrategiesFor(report(["SR-G3"]));
  assert.ok(strategies.some((s) => s.label.includes("corner")));
});

test("shrinkIsland 只缩短岛台段", () => {
  const geometry: ParsedGeometry = {
    wallRuns: [
      {
        id: "w1", label: "North", length: 120,
        startsAtCorner: false, endsAtCorner: false, features: [],
      },
      {
        id: "i1", label: "Island", length: 84, kind: "island", depth: 25,
        startsAtCorner: false, endsAtCorner: false, features: [],
      },
    ],
    confidence: 1,
  };
  const applied = applyRepairStrategy(
    { drawerBias: "highUseOnly" },
    geometry,
    {
      kind: "shrinkIsland",
      rules: ["SR-E5"],
      shrinkInches: 12,
      label: "shrinkIsland:12",
    },
  );
  assert.ok(applied.geometry);
  assert.equal(applied.geometry!.wallRuns[0]!.length, 120);
  assert.equal(applied.geometry!.wallRuns[1]!.length, 72);
});

test("blockingRules 去重", () => {
  assert.deepEqual(blockingRules(report(["SR-E5", "SR-E5", "SR-G3"])), ["SR-E5", "SR-G3"]);
});
