/**
 * 外部测试回归：省份误匹配、对话上下水同步到 Design Basis。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingFields, hasProvinceMention } from "../src/agents/orchestrator.js";
import { evaluateDesignReadiness, matchProvince } from "../src/design/readiness.js";
import {
  applyChatPlumbingAnswer, chatConfirmedPlumbing, parsePlumbingFromChat,
} from "../src/design/chat-site-answers.js";
import type { Conversation } from "../src/domain/types.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-06-01T00:00:00.000Z";

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "cv_1",
    customerAccountId: "ca_1",
    messages: [],
    designRequirements: "",
    perCompanyThreads: [],
    createdAt: AT,
    ...over,
  };
}

function planTwoWalls(): FloorPlan {
  return {
    id: "fp_1",
    conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: {
      wallRuns: [
        {
          id: "wr_a", label: "Wall A", length: 120,
          startsAtCorner: true, endsAtCorner: true, features: [],
        },
        {
          id: "wr_b", label: "Wall B", length: 100,
          startsAtCorner: true, endsAtCorner: true, features: [],
        },
      ],
      ceilingHeight: 96,
      confidence: 0.9,
    },
    parseConfidence: 0.9,
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("BC省不会被英文 on 抢成 Ontario", () => {
  assert.equal(matchProvince("BC省")?.code, "BC");
  assert.equal(matchProvince("我在BC省")?.code, "BC");
  assert.equal(matchProvince("sink on left wall, BC省")?.code, "BC");
  assert.equal(matchProvince("Plumbing on Wall A ~60\", BC省")?.code, "BC");
  assert.equal(matchProvince("Modern style on a budget, BC省")?.code, "BC");
  assert.equal(matchProvince("Ontario ON")?.code, "ON");
  assert.equal(matchProvince("British Columbia BC")?.code, "BC");
});

test("英文介词 on 不能让 missingFields 认为省份已填", () => {
  assert.equal(hasProvinceMention("sink on left wall"), false);
  assert.ok(missingFields("Modern style\nsink on left wall\nbudget CAD $10k").includes("province"));
  assert.equal(hasProvinceMention("BC省"), true);
  assert.equal(hasProvinceMention("Ontario ON"), true);
  assert.ok(!missingFields("Modern style\nBC省\nbudget CAD $10k").includes("province"));
});

test("客户直接说英文城市名（不带省名/省码）也要认得——之前只收了城市的中文名", () => {
  assert.equal(hasProvinceMention("I live in Toronto"), true);
  assert.equal(matchProvince("I live in Toronto")?.code, "ON");
  assert.equal(hasProvinceMention("I'm in Vancouver"), true);
  assert.equal(matchProvince("based in Calgary")?.code, "AB");
  assert.equal(matchProvince("we're in Montreal")?.code, "QC");
  assert.equal(matchProvince("Halifax, NS")?.code, "NS");
  assert.equal(matchProvince("Winnipeg")?.code, "MB");
});

test("已确认的省份不该被'问别处有没有服务'这种话里顺带提到的城市名顶掉（第三方测试报告 BUG-008）", () => {
  // 客户先报了 Ontario，后面顺口问一句"你们在 Surrey 有安装服务吗"——问的是
  // 服务范围，不是在说"我搬去 Surrey 了"，不该被当成省份改口。
  assert.equal(
    matchProvince("Ontario ON\nWhat colors do you have?\nDo you offer installation in Surrey?")?.code,
    "ON",
  );
  assert.equal(
    matchProvince("安大略省 ON\n你们在温哥华有安装服务吗？")?.code,
    "ON",
  );
  // 反过来：客户是在真的自报/改口住址时，仍然要认得——只挡"问服务范围"
  // 这一种句式，不能连累到正常的自报句。
  assert.equal(matchProvince("I live in Toronto. Actually we moved, now in Surrey.")?.code, "BC");
  assert.equal(matchProvince("I'm in Surrey")?.code, "BC");
  assert.equal(matchProvince("我在温哥华")?.code, "BC");
});

test("对话确认 sink on left wall 写入 plumbing feature", () => {
  const fp = planTwoWalls();
  const parsed = parsePlumbingFromChat("sink on left wall", fp);
  assert.ok(parsed);
  assert.equal(parsed!.wallRunId, "wr_a"); // left → 第一面墙
  const next = applyChatPlumbingAnswer(fp, "sink on left wall", AT);
  assert.ok(next);
  assert.ok(next!.parsedGeometry.wallRuns[0]!.features.some((f) => f.kind === "plumbing"));
});

test("对话确认上下水后 Design Basis 不再显示 not confirmed", () => {
  const req = "Modern style\nBudget CAD $10-20k\nBC省\nAppliances later\nNo windows\nsink on left wall";
  assert.equal(chatConfirmedPlumbing(req), true);
  const r = evaluateDesignReadiness({
    conversation: conv({ designRequirements: req }),
    plan: planTwoWalls(),
    language: "en",
  });
  const plumbing = r.items.find((i) => i.id === "plumbing");
  assert.equal(plumbing?.status, "ok");
  assert.doesNotMatch(plumbing?.brief ?? "", /not confirmed/i);
  assert.equal(r.items.find((i) => i.id === "province")?.status, "ok");
  assert.match(r.items.find((i) => i.id === "province")?.brief ?? "", /British Columbia|BC/i);
});

test("门板偏好可满足风格关键项", () => {
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements: "Budget CAD $10-20k\nOntario ON\nAppliances later\nNo windows",
      preferences: {
        shared: {},
        byCompany: { co_1: { doorStyleId: "ds_shaker_white" } },
      },
    }),
    plan: {
      ...planTwoWalls(),
      parsedGeometry: {
        ...planTwoWalls().parsedGeometry,
        wallRuns: [{
          id: "wr_a", label: "Wall A", length: 120,
          startsAtCorner: true, endsAtCorner: true,
          features: [{ id: "wf_1", kind: "plumbing", offset: 48, width: 24 }],
        }],
      },
    },
    language: "en",
  });
  assert.equal(r.items.find((i) => i.id === "style")?.status, "ok");
});
