/**
 * 家电配套柜 —— APPLIANCES.md §3。
 *
 * 家电不只是一段"这里不能放柜子"的空白。冰箱顶上有上柜、两侧有通高收口板，
 * 嵌入式灶台下面有柜子（而且不能是普通抽屉柜）。这些以前一个都不排，
 * 于是图上冰箱顶是个空当、灶台底下悬空，报价单里也没有它们。
 *
 * 两条贯穿的原则：
 *
 *   1. **按能力查，不按型号码猜**——问的是「servesAppliance === refrigerator
 *      的型号」，不是 `code.startsWith("RFW")`。
 *   2. **这家做不了就报出来，不静默跳过**——冰箱顶上留空当是客户会看见的
 *      真实结果，由他决定接受还是换一家。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLayout } from "../src/layout/generate.js";
import { buildBom } from "../src/layout/bom.js";
import { auditDeliverable } from "../src/delivery/audit.js";
import { checkErgonomics } from "../src/layout/ergonomics.js";
import { applianceFrom } from "../src/floorplan/appliances.js";
import { hasRole } from "../src/spec/capabilities.js";
import { pilotModules } from "../src/app/seed.js";
import type { ModuleSpec } from "../src/domain/types.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";

function wall(over: Partial<WallRun> & { id: string }): WallRun {
  return {
    label: over.label ?? over.id, length: 168,
    startsAtCorner: false, endsAtCorner: false, features: [],
    ...over,
  };
}
const geo = (...runs: WallRun[]): ParsedGeometry =>
  ({ wallRuns: runs, ceilingHeight: 96, confidence: 1 });

const fridge = applianceFrom({ kind: "refrigerator", width: 33 });
const cooktop = applianceFrom({ kind: "cooktop", width: 30 });

/** 一面能放下水槽 + 冰箱的长墙。 */
const longWall = () => wall({
  id: "wr_1", label: "北墙", length: 192,
  features: [{ id: "f_p", kind: "plumbing", offset: 96, width: 24 }],
});

// ── 冰箱上柜 ──────────────────────────────────────────────────────────────

test("冰箱顶上排出上柜，且它与冰箱位同中心", () => {
  const layout = generateLayout(geo(longWall()), pilotModules, {
    ceilingHeight: 96, appliances: [fridge],
  });
  const over = layout.placements.find((p) => p.label === "冰箱上柜");
  assert.ok(over, "应该排出冰箱上柜");
  const slot = layout.placements.find((p) => p.applianceKind === "refrigerator")!;
  const dc = Math.abs((over.x + over.width / 2) - (slot.x + slot.width / 2));
  assert.ok(dc <= 1.5, `上柜应与冰箱位大致同中心，偏了 ${dc}"`);
  // 与冰箱齐深，不是普通吊柜的 12"
  assert.ok(over.depth >= 24, `冰箱上柜要与冰箱齐深，实际 ${over.depth}"`);
});

test("这家没有冰箱上柜型号时**报出来**，不静默跳过", () => {
  // 去掉带 servesAppliance: refrigerator 的型号
  const without = pilotModules.filter(
    (m) => m.capabilities?.servesAppliance !== "refrigerator");
  const layout = generateLayout(geo(longWall()), without, {
    ceilingHeight: 96, appliances: [fridge],
  });
  assert.equal(layout.placements.some((p) => p.label === "冰箱上柜"), false);
  const w = layout.warnings.find((x) => x.message.includes("冰箱上柜"));
  assert.ok(w, `应该报出缺型号，实际 warnings: ${JSON.stringify(layout.warnings)}`);
  assert.ok(w.message.includes("空当"), w.message);
});

test("冰箱上柜比冰箱位宽时，旁边的吊柜要让开——不能叠在一起", () => {
  // 33" 的冰箱 + 两侧 1" 通风 = 35" 的位，最窄的冰箱上柜是 33"→不够，
  // 于是取 36" 一档：比冰箱位宽 1"，旁边的吊柜必须按 36" 让位而不是 35"
  const layout = generateLayout(geo(longWall()), pilotModules, {
    ceilingHeight: 96, appliances: [fridge],
  });
  const over = layout.placements.find((p) => p.label === "冰箱上柜")!;
  const slot = layout.placements.find((p) => p.applianceKind === "refrigerator")!;
  assert.ok(over.width > slot.width, "这条断言的前提：上柜确实比冰箱位宽");

  // 交给几何自洽审核判——它就是为这类"两个构件叠在一起"设的
  const report = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings",
    layout, wallRuns: geo(longWall()).wallRuns, modules: pilotModules,
  });
  const overlap = report.findings.filter((f) => f.code === "GEOMETRY");
  assert.deepEqual(overlap, [], `不该有几何冲突：${overlap.map((f) => f.message).join("；")}`);
});

// ── 冰箱侧通高收口板 ──────────────────────────────────────────────────────

test("冰箱两侧不靠墙的那些侧面，BOM 里要有**通高**收口板", () => {
  const runs = [longWall()];
  const layout = generateLayout(geo(...runs), pilotModules, {
    ceilingHeight: 96, appliances: [fridge],
  });
  const bom = buildBom({
    layout, wallRuns: runs, modules: pilotModules, toeKickSystem: "plywoodPanel",
  });
  const tall = bom.lines.filter((l) => l.category === "panel" && l.height >= 84);
  assert.equal(tall.length, 1, `应有一行通高收口板，实际 ${JSON.stringify(bom.lines.filter((l) => l.category === "panel"))}`);
  // 墙两头都不是内墙角 → 冰箱两侧都要贴
  assert.equal(tall[0]!.qty, 2);
  assert.ok(tall[0]!.reason?.includes("冰箱"), tall[0]!.reason);
});

test("冰箱贴着内墙角的那一侧不用贴板——那侧对着墙", () => {
  const runs = [wall({
    id: "wr_1", label: "北墙", length: 192, startsAtCorner: true,
    features: [{ id: "f_p", kind: "plumbing", offset: 120, width: 24 }],
  })];
  const layout = generateLayout(geo(...runs), pilotModules, {
    ceilingHeight: 96, appliances: [applianceFrom({ kind: "refrigerator", width: 33, preferredZone: "nearEntry" })],
  });
  const slot = layout.placements.find((p) => p.applianceKind === "refrigerator")!;
  assert.ok(slot.x <= 0.01, `这条断言的前提：冰箱确实排在墙角，实际 x=${slot.x}`);
  const bom = buildBom({
    layout, wallRuns: runs, modules: pilotModules, toeKickSystem: "plywoodPanel",
  });
  const tall = bom.lines.find((l) => l.category === "panel" && l.height >= 84);
  assert.ok(tall);
  assert.equal(tall.qty, 1, "只有一侧外露");
});

test("这家没有够高的收口板时，BOM 如实记进 missing", () => {
  const runs = [longWall()];
  const layout = generateLayout(geo(...runs), pilotModules, {
    ceilingHeight: 96, appliances: [fridge],
  });
  const shortOnly = pilotModules.filter(
    (m) => !(m.type === "panel" && (m.heightOptions[0] ?? 0) >= 84));
  const bom = buildBom({
    layout, wallRuns: runs, modules: shortOnly, toeKickSystem: "plywoodPanel",
  });
  assert.ok(bom.missing.some((x) => x.includes("冰箱侧")), bom.missing.join("；"));
  // 而且不能拿一块 34.5" 的板顶上去充数
  assert.equal(bom.lines.some((l) => l.category === "panel" && l.height >= 84), false);
});

test("收口板按要盖住的高度选，不靠型号在表里的先后顺序", () => {
  const runs = [longWall()];
  const layout = generateLayout(geo(...runs), pilotModules, {
    ceilingHeight: 96, appliances: [fridge],
  });
  // 把通高板排到最前面——如果选型依赖顺序，地柜收口板会被它顶掉
  const reordered: ModuleSpec[] = [
    ...pilotModules.filter((m) => m.code === "REP24"),
    ...pilotModules.filter((m) => m.code !== "REP24"),
  ];
  const bom = buildBom({
    layout, wallRuns: runs, modules: reordered, toeKickSystem: "plywoodPanel",
  });
  const basePanel = bom.lines.find(
    (l) => l.category === "panel" && l.reason?.includes("外露侧面"));
  assert.ok(basePanel);
  assert.ok(basePanel.height < 84, `地柜收口板不该选到通高板，实际 ${basePanel.height}"`);
});

// ── 灶下柜 ────────────────────────────────────────────────────────────────

test("嵌入式灶台下面有柜子——它是台面上的一个洞，不是一段没有柜子的空白", () => {
  const runs = [wall({
    id: "wr_1", label: "北墙", length: 192,
    features: [
      { id: "f_p", kind: "plumbing", offset: 150, width: 24 },
      { id: "f_g", kind: "gas", offset: 48, width: 0 },
    ],
  })];
  const layout = generateLayout(geo(...runs), pilotModules, {
    ceilingHeight: 96, appliances: [cooktop],
  });
  const under = layout.placements.find(
    (p) => p.layer === "base" && p.applianceKind === "cooktop");
  assert.ok(under, "灶台下面应该有柜子");
  assert.equal(under.kind, "cabinet");
  assert.ok(under.moduleCode, "必须是规格库里真实存在的型号");
  assert.ok(under.label?.includes("开孔"), under.label);
});

test("灶下柜不会用抽屉柜——上层抽屉会顶到灶体", () => {
  const runs = [wall({
    id: "wr_1", label: "北墙", length: 192,
    features: [
      { id: "f_p", kind: "plumbing", offset: 150, width: 24 },
      { id: "f_g", kind: "gas", offset: 48, width: 0 },
    ],
  })];
  const layout = generateLayout(geo(...runs), pilotModules, {
    ceilingHeight: 96, appliances: [cooktop],
  });
  const under = layout.placements.find(
    (p) => p.layer === "base" && p.applianceKind === "cooktop")!;
  const mod = pilotModules.find((m) => m.id === under.moduleId)!;
  assert.equal(hasRole(mod, "drawerStorage"), false,
    `灶下柜用了 ${mod.code}（${mod.faceTemplateId}）——抽屉柜的上层抽屉会顶到灶体`);
  assert.ok(hasRole(mod, "cooktopBase"),
    `${mod.code} 不具备灶下柜能力（需要顶部开放的箱体）`);
});

test("没有任何顶部开放的箱体时，退到门板柜并**说明这是替代方案**", () => {
  const runs = [wall({
    id: "wr_1", label: "北墙", length: 192,
    features: [
      { id: "f_p", kind: "plumbing", offset: 150, width: 24 },
      { id: "f_g", kind: "gas", offset: 48, width: 0 },
    ],
  })];
  // 去掉水槽柜类（假抽面箱体），只剩带抽屉的地柜与门板柜
  const noFalseFront = pilotModules.filter((m) => !hasRole(m, "cooktopBase"));
  const layout = generateLayout(geo(...runs), noFalseFront, {
    ceilingHeight: 96, appliances: [cooktop],
  });
  const under = layout.placements.find(
    (p) => p.layer === "base" && p.applianceKind === "cooktop");
  const w = layout.warnings.find((x) => x.message.includes("灶下柜"));
  assert.ok(w, `要么排出灶下柜要么说明为什么排不出，实际 warnings 为空；under=${JSON.stringify(under)}`);
  if (under) {
    // 用了替代型号：必须说出用的是哪个
    assert.ok(w.message.includes(under.moduleCode ?? "?"), w.message);
  } else {
    assert.ok(w.message.includes("必须有柜子"), w.message);
  }
});

test("灶台的落台区检查对嵌入式灶台仍然生效——不能因为它变成柜子就静默失效", () => {
  // 灶台顶在墙角：一侧落台区为 0，这是安全问题，必须被判 blocking
  const run = wall({ id: "wr_1", label: "北墙", length: 120 });
  const placements = [
    {
      kind: "cabinet" as const, layer: "base" as const, wallRunId: "wr_1",
      x: 0, width: 30, height: 34.5, depth: 24,
      moduleId: "m_x", moduleCode: "B30", applianceKind: "cooktop" as const,
    },
    {
      kind: "cabinet" as const, layer: "base" as const, wallRunId: "wr_1",
      x: 30, width: 12, height: 34.5, depth: 24,
      moduleId: "m_y", moduleCode: "B12",
    },
  ];
  const v = checkErgonomics({ run, placements, hasDishwasher: false });
  assert.ok(v.some((x) => x.code === "COOKTOP_LANDING" && x.severity === "blocking"),
    `应判落台区不足，实际 ${JSON.stringify(v)}`);
});

test("灶台位仍然进工作三角——换成嵌入式后三角不能凭空少一个点", () => {
  const runs = [wall({
    id: "wr_1", label: "北墙", length: 192,
    features: [
      { id: "f_p", kind: "plumbing", offset: 150, width: 24 },
      { id: "f_g", kind: "gas", offset: 48, width: 0 },
    ],
  })];
  const layout = generateLayout(geo(...runs), pilotModules, {
    ceilingHeight: 96, appliances: [cooktop, fridge],
  });
  // 三角检查只在三个点都在时才有结论；这里断言它确实跑了（有水槽/灶/冰箱）
  const kinds = new Set(layout.placements
    .filter((p) => p.layer === "base")
    .map((p) => p.applianceKind ?? (p.label === "sink" ? "sink" : undefined))
    .filter(Boolean));
  assert.ok(kinds.has("cooktop") && kinds.has("refrigerator") && kinds.has("sink"),
    `三角的三个点都要在：${[...kinds].join(",")}`);
});

test("嵌入式灶台的方案，几何上仍然自洽", () => {
  const runs = [wall({
    id: "wr_1", label: "北墙", length: 192,
    features: [
      { id: "f_p", kind: "plumbing", offset: 150, width: 24 },
      { id: "f_g", kind: "gas", offset: 48, width: 0 },
    ],
  })];
  const layout = generateLayout(geo(...runs), pilotModules, {
    ceilingHeight: 96, appliances: [cooktop, fridge],
  });
  const report = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings",
    layout, wallRuns: runs, modules: pilotModules,
  });
  const geoms = report.findings.filter((f) => f.code === "GEOMETRY");
  assert.deepEqual(geoms, [], geoms.map((f) => f.message).join("；"));
});

test("灶下柜进报价——以前它根本不在清单里", () => {
  const runs = [wall({
    id: "wr_1", label: "北墙", length: 192,
    features: [
      { id: "f_p", kind: "plumbing", offset: 150, width: 24 },
      { id: "f_g", kind: "gas", offset: 48, width: 0 },
    ],
  })];
  const layout = generateLayout(geo(...runs), pilotModules, {
    ceilingHeight: 96, appliances: [cooktop],
  });
  const under = layout.placements.find(
    (p) => p.layer === "base" && p.applianceKind === "cooktop")!;
  assert.ok(layout.moduleCounts.some((m) => m.moduleId === under.moduleId),
    "灶下柜要出现在型号统计里，否则报价单上没有它");
});
