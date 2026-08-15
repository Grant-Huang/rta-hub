/**
 * 对话写回家电 —— 修复「聊过了但检查表一直待确认」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyChatApplianceAnswers, parseAppliancesFromChat, isDeferAppliances,
} from "../src/design/chat-appliance-answers.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-08-08T12:00:00.000Z";

function emptyPlan(appliances: FloorPlan["appliances"] = []): FloorPlan {
  return {
    id: "fp_a",
    conversationId: "c1",
    sourceFile: { name: "x.png", mimeType: "image/png", sizeBytes: 1 },
    parseConfidence: 0.5,
    parsedGeometry: {
      wallRuns: [{
        id: "wr_n", label: "North", length: 84,
        startsAtCorner: true, endsAtCorner: true, features: [],
      }],
      ceilingHeight: 96,
      confidence: 0.5,
    },
    unresolvedItems: [],
    ...(appliances.length ? { appliances } : {}),
    createdAt: AT,
    updatedAt: AT,
  };
}

test("解析 fridge/stove/dishwasher 宽度并落库", () => {
  const parsed = parseAppliancesFromChat('fridge 33", stove 30", dishwasher 24"');
  // 三样客户给的 + 一台跟着灶具补的推定烟机
  assert.equal(parsed.appliances.length, 4);
  const fridge = parsed.appliances.find((a) => a.kind === "refrigerator");
  assert.equal(fridge?.width, 33);
  assert.equal(fridge?.provenance, "customer");
  const stove = parsed.appliances.find((a) => a.kind === "range");
  assert.equal(stove?.width, 30);
  const hood = parsed.appliances.find((a) => a.kind === "rangeHood");
  assert.equal(hood?.provenance, "assumed");

  const applied = applyChatApplianceAnswers(emptyPlan(), 'Fridge 33", stove 30"');
  assert.ok(applied);
  assert.ok(applied!.applied.includes("widths") || applied!.applied.includes("kinds"));
  assert.equal(applied!.plan.appliances?.length, 3);
});

test("budget range 不误判为灶具", () => {
  const parsed = parseAppliancesFromChat("Budget range CAD $10–20k is fine");
  assert.equal(parsed.appliances.length, 0);
  assert.equal(
    parseAppliancesFromChat("A range is fine for budget, not sure yet").appliances.length,
    0,
  );
});

test("家电后定 isDefer；接受推定时保留 assumed 并在空列表时落入默认三件套+推定烟机", () => {
  assert.equal(isDeferAppliances("appliances later"), true);
  const plan = emptyPlan([
    {
      kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "assumed",
    },
  ]);
  const r = applyChatApplianceAnswers(plan, "assumed widths are fine");
  assert.ok(r);
  assert.ok(r!.applied.includes("confirmAssumed"));
  assert.equal(r!.plan.appliances?.[0]?.provenance, "assumed");
  assert.equal(r!.plan.appliances?.[0]?.width, 33);

  const seeded = applyChatApplianceAnswers(emptyPlan(), "assumed widths are fine");
  assert.ok(seeded);
  assert.ok(seeded!.applied.includes("kinds"));
  assert.ok(seeded!.applied.includes("confirmAssumed"));
  // 冰箱+灶具+洗碗机三件套，另加一台跟着灶具补的推定烟机
  assert.equal(seeded!.plan.appliances?.length, 4);
  assert.ok(seeded!.plan.appliances?.every((a) => a.provenance === "assumed"));
  assert.ok(seeded!.plan.appliances?.some((a) => a.kind === "rangeHood"));
});

test("历史同时有 appliances later 与 assumed widths are fine 时仍落入推定", () => {
  const blob = [
    "ceiling 96 inches, no windows, appliances later",
    "assumed widths are fine, please generate the design now",
  ].join("\n");
  const r = applyChatApplianceAnswers(emptyPlan(), blob);
  assert.ok(r);
  assert.ok(r!.plan.appliances && r!.plan.appliances.length >= 3);
  assert.ok(r!.plan.appliances?.every((a) => a.provenance === "assumed"));
});

test("Q# 话术也可解析种类", () => {
  const parsed = parseAppliancesFromChat(
    'Q4: fridge 33", range 30", dishwasher 24"',
  );
  // 这里的 range 与 fridge 同句，应认作灶具
  assert.ok(parsed.appliances.some((a) => a.kind === "range"));
  assert.ok(parsed.appliances.some((a) => a.kind === "refrigerator"));
});
