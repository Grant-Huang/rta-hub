/**
 * LLM 结构化抽取（Phase 2）——抽取本身的失败兜底 + 数值范围校验，
 * 以及抽取结果写入 FloorPlan 时复用 Phase 1 的"确认锁"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGeometryFromChat, type ChatTurn } from "../src/design/llm-extract.js";
import { applyExtractedWalls } from "../src/design/chat-site-answers.js";
import { applyExtractedAppliances } from "../src/design/chat-appliance-answers.js";
import type { CompletionClient } from "../src/agents/types.js";
import type { BlockedEdit } from "../src/design/confirm-lock.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-08-11T12:00:00.000Z";

function fakeClient(result: unknown): CompletionClient {
  return {
    async complete() { return ""; },
    async extractStructured() { return result as never; },
  };
}

function throwingClient(): CompletionClient {
  return {
    async complete() { return ""; },
    async extractStructured() { throw new Error("boom"); },
  };
}

const turns: ChatTurn[] = [{ role: "user", content: 'North wall 168", East wall 120"' }];

test("没有 client 时直接返回 undefined，不报错", async () => {
  const r = await extractGeometryFromChat(undefined, turns);
  assert.equal(r, undefined);
});

test("client 不支持 extractStructured 时返回 undefined", async () => {
  const r = await extractGeometryFromChat({ async complete() { return ""; } }, turns);
  assert.equal(r, undefined);
});

test("调用抛错时返回 undefined，不往外抛", async () => {
  const r = await extractGeometryFromChat(throwingClient(), turns);
  assert.equal(r, undefined);
});

test("合法范围内的抽取结果原样通过", async () => {
  const client = fakeClient({
    wallRuns: [{ label: "North", lengthInches: 168 }, { label: "East", lengthInches: 120 }],
    ceilingHeightInches: 96,
    appliances: [{ kind: "refrigerator", widthInches: 33 }],
    confirmAssumedAppliances: false,
  });
  const r = await extractGeometryFromChat(client, turns);
  assert.ok(r);
  assert.deepEqual(r!.wallRuns, [{ label: "North", lengthInches: 168 }, { label: "East", lengthInches: 120 }]);
  assert.equal(r!.ceilingHeightInches, 96);
  assert.deepEqual(r!.appliances, [{ kind: "refrigerator", widthInches: 33 }]);
});

test("超出合理范围的数值被过滤掉，不是原样采信——防模型幻觉", async () => {
  const client = fakeClient({
    // 500" 的墙、200" 的层高、5" 的冰箱都不是任何真实厨房会有的尺寸
    wallRuns: [{ label: "North", lengthInches: 500 }, { label: "East", lengthInches: 120 }],
    ceilingHeightInches: 200,
    appliances: [{ kind: "refrigerator", widthInches: 5 }, { kind: "dishwasher", widthInches: 24 }],
    confirmAssumedAppliances: false,
  });
  const r = await extractGeometryFromChat(client, turns);
  assert.ok(r);
  assert.deepEqual(r!.wallRuns, [{ label: "East", lengthInches: 120 }]);
  assert.equal(r!.ceilingHeightInches, undefined);
  assert.deepEqual(r!.appliances, [{ kind: "refrigerator" }, { kind: "dishwasher", widthInches: 24 }]);
});

function confirmedWallPlan(): FloorPlan {
  return {
    id: "fp_llm",
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
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("LLM 抽取路径写入墙长时，同样受确认锁保护——已确认的不被覆盖", () => {
  const plan = confirmedWallPlan();
  const blocked: BlockedEdit[] = [];
  const next = applyExtractedWalls(plan, [{ label: "North", lengthInches: 100 }], undefined, AT, blocked);
  assert.equal(next.parsedGeometry.wallRuns[0]!.length, 168);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.current, 168);
  assert.equal(blocked[0]!.attempted, 100);
});

test("LLM 抽取路径可以给新墙段写入长度（还没确认过）", () => {
  const plan = confirmedWallPlan();
  const next = applyExtractedWalls(plan, [{ label: "East", lengthInches: 120 }], undefined, AT);
  const east = next.parsedGeometry.wallRuns.find((r) => r.label === "East");
  assert.ok(east);
  assert.equal(east!.length, 120);
});

test("LLM 抽取路径写入家电时，同样受确认锁保护", () => {
  const plan: FloorPlan = {
    ...confirmedWallPlan(),
    appliances: [{ kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "customer" }],
  };
  const blocked: BlockedEdit[] = [];
  const next = applyExtractedAppliances(plan, [{ kind: "refrigerator", widthInches: 30 }], false, blocked);
  assert.equal(next.appliances?.[0]?.width, 33);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.current, 33);
  assert.equal(blocked[0]!.attempted, 30);
});
