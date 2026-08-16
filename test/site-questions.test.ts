/**
 * 户型追问分批（FR-19 扩展）：不一次甩一屏，按优先级分批出题。
 * 见 src/design/site-questions.ts 顶部注释。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSiteQuestions } from "../src/design/site-questions.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-06-01T00:00:00.000Z";

function basePlan(overrides: Partial<FloorPlan> = {}): FloorPlan {
  return {
    id: "fp_1",
    conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: {
      wallRuns: [
        { id: "wr_n", label: "North", length: 144, startsAtCorner: true, endsAtCorner: true, features: [] },
      ],
      ceilingHeight: 96,
      confidence: 0.8,
    },
    parseConfidence: 0.8,
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

test("层高未答时，只返回层高这一条 Q#——墙面特征那批还不出现", () => {
  const plan = basePlan({
    parsedGeometry: {
      wallRuns: [
        { id: "wr_n", label: "North", length: 144, startsAtCorner: true, endsAtCorner: true, features: [] },
      ],
      ceilingHeight: undefined,
      confidence: 0.8,
    },
  });
  const site = buildSiteQuestions(plan, "", "en");
  assert.equal(site.questions.length, 1);
  assert.equal(site.questions[0]!.kind, "ceiling");
  assert.equal(site.questions[0]!.q, 1);
});

test("墙长为 0（硬缺口）时，只问墙长——即便层高已答、墙面特征本该出题也不出现", () => {
  const plan = basePlan({
    parsedGeometry: {
      wallRuns: [
        { id: "wr_n", label: "North", length: 0, startsAtCorner: true, endsAtCorner: true, features: [] },
      ],
      ceilingHeight: 96,
      confidence: 0.8,
    },
  });
  const site = buildSiteQuestions(plan, "", "en");
  assert.equal(site.questions.length, 1);
  assert.equal(site.questions[0]!.kind, "wall_length");
});

test("层高、墙长都齐了：墙面特征一组一起出（不用逐条分轮）", () => {
  const plan = basePlan();
  const site = buildSiteQuestions(plan, "", "en");
  const kinds = site.questions.map((q) => q.kind);
  assert.ok(kinds.includes("plumbing"));
  assert.ok(kinds.includes("window"));
  assert.ok(kinds.includes("door"));
  assert.ok(kinds.includes("gas"));
  assert.ok(kinds.includes("electrical"));
  assert.ok(kinds.includes("island"));
  // 每批各自从 Q1 编号
  assert.equal(site.questions[0]!.q, 1);
});

test("墙面特征组只要还有一条没答，家电文字题就不会跳出来插队", () => {
  const plan = basePlan({
    parsedGeometry: {
      wallRuns: [
        { id: "wr_n", label: "North", length: 144, startsAtCorner: true, endsAtCorner: true, features: [] },
      ],
      ceilingHeight: 96,
      confidence: 0.8,
    },
  });
  // 推迟了 window/door/gas/island 和上下水，只剩 electrical 还没答——
  // 只要 confirmCandidates 还有一条没消掉，批次就还是"墙面特征"，不会
  // 跳到下一批去问家电。
  const site = buildSiteQuestions(
    plan,
    "no windows, no door openings, no gas, no island, plumbing later",
    "en",
  );
  assert.deepEqual(site.questions.map((q) => q.kind), ["electrical"]);
});

test("零墙段（needsManualWalls）时墙面特征批的前置条件不成立，直接落到家电批", () => {
  const plan = basePlan({
    parsedGeometry: { wallRuns: [], ceilingHeight: 96, confidence: 0.8 },
  });
  const site = buildSiteQuestions(plan, "", "en");
  assert.equal(site.needsManualWalls, true);
  assert.deepEqual(site.questions.map((q) => q.kind), ["appliance_kinds"]);
});

test("家电已知、且有推定宽度：家电批出的是 appliance_width，不是 appliance_kinds", () => {
  const plan = basePlan({
    parsedGeometry: { wallRuns: [], ceilingHeight: 96, confidence: 0.8 },
    appliances: [{ kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "assumed" }],
  });
  const site = buildSiteQuestions(plan, "", "en");
  assert.ok(site.questions.some((q) => q.kind === "appliance_width"));
  assert.ok(!site.questions.some((q) => q.kind === "appliance_kinds"));
});
