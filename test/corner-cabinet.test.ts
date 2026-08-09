/**
 * 转角柜选型：盲角 BBC42/45、地柜优先盲角、吊柜优先 L 形；角区先于家电。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pilotModules } from "../src/app/seed.js";
import { generateLayout } from "../src/layout/generate.js";
import {
  cornerInterchangePeers,
  cornerStyleRank,
  rematchCornerModuleHeight,
} from "../src/layout/corner-reserve.js";
import { cornerOccupyWidth, cornerStyleOf } from "../src/spec/capabilities.js";
import { matchFaceTemplate } from "../src/render/templates.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";

function wall(id: string, label: string, length: number, opts: Partial<WallRun> = {}): WallRun {
  return {
    id, label, length, startsAtCorner: false, endsAtCorner: false, features: [], ...opts,
  };
}

test("seed：LSB/DC 33·36；墙柜 LC/CW 2412·2430·2436·2442", () => {
  assert.equal(pilotModules.some((m) => /^BBC/.test(m.code) && !/^BBC(42|45)$/.test(m.code)), false);
  assert.equal(pilotModules.some((m) => m.code === "BBC36"), false);
  const bbc42 = pilotModules.find((m) => m.code === "BBC42")!;
  assert.equal(cornerStyleOf(bbc42), "blind");
  assert.equal(cornerOccupyWidth(bbc42, 42), 42);
  assert.deepEqual(bbc42.widthOptions, [42]);

  const bbc45 = pilotModules.find((m) => m.code === "BBC45")!;
  assert.equal(cornerOccupyWidth(bbc45, 45), 45);

  for (const code of ["LSB33", "LSB36"] as const) {
    const m = pilotModules.find((x) => x.code === code)!;
    assert.equal(cornerStyleOf(m), "lazySusan");
  }
  for (const code of ["DC33", "DC36"] as const) {
    const m = pilotModules.find((x) => x.code === code)!;
    assert.equal(cornerStyleOf(m), "diagonal");
    assert.equal(matchFaceTemplate(code)?.templateId, "F9_DIAGONAL_CORNER");
  }

  const wallHeights = [12, 30, 36, 42] as const;
  for (const h of wallHeights) {
    const cw = pilotModules.find((m) => m.code === `CW24${String(h).padStart(2, "0")}`)!;
    assert.equal(cornerStyleOf(cw), "diagonal");
    assert.deepEqual(cw.heightOptions, [h]);
    assert.equal(matchFaceTemplate(cw.code)?.templateId, "F9_DIAGONAL_CORNER");

    const lc = pilotModules.find((m) => m.code === `LC24${String(h).padStart(2, "0")}`)!;
    assert.equal(cornerStyleOf(lc), "lShape");
    assert.deepEqual(lc.heightOptions, [h]);
    assert.equal(lc.faceTemplateId, "F1_SINGLE_DOOR");
  }
});

test("L 型地柜角：优先 BBC42（码宽=占墙宽），贴墙角落位", () => {
  const geo: ParsedGeometry = {
    wallRuns: [
      wall("long", "西墙", 144, { endsAtCorner: true }),
      wall("short", "北墙", 96, { startsAtCorner: true }),
    ],
    ceilingHeight: 96,
    confidence: 1,
  };
  const layout = generateLayout(geo, pilotModules, { ceilingHeight: 96, appliances: [] });
  const corners = layout.placements.filter((p) => p.label === "corner" && p.layer === "base");
  assert.ok(corners.length >= 1);
  const c = corners[0]!;
  assert.equal(c.moduleCode, "BBC42");
  assert.equal(c.width, 42);
  assert.equal(c.wallRunId, "long");
  // x = 144 - 42 = 102
  assert.ok(Math.abs(c.x - 102) < 0.3, `expected box at 102", got ${c.x}`);
});

test("段太短装不下 BBC42 时退回 LSB", () => {
  const geo: ParsedGeometry = {
    wallRuns: [
      wall("a", "东墙", 60, {
        endsAtCorner: true,
        features: [{ id: "e", kind: "electrical", offset: 0, width: 0 }],
      }),
      wall("b", "南墙", 40, { startsAtCorner: true }),
    ],
    ceilingHeight: 96,
    confidence: 1,
  };
  const layout = generateLayout(geo, pilotModules, {
    ceilingHeight: 96,
    appliances: [],
  });
  const corners = layout.placements.filter((p) => p.label === "corner" && p.layer === "base");
  for (const c of corners) {
    assert.notEqual(c.moduleCode, "BBC45");
    if (c.moduleCode?.startsWith("BBC")) {
      assert.equal(c.moduleCode, "BBC42");
      assert.equal(c.width, 42);
    }
  }
});

test("默认家电时墙角仍留给 BBC42，灶具不得坐进角区", () => {
  const geo: ParsedGeometry = {
    wallRuns: [
      wall("long", "西墙", 144, { endsAtCorner: true }),
      wall("short", "北墙", 96, { startsAtCorner: true }),
    ],
    ceilingHeight: 96,
    confidence: 1,
  };
  const layout = generateLayout(geo, pilotModules, { ceilingHeight: 96 });
  const baseCorners = layout.placements.filter((p) => p.label === "corner" && p.layer === "base");
  assert.ok(baseCorners.some((c) => c.moduleCode === "BBC42"),
    `expected BBC42 at corner, got ${baseCorners.map((c) => c.moduleCode).join(",")}`);

  const appliances = layout.placements.filter((p) => p.kind === "appliance" && p.layer === "base");
  for (const a of appliances) {
    if (a.wallRunId !== "long") continue;
    // 角区 [102, 144) 不得被家电占用
    const aEnd = a.x + a.width;
    assert.ok(aEnd <= 102.01 || a.x >= 144 - 0.01,
      `${a.applianceKind ?? a.label} at ${a.x}–${aEnd} overlaps corner keep-out`);
  }
});

test("同尺寸 LSB↔DC、LC↔CW 选型同档可互换", () => {
  assert.equal(cornerStyleRank("lazySusan", "base"), cornerStyleRank("diagonal", "base"));
  assert.equal(cornerStyleRank("lShape", "wall"), cornerStyleRank("diagonal", "wall"));
  assert.ok(cornerStyleRank("blind", "base") < cornerStyleRank("lazySusan", "base"));

  assert.deepEqual(
    [...cornerInterchangePeers("lazySusan", "base")].sort(),
    ["diagonal", "lazySusan"],
  );
  assert.deepEqual(
    [...cornerInterchangePeers("diagonal", "wall")].sort(),
    ["diagonal", "lShape"],
  );

  // 缺 LC2430 时可用同宽同高的 CW2430 补齐
  const lc = pilotModules.find((m) => m.code === "LC2412")!;
  const cw = pilotModules.find((m) => m.code === "CW2430")!;
  const hit = rematchCornerModuleHeight(lc, 24, [30], [lc, cw], "wall");
  assert.equal(hit.code, "CW2430");
});

test("吊柜角用 LC 或同尺寸 CW（可互换），高度跟墙柜叠装", () => {
  const geo: ParsedGeometry = {
    wallRuns: [
      wall("w1", "西墙", 132, { endsAtCorner: true }),
      wall("w2", "北墙", 132, { startsAtCorner: true, endsAtCorner: true }),
      wall("w3", "东墙", 132, { startsAtCorner: true }),
    ],
    ceilingHeight: 96,
    confidence: 1,
  };
  const layout = generateLayout(geo, pilotModules, { ceilingHeight: 96, appliances: [] });
  const wallCorners = layout.placements.filter((p) => p.label === "corner" && p.layer === "wall");
  assert.ok(wallCorners.length >= 1, "应有吊柜转角");
  assert.ok(
    wallCorners.every((c) => /^(LC|CW)24(12|30|36|42)$/.test(c.moduleCode ?? "")),
    `expected LC/CW24xx, got ${wallCorners.map((c) => c.moduleCode).join(",")}`,
  );
});
