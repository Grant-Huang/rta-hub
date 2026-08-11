/**
 * 现场块图 + 开场采集门控。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSiteDiagram } from "../src/render/site-diagram.js";
import { buildSiteQuestions, geometrySuppressesIntake } from "../src/design/site-questions.js";
import type { FloorPlan } from "../src/floorplan/types.js";
import {
  floorplanFirstWelcome, shouldSuggestReupload, intakeSampleCards,
} from "../src/floorplan/intake.js";
import { isAllowedSampleFile, INTAKE_SAMPLES } from "../src/samples/catalog.js";
import { quickRepliesFor } from "../src/agents/quick-replies.js";
import { missingFields } from "../src/agents/orchestrator.js";

const AT = "2026-06-01T00:00:00.000Z";

function planTwoWalls(extra?: Partial<FloorPlan["parsedGeometry"]>): FloorPlan {
  return {
    id: "fp_1",
    conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: {
      wallRuns: [
        {
          id: "wr_n", label: "North", length: 144,
          startsAtCorner: true, endsAtCorner: true,
          features: [
            { id: "wf_w", kind: "window", offset: 48, width: 36 },
          ],
        },
        {
          id: "wr_e", label: "East", length: 96,
          startsAtCorner: true, endsAtCorner: false,
          features: [
            { id: "wf_p", kind: "plumbing", offset: 24, width: 24 },
          ],
        },
      ],
      ceilingHeight: 96,
      confidence: 0.8,
      ...extra,
    },
    parseConfidence: 0.8,
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("两段墙的块图 SVG 含墙标签、尺寸与特征", () => {
  const p = planTwoWalls();
  const site = buildSiteQuestions(p, "", "en");
  const d = renderSiteDiagram(p.parsedGeometry, site.questions);
  assert.ok(d.svg.includes("North"), "应标出 North");
  assert.ok(d.svg.includes("East"), "应标出 East");
  assert.ok(d.svg.includes("Site blocks"), "标题为块图");
  assert.ok(d.svg.includes("144") || d.svg.includes(`144"`), "应有北墙尺寸");
  assert.ok(d.svg.includes("W ") || d.svg.includes("window") || d.svg.includes("#4d9ad7"), "应画窗特征");
  assert.ok(d.svg.includes("Sink") || d.svg.includes("#5fb08a"), "应画上下水");
  assert.ok(d.svg.includes("Ceiling"), "应标层高");
  assert.deepEqual(d.wallLabels.sort(), ["East", "North"]);
});

test("开放现场项以 Q# 出现在图与题列表", () => {
  const p = planTwoWalls({
    wallRuns: [
      {
        id: "wr_n", label: "North", length: 144,
        startsAtCorner: true, endsAtCorner: true, features: [],
      },
      {
        id: "wr_e", label: "East", length: 96,
        startsAtCorner: true, endsAtCorner: false, features: [],
      },
    ],
  });
  // 清掉 features 后应出 plumbing/window 题
  const bare: FloorPlan = {
    ...p,
    parsedGeometry: {
      ...p.parsedGeometry,
      wallRuns: p.parsedGeometry.wallRuns.map((r) => ({ ...r, features: [] })),
    },
  };
  const site = buildSiteQuestions(bare, "", "en");
  assert.ok(site.questions.some((q) => q.kind === "plumbing"));
  assert.ok(site.questions.some((q) => q.kind === "window"));
  const d = renderSiteDiagram(bare.parsedGeometry, site.questions);
  assert.ok(d.questionMarks.some((m) => /^Q\d+$/.test(m)));
  assert.ok(d.svg.includes("Q1") || d.svg.includes("Q2"));
});

test("解读可用时 geometrySuppressesIntake，尺寸/形状不进 quick replies", () => {
  const p = planTwoWalls();
  assert.equal(geometrySuppressesIntake(p), true);
  let missing = missingFields("Modern style, budget CAD $10k, Ontario ON");
  if (geometrySuppressesIntake(p)) {
    missing = missing.filter((f) => f !== "kitchen size" && f !== "layout");
  }
  const qr = quickRepliesFor(missing, 5, "zh");
  assert.ok(!qr.some((q) => q.field === "kitchen size"));
  assert.ok(!qr.some((q) => q.field === "layout"));
});

test("低置信 / 多 unresolved → 建议重传", () => {
  const p = planTwoWalls();
  assert.equal(shouldSuggestReupload(p, { status: "ok" }), false);
  assert.equal(shouldSuggestReupload(p, { status: "emptyResult" }), true);
  assert.equal(shouldSuggestReupload(p, { status: "failed", reason: "timeout" }), true);

  const many: FloorPlan = {
    ...p,
    unresolvedItems: [
      { id: "1", target: { kind: "wallRun", id: "wr_n" }, field: "length", reason: "x", resolved: false },
      { id: "2", target: { kind: "feature" }, field: "offset", reason: "x", resolved: false },
      { id: "3", target: { kind: "global" }, field: "ceilingHeight", reason: "x", resolved: false },
    ],
  };
  assert.equal(shouldSuggestReupload(many, { status: "ok" }), true);
});

test("开场欢迎语优先户型；示例白名单含设计草图 jpg", () => {
  const zh = floorplanFirstWelcome("zh");
  assert.ok(zh.includes("户型") || zh.includes("上传"));
  assert.ok(!zh.includes("厨房大概多大"));
  const cards = intakeSampleCards("zh");
  assert.ok(cards.some((c) => c.file === "sample-floorplan-minimal.png"));
  assert.ok(cards.some((c) => c.file === "sample-design-sketch.jpg"));
  assert.equal(isAllowedSampleFile("sample-design-sketch.jpg"), true);
  assert.equal(isAllowedSampleFile("../secrets.env"), false);
  assert.equal(INTAKE_SAMPLES.length, 6);
});
