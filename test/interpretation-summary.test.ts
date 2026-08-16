/**
 * interpretationSummary（FR-17 上传后复述）：不该承诺一个跟实际出题数量对不上
 * 的数字，也不该提一张从来不会渲染出来的"图"——见 src/floorplan/parse.ts
 * 里这段的注释和 buildSiteQuestions 的分批出题。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretationSummary } from "../src/floorplan/parse.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-06-01T00:00:00.000Z";

function plan(overrides: Partial<FloorPlan> = {}): FloorPlan {
  return {
    id: "fp_1",
    conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: {
      wallRuns: [
        { id: "wr_n", label: "North", length: 120, startsAtCorner: true, endsAtCorner: true, features: [] },
      ],
      ceilingHeight: 96,
      confidence: 0.6,
    },
    parseConfidence: 0.6,
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

test("有待确认项时，不承诺一个具体数字，也不提「图上」——buildSiteQuestions 分批出题后，这份摘要不知道这一轮实际会问几条", () => {
  const p = plan({
    unresolvedItems: [
      { id: "u1", target: { kind: "global" }, field: "ceilingHeight", reason: "x", resolved: false },
      { id: "u2", target: { kind: "wallRun", id: "wr_n" }, field: "length", reason: "x", resolved: false },
    ],
  });
  const summary = interpretationSummary(p, { status: "ok", ocrGrounded: false }, "en");
  assert.ok(!/\d+\s*item/i.test(summary), `不该报具体数字: ${summary}`);
  assert.ok(!/diagram/i.test(summary), `不该提从来不会渲染的图: ${summary}`);
  assert.ok(/North ~120/.test(summary), "已读到的墙长仍要如实陈述");
  assert.ok(/Ceiling ~96/.test(summary), "已读到的层高仍要如实陈述");
});

test("没有待确认项时，说清楚都已算确认、可在右侧改", () => {
  const p = plan({ unresolvedItems: [] });
  const summary = interpretationSummary(p, { status: "ok", ocrGrounded: false }, "en");
  assert.ok(/already confirmed/i.test(summary));
  assert.ok(/Confirmed panel/i.test(summary));
});

test("中文同样不报数字、不提图", () => {
  const p = plan({
    unresolvedItems: [
      { id: "u1", target: { kind: "global" }, field: "ceilingHeight", reason: "x", resolved: false },
    ],
  });
  const summary = interpretationSummary(p, { status: "ok", ocrGrounded: false }, "zh");
  assert.ok(!/\d+\s*处/.test(summary), `不该报具体数字: ${summary}`);
  // "从图上读到"是指客户上传的那张原图，合理；不该提的是从来不会渲染的
  // 系统生成 Q# 块图（"图上的 Q#"/"块图"这类措辞）。
  assert.ok(!/图上的\s*Q|块图/.test(summary), `不该提从来不会渲染的块图: ${summary}`);
  assert.ok(/已确认/.test(summary));
});
