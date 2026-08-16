/**
 * 现场块图 + 开场采集门控。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSiteDiagram } from "../src/render/site-diagram.js";
import { buildSiteQuestions, geometrySuppressesIntake } from "../src/design/site-questions.js";
import type { FloorPlan } from "../src/floorplan/types.js";
import { normalizeExtraction } from "../src/floorplan/parse.js";
import {
  floorplanFirstWelcome, shouldSuggestReupload, intakeSampleCards,
} from "../src/floorplan/intake.js";
import { isAllowedSampleFile, INTAKE_SAMPLES } from "../src/samples/catalog.js";
import { quickRepliesFor, isExplicitLayoutChoice } from "../src/agents/quick-replies.js";
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
  assert.equal(shouldSuggestReupload(p, { status: "ok", ocrGrounded: false }), false);
  assert.equal(shouldSuggestReupload(p, { status: "emptyResult" }), true);
  assert.equal(shouldSuggestReupload(p, { status: "failed", reason: "timeout" }), true);

  // 3 条待确认，但都指向已经有值的字段（墙长 144/96、层高 96、feature 已落地）——
  // 这是 FR-15.5 的正常状态（视觉结果永远进待确认，不管置信度多高），不是扫描
  // 质量问题，不该建议重传。
  const pendingButRead: FloorPlan = {
    ...p,
    unresolvedItems: [
      { id: "1", target: { kind: "wallRun", id: "wr_n" }, field: "length", reason: "x", resolved: false },
      { id: "2", target: { kind: "feature", id: "wf_w" }, field: "window", reason: "x", resolved: false },
      { id: "3", target: { kind: "global" }, field: "ceilingHeight", reason: "x", resolved: false },
    ],
  };
  assert.equal(
    shouldSuggestReupload(pendingButRead, { status: "ok", ocrGrounded: false }),
    false,
    "字段都读到值了，只是例行待确认——不是重传的理由",
  );

  // 换成真读不出来的：墙长仍是 0、层高仍是 undefined、feature 没能落地
  // （target 指回 wallRun 而不是具体 feature id）——这才是该建议重传的场景。
  const genuinelyUnreadable: FloorPlan = {
    ...p,
    parsedGeometry: {
      ...p.parsedGeometry,
      wallRuns: p.parsedGeometry.wallRuns.map((r) => ({ ...r, length: 0 })),
      ceilingHeight: undefined,
    },
    unresolvedItems: [
      { id: "1", target: { kind: "wallRun", id: "wr_n" }, field: "length", reason: "x", resolved: false },
      { id: "2", target: { kind: "wallRun", id: "wr_n" }, field: "feature.window.offset", reason: "x", resolved: false },
      { id: "3", target: { kind: "global" }, field: "ceilingHeight", reason: "x", resolved: false },
    ],
  };
  assert.equal(
    shouldSuggestReupload(genuinelyUnreadable, { status: "ok", ocrGrounded: false }),
    true,
    "墙长/层高/特征都真的没读出来——该建议重传",
  );
});

test("真实抽取管线：4 面墙 + 门窗上下水都读到高置信度 → 不该建议重传（复现过的 false positive）", () => {
  const raw = {
    overallConfidence: 0.95,
    ceilingHeight: 96, ceilingHeightConfidence: 0.9,
    wallRuns: [
      {
        label: "North", length: 144, lengthConfidence: 0.95,
        features: [{ kind: "window" as const, offset: 48, width: 36, confidence: 0.9 }],
      },
      {
        label: "East", length: 96, lengthConfidence: 0.95,
        features: [{ kind: "plumbing" as const, offset: 24, width: 24, confidence: 0.9 }],
      },
      {
        label: "South", length: 144, lengthConfidence: 0.95,
        features: [{ kind: "door" as const, offset: 0, width: 32, confidence: 0.9 }],
      },
      { label: "West", length: 96, lengthConfidence: 0.95, features: [] },
    ],
  };
  const { geometry, unresolved } = normalizeExtraction(raw, "en");
  // 每段墙长、每个特征、层高都按 FR-15.5 进了待确认——单看数量早就 ≥ 3。
  assert.ok(unresolved.length >= 3, "这就是问题所在：正常一次成功抽取也会有一堆待确认项");
  const plan: FloorPlan = {
    id: "fp_real", conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: geometry, parseConfidence: geometry.confidence,
    unresolvedItems: unresolved, createdAt: AT, updatedAt: AT,
  };
  assert.equal(
    shouldSuggestReupload(plan, { status: "ok", ocrGrounded: true }),
    false,
    "全部读到高置信度数值——不该提示重新上传更清晰的草图",
  );
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

test("isExplicitLayoutChoice：精确等于 chip 文字才算，长句子里带到的不算", () => {
  assert.equal(isExplicitLayoutChoice("L-shape"), true);
  assert.equal(isExplicitLayoutChoice("u-shape"), true, "大小写不敏感");
  assert.equal(isExplicitLayoutChoice("  U-shape  "), true, "首尾空白不敏感");
  assert.equal(isExplicitLayoutChoice("U型"), true);
  assert.equal(isExplicitLayoutChoice("L型+岛台"), true);
  assert.equal(isExplicitLayoutChoice("我朋友家是U型的"), false, "长句子里顺带提一句不算明确选择");
  assert.equal(isExplicitLayoutChoice("what does U-shape look like"), false);
  assert.equal(isExplicitLayoutChoice(""), false);
});
