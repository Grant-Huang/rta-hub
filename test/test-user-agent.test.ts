/**
 * 测试用户 Agent：选题与蓝图（不跑完整 HTTP）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocatePointsForCases, allTestPoints, blueprintFromPoints, suggestedPointIds,
} from "../src/testing/index.js";

test("建议测试点覆盖 FR / @厂商 / 几何 / 家电 / 报价", () => {
  const ids = new Set(suggestedPointIds());
  assert.ok(ids.has("tp_fr18_no_default_seller"));
  assert.ok(ids.has("tp_mention_company"));
  assert.ok(ids.has("tp_appliances_declared"));
  assert.ok(ids.has("tp_quote_bom"));
  assert.ok(allTestPoints().length >= 10);
});

test("allocatePointsForCases 产出 count 组且含 @ 或报价类点时可组合", () => {
  const groups = allocatePointsForCases(3);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((g) => g.length >= 1));
});

test("blueprintFromPoints 为人设+意图，而非写死剧本", () => {
  const mention = allTestPoints().find((p) => p.id === "tp_mention_company")!;
  const bp0 = blueprintFromPoints([mention], 0);
  const bp1 = blueprintFromPoints([mention], 1);
  assert.ok(bp0.titleTag.startsWith("test-"));
  assert.equal(bp0.persona, "beginner");
  assert.equal(bp1.persona, "familiar");
  assert.ok(bp0.mission.brief.length > 20);
  assert.ok(bp0.mission.softGoals.length >= 2);
  assert.equal(bp0.observe.mentionCompany, true);
  assert.equal(bp0.companyId, "co_pilot");
  assert.ok(bp0.walls.length >= 1);
  // 不对客户暴露测试点 id
  assert.doesNotMatch(bp0.mission.brief, /tp_/);
  assert.doesNotMatch(JSON.stringify(bp0.facts), /tp_/);
});
