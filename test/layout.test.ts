/**
 * FR-3 户型解析 + FR-4 排布算法 + FR-5 四视图。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addWallRun, createFloorPlan, normalizeExtraction, pendingQuestions,
  resolveCeilingHeight, resolveWallLength, type RawExtraction, type VisionExtractor,
} from "../src/floorplan/parse.js";
import { isLayoutReady, quantize, totalRunLength, type ParsedGeometry, type WallRun } from "../src/floorplan/types.js";
import { allocateFillers, MAX_FILLER_WIDTH, packSegment } from "../src/layout/pack.js";
import {
  generateLayout, pickWallCabinetHeight, regenerateRun, splitIntoSegments, toSelections,
} from "../src/layout/generate.js";
import {
  formatInches, renderFourViews, renderFrontElevation, renderSideView, renderTopView,
} from "../src/render/views.js";
import { pilotModules } from "../src/app/seed.js";
import { applianceFrom, type ApplianceKind } from "../src/floorplan/appliances.js";

/** 测试里造一台家电：不给宽度就走常见尺寸（标为推定值）。 */
const appl = (kind: ApplianceKind) => applianceFrom({ kind });

const AT = "2026-06-01T00:00:00.000Z";

// ── FR-3 解析 ─────────────────────────────────────────────────────────────

const goodExtraction: RawExtraction = {
  ceilingHeight: 96, ceilingHeightConfidence: 0.9,
  overallConfidence: 0.88,
  wallRuns: [
    {
      label: "北墙", length: 144, lengthConfidence: 0.9, startsAtCorner: false, endsAtCorner: true,
      features: [
        { kind: "plumbing", offset: 60, width: 0, confidence: 0.9 },
        { kind: "window", offset: 48, width: 36, sillHeight: 42, confidence: 0.85 },
      ],
    },
  ],
};

test("干净的抽取结果没有待确认项", () => {
  const { geometry, unresolved } = normalizeExtraction(goodExtraction);
  assert.equal(unresolved.length, 0);
  assert.equal(geometry.wallRuns[0]!.length, 144);
  assert.equal(geometry.ceilingHeight, 96);
  assert.equal(geometry.wallRuns[0]!.features.length, 2);
});

test("完整性优先：长度置信度不足时进待确认，不静默采用", () => {
  const { geometry, unresolved } = normalizeExtraction({
    ...goodExtraction,
    wallRuns: [{ ...goodExtraction.wallRuns![0]!, length: 144, lengthConfidence: 0.4 }],
  });
  assert.equal(geometry.wallRuns[0]!.length, 0, "低置信度的值不应被采用");
  const item = unresolved.find((u) => u.field === "length");
  assert.ok(item);
  assert.equal(item.suggestion, 144, "猜测值仅作展示");
  assert.match(item.reason, /看不太准/);
});

test("完全没识别出墙段时给手动录入提示，而不是编一个户型", () => {
  const { geometry, unresolved } = normalizeExtraction({ wallRuns: [] });
  assert.equal(geometry.wallRuns.length, 0);
  assert.equal(unresolved[0]!.field, "wallRuns");
  assert.match(unresolved[0]!.reason, /手动告诉我/);
});

test("认不出类型的特征进待确认", () => {
  const { unresolved } = normalizeExtraction({
    ...goodExtraction,
    wallRuns: [{ ...goodExtraction.wallRuns![0]!, features: [{ kind: "???", offset: 10, confidence: 0.9 }] }],
  });
  assert.ok(unresolved.some((u) => u.field === "feature.kind"));
});

test("天花板高度不确定时追问，不默认 96", () => {
  const { geometry, unresolved } = normalizeExtraction({ ...goodExtraction, ceilingHeightConfidence: 0.2 });
  assert.equal(geometry.ceilingHeight, undefined);
  assert.ok(unresolved.some((u) => u.field === "ceilingHeight"));
});

test("模型自己提出的疑问也进队列", () => {
  const { unresolved } = normalizeExtraction({ ...goodExtraction, notes: ["右下角有个看不清的区域"] });
  assert.ok(unresolved.some((u) => u.reason.includes("右下角")));
});

test("尺寸量化到 1/4 英寸", () => {
  const { geometry } = normalizeExtraction({
    ...goodExtraction,
    wallRuns: [{ ...goodExtraction.wallRuns![0]!, length: 144.13, lengthConfidence: 0.9 }],
  });
  assert.equal(geometry.wallRuns[0]!.length, 144.25);
  assert.equal(quantize(10.3), 10.25);
});

test("没有视觉模型时降级为手动录入", async () => {
  const plan = await createFloorPlan(
    { conversationId: "cv", file: { name: "a.png", mimeType: "image/png", sizeBytes: 1 }, at: AT },
    undefined, undefined,
  );
  assert.equal(plan.parsedGeometry.wallRuns.length, 0);
  assert.ok(pendingQuestions(plan).length > 0);
  assert.equal(isLayoutReady(plan), false);
});

test("视觉模型抛错时不崩，退回手动录入", async () => {
  const failing: VisionExtractor = { async extract() { throw new Error("vision down"); } };
  const plan = await createFloorPlan(
    { conversationId: "cv", file: { name: "a.png", mimeType: "image/png", sizeBytes: 1 }, at: AT },
    "data:image/png;base64,AA", failing,
  );
  assert.equal(plan.unresolvedItems.length > 0, true);
});

test("手动补齐后户型进入可排布状态", async () => {
  const extractor: VisionExtractor = { async extract() { return { wallRuns: [] }; } };
  let plan = await createFloorPlan(
    { conversationId: "cv", file: { name: "a.png", mimeType: "image/png", sizeBytes: 1 }, at: AT },
    "img", extractor,
  );
  assert.equal(isLayoutReady(plan), false);
  plan = addWallRun(plan, { label: "北墙", length: 144 }, AT);
  plan = resolveCeilingHeight(plan, 96, AT);
  assert.equal(isLayoutReady(plan), true);
  assert.equal(totalRunLength(plan.parsedGeometry), 144);
});

test("修正墙长会消解对应的待确认项", async () => {
  const extractor: VisionExtractor = {
    async extract() {
      return { ...goodExtraction, wallRuns: [{ ...goodExtraction.wallRuns![0]!, lengthConfidence: 0.3 }] };
    },
  };
  let plan = await createFloorPlan(
    { conversationId: "cv", file: { name: "a.png", mimeType: "image/png", sizeBytes: 1 }, at: AT },
    "img", extractor,
  );
  const runId = plan.parsedGeometry.wallRuns[0]!.id;
  assert.equal(isLayoutReady(plan), false);
  plan = resolveWallLength(plan, runId, 150, AT);
  assert.equal(plan.parsedGeometry.wallRuns[0]!.length, 150);
  assert.equal(isLayoutReady(plan), true);
});

// ── FR-4 装箱 ─────────────────────────────────────────────────────────────

const widths = [9, 12, 15, 18, 21, 24, 30, 36].map((w) => ({ width: w }));

test("恰好整除时无剩余", () => {
  const r = packSegment(72, widths);
  assert.equal(r.leftover, 0);
  assert.equal(r.widths.reduce((a, b) => a + b, 0), 72);
  assert.equal(r.feasible, true);
});

test("填得尽量满，剩余最小", () => {
  const r = packSegment(100, widths);
  assert.ok(r.leftover < 3, `剩余 ${r.leftover}" 应该很小`);
  assert.equal(r.widths.reduce((a, b) => a + b, 0) + r.leftover, 100);
});

test("同等填充度下柜子更少者胜出", () => {
  const r = packSegment(72, widths);
  // 72 可以是 2×36，也可以是 6×12；应选前者
  assert.equal(r.widths.length, 2);
  assert.deepEqual(r.widths, [36, 36]);
});

test("剩余超过填缝条能力时标为不可行", () => {
  // 只有 36" 一种柜子，50" 的墙会剩 14"
  const r = packSegment(50, [{ width: 36 }]);
  assert.equal(r.leftover, 14);
  assert.equal(r.feasible, false);
  assert.match(r.reason ?? "", /填缝条/);
});

test("没有足够窄的型号时明确报不可行", () => {
  const r = packSegment(8, widths);
  assert.equal(r.feasible, false);
  assert.equal(r.widths.length, 0);
  assert.match(r.reason ?? "", /没有宽度/);
});

test("1/4 英寸精度：非整数墙长也能处理", () => {
  const r = packSegment(72.5, widths);
  assert.equal(r.leftover, 0.5);
  assert.equal(r.feasible, true);
});

test("长墙的 DP 规模可控", () => {
  const r = packSegment(240, widths);
  assert.equal(r.leftover, 0);
  assert.equal(r.widths.reduce((a, b) => a + b, 0), 240);
});

test("填缝条分配到靠墙两端", () => {
  assert.deepEqual(allocateFillers(0, { atStart: true, atEnd: true }), { start: 0, end: 0, feasible: true });
  const two = allocateFillers(5, { atStart: true, atEnd: true });
  assert.equal(two.start + two.end, 5);
  assert.equal(two.feasible, true);
  const one = allocateFillers(4, { atStart: false, atEnd: true });
  assert.deepEqual(one, { start: 0, end: 4, feasible: true });
  // 超过单条上限
  assert.equal(allocateFillers(MAX_FILLER_WIDTH + 1, { atStart: true, atEnd: false }).feasible, false);
  // 无处可放
  assert.equal(allocateFillers(3, { atStart: false, atEnd: false }).feasible, false);
});

// ── FR-4 方案生成 ─────────────────────────────────────────────────────────

const run: WallRun = {
  id: "wr_1", label: "北墙", length: 144, startsAtCorner: false, endsAtCorner: true,
  features: [
    { id: "f1", kind: "plumbing", offset: 60, width: 0 },
    { id: "f2", kind: "window", offset: 48, width: 36, sillHeight: 42 },
    { id: "f3", kind: "gas", offset: 110, width: 0 },
  ],
};
const geometry: ParsedGeometry = { wallRuns: [run], ceilingHeight: 96, confidence: 0.9 };

test("按天花板高度选吊柜高度档位", () => {
  // 取仍能留出 6" 顶线空间的最高档位（规范文档第一节的匹配表）
  assert.equal(pickWallCabinetHeight(96, [30, 36, 42]), 36);  // 顶边 90，留 6" 贴标准顶线
  assert.equal(pickWallCabinetHeight(102, [30, 36, 42]), 42); // 顶边 96，留 6"
  assert.equal(pickWallCabinetHeight(108, [30, 36, 42]), 42); // 顶边 96，留 12"
  // 只有 30" 一种档位时，即使层高很高也只能用它
  assert.equal(pickWallCabinetHeight(96, [30]), 30);
  assert.equal(pickWallCabinetHeight(undefined, [30, 36, 42]), 30);
});

/** 已落位的灶具——落位本身由 planAppliances 负责，这里只测切段。 */
const placedRange = (x: number, width = 30) => ({
  spec: appl("range"), wallRunId: run.id, x, width,
  layer: "base" as const, reason: "测试固定落位",
});

test("门洞与家电位把墙切成可用子段", () => {
  const { segments, reserved } = splitIntoSegments(run, [placedRange(60)]);
  const range = reserved.find((r) => r.kind === "range");
  assert.ok(range);
  assert.equal(range.width, 30);
  assert.ok(segments.length >= 2);
  assert.ok(segments.every((s) => s.length > 0));
});

test("上下水所在子段被标记为必须放水槽柜", () => {
  const { segments } = splitIntoSegments(run, [placedRange(60)]);
  assert.ok(segments.some((s) => s.requiresSink));
});

test("生成的方案只用规格库里真实存在的型号", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const codes = new Set(pilotModules.map((m) => m.code));
  for (const p of layout.placements) {
    if (p.kind !== "cabinet") continue;
    assert.ok(p.moduleCode && codes.has(p.moduleCode), `${p.moduleCode} 不在规格库里`);
    const mod = pilotModules.find((m) => m.id === p.moduleId)!;
    assert.ok(mod.widthOptions.includes(p.width), `${p.moduleCode} 的宽度 ${p.width} 不在候选集内`);
  }
});

test("水槽处放了水槽柜", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const sink = layout.placements.find((p) => p.moduleCode?.startsWith("SB"));
  assert.ok(sink, "上下水处应放水槽柜");
});

test("柜体不超出墙长且互不重叠", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  for (const layer of ["base", "wall"] as const) {
    const items = layout.placements
      .filter((p) => p.layer === layer && p.wallRunId === run.id)
      .sort((a, b) => a.x - b.x);
    for (const p of items) {
      assert.ok(p.x >= -1e-9, `${p.moduleCode ?? p.kind} 起点为负`);
      assert.ok(p.x + p.width <= run.length + 1e-9, `${p.moduleCode ?? p.kind} 超出墙长`);
    }
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]!;
      const cur = items[i]!;
      assert.ok(cur.x + 1e-9 >= prev.x + prev.width, `${layer} 层 ${prev.moduleCode} 与 ${cur.moduleCode} 重叠`);
    }
  }
});

test("窗户下方不放吊柜", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const window = run.features.find((f) => f.kind === "window")!;
  const wallCabs = layout.placements.filter((p) => p.layer === "wall");
  for (const p of wallCabs) {
    const overlaps = p.x < window.offset + window.width && p.x + p.width > window.offset;
    assert.ok(!overlaps, `吊柜 ${p.moduleCode} 压在窗户上`);
  }
});

test("方案可直接转成报价用的选择列表", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const selections = toSelections(layout, { hardwareOptionIds: ["hw_softclose"] });
  assert.ok(selections.length > 0);
  for (const s of selections) {
    assert.ok(s.qty > 0);
    assert.deepEqual(s.hardwareOptionIds, ["hw_softclose"]);
    // 结构里没有任何价格字段（FR-8）
    assert.ok(!("unitPrice" in s) && !("total" in s));
  }
});

test("局部重算只影响指定墙段", () => {
  const twoRuns: ParsedGeometry = {
    wallRuns: [run, { ...run, id: "wr_2", label: "西墙", length: 96, features: [] }],
    ceilingHeight: 96, confidence: 0.9,
  };
  const first = generateLayout(twoRuns, pilotModules, { ceilingHeight: 96 });
  const untouchedBefore = first.placements.filter((p) => p.wallRunId === "wr_1");
  const again = regenerateRun(first, twoRuns, pilotModules, "wr_2", { ceilingHeight: 96 });
  const untouchedAfter = again.placements.filter((p) => p.wallRunId === "wr_1");
  assert.deepEqual(untouchedAfter, untouchedBefore, "未指定的墙段应原样保留");
});

test("公司没有吊柜型号时给出警告而不是静默略过", () => {
  const baseOnly = pilotModules.filter((m) => m.type !== "wall");
  const layout = generateLayout(geometry, baseOnly, { ceilingHeight: 96 });
  assert.ok(layout.warnings.some((w) => w.code === "NO_WALL_CABINETS"));
});

test("放不下的家电给出警告", () => {
  const tiny: ParsedGeometry = {
    wallRuns: [{ ...run, length: 24, features: [{ id: "f", kind: "electrical", offset: 12, width: 0 }] }],
    confidence: 1,
  };
  const layout = generateLayout(tiny, pilotModules, { appliances: [appl("refrigerator")] });
  assert.ok(layout.warnings.some((w) => w.code === "APPLIANCE_NO_ROOM"));
});

// ── FR-5 四视图 ───────────────────────────────────────────────────────────

test("英寸格式化成行业写法", () => {
  assert.equal(formatInches(34.5), '34-1/2"');
  assert.equal(formatInches(30), '30"');
  assert.equal(formatInches(4.5), '4-1/2"');
  assert.equal(formatInches(30.25), '30-1/4"');
  assert.equal(formatInches(0.75), '0-3/4"');
});

test("四视图都能生成合法 SVG", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const views = renderFourViews(run, layout.placements);
  for (const [name, svg] of Object.entries(views)) {
    assert.match(svg, /^<svg /, `${name} 不是 SVG`);
    assert.match(svg, /<\/svg>$/, `${name} 未闭合`);
    assert.ok(svg.length > 200, `${name} 内容太少`);
  }
});

test("视图不使用 scale 变换（否则门缝与线宽会失真）", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const views = renderFourViews(run, layout.placements);
  for (const [name, svg] of Object.entries(views)) {
    assert.ok(!svg.includes('transform="scale'), `${name} 使用了 scale`);
  }
});

test("正视图标注了台面高度与墙长", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const svg = renderFrontElevation(run, layout.placements);
  assert.ok(svg.includes('36"'), "应标注台面高度 36\"");
  assert.ok(svg.includes('144"'), "应标注墙长 144\"");
});

test("俯视图分地柜层与吊柜层，深度不同", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const base = renderTopView(run, layout.placements, "base");
  const wall = renderTopView(run, layout.placements, "wall");
  assert.ok(base.includes('24"'), "地柜层深度应为 24\"");
  assert.ok(wall.includes('12"'), "吊柜层深度应为 12\"");
});

test("侧视图截面与脸型解耦，标注标准建筑高度", () => {
  const side = renderSideView("base");
  assert.ok(side.includes('36"'));      // 台面高
  assert.ok(side.includes('4-1/2"'));   // 踢脚线
  assert.ok(side.includes('24"'));      // 进深
  const wallSide = renderSideView("wall", undefined, { wallCabinetHeight: 30 });
  assert.ok(wallSide.includes('54"'));  // 吊柜底边距地
});

test("空墙段也能安全出图", () => {
  const emptyRun: WallRun = { id: "wr_e", label: "空墙", length: 48, startsAtCorner: false, endsAtCorner: false, features: [] };
  const svg = renderFrontElevation(emptyRun, []);
  assert.match(svg, /^<svg /);
});
