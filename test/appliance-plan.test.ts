/**
 * 家电落位 —— FR-4.6、APPLIANCES.md §3.2 / §5。
 *
 * 核心断言：**家电落位是全局决定，且硬约束在落位阶段就参与。**
 * 只在事后打分的话，排布器会把灶台顶到墙角，然后自己判自己不合格——
 * 那是"用检查器代替设计"，它能告诉你方案不合格，却永远给不出合格的方案。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planAppliances } from "../src/layout/appliance-plan.js";
import { generateLayout } from "../src/layout/generate.js";
import { applianceFrom, type ApplianceKind } from "../src/floorplan/appliances.js";
import { pilotModules } from "../src/app/seed.js";
import type { ParsedGeometry, WallFeature, WallRun } from "../src/floorplan/types.js";

const appl = (kind: ApplianceKind, over: { width?: number; preferredZone?: "nearEntry" | "nearSink" | "nearWindow" | "any" } = {}) =>
  applianceFrom({ kind, ...over });

function wall(over: Partial<WallRun> & { id: string }): WallRun {
  return {
    label: over.label ?? over.id, length: 144,
    startsAtCorner: false, endsAtCorner: false, features: [],
    ...over,
  };
}
const geo = (...runs: WallRun[]): ParsedGeometry =>
  ({ wallRuns: runs, ceilingHeight: 96, confidence: 1 });

const feat = (id: string, kind: WallFeature["kind"], offset: number, width: number): WallFeature =>
  ({ id, kind, offset, width });

// ── 落位优先级 ────────────────────────────────────────────────────────────

test("有燃气口时灶具按现场管线落位——现场事实压过一切偏好", () => {
  const w = wall({ id: "a", features: [feat("g", "gas", 60, 0)] });
  const plan = planAppliances(geo(w), [appl("range", { preferredZone: "nearEntry" })]);
  const range = plan.placed.find((p) => p.spec.kind === "range");
  assert.ok(range);
  assert.ok(Math.abs(range.x + range.width / 2 - 60) <= 3, `灶应在燃气口附近，实际 ${range.x}`);
  assert.ok(range.reason.includes("gas"), range.reason);
});

test("没有对应特征时也要放——没有哪家厨房是没冰箱的", () => {
  // 改造前：没有强电特征就 `continue`，整套厨房一个冰箱位都没有
  const plan = planAppliances(geo(wall({ id: "a" })), [appl("refrigerator")]);
  assert.equal(plan.placed.length, 1);
});

test("客户说的位置偏好被采纳，且在 reason 里说得出来", () => {
  const w = wall({ id: "a", length: 180, features: [feat("p", "plumbing", 90, 0)] });
  const plan = planAppliances(geo(w), [appl("refrigerator", { preferredZone: "nearEntry" })]);
  assert.ok(/near entry/i.test(plan.placed[0]!.reason), plan.placed[0]!.reason);
  const zh = planAppliances(geo(w), [appl("refrigerator", { preferredZone: "nearEntry" })], "zh");
  assert.ok(zh.placed[0]!.reason.includes("靠近入口"), zh.placed[0]!.reason);
});

// ── 硬约束在落位阶段参与 ──────────────────────────────────────────────────

test("灶具不会被顶到墙角——两侧落台区在落位时就要留出来", () => {
  const plan = planAppliances(geo(wall({ id: "a", length: 144 })), [appl("range")]);
  const range = plan.placed.find((p) => p.spec.kind === "range")!;
  const left = range.x;
  const right = 144 - (range.x + range.width);
  const [big, small] = left >= right ? [left, right] : [right, left];
  assert.ok(big >= 15 && small >= 12, `落台区 ${left}/${right} 不满足 NKBA`);
});

test("门洞会打断台面，落台区不能跨过它去借对面的地方", () => {
  // 门洞 96–128；灶如果落在 129，左侧只有 1"，但到墙尽头还有 129"
  const w = wall({ id: "a", length: 216, features: [feat("d", "door", 96, 32)] });
  const plan = planAppliances(geo(w), [appl("range")]);
  const range = plan.placed.find((p) => p.spec.kind === "range");
  if (range) {
    const nearDoorRight = range.x - 128;
    assert.ok(
      range.x + range.width <= 96 || nearDoorRight >= 12,
      `灶落在 ${range.x}，紧贴门洞右侧只有 ${nearDoorRight}" 台面`,
    );
  }
});

test("上下水那一段连同两侧台面一起留给水槽，家电不能占", () => {
  const w = wall({ id: "a", length: 144, features: [feat("p", "plumbing", 72, 24)] });
  const plan = planAppliances(geo(w), [appl("refrigerator")]);
  const fridge = plan.placed.find((p) => p.spec.kind === "refrigerator");
  if (fridge) {
    // 水槽柜 36 + 两侧 24/18 —— 冰箱不该压进这一块
    assert.ok(fridge.x >= 108 || fridge.x + fridge.width <= 36,
      `冰箱落在 ${fridge.x}，压到了留给水槽的区域`);
  }
});

test("放不下就如实报出来，不静默丢掉", () => {
  const plan = planAppliances(geo(wall({ id: "a", length: 30 })), [appl("refrigerator")]);
  assert.equal(plan.placed.length, 0);
  assert.equal(plan.warnings.length, 1);
  assert.ok(/Refrigerator/i.test(plan.warnings[0]!.message), plan.warnings[0]!.message);
});

// ── 跨层：烟机跟着灶台 ────────────────────────────────────────────────────

test("抽油烟机落在吊柜层，正对灶台", () => {
  const w = wall({ id: "a", length: 144, features: [feat("g", "gas", 72, 0)] });
  const plan = planAppliances(geo(w), [appl("range"), appl("rangeHood")]);
  const range = plan.placed.find((p) => p.spec.kind === "range")!;
  const hood = plan.placed.find((p) => p.spec.kind === "rangeHood")!;
  assert.equal(hood.layer, "wall", "烟机在吊柜层");
  assert.equal(range.layer, "base");
  const dx = Math.abs((hood.x + hood.width / 2) - (range.x + range.width / 2));
  assert.ok(dx <= 1, `烟机应与灶台同中心，偏了 ${dx}"`);
});

test("有烟机却没排出灶台时如实报出，不静默把烟机丢掉", () => {
  const plan = planAppliances(geo(wall({ id: "a", length: 144 })), [appl("rangeHood")]);
  assert.equal(plan.placed.length, 0);
  assert.ok(plan.warnings.some((w) => w.kind === "rangeHood"));
});

test("烟机进入吊柜层的 placements——改造前吊柜层根本不知道灶在哪", () => {
  const w = wall({ id: "a", length: 144, features: [feat("g", "gas", 72, 0)] });
  const layout = generateLayout(geo(w), pilotModules, {
    ceilingHeight: 96, appliances: [appl("range"), appl("rangeHood")],
  });
  const hood = layout.placements.find(
    (p) => p.layer === "wall" && p.applianceKind === "rangeHood");
  assert.ok(hood, "烟机必须出现在吊柜层");
});

// ── 尺寸真的按客户给的算 ──────────────────────────────────────────────────

test("留空按客户的尺寸 + 通风间隙，不是写死的 36 寸", () => {
  const layout = generateLayout(geo(wall({ id: "a", length: 180 })), pilotModules, {
    ceilingHeight: 96, appliances: [appl("refrigerator", { width: 30 })],
  });
  const fridge = layout.placements.find((p) => p.applianceKind === "refrigerator");
  assert.ok(fridge);
  assert.equal(fridge.width, 32, "30 寸机身 + 两侧各 1 寸通风");
});

test("图上的家电标签带宽度——客户要能一眼看出这是几寸的冰箱位", () => {
  const layout = generateLayout(geo(wall({ id: "a", length: 180 })), pilotModules, {
    ceilingHeight: 96, appliances: [appl("refrigerator", { width: 33 })],
  });
  const fridge = layout.placements.find((p) => p.applianceKind === "refrigerator")!;
  assert.ok(fridge.label?.includes("Refrigerator"), fridge.label);
  assert.ok(fridge.label?.includes("33"), fridge.label);
  assert.equal(fridge.applianceSpec?.provenance, "customer");
});

test("推定值一路带到 placement 上，渲染与解释都读得到", () => {
  const layout = generateLayout(geo(wall({ id: "a", length: 180 })), pilotModules, {
    ceilingHeight: 96, appliances: [appl("refrigerator")],
  });
  const fridge = layout.placements.find((p) => p.applianceKind === "refrigerator")!;
  assert.equal(fridge.applianceSpec?.provenance, "assumed");
});
