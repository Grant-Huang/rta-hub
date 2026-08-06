/**
 * 价格与偏好的选择式提问 —— FR-1 补强。
 *
 * 重点验证两条硬规则：选项只来自真实规格库、价格影响由代码算出。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDollars } from "../src/domain/money.js";
import type { GenericCatalog } from "../src/domain/types.js";
import {
  accessoryQuestion, applyPreferencesToSelections, assemblyQuestion, budgetQuestion,
  buildQuestionSet, describeImpact, doorStyleQuestion, drawerBiasFor, hardwareQuestion,
  PreferenceError, priceGroupPremiums, resolvePreferences, storageQuestion,
  unappliedPreferences, validatePreferences, type CustomerPreferences,
} from "../src/preferences/questions.js";
import { emptyBundle, type SpecBundle } from "../src/spec/bundle.js";
import {
  genericCatalog, PILOT_COMPANY_ID, PILOT_SPEC_VERSION_ID, pilotAccessories, pilotDoorStyles,
  pilotHardware, pilotModules, pilotPriceGroups, pilotPriceMatrix,
} from "../src/app/seed.js";
import { generateLayout } from "../src/layout/generate.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";

function bundle(over: Partial<SpecBundle> = {}): SpecBundle {
  return {
    ...emptyBundle(PILOT_SPEC_VERSION_ID, PILOT_COMPANY_ID),
    priceGroups: pilotPriceGroups,
    doorStyles: pilotDoorStyles,
    modules: pilotModules,
    priceMatrix: pilotPriceMatrix,
    hardwareOptions: pilotHardware,
    accessoryOptions: pilotAccessories,
    ...over,
  };
}

// ── 门板：价格组的相对价位 ────────────────────────────────────────────────

test("价格组溢价是算出来的，基准组为 0%", () => {
  const premiums = priceGroupPremiums(bundle());
  assert.deepEqual(premiums.get("pg_std"), { kind: "relativeToCheapest", percent: 0 });

  const prem = premiums.get("pg_prem");
  assert.equal(prem?.kind, "relativeToCheapest");
  assert.ok(prem!.kind === "relativeToCheapest" && prem.percent > 0,
    "高档价格组应该贵一些");
});

test("只在两组都有报价的型号上比较——否则比的是不同的篮子", () => {
  // 高档组只给了一个**很贵的大柜**，标准组只有一个便宜小柜，没有交集
  const b = bundle({
    priceMatrix: [
      { specVersionId: "sv", companyId: "co", moduleId: "m_b12", priceGroupId: "pg_std", listPrice: fromDollars("100.00") },
      { specVersionId: "sv", companyId: "co", moduleId: "m_b36", priceGroupId: "pg_prem", listPrice: fromDollars("900.00") },
    ],
  });
  const premiums = priceGroupPremiums(b);
  // 天真实现会算出"贵 800%"——那跟门板无关，是型号不同
  assert.deepEqual(premiums.get("pg_prem"), {
    kind: "unknown", reason: "与基准价位没有可比型号",
  });
  assert.match(describeImpact(premiums.get("pg_prem")!), /价格待确认/);
});

test("有交集时溢价只反映门板差价", () => {
  const b = bundle({
    priceMatrix: [
      { specVersionId: "sv", companyId: "co", moduleId: "m_b30", priceGroupId: "pg_std", listPrice: fromDollars("200.00") },
      { specVersionId: "sv", companyId: "co", moduleId: "m_b30", priceGroupId: "pg_prem", listPrice: fromDollars("240.00") },
      // 只有高档组提供的大柜，不该把溢价拉高
      { specVersionId: "sv", companyId: "co", moduleId: "m_b36", priceGroupId: "pg_prem", listPrice: fromDollars("2000.00") },
    ],
  });
  assert.deepEqual(priceGroupPremiums(b).get("pg_prem"), {
    kind: "relativeToCheapest", percent: 20,
  });
});

test("门板选项全部来自规格库，且标出最低价位", () => {
  const q = doorStyleQuestion(bundle())!;
  const ids = new Set(pilotDoorStyles.map((d) => d.id));
  for (const o of q.options) assert.ok(ids.has(o.id), `${o.id} 不在规格库中`);
  assert.equal(q.options.length, pilotDoorStyles.length);
  assert.ok(q.options.some((o) => o.recommended));
  // 每个选项都有可直接展示的价格说明
  for (const o of q.options) assert.ok(o.priceNote.length > 0);
});

test("只有一种门板时不出题——没得选的问题只是浪费一轮", () => {
  assert.equal(doorStyleQuestion(bundle({ doorStyles: [pilotDoorStyles[0]!] })), undefined);
});

// ── 五金与配件 ────────────────────────────────────────────────────────────

test("五金加价用真实修饰项，知道柜体数时给出合计", () => {
  const plain = hardwareQuestion(bundle())!;
  const soft = plain.options.find((o) => o.id === "hw_softclose")!;
  assert.deepEqual(soft.priceImpact, { kind: "perCabinet", amount: fromDollars("22.00") });
  assert.match(soft.priceNote, /每个柜体 \+\$22\.00/);
  assert.ok(!soft.priceNote.includes("合计"));

  const withCount = hardwareQuestion(bundle(), { estimatedCabinetCount: 12 })!;
  const soft12 = withCount.options.find((o) => o.id === "hw_softclose")!;
  assert.match(soft12.priceNote, /12 个柜体.*\$264\.00/);
});

test("配件标出能装在哪些型号上", () => {
  const q = accessoryQuestion(bundle())!;
  const rollout = q.options.find((o) => o.id === "ac_rollout")!;
  assert.match(rollout.detail ?? "", /可装于/);
  assert.deepEqual(rollout.priceImpact, { kind: "percentOfList", percent: 12 });
});

test("没有五金/配件的公司不出这两题", () => {
  assert.equal(hardwareQuestion(bundle({ hardwareOptions: [] })), undefined);
  assert.equal(accessoryQuestion(bundle({ accessoryOptions: [] })), undefined);
});

// ── 组装方式 ──────────────────────────────────────────────────────────────

test("组装加价取价格矩阵的实际分布，不拍脑袋", () => {
  const b = bundle({
    priceMatrix: [
      { specVersionId: "sv", companyId: "co", moduleId: "m_b30", priceGroupId: "pg_std",
        listPrice: fromDollars("200.00"), assembledUpcharge: { kind: "flat", value: fromDollars("40.00") } },
      { specVersionId: "sv", companyId: "co", moduleId: "m_b36", priceGroupId: "pg_std",
        listPrice: fromDollars("300.00"), assembledUpcharge: { kind: "percent", value: 20 } },
    ],
  });
  const q = assemblyQuestion(b)!;
  const assembled = q.options.find((o) => o.id === "assembled")!;
  assert.deepEqual(assembled.priceImpact, {
    kind: "range", low: fromDollars("40.00"), high: fromDollars("60.00"),
  });
});

test("没有组装加价数据时不出这题", () => {
  assert.equal(assemblyQuestion(bundle({ priceMatrix: [] })), undefined);
});

// ── 预算：必须有尺寸锚点 ──────────────────────────────────────────────────

const catalog: GenericCatalog = genericCatalog;

test("没有户型尺寸就不问预算——凭空给区间是编数字", () => {
  assert.equal(budgetQuestion({ catalog, sourceVerified: true }), undefined);
  assert.equal(budgetQuestion({ baseRunInches: 0, catalog, sourceVerified: true }), undefined);
});

test("有尺寸时给出锚定区间，来源未核实必须标注", () => {
  const unverified = budgetQuestion({ baseRunInches: 144, catalog, sourceVerified: false })!;
  assert.match(unverified.why, /尚未逐条核实/);
  assert.match(unverified.prompt, /144"/);

  const verified = budgetQuestion({ baseRunInches: 144, catalog, sourceVerified: true })!;
  assert.ok(!verified.why.includes("尚未逐条核实"));

  // 三档 + 一个"还没想好"——不强迫客户在不知道的时候硬选
  assert.ok(verified.options.some((o) => o.id === "unsure"));
  const eco = verified.options.find((o) => o.id === "economy")!;
  assert.equal(eco.priceImpact.kind, "range");
});

// ── 出题组卷 ──────────────────────────────────────────────────────────────

test("答过的不再问，且按 maxPerTurn 截断", () => {
  const b = bundle();
  const first = buildQuestionSet({ bundle: b, answered: {}, maxPerTurn: 2 });
  assert.equal(first.length, 2);
  assert.equal(first[0]!.key, "doorStyle", "影响面最大的先问");

  const after = buildQuestionSet({
    bundle: b,
    answered: { doorStyleId: "ds_shaker_white", storage: "balanced" },
    maxPerTurn: 5,
  });
  assert.ok(!after.some((q) => q.key === "doorStyle"));
  assert.ok(!after.some((q) => q.key === "storage"));
});

test("建商一轮问得多——沿用交互差异", () => {
  const b = bundle();
  assert.equal(buildQuestionSet({ bundle: b, answered: {}, maxPerTurn: 2 }).length, 2);
  assert.equal(buildQuestionSet({ bundle: b, answered: {}, maxPerTurn: 5 }).length, 5);
});

test("没有公司上下文时仍能问跨公司通用的题", () => {
  const qs = buildQuestionSet({ answered: {}, maxPerTurn: 5 });
  assert.ok(qs.length > 0);
  // 门板/五金/配件是公司专属的，没有公司就不该出现
  for (const q of qs) assert.ok(!["doorStyle", "hardware", "accessories", "assembly"].includes(q.key));
});

// ── 校验 ──────────────────────────────────────────────────────────────────

test("不存在的门板/五金被拒——不能等到定价时才炸", () => {
  const b = bundle();
  assert.throws(() => validatePreferences({ doorStyleId: "ds_nope" }, b), PreferenceError);
  assert.throws(() => validatePreferences({ hardwareOptionIds: ["hw_nope"] }, b), PreferenceError);
  assert.throws(() => validatePreferences({ accessoryOptionIds: ["ac_nope"] }, b), PreferenceError);
  // 没有公司上下文时也不能放行公司专属的选择
  assert.throws(() => validatePreferences({ doorStyleId: "ds_shaker_white" }, undefined), PreferenceError);
});

test("非法枚举值被拒", () => {
  const b = bundle();
  assert.throws(() => validatePreferences({ storage: "whatever" as never }, b), PreferenceError);
  assert.throws(() => validatePreferences({ assembly: "Assembled" as never }, b), PreferenceError);
  assert.throws(() => validatePreferences({ budgetBand: "cheap" as never }, b), PreferenceError);
  assert.throws(() => validatePreferences({ hardwareOptionIds: "hw_softclose" as never }, b), PreferenceError);
});

test("校验结果按「跨公司 / 公司专属」拆开", () => {
  const { shared, company } = validatePreferences({
    doorStyleId: "ds_navy", hardwareOptionIds: ["hw_softclose", "hw_softclose"],
    storage: "drawers", budgetBand: "standard", assembly: "RTA",
  }, bundle());

  assert.deepEqual(company, { doorStyleId: "ds_navy", hardwareOptionIds: ["hw_softclose"] });
  assert.deepEqual(shared, { storage: "drawers", budgetBand: "standard", assembly: "RTA" });
});

test("合成视图：公司专属项覆盖在跨公司项之上", () => {
  const merged = resolvePreferences(
    { storage: "drawers", budgetBand: "premium" },
    { doorStyleId: "ds_navy" },
  );
  assert.deepEqual(merged, { storage: "drawers", budgetBand: "premium", doorStyleId: "ds_navy" });
});

// ── 偏好真的改变结果 ──────────────────────────────────────────────────────

const run: WallRun = {
  id: "wr_1", label: "北墙", length: 144, startsAtCorner: true, endsAtCorner: true,
  features: [{ id: "f_win", kind: "window", offset: 60, width: 36 }],
};
const geometry: ParsedGeometry = { wallRuns: [run], ceilingHeight: 96, confidence: 0.9 };

test("储物偏好真的改变排出来的柜型，不是记下来给人看", () => {
  const drawerCount = (bias: "always" | "highUseOnly" | "never") => {
    const l = generateLayout(geometry, pilotModules, { ceilingHeight: 96, drawerBias: bias });
    const base = l.placements.filter((p) => p.layer === "base" && p.kind === "cabinet");
    return base.filter((p) => /^\dDB/i.test(p.moduleCode ?? "")).length;
  };
  assert.ok(drawerCount("always") > drawerCount("never"),
    "选了「尽量多做抽屉」就该排出更多抽屉柜");
  assert.equal(drawerCount("never"), 0);
});

test("储物偏好映射到排布参数", () => {
  assert.equal(drawerBiasFor({ storage: "drawers" }), "always");
  assert.equal(drawerBiasFor({ storage: "doors" }), "never");
  assert.equal(drawerBiasFor({ storage: "balanced" }), "highUseOnly");
  assert.equal(drawerBiasFor({}), "highUseOnly", "没选时用常见做法");
});

test("五金/配件只加到真正适用的柜体上", () => {
  const b = bundle();
  const selections = [
    { moduleId: "m_b30", qty: 1, hardwareOptionIds: [], accessoryOptionIds: [], assembly: "RTA" },
    { moduleId: "m_w3030", qty: 1, hardwareOptionIds: [], accessoryOptionIds: [], assembly: "RTA" },
  ];
  const prefs: CustomerPreferences = {
    hardwareOptionIds: ["hw_softclose"],
    // 抽拉层板只适用于地柜（appliesToModuleIds 里没有吊柜）
    accessoryOptionIds: ["ac_rollout"],
  };
  const out = applyPreferencesToSelections(selections, prefs, b);

  assert.deepEqual(out[0]!.accessoryOptionIds, ["ac_rollout"]);
  assert.deepEqual(out[1]!.accessoryOptionIds, [],
    "吊柜装不了抽拉层板，加上去会让定价校验整单拒绝");
  // 五金对两种柜型都适用
  assert.deepEqual(out[0]!.hardwareOptionIds, ["hw_softclose"]);
  assert.deepEqual(out[1]!.hardwareOptionIds, ["hw_softclose"]);
});

test("组装偏好覆盖到每一行", () => {
  const out = applyPreferencesToSelections(
    [{ moduleId: "m_b30", qty: 1, hardwareOptionIds: [], accessoryOptionIds: [], assembly: "RTA" }],
    { assembly: "assembled" },
    bundle(),
  );
  assert.equal(out[0]!.assembly, "assembled");
});

test("没有偏好时不动原选择", () => {
  const selections = [
    { moduleId: "m_b30", qty: 1, hardwareOptionIds: ["hw_handle_bar"], accessoryOptionIds: [], assembly: "RTA" },
  ];
  assert.deepEqual(applyPreferencesToSelections(selections, {}, bundle()), selections);
});

// ── 回归：模拟跑出来的两个真 bug ──────────────────────────────────────────

test("组装偏好只套到提供该形式的柜体上——套错了会整单被拒", () => {
  // 试点公司：地柜提供 RTA + assembled，吊柜只有 RTA
  const b = bundle();
  const out = applyPreferencesToSelections(
    [
      { moduleId: "m_b36", qty: 1, hardwareOptionIds: [], accessoryOptionIds: [], assembly: "RTA" },
      { moduleId: "m_w3630", qty: 1, hardwareOptionIds: [], accessoryOptionIds: [], assembly: "RTA" },
    ],
    { assembly: "assembled" },
    b,
  );
  assert.equal(out[0]!.assembly, "assembled", "地柜提供组装");
  assert.equal(out[1]!.assembly, "RTA",
    "吊柜不提供组装：保持原值，而不是让整单被 ASSEMBLY_NOT_OFFERED 拒掉");
});

test("没落实的偏好要如实说出来，不能静默部分落实", () => {
  const b = bundle();
  const notes = unappliedPreferences(
    [{ moduleId: "m_b36" }, { moduleId: "m_w3630" }],
    { assembly: "assembled" },
    b,
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /W3630/);
  assert.match(notes[0]!, /组装好发货/);
});

test("全都能落实时不报无谓的提示", () => {
  assert.deepEqual(
    unappliedPreferences([{ moduleId: "m_b36" }], { assembly: "assembled" }, bundle()),
    [],
  );
  assert.deepEqual(unappliedPreferences([{ moduleId: "m_b36" }], {}, bundle()), []);
});

test("配件在这版方案里一个都装不了时如实说明", () => {
  // 抽拉层板只装地柜；全是吊柜的方案就装不了
  const notes = unappliedPreferences(
    [{ moduleId: "m_w3630" }],
    { accessoryOptionIds: ["ac_rollout"] },
    bundle(),
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /抽拉层板/);
  assert.match(notes[0]!, /未计入报价/);
});
