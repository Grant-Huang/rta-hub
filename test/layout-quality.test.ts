/**
 * 排布质量：人体工程硬约束 + 美观软约束 + 功能性选型。
 *
 * 这组测试的存在理由：早期目标函数只有「填得满、柜子少」，会主动产出
 * 便宜但难用、难看的方案。把这三类要求分开测，才能保证它们不会在
 * 后续改动里被"优化"掉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { packSegment } from "../src/layout/pack.js";
import {
  AESTHETIC_WEIGHTS, NARROW_THRESHOLD, compareCandidates, scoreAesthetics,
} from "../src/layout/aesthetics.js";
import {
  CLEARANCE, checkErgonomics, checkWorkTriangle, hasBlockingViolation,
} from "../src/layout/ergonomics.js";
import { generateLayout, regenerateRun, HEIGHTS, type Placement } from "../src/layout/generate.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";
import { pilotModules } from "../src/app/seed.js";

const WIDTHS = [9, 12, 15, 18, 21, 24, 27, 30, 33, 36].map((w) => ({ width: w }));

// ── 目标函数：节奏与窄柜 ──────────────────────────────────────────────────

test("不再为了「柜子最少」而塞窄柜", () => {
  // 78" 用旧目标会得到 36+33+9 —— 9" 柜储物几乎没用、单位造价最高、还最扎眼
  const legacy = packSegment(78, WIDTHS, { rhythmWeight: 0, narrowWeight: 0 });
  assert.ok(legacy.widths.some((w) => w < NARROW_THRESHOLD), "旧目标确实会塞窄柜");

  const improved = packSegment(78, WIDTHS);
  assert.equal(improved.leftover, 0, "填充度不应退步");
  assert.ok(
    improved.widths.every((w) => w >= NARROW_THRESHOLD),
    `新目标不该出现窄柜，实得 [${improved.widths.join(", ")}]`,
  );
});

test("同等填充度下选宽度更均匀的组合", () => {
  const r = packSegment(87, WIDTHS);
  assert.equal(r.leftover, 0);
  const spread = Math.max(...r.widths) - Math.min(...r.widths);
  const legacy = packSegment(87, WIDTHS, { rhythmWeight: 0, narrowWeight: 0 });
  const legacySpread = Math.max(...legacy.widths) - Math.min(...legacy.widths);
  assert.ok(spread < legacySpread, `新目标的宽度跨度应更小（${spread} vs ${legacySpread}）`);
});

test("填充度仍然是第一优先级，不会为了好看而浪费空间", () => {
  for (const L of [72, 78, 87, 93, 105, 120, 141]) {
    const r = packSegment(L, WIDTHS);
    assert.equal(r.leftover, 0, `${L}" 应能填满`);
  }
});

test("功能性窄柜是打折不是免罚 —— 一个可以，一排不行", () => {
  const withFunctional = packSegment(45, [
    { width: 36 }, { width: 9, functionalNarrow: true },
  ]);
  const withoutFlag = packSegment(45, [{ width: 36 }, { width: 9 }]);

  // 打折：功能性窄柜的代价明显低于普通窄柜
  assert.ok(withFunctional.cost.narrow < withoutFlag.cost.narrow);
  assert.ok(withFunctional.cost.narrow > 0, "但不能归零，否则会被当成填充手段");

  // 关键行为：不会排出一整排 9" 拉篮柜
  assert.deepEqual(withFunctional.widths.sort((a, b) => b - a), [36, 9],
    `实得 [${withFunctional.widths.join(", ")}]`);
});

test("免罚会导致一整排窄柜 —— 这正是要避免的", () => {
  // 把折扣调到 0（模拟"完全免罚"）就会出现 5 个 9" 柜
  const spammed = packSegment(45, [
    { width: 36 }, { width: 9, functionalNarrow: true },
  ], { narrowWeight: 0 });
  assert.ok(spammed.widths.length > 2, "完全不罚时装箱确实会拿窄柜填满");
});

test("代价明细可解释，便于说明为什么这么排", () => {
  const r = packSegment(93, WIDTHS);
  assert.ok(r.cost.total >= 0);
  assert.equal(r.cost.narrow, 0);
  assert.ok(r.cost.count > 0);
});

test("柜缝对齐奖励确实影响结果", () => {
  // 让首个柜缝落在 30"
  const aligned = packSegment(90, WIDTHS, { preferredSeams: [30, 60], seamWeight: 20 });
  assert.equal(aligned.widths[0], 30, `实得 [${aligned.widths.join(", ")}]`);
  assert.ok(aligned.cost.seam < 0, "命中对齐点应产生负代价（奖励）");
});

// ── 美观评分 ──────────────────────────────────────────────────────────────

const run = (over: Partial<WallRun> = {}): WallRun => ({
  id: "wr_1", label: "北墙", length: 144, startsAtCorner: false, endsAtCorner: true,
  features: [], ...over,
});

const cab = (x: number, width: number, over: Partial<Placement> = {}): Placement => ({
  kind: "cabinet", layer: "base", wallRunId: "wr_1", x, width,
  height: HEIGHTS.baseBox, depth: 24, moduleCode: `B${width}`, ...over,
});

test("宽度均匀得高分，跳动得低分", () => {
  const even = scoreAesthetics({
    run: run(), placements: [cab(0, 36), cab(36, 36), cab(72, 36), cab(108, 36)],
  });
  const jumpy = scoreAesthetics({
    run: run(), placements: [cab(0, 36), cab(36, 9), cab(45, 30), cab(75, 12), cab(87, 33)],
  });
  assert.ok(even.breakdown.widthRhythm > jumpy.breakdown.widthRhythm);
  assert.ok(even.total > jumpy.total, `均匀 ${even.total} 应高于跳动 ${jumpy.total}`);
});

test("凑数的窄柜被扣分，有功能的不扣", () => {
  const padded = scoreAesthetics({
    run: run(), placements: [cab(0, 36), cab(36, 9), cab(45, 36)],
  });
  assert.ok(padded.breakdown.narrowPenalty < 1);
  assert.ok(padded.notes.some((n) => n.includes("窄柜")));

  const functional = scoreAesthetics({
    run: run(), placements: [cab(0, 36), cab(36, 9, { moduleCode: "BPO09" }), cab(45, 36)],
  });
  assert.equal(functional.breakdown.narrowPenalty, 1, "BPO 拉篮柜有功能理由，不该扣分");
});

test("填缝条在墙角得满分，在中间被扣分", () => {
  const atEdge = scoreAesthetics({
    run: run({ length: 75 }),
    placements: [
      { ...cab(0, 3), kind: "filler" },
      cab(3, 36), cab(39, 36),
    ],
  });
  assert.equal(atEdge.breakdown.fillerPlacement, 1);

  const inMiddle = scoreAesthetics({
    run: run({ length: 75 }),
    placements: [cab(0, 36), { ...cab(36, 3), kind: "filler" }, cab(39, 36)],
  });
  assert.equal(inMiddle.breakdown.fillerPlacement, 0);
  assert.ok(inMiddle.notes.some((n) => n.includes("打断门缝节奏")));
});

test("吊柜与地柜柜缝对齐得高分", () => {
  const baseRow = [cab(0, 36), cab(36, 36), cab(72, 36)];
  const aligned = scoreAesthetics({
    run: run(), placements: [
      ...baseRow,
      cab(0, 36, { layer: "wall" }), cab(36, 36, { layer: "wall" }), cab(72, 36, { layer: "wall" }),
    ],
  });
  const misaligned = scoreAesthetics({
    run: run(), placements: [
      ...baseRow,
      cab(0, 30, { layer: "wall" }), cab(30, 30, { layer: "wall" }), cab(60, 48, { layer: "wall" }),
    ],
  });
  assert.equal(aligned.breakdown.seamAlignment, 1);
  assert.ok(misaligned.breakdown.seamAlignment < 1);
});

test("水槽应对齐窗中心，偏了扣分", () => {
  const windowed = run({ features: [{ id: "f", kind: "window", offset: 48, width: 36 }] });
  const centered = scoreAesthetics({
    run: windowed, placements: [cab(51, 30, { moduleCode: "SB30" })], // 中心 66 = 窗中心 66
  });
  const offset = scoreAesthetics({
    run: windowed, placements: [cab(0, 30, { moduleCode: "SB30" })],  // 中心 15
  });
  assert.equal(centered.breakdown.symmetry, 1);
  assert.ok(offset.breakdown.symmetry < 1);
  assert.ok(offset.notes.some((n) => n.includes("偏离窗中心")));
});

test("没有对称参照物时不强求对称", () => {
  const s = scoreAesthetics({ run: run(), placements: [cab(0, 36), cab(36, 30)] });
  assert.equal(s.breakdown.symmetry, 1, "一字型厨房强求对称没有意义");
});

test("候选排序：剩余优先，其次美观，最后柜数", () => {
  // 剩余差得多 → 剩余小的胜出
  assert.ok(compareCandidates(
    { leftover: 0, aesthetic: 10, cabinetCount: 9 },
    { leftover: 4, aesthetic: 99, cabinetCount: 3 },
  ) < 0);
  // 剩余相近 → 美观高的胜出（即使柜子多）
  assert.ok(compareCandidates(
    { leftover: 0, aesthetic: 90, cabinetCount: 5 },
    { leftover: 0.25, aesthetic: 40, cabinetCount: 3 },
  ) < 0);
  // 美观相同 → 柜子少的胜出
  assert.ok(compareCandidates(
    { leftover: 0, aesthetic: 80, cabinetCount: 3 },
    { leftover: 0, aesthetic: 80, cabinetCount: 5 },
  ) < 0);
});

test("权重的相对大小体现优先级", () => {
  assert.ok(AESTHETIC_WEIGHTS.widthRhythm > AESTHETIC_WEIGHTS.seamAlignment);
  assert.ok(AESTHETIC_WEIGHTS.fillerPlacement > AESTHETIC_WEIGHTS.symmetry);
});

// ── 人体工程硬约束 ────────────────────────────────────────────────────────

const appliance = (x: number, width: number, kind: "range" | "refrigerator" | "dishwasher"): Placement => ({
  kind: "appliance", layer: "base", wallRunId: "wr_1", x, width,
  height: HEIGHTS.baseBox, depth: 24, applianceKind: kind,
});

test("灶具两侧落台区不足 → blocking（安全要求）", () => {
  // 灶具紧贴墙角，左侧 0"
  const v = checkErgonomics({
    run: run({ length: 120 }),
    placements: [appliance(0, 30, "range"), cab(30, 36), cab(66, 36)],
  });
  const hit = v.find((x) => x.code === "COOKTOP_LANDING");
  assert.ok(hit, "灶具一侧没有落台区应被拦下");
  assert.equal(hit.severity, "blocking");
  assert.match(hit.message, /热锅/);
  assert.equal(hasBlockingViolation(v), true);
});

test("灶具两侧落台区充足 → 通过", () => {
  const v = checkErgonomics({
    run: run({ length: 120 }),
    placements: [cab(0, 24), appliance(24, 30, "range"), cab(54, 36)],
  });
  assert.ok(!v.some((x) => x.code === "COOKTOP_LANDING"));
});

test("水槽两侧工作区不足 → blocking", () => {
  const v = checkErgonomics({
    run: run({ length: 60 }),
    placements: [cab(0, 30, { moduleCode: "SB30", label: "sink" }), cab(30, 12)],
  });
  const hit = v.find((x) => x.code === "SINK_LANDING");
  assert.ok(hit);
  assert.equal(hit.severity, "blocking");
  assert.match(hit.message, new RegExp(String(CLEARANCE.sinkLandingPrimary)));
});

test("冰箱旁没有落台区 → blocking", () => {
  const v = checkErgonomics({
    run: run({ length: 48 }),
    placements: [appliance(0, 36, "refrigerator"), cab(36, 12)],
  });
  const hit = v.find((x) => x.code === "REFRIGERATOR_LANDING");
  assert.ok(hit);
  assert.equal(hit.severity, "blocking");
});

test("洗碗机离水槽太远 → blocking", () => {
  const v = checkErgonomics({
    run: run({ length: 200 }),
    placements: [
      cab(0, 33, { moduleCode: "SB33", label: "sink" }),
      cab(33, 36), cab(69, 36),
      appliance(105, 24, "dishwasher"),
      cab(129, 36),
    ],
    hasDishwasher: true,
  });
  const hit = v.find((x) => x.code === "DISHWASHER_TOO_FAR");
  assert.ok(hit, `应检出洗碗机过远，实得 ${JSON.stringify(v.map((x) => x.code))}`);
  assert.equal(hit.severity, "blocking");
});

test("洗碗机紧邻水槽 → 通过", () => {
  const v = checkErgonomics({
    run: run({ length: 200 }),
    placements: [
      cab(0, 24), appliance(24, 24, "dishwasher"),
      cab(48, 33, { moduleCode: "SB33", label: "sink" }),
      cab(81, 36), cab(117, 36),
    ],
    hasDishwasher: true,
  });
  assert.ok(!v.some((x) => x.code === "DISHWASHER_TOO_FAR"));
});

test("盲角柜给出可达性提醒（advisory，不否决）", () => {
  const v = checkErgonomics({
    run: run(), placements: [cab(0, 36, { moduleCode: "BBC36" }), cab(36, 36), cab(72, 36)],
  });
  const hit = v.find((x) => x.code === "UNREACHABLE_BLIND_CORNER");
  assert.ok(hit);
  assert.equal(hit.severity, "advisory");
  assert.match(hit.message, /拉篮|转角柜/);
});

test("工作三角：三点不全时不判定", () => {
  assert.deepEqual(checkWorkTriangle([{ kind: "sink", x: 0, y: 0 }]), []);
});

test("工作三角过长/过短给出提醒", () => {
  const tooFar = checkWorkTriangle([
    { kind: "sink", x: 0, y: 0 },
    { kind: "cooktop", x: 200, y: 0 },
    { kind: "refrigerator", x: 0, y: 200 },
  ]);
  assert.ok(tooFar.some((v) => v.code === "WORK_TRIANGLE"));

  const tooClose = checkWorkTriangle([
    { kind: "sink", x: 0, y: 0 },
    { kind: "cooktop", x: 20, y: 0 },
    { kind: "refrigerator", x: 0, y: 20 },
  ]);
  assert.ok(tooClose.some((v) => v.code === "WORK_TRIANGLE"));

  const good = checkWorkTriangle([
    { kind: "sink", x: 0, y: 0 },
    { kind: "cooktop", x: 72, y: 0 },
    { kind: "refrigerator", x: 0, y: 72 },
  ]);
  assert.equal(good.length, 0);
});

test("硬约束与软约束是不同维度：advisory 不阻止出图", () => {
  const advisoryOnly = checkErgonomics({
    run: run(), placements: [cab(0, 36, { moduleCode: "BBC36" }), cab(36, 36), cab(72, 36)],
  });
  assert.equal(hasBlockingViolation(advisoryOnly), false);
});

// ── 端到端：生成的方案带评分与检查结果 ────────────────────────────────────

const kitchen: ParsedGeometry = {
  wallRuns: [{
    id: "wr_k", label: "北墙", length: 168, startsAtCorner: false, endsAtCorner: true,
    features: [
      { id: "f1", kind: "window", offset: 60, width: 36, sillHeight: 42 },
      { id: "f2", kind: "plumbing", offset: 78, width: 0 },
      { id: "f3", kind: "gas", offset: 132, width: 0 },
    ],
  }],
  ceilingHeight: 96,
  confidence: 0.9,
};

test("生成的方案带人体工程检查与美观评分", () => {
  const layout = generateLayout(kitchen, pilotModules, { ceilingHeight: 96 });
  assert.ok(Array.isArray(layout.ergonomics));
  assert.equal(layout.aesthetics.length, 1);
  assert.equal(typeof layout.acceptable, "boolean");
  assert.ok(layout.aesthetics[0]!.score.total >= 0 && layout.aesthetics[0]!.score.total <= 100);
});

test("水槽对齐窗中心", () => {
  const layout = generateLayout(kitchen, pilotModules, { ceilingHeight: 96 });
  const sink = layout.placements.find((p) => p.label === "sink");
  assert.ok(sink, "应放置水槽柜");
  const sinkCenter = sink.x + sink.width / 2;
  const windowCenter = 60 + 36 / 2;
  assert.ok(Math.abs(sinkCenter - windowCenter) <= 3,
    `水槽中心 ${sinkCenter} 应接近窗中心 ${windowCenter}`);
});

test("要求洗碗机时它落在水槽旁边", () => {
  const layout = generateLayout(kitchen, pilotModules, {
    ceilingHeight: 96, appliances: ["refrigerator", "range", "dishwasher"],
  });
  const sink = layout.placements.find((p) => p.label === "sink")!;
  const dw = layout.placements.find((p) => p.applianceKind === "dishwasher");
  assert.ok(dw, "应放置洗碗机");
  const gap = dw.x > sink.x ? dw.x - (sink.x + sink.width) : sink.x - (dw.x + dw.width);
  assert.ok(gap <= CLEARANCE.dishwasherToSinkMax, `洗碗机距水槽 ${gap}" 应 ≤ ${CLEARANCE.dishwasherToSinkMax}"`);
});

test("高频区（灶台/水槽旁）用上抽屉柜", () => {
  const layout = generateLayout(kitchen, pilotModules, { ceilingHeight: 96 });
  const drawers = layout.placements.filter(
    (p) => p.kind === "cabinet" && /^(\d)DB/.test(p.moduleCode ?? ""),
  );
  assert.ok(drawers.length > 0,
    `高频区应用上抽屉柜，实得 ${layout.placements.filter((p) => p.kind === "cabinet").map((p) => p.moduleCode).join("、")}`);
});

test("规格库在某宽度上没有抽屉柜时，退回普通地柜而不是硬凑", () => {
  // 试点公司的抽屉柜只有 24"/30"；被家电夹出的 21" 段只能用普通地柜
  const layout = generateLayout(kitchen, pilotModules, { ceilingHeight: 96 });
  const cooktop = layout.placements.find((p) => p.applianceKind === "range")!;
  const neighbours = layout.placements.filter(
    (p) => p.kind === "cabinet" && p.layer === "base"
      && p.x < cooktop.x + cooktop.width + 1 && p.x + p.width > cooktop.x - 1,
  );
  // 关键：仍然只用规格库里真实存在的型号，不会因为"想要抽屉柜"而编一个 21" 的
  for (const p of neighbours) {
    const mod = pilotModules.find((m) => m.id === p.moduleId)!;
    assert.ok(mod.widthOptions.includes(p.width));
  }
});

test("灶具两侧的段能放下抽屉柜时就放抽屉柜", () => {
  // 90" 墙，燃气在正中：灶具占 30-60，两侧各剩 30" —— 恰好是抽屉柜 3DB30 的宽度
  const cooktopRun: ParsedGeometry = {
    wallRuns: [{
      id: "wr_cook", label: "灶台墙", length: 90,
      startsAtCorner: false, endsAtCorner: false,
      features: [{ id: "g", kind: "gas", offset: 45, width: 0 }],
    }],
    ceilingHeight: 96, confidence: 1,
  };
  const layout = generateLayout(cooktopRun, pilotModules, {
    ceilingHeight: 96, appliances: ["range"],
  });
  const bases = layout.placements.filter((p) => p.kind === "cabinet" && p.layer === "base");
  assert.ok(bases.some((p) => /^(\d)DB/.test(p.moduleCode ?? "")),
    `灶具旁应选到抽屉柜，实得 ${bases.map((p) => `${p.moduleCode}@${p.width}`).join("、")}`);
});

test("装箱偏好确实作用在宽度选择上，而不只是事后挑型号", () => {
  // 直接验证机制：给 24 更差的偏好，30 就该胜出
  const neutral = packSegment(54, [{ width: 24 }, { width: 30 }]);
  const biased = packSegment(54, [{ width: 24, preference: 3 }, { width: 30 }]);
  assert.equal(neutral.leftover, 0);
  assert.equal(biased.leftover, 0);
  assert.deepEqual(neutral.widths.slice().sort((a, b) => a - b), [24, 30]);
  // 54 只能是 24+30，偏好体现在代价上
  assert.equal(neutral.cost.preference, 0);
  assert.equal(biased.cost.preference, 3, "偏好应计入代价明细，否则无法解释结果");
  assert.ok(biased.cost.total > neutral.cost.total);
});

test("吊柜柜缝尽量对齐地柜", () => {
  const layout = generateLayout(kitchen, pilotModules, { ceilingHeight: 96 });
  const score = layout.aesthetics[0]!.score;
  assert.ok(score.breakdown.seamAlignment > 0,
    `吊柜应至少部分对齐地柜（现为 ${score.breakdown.seamAlignment}）`);
});

test("生成的方案不含凑数窄柜", () => {
  const layout = generateLayout(kitchen, pilotModules, { ceilingHeight: 96 });
  const narrow = layout.placements.filter(
    (p) => p.kind === "cabinet" && p.width < NARROW_THRESHOLD
      && !/^(BPO|TDC|BWB)/i.test(p.moduleCode ?? ""),
  );
  assert.equal(narrow.length, 0,
    `不该有凑数窄柜，实得 ${narrow.map((p) => `${p.moduleCode} ${p.width}"`).join("、")}`);
});

test("skipErgonomics 只用于调试，默认路径一定会检查", () => {
  const checked = generateLayout(kitchen, pilotModules, { ceilingHeight: 96 });
  const skipped = generateLayout(kitchen, pilotModules, { ceilingHeight: 96, skipErgonomics: true });
  assert.equal(skipped.ergonomics.length, 0);
  assert.equal(skipped.acceptable, true);
  // 默认路径确实跑了检查（至少产出了结构，可能为空数组但走过逻辑）
  assert.ok(Array.isArray(checked.ergonomics));
});

test("局部重算后硬约束与评分整体重新计算", () => {
  const first = generateLayout(kitchen, pilotModules, { ceilingHeight: 96 });
  const again = regenerateRun(first, kitchen, pilotModules, "wr_k", { ceilingHeight: 96 });
  assert.equal(again.aesthetics.length, 1);
  assert.equal(typeof again.acceptable, "boolean");
});
