/**
 * "确认锁"——已确认（无待处理项）的墙长/家电宽度，不能被聊天新解析出的
 * 不同数值静默覆盖。这是把 FR-24 里已有的 provenance 推导（`design-input.ts`）
 * 从"仅用于导出描述"升级成"写入门禁"，见 `src/design/confirm-lock.ts`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChatSiteAnswers, applyChatWallLengths } from "../src/design/chat-site-answers.js";
import { applyChatApplianceAnswers } from "../src/design/chat-appliance-answers.js";
import type { BlockedEdit } from "../src/design/confirm-lock.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-08-11T12:00:00.000Z";

function confirmedWallPlan(): FloorPlan {
  return {
    id: "fp_lock",
    conversationId: "c1",
    sourceFile: { name: "x.png", mimeType: "image/png", sizeBytes: 1 },
    parseConfidence: 0.9,
    parsedGeometry: {
      wallRuns: [{
        id: "wr_n", label: "North", length: 168,
        startsAtCorner: true, endsAtCorner: true, features: [],
      }],
      ceilingHeight: 96,
      confidence: 0.9,
    },
    // 没有任何待处理项 → North 墙长按 FR-24 的 provenance 推导已是 "customer"
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("已确认的墙长不会被聊天里不同的新数字静默覆盖", () => {
  const plan = confirmedWallPlan();
  const blocked: BlockedEdit[] = [];
  const result = applyChatWallLengths(plan, 'North 120"', AT, blocked);
  // 没有任何字段真的被改变
  assert.equal(result, undefined);
  assert.equal(plan.parsedGeometry.wallRuns[0]!.length, 168);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.kind, "wallLength");
  assert.equal(blocked[0]!.current, 168);
  assert.equal(blocked[0]!.attempted, 120);
});

test("applyChatSiteAnswers 把被拦下的修改记进 blockedEdits，原值不变", () => {
  const plan = confirmedWallPlan();
  const r = applyChatSiteAnswers(plan, 'North 120"', AT);
  assert.ok(r, "有 blockedEdits 时也应返回结果，而不是 undefined");
  assert.equal(r!.plan.parsedGeometry.wallRuns[0]!.length, 168);
  assert.ok(!r!.applied.includes("wallLength"));
  assert.equal(r!.blockedEdits.length, 1);
  assert.equal(r!.blockedEdits[0]!.current, 168);
  assert.equal(r!.blockedEdits[0]!.attempted, 120);
});

test("重发同一个已确认的墙长数值不算修改，也不算拦截", () => {
  const plan = confirmedWallPlan();
  const blocked: BlockedEdit[] = [];
  const result = applyChatWallLengths(plan, 'North 168"', AT, blocked);
  assert.equal(result, undefined);
  assert.equal(blocked.length, 0);
});

test("还没确认（有待处理项）的墙长可以正常被聊天解析写入，不受锁限制", () => {
  const plan: FloorPlan = {
    ...confirmedWallPlan(),
    parsedGeometry: {
      wallRuns: [{
        id: "wr_n", label: "North", length: 0,
        startsAtCorner: true, endsAtCorner: true, features: [],
      }],
      confidence: 0.5,
    },
    unresolvedItems: [{
      id: "fpu_1", target: { kind: "wallRun", id: "wr_n" }, field: "length",
      reason: "北墙长度待确认", resolved: false,
    }],
  };
  const blocked: BlockedEdit[] = [];
  const result = applyChatWallLengths(plan, 'North 120"', AT, blocked);
  assert.ok(result);
  assert.equal(result!.parsedGeometry.wallRuns[0]!.length, 120);
  assert.equal(blocked.length, 0);
});

test("已确认的家电宽度不会被聊天里不同的新数字静默覆盖", () => {
  const plan: FloorPlan = {
    ...confirmedWallPlan(),
    appliances: [
      { kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "customer" },
    ],
  };
  const r = applyChatApplianceAnswers(plan, 'Fridge 30"');
  assert.ok(r, "有 blockedEdits 时也应返回结果");
  assert.equal(r!.plan.appliances?.[0]?.width, 33);
  assert.ok(!r!.applied.includes("widths"));
  assert.equal(r!.blockedEdits.length, 1);
  assert.equal(r!.blockedEdits[0]!.kind, "appliance");
  assert.equal(r!.blockedEdits[0]!.current, 33);
  assert.equal(r!.blockedEdits[0]!.attempted, 30);
});

test("推定（assumed）的家电宽度仍可以被客户明确说出的宽度正常覆盖", () => {
  const plan: FloorPlan = {
    ...confirmedWallPlan(),
    appliances: [
      { kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "assumed" },
    ],
  };
  const r = applyChatApplianceAnswers(plan, 'Fridge 30"');
  assert.ok(r);
  assert.equal(r!.plan.appliances?.[0]?.width, 30);
  assert.equal(r!.plan.appliances?.[0]?.provenance, "customer");
  assert.equal(r!.blockedEdits.length, 0);
});
