/**
 * 对话写回家电 —— 修复「聊过了但检查表一直待确认」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyChatApplianceAnswers, parseAppliancesFromChat, isDeferAppliances, isFridgeElsewhere,
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

test("中文「数字在前」说法（36寸双门对开冰箱）也要解析出宽度，不落回推定值", () => {
  // 回归：widthNear 原来只往关键词后面找数字，中文「N寸+描述+家电」这种
  // 数字在关键词前的惯用语序会静默丢宽度，家电落成 assumed 33"，引出重复提问。
  const parsed = parseAppliancesFromChat(
    "36寸双门对开冰箱、30寸灶具、24寸洗碗机、30寸油烟机、30寸水槽柜",
  );
  const fridge = parsed.appliances.find((a) => a.kind === "refrigerator");
  assert.equal(fridge?.width, 36);
  assert.equal(fridge?.provenance, "customer");
  const range = parsed.appliances.find((a) => a.kind === "range");
  assert.equal(range?.width, 30);
  assert.equal(range?.provenance, "customer");
  const dishwasher = parsed.appliances.find((a) => a.kind === "dishwasher");
  assert.equal(dishwasher?.width, 24);
  assert.equal(dishwasher?.provenance, "customer");
});

test("英文「宽度在前 + 品类描述词 + 家电名」（36\" French Door Refrigerator）也要解析出宽度，不落回推定值（第三方测试报告 BUG-003）", () => {
  // 回归：widthNear 找"数字在关键词前"时，数字和关键词之间只放了 12 个
  // 字符——比"French Door "本身（连关键词前的空格正好 13 个字符）还短，
  // 导致客户报了尺寸也被静默丢弃、悄悄落回推定值 33"，看起来就像系统
  // 完全没收到客户已经给过的答案，之后还会继续追问同一件事。
  const parsed = parseAppliancesFromChat('36" French Door Refrigerator');
  const fridge = parsed.appliances.find((a) => a.kind === "refrigerator");
  assert.equal(fridge?.width, 36);
  assert.equal(fridge?.provenance, "customer");

  // 更长的品类描述词（"Counter-Depth French Door"）同样不能把宽度挤丢。
  const parsed2 = parseAppliancesFromChat('36" Counter-Depth French Door Refrigerator');
  assert.equal(parsed2.appliances.find((a) => a.kind === "refrigerator")?.width, 36);

  // 一句话里报好几件家电时，品类描述词不能把宽度错吃到上一件家电头上。
  const parsed3 = parseAppliancesFromChat('36" French Door Refrigerator, 30" Gas Range, 24" Built-in Dishwasher');
  assert.equal(parsed3.appliances.find((a) => a.kind === "refrigerator")?.width, 36);
  assert.equal(parsed3.appliances.find((a) => a.kind === "range")?.width, 30);
  assert.equal(parsed3.appliances.find((a) => a.kind === "dishwasher")?.width, 24);
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

// ── 冰箱高度 ──────────────────────────────────────────────────────────────

test("聊天里说冰箱多高，能识别出来并落到高度上", () => {
  const r1 = applyChatApplianceAnswers(emptyPlan(), "the fridge is 70 tall");
  assert.ok(r1);
  assert.ok(r1!.applied.includes("height"));
  const f1 = r1!.plan.appliances?.find((a) => a.kind === "refrigerator");
  assert.equal(f1?.height, 70);
  assert.equal(f1?.heightProvenance, "customer");

  const r2 = applyChatApplianceAnswers(emptyPlan(), "冰箱高68寸");
  const f2 = r2!.plan.appliances?.find((a) => a.kind === "refrigerator");
  assert.equal(f2?.height, 68);
});

test("只报宽度不该被误判成高度——两者不能抢同一个数字", () => {
  const r = applyChatApplianceAnswers(emptyPlan(), 'fridge 33" wide');
  assert.ok(r);
  const fridge = r!.plan.appliances?.find((a) => a.kind === "refrigerator");
  assert.equal(fridge?.width, 33);
  // 宽度那个 33 不该被高度解析捡走——高度仍是没问过时的常见推定值，不是 33
  assert.equal(fridge?.height, 70);
  assert.equal(fridge?.heightProvenance, "assumed", "没提高度就该标推定，不是悄悄标成已确认");
});

test("已确认宽度的冰箱，补一句高度只改高度，不动宽度/provenance", () => {
  const plan = emptyPlan([
    { kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer" },
  ]);
  const r = applyChatApplianceAnswers(plan, "fridge height 72");
  assert.ok(r);
  const fridge = r!.plan.appliances?.find((a) => a.kind === "refrigerator");
  assert.equal(fridge?.width, 36);
  assert.equal(fridge?.provenance, "customer");
  assert.equal(fridge?.height, 72);
  assert.equal(fridge?.heightProvenance, "customer");
});

// ── 冰箱不放在这面墙 ──────────────────────────────────────────────────────

test("聊天里直接说冰箱放别处，能识别出来", () => {
  assert.equal(isFridgeElsewhere("the fridge is going elsewhere, not on this wall"), true);
  assert.equal(isFridgeElsewhere("我们冰箱不放在这面墙，放过道储藏间"), true);
  assert.equal(isFridgeElsewhere("fridge is 33 inches wide"), false, "只报尺寸不该误判");
});

test("已有冰箱时，说「放别处」只改 placement，不动宽度/provenance", () => {
  const plan = emptyPlan([
    { kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer" },
  ]);
  const r = applyChatApplianceAnswers(plan, "actually the fridge is going elsewhere, not on this wall");
  assert.ok(r);
  assert.ok(r!.applied.includes("placement"));
  const fridge = r!.plan.appliances?.find((a) => a.kind === "refrigerator");
  assert.equal(fridge?.placement, "elsewhere");
  assert.equal(fridge?.width, 36, "宽度不该被这句话改动");
  assert.equal(fridge?.provenance, "customer");
});

test("还没提过冰箱时，一句「放别处」也补出一台冰箱并标 elsewhere", () => {
  const r = applyChatApplianceAnswers(emptyPlan(), "fridge will be elsewhere, in the pantry");
  assert.ok(r);
  const fridge = r!.plan.appliances?.find((a) => a.kind === "refrigerator");
  assert.ok(fridge, "客户提到了冰箱这件事，不该在列表里凭空消失");
  assert.equal(fridge?.placement, "elsewhere");
});

test("Q# 话术也可解析种类", () => {
  const parsed = parseAppliancesFromChat(
    'Q4: fridge 33", range 30", dishwasher 24"',
  );
  // 这里的 range 与 fridge 同句，应认作灶具
  assert.ok(parsed.appliances.some((a) => a.kind === "range"));
  assert.ok(parsed.appliances.some((a) => a.kind === "refrigerator"));
});
