/**
 * 连通的厨房平面 —— 墙角、门洞台面外伸、岛台。
 *
 * 触发这一轮的是客户的一段话：「全局视图要把几个墙围起来、连起来，不能像四个
 * 单独的视图那样，把南墙、北墙、东墙分开写。只有把它们连起来的时候，才会发现
 * 开关门的问题、干涉的问题，以及一些边角柜等细节。另外，如果涉及到门洞等边缘，
 * 橱柜靠近门的位置要把台面伸出来的宽度计算进去……同时，全局图还要考虑有岛台的情况。」
 *
 * 所以这一组测试断言的不是"能画出来"，而是**连起来之后那些原本看不见的事**：
 * 两段墙在墙角不占同一块地方、门洞旁真的让出了台面外伸、岛台的过道够人走。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildKitchenPlan, usableSpan, footprint, overlaps, toPlane, depthOf,
  doorSpan, hasContinuousCounter, COUNTERTOP, DOOR_CLEARANCE, CORNER, AISLE,
} from "../src/layout/plan-model.js";
import { generateLayout } from "../src/layout/generate.js";
import { auditDeliverable } from "../src/delivery/audit.js";
import { addWallRun, createFloorPlan } from "../src/floorplan/parse.js";
import { pilotModules } from "../src/app/seed.js";
import { applianceFrom } from "../src/floorplan/appliances.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";
import type { Placement } from "../src/layout/generate.js";

const appliances = [
  applianceFrom({ kind: "refrigerator", width: 33 }),
  applianceFrom({ kind: "range", width: 30 }),
];

function wall(id: string, label: string, length: number, opts: Partial<WallRun> = {}): WallRun {
  return {
    id, label, length, startsAtCorner: false, endsAtCorner: false, features: [], ...opts,
  };
}

/** U 型：三面等长的墙，两个内墙角。 */
const uShaped: ParsedGeometry = {
  wallRuns: [
    wall("w1", "西墙", 132, {
      endsAtCorner: true,
      features: [{ id: "f1", kind: "electrical", offset: 0, width: 36 }],
    }),
    wall("w2", "北墙", 132, {
      startsAtCorner: true, endsAtCorner: true,
      features: [
        { id: "f2", kind: "window", offset: 48, width: 36 },
        { id: "f3", kind: "plumbing", offset: 54, width: 24 },
      ],
    }),
    wall("w3", "东墙", 132, { startsAtCorner: true }),
  ],
  ceilingHeight: 96, confidence: 1,
};

const uLayout = generateLayout(uShaped, pilotModules, { ceilingHeight: 96, appliances });

// ── 连起来 ────────────────────────────────────────────────────────────────

test("相接的墙段串成一个真正的平面，不是三条各自独立的横条", () => {
  const plan = buildKitchenPlan(uShaped);
  assert.equal(plan.connected, true);
  assert.equal(plan.note, undefined, "拼得起来就不该出「示意排列」的提示");
  // 每转一次弯走向要变——三段同向说明根本没转
  assert.deepEqual(plan.runs.map((r) => r.heading), [0, 90, 180]);
});

test("拼不上的墙段如实标注为示意排列，不假装知道方位", () => {
  const loose: ParsedGeometry = {
    wallRuns: [wall("a", "南墙", 120), wall("b", "北墙", 120)],
    confidence: 1,
  };
  const plan = buildKitchenPlan(loose);
  assert.equal(plan.connected, false);
  assert.match(plan.note ?? "", /schematic|示意排列/i);
});

// ── 墙角 ─────────────────────────────────────────────────────────────────

test("内墙角：长的那一段拥有墙角，短的那一段让出「转角方块 + 转角填缝条」", () => {
  const lShaped: ParsedGeometry = {
    wallRuns: [
      wall("long", "北墙", 156, { endsAtCorner: true }),
      wall("short", "东墙", 102, { startsAtCorner: true }),
    ],
    confidence: 1,
  };
  const plan = buildKitchenPlan(lShaped);
  assert.equal(plan.corners.length, 1);
  assert.equal(plan.corners[0]!.ownerRunId, "long");
  assert.equal(plan.corners[0]!.yieldingRunId, "short");

  const short = plan.runs.find((r) => r.run.id === "short")!;
  // 各层同一个值：转角吊柜在平面上也是 24"×24"，冰箱上柜同样 24" 深，
  // 吊柜层按 12" 让位会让两面墙的上柜叠在一起
  assert.equal(usableSpan(short, "base").start, CORNER.square + CORNER.filler);
  assert.equal(usableSpan(short, "wall").start, CORNER.square + CORNER.filler);

  const long = plan.runs.find((r) => r.run.id === "long")!;
  assert.equal(usableSpan(long, "base").start, 0, "拥有墙角的一段不让位");
});

test("U 型的中间段两头都要让位——一头一个墙角", () => {
  const plan = buildKitchenPlan({
    wallRuns: [
      wall("a", "西墙", 144, { endsAtCorner: true }),
      wall("b", "北墙", 108, { startsAtCorner: true, endsAtCorner: true }),
      wall("c", "东墙", 144, { startsAtCorner: true }),
    ],
    confidence: 1,
  });
  const mid = plan.runs.find((r) => r.run.id === "b")!;
  const span = usableSpan(mid, "base");
  assert.equal(span.start, 27);
  assert.equal(span.end, 108 - 27);
});

test("墙角处两段墙的柜子不再占同一块地方", () => {
  const plan = buildKitchenPlan(uShaped);
  const byId = new Map(plan.runs.map((rp) => [rp.run.id, rp]));
  const boxes = uLayout.placements
    .filter((p) => p.layer === "base")
    .map((p) => {
      const rp = byId.get(p.wallRunId)!;
      return { p, box: footprint(rp, p.x, p.width, p.depth || depthOf(rp, "base")) };
    });

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.p.wallRunId === b.p.wallRunId) continue;
      assert.equal(overlaps(a.box, b.box), false,
        `${a.p.wallRunId} 的 ${a.p.moduleCode ?? a.p.label} 与 ` +
        `${b.p.wallRunId} 的 ${b.p.moduleCode ?? b.p.label} 在墙角撞上了`);
    }
  }
});

test("转角柜真的被排进去了——目录里有 corner 型号却一个也用不上是改造前的状态", () => {
  const corners = uLayout.placements.filter((p) => p.label === "corner");
  assert.ok(corners.length > 0, "两个内墙角，一个转角柜都没排");
  for (const c of corners) {
    assert.ok(c.moduleCode, "转角柜必须指向规格库里真实存在的型号");
  }
});

test("交付前审核查得出跨墙段干涉——单段墙内的重叠检查看不见墙角", () => {
  // 手工把东墙的柜子推回墙角，模拟"没有让位"的排布
  const broken: Placement[] = uLayout.placements.map((p) =>
    p.wallRunId === "w3" && p.layer === "base" ? { ...p, x: p.x - 27 } : p);
  const report = auditDeliverable({
    deliverable: "planView", stage: "planReview",
    layout: { ...uLayout, placements: broken },
    wallRuns: uShaped.wallRuns,
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockers.some((f) => f.code === "INTERFERENCE"),
    `跨墙段干涉没被拦住：${report.blockers.map((f) => f.code).join("、")}`);
});

test("原样的排布过得了跨墙段干涉这一关", () => {
  const report = auditDeliverable({
    deliverable: "planView", stage: "planReview",
    layout: uLayout, wallRuns: uShaped.wallRuns,
  });
  assert.equal(report.blockers.some((f) => f.code === "INTERFERENCE"), false,
    report.blockers.map((f) => f.message).join(" / "));
  assert.ok(report.checked.includes("INTERFERENCE"), "「没查」和「查过没问题」不是一回事");
});

// ── 门洞与台面外伸 ────────────────────────────────────────────────────────

test("门洞两侧让出台面端头外伸 + 门套线，吊柜层只让门套线", () => {
  const f = { id: "d", kind: "door" as const, offset: 96, width: 32 };
  const base = doorSpan(f, "base");
  assert.equal(base.x, 96 - DOOR_CLEARANCE.base);
  assert.equal(base.width, 32 + DOOR_CLEARANCE.base * 2);
  assert.equal(DOOR_CLEARANCE.base, COUNTERTOP.endOverhang + DOOR_CLEARANCE.casing);

  const wallLayer = doorSpan(f, "wall");
  assert.ok(wallLayer.width < base.width, "吊柜没有台面，不该让得比地柜还多");
});

test("门洞旁的柜子真的退开了——台面外沿不压到门洞上", () => {
  const geometry: ParsedGeometry = {
    wallRuns: [wall("w", "南墙", 216, {
      features: [
        { id: "d", kind: "door", offset: 96, width: 32 },
        { id: "p", kind: "plumbing", offset: 30, width: 24 },
      ],
    })],
    ceilingHeight: 96, confidence: 1,
  };
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96, appliances });
  const doorStart = 96;
  const doorEnd = 96 + 32;

  for (const p of layout.placements.filter((q) => q.layer === "base" && q.kind !== "appliance")) {
    // 台面比柜体两端各多伸 1-1/2"，判的是台面而不是柜体
    const left = p.x - COUNTERTOP.endOverhang;
    const right = p.x + p.width + COUNTERTOP.endOverhang;
    assert.ok(right <= doorStart || left >= doorEnd,
      `${p.moduleCode ?? p.label} 的台面（${left}"–${right}"）伸进了门洞 ${doorStart}"–${doorEnd}"`);
  }
});

// ── 岛台 ─────────────────────────────────────────────────────────────────

const withIsland: ParsedGeometry = {
  wallRuns: [
    wall("n", "北墙", 168, {
      endsAtCorner: true,
      features: [
        { id: "w", kind: "window", offset: 72, width: 36 },
        { id: "p", kind: "plumbing", offset: 78, width: 24 },
      ],
    }),
    wall("e", "西墙", 120, {
      startsAtCorner: true,
      features: [{ id: "g", kind: "gas", offset: 60, width: 30 }],
    }),
    wall("i", "岛台", 84, { kind: "island", depth: 25 }),
  ],
  ceilingHeight: 96, confidence: 1,
};

test("岛台落在围合区里，且与每一面墙都留够工作过道", () => {
  const layout = generateLayout(withIsland, pilotModules, { ceilingHeight: 96, appliances });
  const narrow = layout.ergonomics.filter((v) => v.code === "AISLE_TOO_NARROW");
  assert.deepEqual(narrow, [], narrow.map((v) => v.message).join(" / "));
});

test("岛台太大就阻断，不是悄悄挪一挪当没事", () => {
  const tooBig: ParsedGeometry = {
    ...withIsland,
    wallRuns: withIsland.wallRuns.map((r) =>
      r.id === "i" ? { ...r, length: 84, depth: 72 } : r),
  };
  const layout = generateLayout(tooBig, pilotModules, { ceilingHeight: 96, appliances });
  const blocking = layout.ergonomics.filter(
    (v) => v.code === "AISLE_TOO_NARROW" && v.severity === "blocking");
  assert.ok(blocking.length > 0, "72 寸深的岛台把过道挤到走不通了，应该阻断");
  assert.match(blocking[0]!.message, new RegExp(String(AISLE.walkway)));
});

test("岛台没有吊柜层——它头顶上没有墙", () => {
  const layout = generateLayout(withIsland, pilotModules, { ceilingHeight: 96, appliances });
  const onIsland = layout.placements.filter((p) => p.wallRunId === "i");
  assert.ok(onIsland.length > 0, "岛台上一个柜子都没排");
  assert.equal(onIsland.some((p) => p.layer === "wall"), false);
});

test("岛台不接墙角——它四周都是过道", () => {
  const plan = buildKitchenPlan(withIsland);
  const island = plan.runs.find((r) => r.run.id === "i")!;
  assert.equal(island.island, true);
  assert.equal(usableSpan(island, "base").start, 0);
  assert.equal(plan.corners.some((c) => c.yieldingRunId === "i" || c.ownerRunId === "i"), false);
});

// ── 台面连续性只有一份判断 ────────────────────────────────────────────────

test("洗碗机上面的台面是连着的，冰箱上面不是", () => {
  assert.equal(hasContinuousCounter(
    { kind: "appliance", layer: "base", height: 34.5, applianceKind: "dishwasher" }), true);
  assert.equal(hasContinuousCounter(
    { kind: "appliance", layer: "base", height: 34.5, applianceKind: "refrigerator" }), false);
  assert.equal(hasContinuousCounter(
    { kind: "cabinet", layer: "base", height: 34.5 }), true);
  assert.equal(hasContinuousCounter(
    { kind: "cabinet", layer: "wall", height: 30 }), false);
});

// ── 手工录入的墙段默认相接 ────────────────────────────────────────────────

test("一段一段报进来的墙默认首尾相接——报的是一圈墙，不是三面孤墙", async () => {
  let plan = await createFloorPlan(
    {
      conversationId: "c1", at: "2026-01-01T00:00:00.000Z",
      file: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    },
    undefined, undefined,
  );
  for (const [label, length] of [["西墙", 132], ["北墙", 132], ["东墙", 132]] as const) {
    plan = addWallRun(plan, { label, length }, "2026-01-01T00:00:00.000Z");
  }
  const runs = plan.parsedGeometry.wallRuns;
  assert.deepEqual(runs.map((r) => r.startsAtCorner), [false, true, true]);
  assert.deepEqual(runs.map((r) => r.endsAtCorner), [true, true, false]);
  assert.equal(buildKitchenPlan(plan.parsedGeometry).connected, true,
    "默认值不对的话，U 型厨房在全局俯视图上就是三条各自独立的横条");
});

test("岛台加进来不接任何墙", async () => {
  let plan = await createFloorPlan(
    {
      conversationId: "c2", at: "2026-01-01T00:00:00.000Z",
      file: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    },
    undefined, undefined,
  );
  plan = addWallRun(plan, { label: "北墙", length: 168 }, "2026-01-01T00:00:00.000Z");
  plan = addWallRun(plan, { label: "岛台", length: 84, kind: "island", depth: 25 },
    "2026-01-01T00:00:00.000Z");
  const island = plan.parsedGeometry.wallRuns[1]!;
  assert.equal(island.kind, "island");
  assert.equal(island.startsAtCorner, false);
  assert.equal(plan.parsedGeometry.wallRuns[0]!.endsAtCorner, false,
    "岛台不该把上一段墙的末端标成墙角");
});

// ── 世界坐标 ─────────────────────────────────────────────────────────────

test("段内坐标换到世界坐标：室内在走向的右手侧", () => {
  const plan = buildKitchenPlan(uShaped);
  const west = plan.runs[0]!; // heading 0，向右走
  // 沿走向 10"、往室内 24"
  assert.deepEqual(toPlane(west, 10, 24), { x: 10, y: 24 });
  const north = plan.runs[1]!; // heading 90，向下走
  assert.deepEqual(toPlane(north, 10, 24), { x: 132 - 24, y: 10 });
});
