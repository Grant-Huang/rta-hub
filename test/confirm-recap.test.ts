/**
 * "本轮刚确认了什么"的差分——弱确认复述用（Phase 3）。
 * 只报这一轮新增/新确认的，不是全量已确认清单。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { justConfirmedNotes } from "../src/design/confirm-recap.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-08-11T12:00:00.000Z";

function plan(overrides: Partial<FloorPlan> = {}): FloorPlan {
  return {
    id: "fp_recap",
    conversationId: "c1",
    sourceFile: { name: "x.png", mimeType: "image/png", sizeBytes: 1 },
    parseConfidence: 0.9,
    parsedGeometry: { wallRuns: [], confidence: 0.9 },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

test("没有 before（全新会话）时，新确认的墙长/层高都进 justConfirmed", () => {
  const after = plan({
    parsedGeometry: {
      wallRuns: [{ id: "wr_n", label: "North", length: 168, startsAtCorner: true, endsAtCorner: true, features: [] }],
      ceilingHeight: 96,
      confidence: 0.9,
    },
  });
  const notes = justConfirmedNotes(undefined, after, "en");
  assert.deepEqual(notes, [`North 168"`, `ceiling 96"`]);
});

test("这一轮没有新变化时返回空数组——不重复复述已经确认过的", () => {
  const before = plan({
    parsedGeometry: {
      wallRuns: [{ id: "wr_n", label: "North", length: 168, startsAtCorner: true, endsAtCorner: true, features: [] }],
      ceilingHeight: 96,
      confidence: 0.9,
    },
  });
  const after = before; // 这一轮什么都没变
  const notes = justConfirmedNotes(before, after, "en");
  assert.deepEqual(notes, []);
});

test("只报这一轮新增的那一段墙，不重复报已经确认过的墙", () => {
  const before = plan({
    parsedGeometry: {
      wallRuns: [{ id: "wr_n", label: "North", length: 168, startsAtCorner: true, endsAtCorner: true, features: [] }],
      confidence: 0.9,
    },
  });
  const after = plan({
    parsedGeometry: {
      wallRuns: [
        { id: "wr_n", label: "North", length: 168, startsAtCorner: true, endsAtCorner: true, features: [] },
        { id: "wr_e", label: "East", length: 120, startsAtCorner: false, endsAtCorner: false, features: [] },
      ],
      confidence: 0.9,
    },
  });
  const notes = justConfirmedNotes(before, after, "en");
  assert.deepEqual(notes, [`East 120"`]);
});

test("待确认（有 unresolvedItems 挂着）的墙长不算已确认，不进 justConfirmed", () => {
  const after = plan({
    parsedGeometry: {
      wallRuns: [{ id: "wr_n", label: "North", length: 168, startsAtCorner: true, endsAtCorner: true, features: [] }],
      confidence: 0.9,
    },
    unresolvedItems: [{
      id: "u1", target: { kind: "wallRun", id: "wr_n" }, field: "length",
      reason: "待确认", resolved: false, suggestion: 168,
    }],
  });
  const notes = justConfirmedNotes(undefined, after, "en");
  assert.deepEqual(notes, []);
});

test("新确认的家电宽度进 justConfirmed；中文时用中文单位", () => {
  const after = plan({
    appliances: [{ kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "customer" }],
  });
  const notesEn = justConfirmedNotes(undefined, after, "en");
  assert.deepEqual(notesEn, [`Refrigerator 33"`]);
  const notesZh = justConfirmedNotes(undefined, after, "zh");
  assert.deepEqual(notesZh, ["冰箱 33寸"]);
});

test("推定（assumed）宽度的家电不进 justConfirmed", () => {
  const after = plan({
    appliances: [{ kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "assumed" }],
  });
  const notes = justConfirmedNotes(undefined, after, "en");
  assert.deepEqual(notes, []);
});
