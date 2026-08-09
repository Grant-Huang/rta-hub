/**
 * FR-22.2：会话纠错识别 → L1 队列信号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectSessionCorrections, detectCorrectionFromText, looksLikeSessionCorrection,
} from "../src/knowledge/session-corrections.js";
import type { Conversation } from "../src/domain/types.js";

test("识别中英纠错话术", () => {
  assert.ok(looksLikeSessionCorrection("不对，B12 应该是单门不是双抽"));
  assert.ok(looksLikeSessionCorrection("Actually that prefix means tall pantry"));
  assert.ok(!looksLikeSessionCorrection("hi"));
});

test("detectCorrectionFromText 可抽 codingHint", () => {
  const hit = detectCorrectionFromText(
    "Correction: B12 means 1 drawer over door, not double door",
    "c1",
  );
  assert.ok(hit);
  assert.match(hit!.summary, /B12/);
});

test("collectSessionCorrections 只收绑定该公司的会话", () => {
  const convA: Conversation = {
    id: "c_a",
    customerAccountId: "acc1",
    messages: [
      { role: "user", content: "不对，你们前缀 X 其实是高柜", at: "2026-08-08T00:00:00.000Z" },
    ],
    designRequirements: "",
    perCompanyThreads: [{ companyId: "co_a", messages: [] }],
    createdAt: "2026-08-08T00:00:00.000Z",
  };
  const convB: Conversation = {
    ...convA,
    id: "c_b",
    perCompanyThreads: [{ companyId: "co_b", messages: [] }],
  };
  const hits = collectSessionCorrections({
    companyId: "co_a",
    conversations: [convA, convB],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.conversationId, "c_a");
});
