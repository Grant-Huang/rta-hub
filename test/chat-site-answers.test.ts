/**
 * FR-19：Q# / 对话现场特征结构化落库。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyChatSiteAnswers, chatMentionsGeometry, parseCeilingFromChat, parseDoorFromChat,
  parsePlumbingFromChat, parseWindowFromChat,
} from "../src/design/chat-site-answers.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-08-08T12:00:00.000Z";

function plan(opts?: { ceiling?: number }): FloorPlan {
  return {
    id: "fp_test",
    conversationId: "c1",
    sourceFile: { name: "x.png", mimeType: "image/png", sizeBytes: 1 },
    parseConfidence: 0.9,
    parsedGeometry: {
      wallRuns: [
        {
          id: "wr_n", label: "North", length: 144,
          startsAtCorner: true, endsAtCorner: true, features: [],
        },
        {
          id: "wr_w", label: "West", length: 96,
          startsAtCorner: true, endsAtCorner: true, features: [],
        },
      ],
      ...(opts?.ceiling !== undefined ? { ceilingHeight: opts.ceiling } : {}),
      confidence: 0.9,
    },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("解析层高英寸 / 英尺", () => {
  assert.equal(parseCeilingFromChat("Q1: ceiling is 96 inches")?.height, 96);
  assert.equal(parseCeilingFromChat("层高 8 ft")?.height, 96);
  assert.equal(parseCeilingFromChat("Ceiling height 108\"")?.height, 108);
});

test("Q# 纯数字答层高（根治层高失忆）", () => {
  assert.equal(parseCeilingFromChat("Q1: 96")?.height, 96);
  assert.equal(parseCeilingFromChat("Q1：108")?.height, 108);
  assert.equal(parseCeilingFromChat("96")?.height, 96);
});

test("数字在关键词前面的自然说法也要认得（\"a 9ft ceiling\"，不止\"ceiling 9ft\"）", () => {
  assert.equal(parseCeilingFromChat("a 9ft ceiling")?.height, 108);
  assert.equal(parseCeilingFromChat("and a 9ft ceiling (108 in)")?.height, 108);
  assert.equal(parseCeilingFromChat("9尺层高")?.height, 108);
});

test("解析上下水到指定墙", () => {
  const p = parsePlumbingFromChat(
    "Q2: plumbing on the North wall, about 60\" from the corner",
    plan(),
  );
  assert.ok(p);
  assert.equal(p!.wallRunId, "wr_n");
  assert.equal(p!.offset, 60);
});

test("解析窗到墙 + 宽度", () => {
  const w = parseWindowFromChat('Window on West wall, 36" wide near the middle', plan());
  assert.ok(w);
  assert.notEqual(w, "none");
  assert.equal((w as { wallRunId: string }).wallRunId, "wr_w");
  assert.equal((w as { width: number }).width, 36);
});

test("no windows 返回 none 标记", () => {
  assert.equal(parseWindowFromChat("no windows on these walls", plan()), "none");
});

test("解析门洞", () => {
  const d = parseDoorFromChat('Door opening on North, 32" wide', plan());
  assert.ok(d);
  assert.notEqual(d, "none");
  assert.equal((d as { wallRunId: string }).wallRunId, "wr_n");
  assert.equal((d as { width: number }).width, 32);
});

test("手输墙长 North 84 写入 wallRuns", () => {
  const base = plan();
  // 先把 North 清成 0，模拟识图失败后手输
  const broken: FloorPlan = {
    ...base,
    parsedGeometry: {
      ...base.parsedGeometry,
      wallRuns: base.parsedGeometry.wallRuns.map((r) =>
        r.id === "wr_n" ? { ...r, length: 0 } : r),
    },
  };
  const r = applyChatSiteAnswers(broken, 'North 84", ceiling 96"', AT);
  assert.ok(r);
  assert.ok(r!.applied.includes("wallLength"));
  assert.ok(r!.applied.includes("ceiling"));
  const north = r!.plan.parsedGeometry.wallRuns.find((x) => x.id === "wr_n");
  assert.equal(north?.length, 84);
  assert.equal(r!.plan.parsedGeometry.ceilingHeight, 96);
});

test("无墙壳时 left/back + ft 新建墙段并写入层高", () => {
  const empty: FloorPlan = {
    id: "fp_empty",
    conversationId: "c1",
    sourceFile: { name: "chat-geometry.txt", mimeType: "text/plain", sizeBytes: 0 },
    parseConfidence: 0.5,
    parsedGeometry: { wallRuns: [], confidence: 0.5 },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
  const r = applyChatSiteAnswers(
    empty,
    "L-shape: left wall 12ft, back wall 10ft\nceiling 96 inches",
    AT,
  );
  assert.ok(r);
  assert.ok(r!.applied.includes("wallLength"));
  assert.ok(r!.applied.includes("ceiling"));
  const left = r!.plan.parsedGeometry.wallRuns.find((x) => /left/i.test(x.label));
  const back = r!.plan.parsedGeometry.wallRuns.find((x) => /back/i.test(x.label));
  assert.equal(left?.length, 144);
  assert.equal(back?.length, 120);
  assert.equal(r!.plan.parsedGeometry.ceilingHeight, 96);
});

test("助手复述 L-shape 12ft / 10ft 无墙名也可落两段墙", () => {
  const empty: FloorPlan = {
    id: "fp_l",
    conversationId: "c1",
    sourceFile: { name: "chat-geometry.txt", mimeType: "text/plain", sizeBytes: 0 },
    parseConfidence: 0.5,
    parsedGeometry: { wallRuns: [], confidence: 0.5 },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
  const r = applyChatSiteAnswers(
    empty,
    "L-shape: left wall 12ft / back wall 10ft, ceiling 96\", no windows.",
    AT,
  );
  assert.ok(r);
  assert.equal(r!.plan.parsedGeometry.wallRuns.filter((w) => w.length > 0).length, 2);
});

test("applyChatSiteAnswers 一次写入层高与上下水", () => {
  const r = applyChatSiteAnswers(
    plan(),
    'Ceiling 96". Plumbing on North wall about 48" from corner.',
    AT,
  );
  assert.ok(r);
  assert.ok(r!.applied.includes("ceiling"));
  assert.ok(r!.applied.includes("plumbing"));
  assert.equal(r!.plan.parsedGeometry.ceilingHeight, 96);
  assert.ok(r!.plan.parsedGeometry.wallRuns[0]!.features.some((f) => f.kind === "plumbing"));
});

test("已有 plumbing 时不再覆盖", () => {
  const base = plan();
  const withPlumb = applyChatSiteAnswers(
    base, 'Plumbing on West wall 40" from corner.', AT,
  )!;
  const again = applyChatSiteAnswers(
    withPlumb.plan, 'Plumbing on North wall 20" from corner.', AT,
  );
  // 可能仍写入窗/层高，但不应再写 plumbing
  if (again) {
    assert.ok(!again.applied.includes("plumbing"));
  }
  const plumbs = withPlumb.plan.parsedGeometry.wallRuns.flatMap((r) =>
    r.features.filter((f) => f.kind === "plumbing"));
  assert.equal(plumbs.length, 1);
  assert.equal(plumbs[0]!.offset, 40);
});

test("快捷回答 One wall ~12 ft 落成 144\" 墙段", () => {
  const empty: FloorPlan = {
    id: "fp_one",
    conversationId: "c1",
    sourceFile: { name: "chat-geometry.txt", mimeType: "text/plain", sizeBytes: 0 },
    parseConfidence: 0.5,
    parsedGeometry: { wallRuns: [], confidence: 0.5 },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
  const r = applyChatSiteAnswers(empty, "One wall ~12 ft", AT);
  assert.ok(r);
  assert.ok(r!.applied.includes("wallLength"));
  assert.equal(r!.plan.parsedGeometry.wallRuns.length, 1);
  assert.equal(r!.plan.parsedGeometry.wallRuns[0]!.length, 144);
});

test("快捷回答 Two walls ~10 ft each 落成两段 120\"", () => {
  const empty: FloorPlan = {
    id: "fp_two",
    conversationId: "c1",
    sourceFile: { name: "chat-geometry.txt", mimeType: "text/plain", sizeBytes: 0 },
    parseConfidence: 0.5,
    parsedGeometry: { wallRuns: [], confidence: 0.5 },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
  const r = applyChatSiteAnswers(empty, "Two walls ~10 ft each", AT);
  assert.ok(r);
  const runs = r!.plan.parsedGeometry.wallRuns.filter((x) => x.length > 0);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((x) => x.length === 120));
});

test("一句里两面墙 East 120 North 144 都要落库（数字后空白不得吞掉下一墙名）", () => {
  const empty: FloorPlan = {
    id: "fp_en",
    conversationId: "c1",
    sourceFile: { name: "chat-geometry.txt", mimeType: "text/plain", sizeBytes: 0 },
    parseConfidence: 0.5,
    parsedGeometry: { wallRuns: [], confidence: 0.5 },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
  const r = applyChatSiteAnswers(empty, "East 120 North 144", AT);
  assert.ok(r);
  const labels = r!.plan.parsedGeometry.wallRuns.map((x) => x.label).sort();
  assert.deepEqual(labels, ["East", "North"]);
});

test("Q# 答窗绑到题面墙：Q3 写 North，不得落到 West", () => {
  const qs = [
    {
      q: 3, id: "sq_window", kind: "window" as const,
      mark: "Window?", prompt: "Q3: windows?",
    },
  ];
  const r = applyChatSiteAnswers(
    plan({ ceiling: 96 }),
    'Q3: North window 36" about 48" from corner',
    AT,
    qs,
  );
  assert.ok(r?.applied.includes("window"));
  const north = r!.plan.parsedGeometry.wallRuns.find((x) => x.id === "wr_n")!;
  const west = r!.plan.parsedGeometry.wallRuns.find((x) => x.id === "wr_w")!;
  assert.ok(north.features.some((f) => f.kind === "window"));
  assert.equal(west.features.some((f) => f.kind === "window"), false);
});

test("「A墙120英寸，B墙96英寸」——字母墙名+中文墙字须落成两段墙（回归：此前无限循环+数据丢失）", () => {
  const empty: FloorPlan = {
    id: "fp_ab",
    conversationId: "c1",
    sourceFile: { name: "chat-geometry.txt", mimeType: "text/plain", sizeBytes: 0 },
    parseConfidence: 0.5,
    parsedGeometry: { wallRuns: [], confidence: 0.5 },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
  const r = applyChatSiteAnswers(
    empty, "A墙120英寸，B墙96英寸，层高108英寸，下水稍后", AT,
  );
  assert.ok(r);
  assert.ok(r!.applied.includes("wallLength"));
  assert.ok(r!.applied.includes("ceiling"));
  const wallA = r!.plan.parsedGeometry.wallRuns.find((x) => /A/i.test(x.label));
  const wallB = r!.plan.parsedGeometry.wallRuns.find((x) => /B/i.test(x.label));
  assert.equal(wallA?.length, 120);
  assert.equal(wallB?.length, 96);
  assert.equal(r!.plan.parsedGeometry.ceilingHeight, 108);
  // 「下水稍后」是明确推迟，不应被当成上下水位置写入
  assert.ok(!r!.applied.includes("plumbing"));
});

test("chatMentionsGeometry 识别「A墙120」（无需层高词也应建壳）", () => {
  assert.ok(chatMentionsGeometry("A墙120，B墙96"));
  assert.ok(chatMentionsGeometry("A墙 120cm"));
  assert.equal(chatMentionsGeometry("这个厨房挺大的"), false);
});

test("口语含糊尺寸「North about 7 ft」不应因中间插入词而解析失败（回归：beginner 人设死循环）", () => {
  const empty: FloorPlan = {
    id: "fp_hedge",
    conversationId: "c1",
    sourceFile: { name: "chat-geometry.txt", mimeType: "text/plain", sizeBytes: 0 },
    parseConfidence: 0.5,
    parsedGeometry: { wallRuns: [], confidence: 0.5 },
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
  const r = applyChatSiteAnswers(
    empty, "Um… maybe North about 7 ft, ceiling around 8 ft", AT,
  );
  assert.ok(r, "含糊口语也应落成墙长/层高，而不是原样重复同一句提示");
  assert.ok(r!.applied.includes("wallLength"));
  assert.ok(r!.applied.includes("ceiling"));
  const north = r!.plan.parsedGeometry.wallRuns.find((x) => /north/i.test(x.label));
  assert.equal(north?.length, 84); // 7 ft
  assert.equal(r!.plan.parsedGeometry.ceilingHeight, 96); // 8 ft
});
