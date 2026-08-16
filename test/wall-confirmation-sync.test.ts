/**
 * 一段墙的"长度是否已确认"，确认栏（readiness.ts）、导出 JSON（design-input.ts）、
 * Q# 追问（site-questions.ts）三处必须给出同一个答案——都从 `isWallLengthPending`
 * 派生（parse.ts），不各自重新判断一遍。
 *
 * 回归场景：墙长本身已确认（`field==="length"` 的待确认项已 resolved），但同一面墙
 * 上还挂着一条不相关的待确认项（如"这个识别不出类型的东西是窗/门/上下水？"，
 * `field==="feature.kind"`）。改之前，三处里有两处（Q# 生成、导出 JSON）没按
 * `field` 过滤，看到"这面墙还有未解决项"就整段判成未确认——于是确认栏显示
 * "已确认 ✓"，导出 JSON 却写 `provenance: "assumed"`，Q# 还会把已经确认过的墙长
 * 重新问一遍。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../src/domain/types.js";
import type { FloorPlan } from "../src/floorplan/types.js";
import { evaluateDesignReadiness } from "../src/design/readiness.js";
import { exportDesignInput, wallRunProvenance } from "../src/floorplan/design-input.js";
import { buildSiteQuestions } from "../src/design/site-questions.js";
import { isWallLengthPending } from "../src/floorplan/parse.js";

const AT = "2026-08-16T00:00:00.000Z";

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

/** 墙长已确认，同一面墙上还有一条不相关的待确认特征分类项。 */
function planWithConfirmedLengthAndPendingFeature(): FloorPlan {
  return {
    id: "fp_1",
    conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: {
      wallRuns: [{
        id: "w1", label: "北墙", length: 144,
        startsAtCorner: true, endsAtCorner: true,
        features: [{ id: "feat_plumb", kind: "plumbing", offset: 60, width: 0 }],
      }],
      ceilingHeight: 96,
      confidence: 0.9,
    },
    parseConfidence: 0.9,
    unresolvedItems: [
      { id: "u1", target: { kind: "wallRun", id: "w1" }, field: "length", reason: "客户已确认", resolved: true },
      { id: "u2", target: { kind: "wallRun", id: "w1" }, field: "feature.kind", reason: "识别不出类型的东西", resolved: false },
    ],
    appliances: [{ kind: "range", width: 30, clearanceEachSide: 0, provenance: "customer" }],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("isWallLengthPending：只看 field===length，不被同一面墙上的其他待确认项带偏", () => {
  const plan = planWithConfirmedLengthAndPendingFeature();
  assert.equal(isWallLengthPending(plan, "w1"), false, "长度本身已经 resolved，不该因为特征分类还没定就算 pending");
});

test("确认栏 / 导出 JSON / Q# 三处对同一面墙的确认状态必须一致", () => {
  const plan = planWithConfirmedLengthAndPendingFeature();

  const readiness = evaluateDesignReadiness({ conversation: conv(), plan, language: "zh" });
  const wallFact = readiness.confirmedFacts.find((f) => f.key === "wall:w1");
  assert.equal(wallFact?.status, "ok", "确认栏应显示这面墙的长度已确认");

  const exported = exportDesignInput(plan);
  assert.equal(exported.geometry.wallRuns[0]?.provenance, "customer",
    "导出 JSON 的 provenance 不该和确认栏的状态对不上");
  assert.equal(wallRunProvenance(plan, "w1"), "customer",
    "确认锁（chat-site-answers.ts 用它判断能不能被聊天静默覆盖）也该认为已确认");

  const site = buildSiteQuestions(plan, "", "zh");
  assert.ok(
    !site.questions.some((q) => q.kind === "wall_confirm" && q.wallRunId === "w1"),
    "Q# 不该把已经确认过长度的墙再问一遍",
  );
  // 墙上那条真正待确认的（识别不出类型的特征）走的是别的 Q#，不受影响——
  // 这里没有窗/门/上下水/燃气/强电任何一类的 feature，所以照常各自出题。
  assert.ok(site.questions.some((q) => q.kind === "window"));
});

test("墙长仍待确认时，三处仍然一致地显示未确认（不是把过滤条件改松了）", () => {
  const plan: FloorPlan = {
    ...planWithConfirmedLengthAndPendingFeature(),
    unresolvedItems: [
      { id: "u1", target: { kind: "wallRun", id: "w1" }, field: "length", reason: "还没确认", resolved: false },
    ],
  };

  assert.equal(isWallLengthPending(plan, "w1"), true);

  const readiness = evaluateDesignReadiness({ conversation: conv(), plan, language: "zh" });
  const wallFact = readiness.confirmedFacts.find((f) => f.key === "wall:w1");
  assert.equal(wallFact?.status, "needs_confirm");

  assert.equal(wallRunProvenance(plan, "w1"), "assumed");
  assert.equal(exportDesignInput(plan).geometry.wallRuns[0]?.provenance, "assumed");

  const site = buildSiteQuestions(plan, "", "zh");
  assert.ok(site.questions.some((q) => q.kind === "wall_confirm" && q.wallRunId === "w1"),
    "长度真的还没确认时，Q# 应该照常问");
});
