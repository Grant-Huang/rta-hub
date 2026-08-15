/**
 * A/B：同一份 qwen2.5vl 实测 raw（2026-08-15，L 型+岛台手绘），
 * A = 改管线前的归一化结果（实录，不重跑旧代码），
 * B = 当前 templateAnchor + exportDesignInput。
 *
 * 断言盯的是安全属性：错读不得标成 customer；标签对不上不得按顺序硬套。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFloorPlanWithOutcome } from "../src/floorplan/parse.js";
import { matchesKnownTemplate, normalizeExtractionWithTemplate } from "../src/floorplan/template-match.js";
import { exportDesignInput } from "../src/floorplan/design-input.js";
import type { RawExtraction } from "../src/floorplan/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(path.join(here, "fixtures", "l-island-qwen2.5vl-raw.json"), "utf8"),
) as RawExtraction;

/** 改管线前，同一份 raw 经 template-match 硬套顺序后的结果（2026-08-15 实测）。 */
const A = {
  northLength: 137,
  eastLength: 120,
  islandLength: 144,
  islandStartsAtCorner: true,
  northProvenance: "customer" as const,
  eastProvenance: "customer" as const,
  islandProvenance: "customer" as const,
  featureCount: 0,
  unusedWallNotes: 0,
};

const templateAnchor = (raw: RawExtraction | undefined, lang: "en" | "zh") => {
  const template = matchesKnownTemplate(raw);
  return template ? normalizeExtractionWithTemplate(raw!, template, lang) : undefined;
};

test("A/B：同一份 L+岛台 raw，B 不得把 137/144 错读标成已确认", async () => {
  const { plan, extraction } = await createFloorPlanWithOutcome(
    {
      conversationId: "c_ab_l_island",
      file: { name: "l-island-kitchen-floorplan.png", mimeType: "image/png", sizeBytes: 1 },
      at: "2026-08-15T20:40:16.245Z",
      language: "zh",
    },
    "data:image/png;base64,aa",
    { extract: async () => FIXTURE },
    templateAnchor,
  );
  assert.equal(extraction.status, "ok");

  const byLabel = Object.fromEntries(plan.parsedGeometry.wallRuns.map((r) => [r.label, r]));
  const exported = exportDesignInput(plan);
  const expByLabel = Object.fromEntries(exported.geometry.wallRuns.map((r) => [r.label, r]));

  const B = {
    northLength: byLabel.North?.length ?? 0,
    eastLength: byLabel.East?.length ?? 0,
    islandLength: byLabel.Island?.length ?? 0,
    islandStartsAtCorner: byLabel.Island?.startsAtCorner ?? true,
    islandDepth: byLabel.Island?.depth,
    northProvenance: expByLabel.North?.provenance,
    eastProvenance: expByLabel.East?.provenance,
    islandProvenance: expByLabel.Island?.provenance,
    featureCount: plan.parsedGeometry.wallRuns.reduce((n, r) => n + r.features.length, 0),
    unusedWallNotes: plan.unresolvedItems.filter((u) =>
      u.field === "note" && /Wall [ABCD]|Kitchen wall/i.test(u.reason)).length,
  };

  console.log("[vision A/B]\n" + JSON.stringify({ A, B }, null, 2));

  assert.equal(plan.parsedGeometry.wallRuns.map((r) => r.label).join(","), "North,East,Island");
  // A 把 Wall A 的 137 硬套进北墙、Wall C 的 144 硬套进岛台，并标成 customer
  assert.notEqual(B.northLength, A.northLength, "B 不得再把提示词泄漏的 137 写到北墙");
  assert.notEqual(B.islandLength, A.islandLength, "B 不得再把 144 写到岛台");
  assert.equal(B.northLength, 0, "Kitchen wall A 对不上 North，槽位应空着");
  assert.equal(B.eastLength, 0, "Kitchen wall B 对不上 East，即使 120 碰巧对也不该按顺序硬套");
  assert.equal(B.islandLength, 0);
  assert.equal(B.islandDepth, 36);
  assert.equal(B.islandStartsAtCorner, false);
  assert.equal(B.northProvenance, "assumed");
  assert.equal(B.eastProvenance, "assumed");
  assert.equal(B.islandProvenance, "assumed");
  assert.ok(B.unusedWallNotes >= 3, `多出来的 A/B/C/D 应进待确认，got ${B.unusedWallNotes}`);
  assert.equal(exported.geometry.ceilingHeight, undefined, "层高置信度 0.4，不写入几何");
  assert.ok(plan.unresolvedItems.some((u) => u.field === "ceilingHeight" && u.suggestion === 96));
});
