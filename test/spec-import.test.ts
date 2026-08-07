/**
 * FR-2 导入路径、入驻会话、量化验收。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDollars } from "../src/domain/money.js";
import { parseCsv, parseCsvRows, parseNumberList, CsvParseError } from "../src/spec/csv.js";
import { blankTemplates, importSpecTemplates, type ImportSources } from "../src/spec/import.js";
import {
  answerQuestion, assertPublishable, ingestTemplates, OnboardingError, publish, startSession,
} from "../src/spec/onboarding.js";
import {
  evaluateAcceptance, evaluateSample, planStratifiedSample, reconcile, THRESHOLDS,
} from "../src/spec/acceptance.js";
import type { ProductSpecVersion } from "../src/domain/types.js";

const AT = "2026-06-01T00:00:00.000Z";

// ── CSV ───────────────────────────────────────────────────────────────────

test("CSV 处理引号、转义与字段内逗号", () => {
  const rows = parseCsv('a,b\n"Smith, Bob","say ""hi"""\n');
  assert.deepEqual(rows[1], ["Smith, Bob", 'say "hi"']);
});

test("CSV 处理字段内换行", () => {
  const rows = parseCsv('a,b\n"line1\nline2",x\n');
  assert.equal(rows[1]![0], "line1\nline2");
});

test("引号未闭合时报错而不是静默截断", () => {
  assert.throws(() => parseCsv('a,b\n"unterminated,x\n'), CsvParseError);
});

test("自动识别 TSV", () => {
  const rows = parseCsvRows("code\ttype\nB30\tbase\n");
  assert.equal(rows[0]!["code"], "B30");
  assert.equal(rows[0]!["type"], "base");
});

test("尺寸列表支持 34-1/2 与 34.5 两种写法", () => {
  assert.deepEqual(parseNumberList("30|36|42"), [30, 36, 42]);
  assert.deepEqual(parseNumberList("34-1/2"), [34.5]);
  assert.deepEqual(parseNumberList("12, 15, 18"), [12, 15, 18]);
  assert.deepEqual(parseNumberList("34.5"), [34.5]);
});

test("`/` 的双重身份：分数线 vs 分隔符", () => {
  // 分数：分母是 2/4/8/16/32 的真分数
  assert.deepEqual(parseNumberList("1/2"), [0.5]);
  assert.deepEqual(parseNumberList("34-3/4"), [34.75]);
  assert.deepEqual(parseNumberList("30-1/16"), [30.0625]);
  // 分隔符：30/36 不是合法分数写法，按分隔符处理
  assert.deepEqual(parseNumberList("30/36/42"), [30, 36, 42]);
  assert.deepEqual(parseNumberList("12/15/18"), [12, 15, 18]);
  // 混用
  assert.deepEqual(parseNumberList('30/36, 34-1/2'), [30, 36, 34.5]);
});

test("剥离尺寸里的英寸符号", () => {
  assert.deepEqual(parseNumberList('30"|36"'), [30, 36]);
});

// ── 导入 ──────────────────────────────────────────────────────────────────

const good: ImportSources = {
  priceGroups: "code,displayName,rank\nA,Standard,1\nB,Premium,2\n",
  doorStyles: "name,priceGroup,material\nShaker White,A,Maple\nMaple Glaze,B,Maple\n",
  modules: [
    "code,type,widths,heights,depths,assembly",
    "B30,base,30,34-1/2,24,RTA|assembled",
    "B12,base,12,34-1/2,24,RTA",
    "W3030,wall,30,30|36|42,12,RTA",
    "SB36,sinkBase,36,34-1/2,24,RTA",
  ].join("\n"),
  priceMatrix: [
    "moduleCode,priceGroup,listPrice,assembledUpcharge",
    "B30,A,245.50,15%",
    "B30,B,398.75,15%",
    "B12,A,142.00,15%",
    "B12,B,230.00,15%",
    "W3030,A,178.00,",
    "W3030,B,289.00,",
    "SB36,A,284.00,",
  ].join("\n"),
};

test("干净的模板全部导入，无待确认项", () => {
  const r = importSpecTemplates("sv1", "co_1", good);
  assert.equal(r.unresolved.length, 0, JSON.stringify(r.unresolved));
  assert.equal(r.bundle.modules.length, 4);
  assert.equal(r.bundle.priceMatrix.length, 7);
  assert.equal(r.bundle.doorStyles.length, 2);
  assert.equal(r.bundle.priceGroups.length, 2);
});

test("价格按整数分解析，不经过浮点", () => {
  const r = importSpecTemplates("sv1", "co_1", good);
  const b30a = r.bundle.priceMatrix.find((e) => e.moduleId === "m_b30" && e.priceGroupId === "pg_a");
  assert.equal(b30a!.listPrice, fromDollars("245.50"));
  assert.deepEqual(b30a!.assembledUpcharge, { kind: "percent", value: 15 });
});

test("脸型由命名规则自动判定并计数", () => {
  const r = importSpecTemplates("sv1", "co_1", good);
  assert.equal(r.stats.faceTemplateRuleHits, 4);
  assert.equal(r.bundle.modules.find((m) => m.code === "B30")!.faceTemplateId, "F5_TWO_DRAWERS_OVER_DOUBLE");
  assert.equal(r.bundle.modules.find((m) => m.code === "SB36")!.faceTemplateId, "F7_FALSE_FRONT_DOUBLE");
});

test("零静默失败：认不出的脸型进待确认队列，不猜——但型号本身照样收下", () => {
  const r = importSpecTemplates("sv1", "co_1", {
    ...good,
    modules: "code,type,widths,heights,depths\nACME999,base,30,34.5,24\n",
    priceMatrix: "moduleCode,priceGroup,listPrice\nACME999,A,100.00\n",
  });

  // 不猜：脸型留空，而不是塞一个占位值。空是"还不知道"，占位值是"我们猜了一个"，
  // 而占位值会一路画到正视图上，谁也看不出那是猜的
  assert.equal(r.bundle.modules.length, 1, "型号的尺寸是商家给的真实数据，不该被扔掉");
  assert.equal(r.bundle.modules[0]!.faceTemplateId, undefined);
  assert.deepEqual(r.bundle.modules[0]!.widthOptions, [30]);

  const issue = r.unresolved.find((u) => u.field === "faceTemplate");
  assert.ok(issue);
  assert.match(issue.reason, /未能按命名规则判定脸型/);
});

test("认不出脸型**不会**连累价格行报「型号未在型号表中定义」", () => {
  // 这是把整行丢掉时的代价：商家明明定义了 ACME999，价格矩阵里每一行却都说
  // 「未在型号表中定义」。一家命名规律与我们对不上的商家（这是常态）会看到
  // 几十条互相矛盾的提示，根本找不到真正要改的那一件事。
  const r = importSpecTemplates("sv1", "co_1", {
    ...good,
    modules: "code,type,widths,heights,depths\nACME999,base,30,34.5,24\n",
    priceMatrix: "moduleCode,priceGroup,listPrice\nACME999,A,100.00\nACME999,B,150.00\n",
  });
  const bogus = r.unresolved.filter((u) => /未在型号表中定义/.test(u.reason));
  assert.deepEqual(bogus, [], `冒出了 ${bogus.length} 条假问题`);
  assert.equal(r.unresolved.length, 1, "真正的问题只有一条：这个柜子正面长什么样");
  assert.equal(r.bundle.priceMatrix.length, 2, "价格行照样进来了");
});

test("认不出脸型仍然拦住发布——拦的是队列，不是丢掉那一行", () => {
  const r = importSpecTemplates("sv1", "co_1", {
    ...good,
    modules: "code,type,widths,heights,depths\nACME999,base,30,34.5,24\n",
    priceMatrix: "moduleCode,priceGroup,listPrice\nACME999,A,100.00\n",
  });
  const { session } = startSession("co_1", "2026-03-01T00:00:00.000Z");
  const ingested = ingestTemplates(session, {
    ...good,
    modules: "code,type,widths,heights,depths\nACME999,base,30,34.5,24\n",
    priceMatrix: "moduleCode,priceGroup,listPrice\nACME999,A,100.00\n",
  }, "2026-03-01T00:00:00.000Z");
  assert.ok(ingested.session.unresolved.length > 0);
  assert.throws(() => assertPublishable(ingested.session, r.bundle), /待确认/);
});

test("公司覆盖表可救回自有命名体系", () => {
  const r = importSpecTemplates("sv1", "co_1", {
    ...good,
    modules: "code,type,widths,heights,depths\nACME999,base,30,34.5,24\n",
    priceMatrix: "moduleCode,priceGroup,listPrice\nACME999,A,100.00\n",
  }, { ACME: { templateId: "F2_DOUBLE_DOOR" } });
  assert.equal(r.unresolved.length, 0);
  assert.equal(r.bundle.modules[0]!.faceTemplateId, "F2_DOUBLE_DOOR");
});

test("模板里显式指定的脸型优先于规则", () => {
  const r = importSpecTemplates("sv1", "co_1", {
    ...good,
    modules: "code,type,widths,heights,depths,faceTemplate\nB30,base,30,34.5,24,F1_SINGLE_DOOR\n",
    priceMatrix: "moduleCode,priceGroup,listPrice\nB30,A,245.50\n",
  });
  assert.equal(r.bundle.modules[0]!.faceTemplateId, "F1_SINGLE_DOOR");
});

test("引用未定义的价格组/型号会被拒并说明原因", () => {
  const r = importSpecTemplates("sv1", "co_1", {
    ...good,
    priceMatrix: "moduleCode,priceGroup,listPrice\nB30,ZZZ,245.50\nGHOST,A,1.00\n",
  });
  assert.equal(r.bundle.priceMatrix.length, 0);
  assert.ok(r.unresolved.some((u) => u.field === "priceGroup" && u.raw === "ZZZ"));
  assert.ok(r.unresolved.some((u) => u.field === "moduleCode" && u.raw === "GHOST"));
});

test("无法解析的价格进待确认，不按 0 处理", () => {
  const r = importSpecTemplates("sv1", "co_1", {
    ...good,
    priceMatrix: "moduleCode,priceGroup,listPrice\nB30,A,面议\n",
  });
  assert.equal(r.bundle.priceMatrix.length, 0);
  assert.ok(r.unresolved.some((u) => u.field === "listPrice" && u.raw === "面议"));
});

test("带货币符号与千分位的价格能正确解析", () => {
  const r = importSpecTemplates("sv1", "co_1", {
    ...good,
    priceMatrix: 'moduleCode,priceGroup,listPrice\nB30,A,"$1,245.50"\n',
  });
  assert.equal(r.bundle.priceMatrix[0]!.listPrice, fromDollars("1245.50"));
});

test("空白模板本身可被解析", () => {
  const r = importSpecTemplates("sv1", "co_1", blankTemplates());
  assert.equal(r.unresolved.length, 0, JSON.stringify(r.unresolved));
  assert.equal(r.bundle.modules.length, 2);
});

// ── 入驻会话 ──────────────────────────────────────────────────────────────

test("干净导入直接进入 ready", () => {
  const { session } = startSession("co_1", AT);
  const r = ingestTemplates(session, good, AT);
  assert.equal(r.session.status, "ready");
  assert.equal(r.session.questions.length, 0);
});

test("有待确认项时进入 reviewing 并生成追问", () => {
  const { session } = startSession("co_1", AT);
  const r = ingestTemplates(session, {
    ...good,
    modules: "code,type,widths,heights,depths\nACME999,base,30,34.5,24\n",
  }, AT);
  assert.equal(r.session.status, "reviewing");
  assert.ok(r.session.questions.length > 0);
  assert.match(r.session.questions[0]!.prompt, /正视图上长什么样/);
});

test("待确认项未清空不允许发布", () => {
  const { session } = startSession("co_1", AT);
  const r = ingestTemplates(session, {
    ...good,
    modules: "code,type,widths,heights,depths\nACME999,base,30,34.5,24\n",
  }, AT);
  assert.throws(
    () => assertPublishable(r.session, r.bundle),
    (e: unknown) => e instanceof OnboardingError && e.code === "UNRESOLVED_ITEMS",
  );
});

const oneUnknown = {
  ...good,
  modules: "code,type,widths,heights,depths\nACME999,base,30,34.5,24\n",
  priceMatrix: "moduleCode,priceGroup,listPrice\nACME999,A,100.00\n",
};

function ingestOne() {
  const { session } = startSession("co_1", AT);
  return ingestTemplates(session, oneUnknown, AT);
}

test("回答追问会计入人工修正次数", () => {
  const r = ingestOne();
  const q = r.session.questions.find((x) => /正视图/.test(x.prompt))!;
  const after = answerQuestion(r.session, r.bundle, q.id, { faceTemplateId: "F2_DOUBLE_DOOR" }, AT);
  assert.equal(after.session.manualCorrections, 1);
});

test("回答**必须带值并真的落到规格上**——只把警报关掉等于没答", () => {
  // 这是零静默失败的反面：一个看起来被处理过、实际什么也没改的待确认项，
  // 比不提示更糟——因为没有人会再回头看它
  const r = ingestOne();
  const q = r.session.questions.find((x) => /正视图/.test(x.prompt))!;
  const after = answerQuestion(r.session, r.bundle, q.id, { faceTemplateId: "F2_DOUBLE_DOOR" }, AT);

  assert.equal(after.bundle.modules[0]!.faceTemplateId, "F2_DOUBLE_DOOR",
    "答案没有落到规格上——那个柜子会带着一张空脸走到正视图上");
  assert.equal(after.session.unresolved.some((u) => u.field === "faceTemplate"), false,
    "答完了那一条还留在队列里");
});

test("不给值就不算答完", () => {
  const r = ingestOne();
  const q = r.session.questions.find((x) => /正视图/.test(x.prompt))!;
  assert.throws(() => answerQuestion(r.session, r.bundle, q.id, {}, AT),
    (e: unknown) => e instanceof OnboardingError && e.code === "ANSWER_MISSING_VALUE");
});

test("答不上来的题不给「算你答过了」的出口，明说要改表重导", () => {
  const { session } = startSession("co_1", AT);
  const r = ingestTemplates(session, {
    ...good,
    priceMatrix: "moduleCode,priceGroup,listPrice\nB30,A,面议\n",
  }, AT);
  const q = r.session.questions.find((x) => /标价|listPrice/.test(x.prompt));
  assert.ok(q, "价格解析不出来那一条应该有追问");
  assert.throws(() => answerQuestion(r.session, r.bundle, q.id, { faceTemplateId: "F1_SINGLE_DOOR" }, AT),
    (e: unknown) => e instanceof OnboardingError && e.code === "NOT_ANSWERABLE_INLINE");
});

test("答掉一条之后，剩下追问的索引要重新对齐", () => {
  // 不重算的话，下一个答案会落到另一个型号身上——那种错不会报错，
  // 只会让某个柜子悄悄换了脸
  const { session } = startSession("co_1", AT);
  const r = ingestTemplates(session, {
    ...good,
    modules: "code,type,widths,heights,depths\nACME111,base,30,34.5,24\nACME222,wall,30,30,12\n",
    priceMatrix: "moduleCode,priceGroup,listPrice\nACME111,A,100.00\nACME222,A,90.00\n",
  }, AT);

  const faceQs = r.session.questions.filter((x) => /正视图/.test(x.prompt));
  assert.equal(faceQs.length, 2);
  const first = answerQuestion(r.session, r.bundle, faceQs[0]!.id, { faceTemplateId: "F2_DOUBLE_DOOR" }, AT);

  // 第二条现在必须仍然指向 ACME222，而不是被错位到别的型号上
  const second = first.session.questions.find((x) => x.id === faceQs[1]!.id)!;
  const item = first.session.unresolved[second.unresolvedIndex]!;
  assert.equal(item.raw, "ACME222", `索引错位了，第二条指向 ${item.raw}`);

  const done = answerQuestion(first.session, first.bundle, second.id, { faceTemplateId: "F1_SINGLE_DOOR" }, AT);
  const byCode = new Map(done.bundle.modules.map((m) => [m.code, m.faceTemplateId]));
  assert.equal(byCode.get("ACME111"), "F2_DOUBLE_DOOR");
  assert.equal(byCode.get("ACME222"), "F1_SINGLE_DOOR");
});

test("没有价格的型号不允许发布", () => {
  const { session } = startSession("co_1", AT);
  const r = ingestTemplates(session, {
    ...good,
    modules: good.modules + "\nB18,base,18,34-1/2,24,RTA",
  }, AT);
  assert.throws(
    () => assertPublishable(r.session, r.bundle),
    (e: unknown) => e instanceof OnboardingError && e.code === "MODULES_WITHOUT_PRICE",
  );
});

test("发布产生 published 版本，旧版转 archived", () => {
  const { session, draftVersion } = startSession("co_1", AT);
  const r = ingestTemplates(session, good, AT);
  const prior: ProductSpecVersion = {
    id: "sv_old", companyId: "co_1", versionNo: 0, status: "published",
    currency: "CAD", construction: "framed", overlay: "full", effectiveFrom: "2025-01-01T00:00:00.000Z",
  };
  const out = publish(r.session, r.bundle, [prior, draftVersion], "ops@x.example", AT);
  assert.equal(out.session.status, "published");
  assert.equal(out.result.published.status, "published");
  assert.equal(out.result.published.publishedBy, "ops@x.example");
  assert.equal(out.result.archived!.id, "sv_old");
  assert.equal(out.result.archived!.effectiveTo, AT);
});

test("已发布的版本不可再次发布", () => {
  const { session, draftVersion } = startSession("co_1", AT);
  const r = ingestTemplates(session, good, AT);
  const published: ProductSpecVersion = { ...draftVersion, status: "published" };
  assert.throws(() => publish(r.session, r.bundle, [published], "ops", AT), /不可修改|IMMUTABLE/);
});

// ── 量化验收 ──────────────────────────────────────────────────────────────

test("双路对账只暴露分歧项", () => {
  const a = [
    { moduleCode: "B30", priceGroupCode: "A", listPrice: fromDollars("245.50") },
    { moduleCode: "B12", priceGroupCode: "A", listPrice: fromDollars("142.00") },
    { moduleCode: "W3030", priceGroupCode: "A", listPrice: fromDollars("178.00") },
  ];
  const b = [
    { moduleCode: "B30", priceGroupCode: "A", listPrice: fromDollars("245.50") },
    { moduleCode: "B12", priceGroupCode: "A", listPrice: fromDollars("142.50") }, // 分歧
    { moduleCode: "SB36", priceGroupCode: "A", listPrice: fromDollars("284.00") }, // A 路缺失
  ];
  const r = reconcile(a, b);
  assert.equal(r.agreed, 1);
  assert.equal(r.disagreements.length, 3);
  assert.ok(r.disagreements.some((d) => d.kind === "valueMismatch" && d.moduleCode === "B12"));
  assert.ok(r.disagreements.some((d) => d.kind === "missingInB" && d.moduleCode === "W3030"));
  assert.ok(r.disagreements.some((d) => d.kind === "missingInA" && d.moduleCode === "SB36"));
});

test("分层抽样覆盖每个 (柜类 × 价格组) 且含价格极值", () => {
  const { bundle } = importSpecTemplates("sv1", "co_1", good);
  const plan = planStratifiedSample(bundle, { minPerStratum: 2, minTotal: 4 });
  const strata = new Set(plan.strata.map((s) => s.stratum));
  assert.ok(strata.has("base×A"));
  assert.ok(strata.has("base×B"));
  assert.ok(strata.has("wall×A"));
  assert.ok(strata.has("sinkBase×A"));
  // base×A 里最贵(B30 245.50)与最便宜(B12 142.00)都应被抽到
  const baseA = plan.cells.filter((c) => c.priceGroupCode === "A" && ["B30", "B12"].includes(c.moduleCode));
  assert.equal(baseA.length, 2);
});

test("抽样量不足时给出 rule of three 的明确警告", () => {
  const { bundle } = importSpecTemplates("sv1", "co_1", good);
  const plan = planStratifiedSample(bundle);
  assert.ok(plan.warnings.some((w) => w.includes("rule of three")));
});

test("价格准确率 0 容错：一条不一致即不通过", () => {
  const planned = [
    { moduleCode: "B30", priceGroupCode: "A", listPrice: fromDollars("245.50") },
    { moduleCode: "B12", priceGroupCode: "A", listPrice: fromDollars("142.00") },
  ];
  const truth = [
    { moduleCode: "B30", priceGroupCode: "A", listPrice: fromDollars("245.50") },
    { moduleCode: "B12", priceGroupCode: "A", listPrice: fromDollars("142.50") },
  ];
  const report = evaluateSample(planned, truth);
  assert.equal(report.sampled, 2);
  assert.equal(report.mismatches.length, 1);
  assert.ok(report.accuracy < THRESHOLDS.priceAccuracy);
});

test("验收报告：干净导入 + 达标抽样 → 通过", () => {
  const r = importSpecTemplates("sv1", "co_1", good);
  const cells = r.bundle.priceMatrix.map((e) => ({
    moduleCode: r.bundle.modules.find((m) => m.id === e.moduleId)!.code,
    priceGroupCode: r.bundle.priceGroups.find((g) => g.id === e.priceGroupId)!.code,
    listPrice: e.listPrice,
  }));
  const report = evaluateAcceptance({
    bundle: r.bundle,
    unresolved: r.unresolved,
    sourceSkuCount: 4,
    faceTemplateRuleHits: r.stats.faceTemplateRuleHits,
    manualCorrections: 3,
    endToEndHours: 1.5,
    faceTemplateErrors: 0,
    sampling: { ...evaluateSample(cells, cells), sampled: 100 },
  });
  assert.equal(report.pass, true, report.blockers.join("; "));
});

test("验收报告：召回率不足与待确认项都会成为 blocker", () => {
  const r = importSpecTemplates("sv1", "co_1", {
    ...good,
    modules: good.modules + "\nACME999,base,30,34.5,24,RTA",
  });
  const report = evaluateAcceptance({
    bundle: r.bundle,
    unresolved: r.unresolved,
    sourceSkuCount: 100, // 人工数出 100 个，只导进来 4 个
    faceTemplateRuleHits: r.stats.faceTemplateRuleHits,
    manualCorrections: 3,
    endToEndHours: 1,
    faceTemplateErrors: 0,
  });
  assert.equal(report.pass, false);
  assert.ok(report.blockers.some((b) => b.includes("SKU 召回率")));
  assert.ok(report.blockers.some((b) => b.includes("待确认项")));
  assert.ok(report.blockers.some((b) => b.includes("分层抽样")));
});
