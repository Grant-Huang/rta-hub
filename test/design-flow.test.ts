/**
 * 分阶段设计流程 —— 先问再画、全局俯视图评审、完整 BOM、分组报价清单。
 *
 * 这一组测的是**四个模块合起来才成立的一件事**：客户先看到一张排布图、
 * 在上面改几轮、认可之后才拿到完整图纸和一份逐行的报价清单。任何一环
 * 只做了一半（比如"改了但图没变"），单独看都像是通过的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_STAGE_MOVES, allowedArtifacts, approvePlan, assertStageMove, backToPlan,
  deferDrawing, grantDrawingConsent, markQuoted, markReadyToDraw, newSession,
  recordPlanRevision, stagePrompt, StageError,
} from "../src/design/stages.js";
import { generateLayout } from "../src/layout/generate.js";
import { buildBom, bomToSelections } from "../src/layout/bom.js";
import { buildQuoteList, countFaces, renderQuoteListText } from "../src/quote/line-items.js";

const zhLang = "zh" as const;
import { layoutPlan, renderPlanViews } from "../src/render/plan-view.js";
import { checkErgonomics } from "../src/layout/ergonomics.js";
import { pilotModules } from "../src/app/seed.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";
import type { Money } from "../src/domain/money.js";
import type { Quote } from "../src/domain/types.js";
import { doorStyles, modules as fixtureModules } from "./fixtures.js";

const AT = "2026-06-01T00:00:00.000Z";
const LATER = "2026-06-01T01:00:00.000Z";

function run(over: Partial<WallRun> = {}): WallRun {
  return {
    id: "wr_1", label: "北墙", length: 144,
    startsAtCorner: false, endsAtCorner: false,
    features: [], ...over,
  };
}

function geometryOf(...runs: WallRun[]): ParsedGeometry {
  return { wallRuns: runs, ceilingHeight: 96, confidence: 0.9 };
}

// ── 阶段机 ────────────────────────────────────────────────────────────────

test("资料齐了只推进到「该问客户了」，不是「可以画了」", () => {
  const s = markReadyToDraw(newSession({ conversationId: "cv_1", companyId: "co_1", at: AT }), AT);
  assert.equal(s.stage, "readyToDraw");
  assert.equal(allowedArtifacts(s.stage).planView, false, "还没点头就不该能出图");
});

test("readyToDraw 阶段说的是一句问句，而不是直接给图", () => {
  const s = markReadyToDraw(newSession({ conversationId: "cv_1", companyId: "co_1", at: AT }), AT);
  const p = stagePrompt(s, {});
  assert.equal(p.awaiting, "drawingConsent");
  assert.ok(p.message.includes("Shall I generate a design drawing"), p.message);
  assert.ok(p.actions.some((a) => a.id === "notYet"), "必须给「先等等」这个选项");
});

test("客户点头后只开放全局俯视图，四视图与报价清单仍然关着", () => {
  let s = markReadyToDraw(newSession({ conversationId: "cv_1", companyId: "co_1", at: AT }), AT);
  s = grantDrawingConsent(s, AT);
  assert.equal(s.stage, "planReview");
  assert.deepEqual(allowedArtifacts(s.stage), { planView: true, fourViews: false, quoteList: false });
});

test("认可排布之后才开放完整四视图与报价清单", () => {
  let s = markReadyToDraw(newSession({ conversationId: "cv_1", companyId: "co_1", at: AT }), AT);
  s = approvePlan(grantDrawingConsent(s, AT), AT);
  assert.deepEqual(allowedArtifacts(s.stage), { planView: true, fourViews: true, quoteList: true });
});

test("跨阶段直接跳会被拒绝——collecting 不能一步到 fullDrawings", () => {
  assert.throws(() => assertStageMove("collecting", "fullDrawings"), StageError);
  assert.throws(() => assertStageMove("collecting", "planReview"), StageError);
});

test("每个阶段的可达集合都不为空，不会走进死胡同", () => {
  for (const [from, to] of Object.entries(ALLOWED_STAGE_MOVES)) {
    assert.ok(to.length > 0, `${from} 没有任何后继阶段`);
  }
});

test("出完图仍可回到排布评审——看到正视图才发现不对是常事", () => {
  let s = markReadyToDraw(newSession({ conversationId: "cv_1", companyId: "co_1", at: AT }), AT);
  s = markQuoted(approvePlan(grantDrawingConsent(s, AT), AT), AT);
  assert.equal(backToPlan(s, LATER).stage, "planReview");
});

test("客户说「先等等」会退回收集阶段，不把资料丢掉", () => {
  const s = deferDrawing(markReadyToDraw(
    newSession({ conversationId: "cv_1", companyId: "co_1", at: AT }), AT), LATER);
  assert.equal(s.stage, "collecting");
});

test("一轮修改必须记下改了什么；改不动的话如实标注", () => {
  let s = grantDrawingConsent(
    markReadyToDraw(newSession({ conversationId: "cv_1", companyId: "co_1", at: AT }), AT), AT);
  s = recordPlanRevision(s, AT, { note: "抽屉多一点", applied: ["storage"] });
  s = recordPlanRevision(s, LATER, { note: "看着大气一点", applied: [], unapplied: "改不到排布上" });

  assert.equal(s.planRevisions, 2);
  assert.equal(s.revisionRequests?.length, 2);
  assert.deepEqual(s.revisionRequests?.[0]?.applied, ["storage"]);
  assert.equal(s.revisionRequests?.[1]?.applied.length, 0);
  assert.ok(s.revisionRequests?.[1]?.unapplied, "落不下去的要求必须留痕，不能装作改过了");
  assert.equal(s.stage, "planReview", "改排布停在原地，不往下走");
});

test("不在评审阶段时不能改排布", () => {
  const s = markReadyToDraw(newSession({ conversationId: "cv_1", companyId: "co_1", at: AT }), AT);
  assert.throws(() => recordPlanRevision(s, AT, { applied: [] }), StageError);
});

// ── 水槽落位：硬约束参与排布，而不是只在事后打分 ──────────────────────────

test("窗贴着墙角时，水槽让位给台面工作区（硬约束压过对窗居中）", () => {
  // 84" 单墙，窗在 6"–30"。对准窗中心会让水槽左侧台面为 0
  const wall = run({
    length: 84,
    features: [
      { id: "f_wi6", kind: "window", offset: 6, width: 24 },
      { id: "f_pl12", kind: "plumbing", offset: 12, width: 24 },
    ],
  });
  // 84" 单墙本身就排不下默认推定的整套家电（冰箱+灶具）——这条测的是水槽
  // 对窗角的硬约束，不是家电放不下，所以不带默认推定家电，只看水槽落位。
  const layout = generateLayout(geometryOf(wall), pilotModules, { ceilingHeight: 96, appliances: [] });

  const sink = layout.placements.find((p) => p.label === "sink");
  assert.ok(sink, "应当排出水槽柜");
  assert.ok(sink.x >= 18, `水槽左侧至少要留 18"，实际起点 ${sink.x}"`);
  assert.equal(
    layout.ergonomics.some((v) => v.code === "SINK_LANDING"), false,
    "排布器不该产出一个它自己随后就判为不合格的方案",
  );
  assert.equal(layout.acceptable, true);
});

test("很长的墙上水槽也不会被推到墙角", () => {
  const wall = run({
    length: 216,
    features: [
      { id: "f_do96", kind: "door", offset: 96, width: 32 },
      { id: "f_pl30", kind: "plumbing", offset: 30, width: 24 },
    ],
  });
  const layout = generateLayout(geometryOf(wall), pilotModules, { ceilingHeight: 96 });
  assert.equal(layout.ergonomics.some((v) => v.code === "SINK_LANDING"), false);
});

test("墙太短放不下合格的水槽区时，如实报违规而不是假装摆平", () => {
  // 48" 墙 + 36" 水槽柜 → 只剩 12"，两侧怎么摆都不够
  const wall = run({ length: 48, features: [{ id: "f_pl24", kind: "plumbing", offset: 24, width: 24 }] });
  const layout = generateLayout(geometryOf(wall), pilotModules, { ceilingHeight: 96 });
  const sink = layout.placements.find((p) => p.label === "sink");
  if (sink) {
    const violations = checkErgonomics({ run: wall, placements: layout.placements });
    assert.ok(
      violations.some((v) => v.code === "SINK_LANDING"),
      "摆不下就要报出来，不能因为夹不进可行区间就静默通过",
    );
  }
});

// ── 储物偏好真的会改变排布 ────────────────────────────────────────────────

test("storage 偏好换一个值，排出来的柜型跟着变", () => {
  const wall = run({
    length: 144,
    features: [
      { id: "f_wi60", kind: "window", offset: 60, width: 36 },
      { id: "f_pl66", kind: "plumbing", offset: 66, width: 24 },
    ],
  });
  const geometry = geometryOf(wall);
  const mix = (bias: "always" | "never") =>
    generateLayout(geometry, pilotModules, { ceilingHeight: 96, drawerBias: bias })
      .moduleCounts.map((m) => `${m.moduleCode}×${m.qty}`).sort().join(" ");

  assert.notEqual(mix("always"), mix("never"),
    "「以抽屉为主」和「以门板柜为主」排出来必须不一样，否则这道选择题是摆设");
});

// ── 全局俯视图 ────────────────────────────────────────────────────────────

test("L 型的两段墙在平面上是接起来的，不是并排画两条", () => {
  const a = run({ id: "wr_a", label: "北墙", length: 144, endsAtCorner: true });
  const b = run({ id: "wr_b", label: "东墙", length: 96, startsAtCorner: true });
  const plan = layoutPlan(geometryOf(a, b));

  assert.equal(plan.runs.length, 2);
  assert.notEqual(plan.runs[0]!.heading, plan.runs[1]!.heading, "内墙角处要转 90°");
  assert.equal(plan.note, undefined, "接得上就不该标示意排列");
});

test("接不上的墙段如实标注为示意排列，不假装知道方位", () => {
  const a = run({ id: "wr_a", label: "北墙", length: 144, endsAtCorner: false });
  const b = run({ id: "wr_b", label: "南墙", length: 96, startsAtCorner: false });
  const plan = layoutPlan(geometryOf(a, b));
  assert.ok(/schematic layout|示意排列/.test(plan.note ?? ""), plan.note);
});

test("全局俯视图分地柜层与吊柜层两张，各自只画自己那层", () => {
  const wall = run({
    length: 144,
    features: [{ id: "f_wi60", kind: "window", offset: 60, width: 36 }, { id: "f_pl66", kind: "plumbing", offset: 66, width: 24 }],
  });
  const geometry = geometryOf(wall);
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const views = renderPlanViews(geometry, layout.placements);

  assert.ok(views.base.startsWith("<svg"));
  assert.ok(views.wall.startsWith("<svg"));
  assert.ok(views.base.includes("Overall plan · Base") || views.base.includes("Base"));
  assert.ok(views.wall.includes("Overall plan · Wall") || views.wall.includes("Wall"));

  const wallCode = layout.placements.find((p) => p.layer === "wall" && p.moduleCode)?.moduleCode;
  if (wallCode) {
    assert.ok(views.wall.includes(wallCode), "吊柜层图上应当有吊柜型号");
  }
});

// ── 完整 BOM ──────────────────────────────────────────────────────────────

function sampleLayout() {
  const wall = run({
    length: 145, // 故意不是柜体宽度的整数和，逼出填缝条
    features: [{ id: "f_wi60", kind: "window", offset: 60, width: 36 }, { id: "f_pl66", kind: "plumbing", offset: 66, width: 24 }],
  });
  const geometry = geometryOf(wall);
  return { geometry, wall, layout: generateLayout(geometry, pilotModules, { ceilingHeight: 96 }) };
}

test("BOM 覆盖柜体之外的东西——填缝条、踢脚、收口板都在", () => {
  const { layout, wall } = sampleLayout();
  const bom = buildBom({
    layout, wallRuns: [wall], modules: pilotModules, toeKickSystem: "plywoodPanel",
  });
  const cats = new Set(bom.lines.map((l) => l.category));
  assert.ok(cats.has("cabinet"));
  assert.ok(cats.has("toeKick"), "踢脚从来没进过报价单，是这套 BOM 要补的缺口");
  assert.ok(cats.has("panel"), "两端都不是内墙角，应当有收口板");
  assert.deepEqual(bom.missing, [], `不该缺辅料型号：${bom.missing.join("、")}`);
});

test("塑料地脚与整体底座是两份不同的清单", () => {
  const { layout, wall } = sampleLayout();
  const input = { layout, wallRuns: [wall], modules: pilotModules };

  const panel = buildBom({ ...input, toeKickSystem: "plywoodPanel" });
  const legs = buildBom({ ...input, toeKickSystem: "plasticLegs" });

  assert.equal(panel.lines.some((l) => l.category === "leg"), false, "整体底座不该出现地脚");
  const legLine = legs.lines.find((l) => l.category === "leg");
  assert.ok(legLine, "选了塑料地脚就必须有地脚这一行");
  assert.ok(legLine.qty >= 4, "至少一柜四条腿");
});

test("地脚数量随柜体宽度走：宽于 30\" 的用 6 条", () => {
  const wall = run({ length: 144, features: [{ id: "f_pl66", kind: "plumbing", offset: 66, width: 24 }] });
  const geometry = geometryOf(wall);
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const bom = buildBom({
    layout, wallRuns: [wall], modules: pilotModules, toeKickSystem: "plasticLegs",
  });

  const bases = layout.placements.filter((p) => p.layer === "base" && p.kind === "cabinet");
  const expected = bases.reduce((n, p) => n + (p.width > 30 ? 6 : 4), 0);
  assert.equal(bom.lines.find((l) => l.category === "leg")?.qty, expected);
});

test("缺辅料型号时如实报出，不静默漏掉", () => {
  const { layout, wall } = sampleLayout();
  const cabinetsOnly = pilotModules.filter(
    (m) => !["filler", "toeKick", "leg", "panel"].includes(m.type));
  const bom = buildBom({
    layout, wallRuns: [wall], modules: cabinetsOnly, toeKickSystem: "plasticLegs",
  });
  assert.ok(bom.missing.length > 0, "少了踢脚就是装不上，必须报出来");
  assert.ok(bom.missing.some((m) =>
    /leg|toe.?kick|地脚|踢脚/i.test(m)));
});

test("五金与配件只加在柜体上，不加在填缝条上", () => {
  const { layout, wall } = sampleLayout();
  const bom = buildBom({
    layout, wallRuns: [wall], modules: pilotModules, toeKickSystem: "plywoodPanel",
  });
  const sels = bomToSelections(bom, { hardwareOptionIds: ["hw_x"], accessoryOptionIds: ["ac_y"] });

  for (const [i, l] of bom.lines.entries()) {
    const sel = sels[i]!;
    if (l.category === "cabinet") {
      assert.deepEqual(sel.hardwareOptionIds, ["hw_x"], `${l.moduleCode} 是柜体，应当带五金`);
    } else {
      assert.deepEqual(sel.hardwareOptionIds, [], `给 ${l.moduleCode} 配 soft-close 铰链没有意义`);
    }
  }
});

// ── 报价清单 ──────────────────────────────────────────────────────────────

function quoteWith(lineItems: Quote["lineItems"], subtotal: number): Quote {
  return {
    id: "q_1", companyId: "co_maple", conversationId: "cv_1", accountId: "ca_1",
    specVersionId: "spec_maple_v1", doorStyleId: "ds_shaker_white",
    audience: "consumer", province: "ON", currency: "CAD",
    status: "draft", lineItems,
    subtotal: subtotal as Money, discountTotal: 0 as Money, shipping: 0 as Money,
    taxTotal: 0 as Money, total: subtotal as Money,
    createdAt: AT, updatedAt: AT,
  } as unknown as Quote;
}

const cabinetLine = {
  moduleId: "m_b30", moduleCode: "B30", qty: 2,
  width: 30, height: 34.5, depth: 24,
  unitListPrice: 24550 as Money, unitNetPrice: 26350 as Money,
  lineSubtotal: 52700 as Money,
  modifiers: [
    { kind: "hardware", refId: "hw_softclose", name: "Soft-close hinge", amount: 1800 as Money },
  ],
} as unknown as Quote["lineItems"][number];

const trimLine = {
  moduleId: "m_fb3", moduleCode: "FB3", qty: 1,
  width: 3, height: 34.5, depth: 0.75,
  unitListPrice: 2400 as Money, unitNetPrice: 2400 as Money,
  lineSubtotal: 2400 as Money, modifiers: [],
} as unknown as Quote["lineItems"][number];

test("柜体与它的门板放在一组，附件单独成区", () => {
  const list = buildQuoteList({ language: zhLang, 
    quote: quoteWith([cabinetLine, trimLine], 55100),
    modules: fixtureModules,
    doorStyles,
    bomLines: [
      { moduleId: "m_b30", moduleCode: "B30", qty: 2, width: 30, height: 34.5, depth: 24, category: "cabinet" },
      { moduleId: "m_fb3", moduleCode: "FB3", qty: 1, width: 3, height: 34.5, depth: 0.75, category: "filler", reason: "1 处需要填缝" },
    ],
  });

  assert.equal(list.cabinets.length, 1);
  assert.equal(list.trim.length, 1, "填缝条不属于任何一个柜体，单独列");
  assert.equal(list.cabinets[0]!.door.styleName, "Shaker White");
  assert.equal(list.cabinets[0]!.modifiers.length, 1);
});

test("门板不编一个假的单价，而是标明含在柜体价内", () => {
  const list = buildQuoteList({ language: zhLang, 
    quote: quoteWith([cabinetLine], 52700), modules: fixtureModules, doorStyles,
  });
  const door = list.subtotals.find((s) => s.category === "door");
  assert.ok(door, "分类汇总里要有门板一类");
  assert.equal(door.amount, 0);
  assert.ok(door.includedIn && /not priced separately|不单独计价/i.test(door.includedIn),
    "0 元要有解释，不能让人以为门是送的");
  assert.ok(/price group|门板价格组|included in cabinet/i.test(list.cabinets[0]!.door.includedNote));
});

test("逐行合计对不上报价单小计时会报出差额", () => {
  const list = buildQuoteList({ language: zhLang, 
    quote: quoteWith([cabinetLine], 99999), modules: fixtureModules, doorStyles,
  });
  assert.notEqual(list.reconciliationDelta, 0);
  assert.ok(/may be missing items|清单可能有遗漏项/i.test(renderQuoteListText(list, zhLang)));
});

test("逐行合计与小计一致时不报警", () => {
  const list = buildQuoteList({ language: zhLang, 
    quote: quoteWith([cabinetLine, trimLine], 55100), modules: fixtureModules, doorStyles,
  });
  assert.equal(list.reconciliationDelta, 0);
  assert.equal(/missing items|遗漏项/i.test(renderQuoteListText(list, zhLang)), false);
});

test("分类汇总把五金与配件分开——它们是真的额外收费", () => {
  const list = buildQuoteList({ language: zhLang, 
    quote: quoteWith([cabinetLine], 52700), modules: fixtureModules, doorStyles,
  });
  const hw = list.subtotals.find((s) => s.category === "hardware");
  assert.ok(hw, "有五金加价就要有五金这一类");
  assert.equal(hw.amount, 3600, "18.00 × 2 个柜体");
});

test("门板数量取自渲染那套脸型文法，不另起一套规则", () => {
  // 报价单写 2 扇门、图纸画 1 扇，是同一份数据两套规则的典型后果
  assert.deepEqual(countFaces("B30"), { doors: 2, drawerFronts: 2 });
  assert.deepEqual(countFaces("3DB24"), { doors: 0, drawerFronts: 3 });
  assert.deepEqual(countFaces("SB36"), { doors: 2, drawerFronts: 1 });
  assert.deepEqual(countFaces("FB3"), { doors: 0, drawerFronts: 0 }, "填缝条没有门板");
});

test("报价清单文本里五项俱全：代码、名称、数量、单价、总价", () => {
  const text = renderQuoteListText(buildQuoteList({ language: zhLang, 
    quote: quoteWith([cabinetLine], 52700), modules: fixtureModules, doorStyles,
  }));
  for (const h of ["Code", "Name", "Qty", "Unit", "Total"]) {
    assert.ok(text.includes(h), `表头缺 ${h}`);
  }
  assert.ok(text.includes("B30"));
  assert.ok(/Category subtotals|分类汇总/i.test(text));
});
