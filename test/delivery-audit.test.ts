/**
 * 交付前审核 —— FR-14。
 *
 * 这一层不重新实现任何检查，它把散在各处的结论**合起来**回答一个问题：
 * 「这一份东西现在能不能给客户」。以前没人回答这个问题，于是出现过
 * 「方案合格但物料缺料」「报价算出来了但逐行对不上小计」这类组合。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDeliverable, renderAuditText } from "../src/delivery/audit.js";
import { generateLayout } from "../src/layout/generate.js";
import { buildBom } from "../src/layout/bom.js";
import { pilotModules } from "../src/app/seed.js";
import { applianceFrom } from "../src/floorplan/appliances.js";
import { RTA_QUOTE_NOTE } from "../src/quote/rta-disclosure.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";
import type { GeneratedLayout } from "../src/layout/generate.js";
import type { QuoteList } from "../src/quote/line-items.js";
import type { Money } from "../src/domain/money.js";

const wall: WallRun = {
  id: "wr_1", label: "北墙", length: 144,
  startsAtCorner: false, endsAtCorner: false,
  features: [
    { id: "f_w", kind: "window", offset: 60, width: 36 },
    { id: "f_p", kind: "plumbing", offset: 66, width: 24 },
  ],
};
const geometry: ParsedGeometry = { wallRuns: [wall], ceilingHeight: 96, confidence: 1 };
const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
const bom = buildBom({
  layout, wallRuns: [wall], modules: pilotModules, toeKickSystem: "plywoodPanel",
});

const emptyList = (delta: number): QuoteList => ({
  cabinets: [], trim: [], subtotals: [],
  itemsTotal: 0 as Money, reconciliationDelta: delta as Money,
});

// ── 基本形状 ──────────────────────────────────────────────────────────────

test("干净的方案能过，并且报出**查了哪几项**", () => {
  const r = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings",
    layout, wallRuns: [wall], modules: pilotModules, bom,
  });
  assert.equal(r.ok, true, r.blockers.map((b) => b.message).join("; "));
  assert.ok(r.checked.includes("ERGONOMICS"));
  assert.ok(r.checked.includes("BOM_INCOMPLETE"));
  assert.ok(r.checked.includes("SPEC_MISMATCH"));
  // 「没查」和「查过没问题」不是一回事，所以 checked 要如实报出来
  assert.ok(renderAuditText(r).includes("交付前检查"), renderAuditText(r));
  assert.equal(r.blockers.length, 0);
});

test("阶段不对时直接拦下——planReview 阶段不该出报价清单", () => {
  const r = auditDeliverable({ deliverable: "quoteList", stage: "planReview" });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => b.code === "STAGE"), JSON.stringify(r.blockers));
});

// ── 阻断项 ────────────────────────────────────────────────────────────────

test("物料缺一条踢脚板就不给——照它下单是装不完整的", () => {
  const noTrim = pilotModules.filter(
    (m) => !["filler", "toeKick", "panel", "leg"].includes(m.type));
  const bad = buildBom({
    layout, wallRuns: [wall], modules: noTrim, toeKickSystem: "plywoodPanel",
  });
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted", bom: bad, quoteList: emptyList(0),
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => b.code === "BOM_INCOMPLETE"));
  assert.ok(r.blockers[0]!.message.includes("缺料"), r.blockers[0]!.message);
});

test("逐行合计与小计对不上就不给——那个价格没法拿去比价", () => {
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted", quoteList: emptyList(300),
  });
  assert.equal(r.ok, false);
  const f = r.blockers.find((b) => b.code === "QUOTE_RECONCILIATION")!;
  assert.ok(f, "对不上必须拦");
  assert.ok(f.message.includes("$3.00"), f.message);
});

test("人体工程有 blocking 项就不给，且逐条说清是哪一条", () => {
  const bad: GeneratedLayout = {
    ...layout, acceptable: false,
    ergonomics: [{
      code: "SINK_LANDING", severity: "blocking", wallRunId: wall.id,
      message: "水槽两侧的台面工作区不足",
    }],
  };
  const r = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings", layout: bad, wallRuns: [wall],
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => b.message.includes("水槽两侧")));
});

test("柜体超出墙长会被抓住——SVG 照画不误，到现场才发现装不下", () => {
  const bad: GeneratedLayout = {
    ...layout,
    placements: [
      { kind: "cabinet", layer: "base", wallRunId: wall.id, x: 130, width: 36,
        height: 34.5, depth: 24, moduleCode: "B36" },
    ],
  };
  const r = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings", layout: bad, wallRuns: [wall],
  });
  assert.ok(r.blockers.some((b) => b.code === "GEOMETRY" && b.message.includes("超出墙长")));
});

test("柜体互相重叠会被抓住", () => {
  const bad: GeneratedLayout = {
    ...layout,
    placements: [
      { kind: "cabinet", layer: "base", wallRunId: wall.id, x: 0, width: 36,
        height: 34.5, depth: 24, moduleCode: "B36" },
      { kind: "cabinet", layer: "base", wallRunId: wall.id, x: 24, width: 30,
        height: 34.5, depth: 24, moduleCode: "B30" },
    ],
  };
  const r = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings", layout: bad, wallRuns: [wall],
  });
  assert.ok(r.blockers.some((b) => b.code === "GEOMETRY" && b.message.includes("重叠")));
});

test("清单里出现规格库外的尺寸会被抓住（FR-8 同源）", () => {
  const bad = {
    ...bom,
    lines: [{
      moduleId: "m_b30", moduleCode: "B30", qty: 1,
      // 这家的 B30 只有 30" 宽
      width: 31, height: 34.5, depth: 24, category: "cabinet" as const,
    }],
  };
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted",
    modules: pilotModules, bom: bad, quoteList: emptyList(0),
  });
  assert.ok(r.blockers.some((b) => b.code === "SPEC_MISMATCH" && b.message.includes("31")));
});

test("清单里出现规格库里没有的型号会被抓住", () => {
  const bad = {
    ...bom,
    lines: [{
      moduleId: "m_不存在", moduleCode: "XX99", qty: 1,
      width: 30, height: 34.5, depth: 24, category: "cabinet" as const,
    }],
  };
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted",
    modules: pilotModules, bom: bad, quoteList: emptyList(0),
  });
  assert.ok(r.blockers.some((b) => b.code === "SPEC_MISMATCH" && b.message.includes("XX99")));
});

test("快照复算对不上就不给——一份复算对不上的报价看起来和对得上的一模一样", () => {
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted", quoteList: emptyList(0),
    snapshot: { ok: false, mismatches: ["subtotal 快照 100 ≠ 复算 200"] },
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => b.code === "PRICE_SNAPSHOT"));
});

// ── 推定值必须**在文字里**披露 ────────────────────────────────────────────

test("家电尺寸是推定的，但交给客户的说明里没写，就不给", () => {
  const r = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings",
    appliances: [applianceFrom({ kind: "refrigerator" })],
    customerFacingText: "这面墙排了 5 个柜体，人体工程检查全部通过。",
  });
  assert.equal(r.ok, false);
  const f = r.blockers.find((b) => b.code === "UNDISCLOSED_ASSUMPTION")!;
  assert.ok(f, "数据里有 provenance 不等于客户读到了");
  assert.ok(f.message.includes("冰箱"), f.message);
});

test("说明里写清楚了就放行", () => {
  const r = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings",
    appliances: [applianceFrom({ kind: "refrigerator" })],
    customerFacingText: "冰箱位按 33\" 常见尺寸预留（推定值），实际尺寸不同的话要重排。",
  });
  assert.equal(r.findings.some((b) => b.code === "UNDISCLOSED_ASSUMPTION"), false);
});

test("客户给了准确尺寸时不要求披露——没有推定就没有要说的", () => {
  const r = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings",
    appliances: [applianceFrom({ kind: "refrigerator", width: 33 })],
    customerFacingText: "",
  });
  assert.equal(r.findings.some((b) => b.code === "UNDISCLOSED_ASSUMPTION"), false);
});

// ── 提示项：不拦，但必须显示 ──────────────────────────────────────────────

test("未落实的偏好是提示项——不拦交付，但一定要显示给客户", () => {
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted", quoteList: emptyList(0),
    customerFacingText: RTA_QUOTE_NOTE,  // 报价单必须带产品边界说明（SR-D4）
    unappliedPreferences: ["W3030 不提供「组装好发货」，这几个柜体按平板发货"],
  });
  assert.equal(r.ok, true, "这不该拦住交付");
  assert.equal(r.notices.length, 1);
  assert.ok(renderAuditText(r).includes("需要你知道的几点"), renderAuditText(r));
});

test("美观分低是提示项，不是阻断项——难看不等于不能用", () => {
  const ugly: GeneratedLayout = {
    ...layout,
    aesthetics: [{ wallRunId: wall.id, score: { total: 40 } as never }],
  };
  const r = auditDeliverable({
    deliverable: "fourViews", stage: "fullDrawings", layout: ugly, wallRuns: [wall],
  });
  assert.equal(r.ok, true);
  assert.ok(r.notices.some((n) => n.code === "AESTHETICS"));
});

test("阻断项一条都不放行——不参与权衡", () => {
  // 一堆提示项也压不过一条阻断项，这与 FR-4.1 的三层结构同源
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted", quoteList: emptyList(1),
    unappliedPreferences: ["a", "b", "c", "d", "e"],
  });
  assert.equal(r.ok, false);
});


// ── SR-D4：报价单要写明这份价对应的是什么产品 ────────────────────────────

test("报价单没写明是 RTA：拦下来", () => {
  // 客户拿这张单子去跟全定制的报价比，而那两个数不可比——
  // 不是"客户没问"，是他不知道有这个维度存在，所以问不出来
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted", quoteList: emptyList(0),
    customerFacingText: "柜体 $8,000　五金 $600　合计 $8,600",
  });
  assert.equal(r.ok, false);
  const f = r.blockers.find((b) => b.code === "UNDISCLOSED_PRODUCT_SCOPE");
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.rule, "SR-D4");
  assert.match(f.message, /RTA/);
});

test("商家有多档箱体却没写明按的哪一档：拦下来", () => {
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted", quoteList: emptyList(0),
    customerFacingText: RTA_QUOTE_NOTE,
    boxMaterialCount: 3,
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => /哪一档/.test(b.message)), JSON.stringify(r.blockers));
});

test("商家只有一档箱体时不要求写——没有可比的另一档，写了只是噪音", () => {
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted", quoteList: emptyList(0),
    customerFacingText: RTA_QUOTE_NOTE,
    boxMaterialCount: 1,
  });
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
});

test("两条都写全了就放行", () => {
  const r = auditDeliverable({
    deliverable: "quoteList", stage: "quoted", quoteList: emptyList(0),
    customerFacingText: `【箱体板材】全夹板箱体（你选的）\n\n${RTA_QUOTE_NOTE}`,
    boxMaterialCount: 3,
  });
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
  assert.ok(r.checkedRules.includes("SR-D4"), r.checkedRules.join());
});

test("这一条只管报价单——图纸不必每张都写一遍 RTA", () => {
  const r = auditDeliverable({ deliverable: "planView", stage: "planReview", layout });
  assert.equal(r.checkedRules.includes("SR-D4"), false,
    "俯视图上也要求写 RTA 说明，那是把每张图都变成免责声明");
});
