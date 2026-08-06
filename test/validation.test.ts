/**
 * FR-8 硬校验测试 —— 重点是「存在的型号 id + 编造的价格」这条攻击路径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripPriceFields, validateSelections, type ValidationContext } from "../src/spec/validation.js";
import { SEED_TAX_RULES } from "../src/pricing/tax.js";
import {
  COMPANY_ID, SPEC_V1, accessoryOptions, doorStyles, hardwareOptions, modules, priceMatrix,
} from "./fixtures.js";

const ctx: ValidationContext = {
  specVersionId: SPEC_V1, companyId: COMPANY_ID,
  modules, doorStyles, priceMatrix, hardwareOptions, accessoryOptions,
  taxRules: SEED_TAX_RULES,
};
const AT = "2026-06-01T00:00:00.000Z";

const ok = (over = {}) => ({
  moduleId: "m_b30", qty: 1, width: 30, height: 34.5, depth: 24,
  assembly: "RTA" as const, hardwareOptionIds: [], accessoryOptionIds: [], ...over,
});

test("stripPriceFields 丢弃 LLM 输出里的所有价格字段", () => {
  const raw = [{
    moduleId: "m_b30", qty: 2, width: 30, height: 34.5, depth: 24,
    // 模型编造的价格 —— 这些必须全部消失
    unitPrice: 99.99, listPrice: 1, total: 12345, subtotal: 1, amount: 7, cost: 3, fee: 2,
  }];
  const { selections, strippedPaths } = stripPriceFields(raw);
  assert.equal(selections.length, 1);
  assert.equal(selections[0]!.moduleId, "m_b30");
  assert.equal(selections[0]!.qty, 2);
  // 结果对象里不含任何价格键
  const keys = Object.keys(selections[0]!);
  for (const bad of ["unitPrice", "listPrice", "total", "subtotal", "amount", "cost", "fee"]) {
    assert.ok(!keys.includes(bad), `${bad} 不应出现在 selection 里`);
  }
  assert.equal(strippedPaths.length, 7);
});

test("stripPriceFields 是白名单：未知字段不会透传", () => {
  const { selections } = stripPriceFields([{ moduleId: "m_b12", qty: 1, evilField: "x", __proto__: { polluted: 1 } }]);
  assert.deepEqual(Object.keys(selections[0]!).sort(), [
    "accessoryOptionIds", "assembly", "depth", "hardwareOptionIds", "height", "moduleId", "qty", "width",
  ]);
});

test("缺 moduleId 的行被丢弃", () => {
  const { selections } = stripPriceFields([{ qty: 1 }, { moduleId: "m_b12" }]);
  assert.equal(selections.length, 1);
});

test("校验 1：型号必须在该公司 published 规格版本内", () => {
  const r = validateSelections(ctx, [ok({ moduleId: "m_nonexistent" })], "ds_shaker_white", "ON", AT);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0]!.code, "MODULE_NOT_IN_PUBLISHED_SPEC");
});

test("校验 1：别家公司的型号不算数（租户隔离）", () => {
  const foreign = { ...modules[0]!, id: "m_foreign", companyId: "co_other" };
  const r = validateSelections(
    { ...ctx, modules: [...modules, foreign] },
    [ok({ moduleId: "m_foreign", width: 12 })], "ds_shaker_white", "ON", AT,
  );
  assert.equal(r.ok, false);
  assert.equal(r.issues[0]!.code, "MODULE_NOT_IN_PUBLISHED_SPEC");
});

test("校验 2：尺寸必须是离散候选值，不接受接近的值", () => {
  const r = validateSelections(ctx, [ok({ width: 31 })], "ds_shaker_white", "ON", AT);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0]!.code, "DIMENSION_NOT_IN_OPTIONS");
  assert.match(r.issues[0]!.message, /31"/);
});

test("校验 3：价格矩阵空洞被拒绝", () => {
  const r = validateSelections(
    ctx, [ok({ moduleId: "m_sb36", width: 36 })], "ds_maple_glaze", "ON", AT,
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === "PRICE_MATRIX_HOLE"));
});

test("校验 3：门板必须属于该公司同一版本", () => {
  const r = validateSelections(ctx, [ok()], "ds_not_ours", "ON", AT);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === "DOOR_STYLE_NOT_IN_SPEC"));
});

test("校验 4：五金必须适用于该型号类型", () => {
  // hw_wall_only 只适用 wall，用在 base 型号上应被拒
  const r = validateSelections(ctx, [ok({ hardwareOptionIds: ["hw_wall_only"] })], "ds_shaker_white", "ON", AT);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === "OPTION_NOT_APPLICABLE"));
});

test("校验 4：配件必须适用于该型号", () => {
  const r = validateSelections(
    ctx, [ok({ moduleId: "m_b12", width: 12, accessoryOptionIds: ["ac_rollout"] })],
    "ds_shaker_white", "ON", AT,
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === "OPTION_NOT_APPLICABLE"));
});

test("校验 5：查不到省份税率时拒绝", () => {
  const r = validateSelections({ ...ctx, taxRules: [] }, [ok()], "ds_shaker_white", "ON", AT);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === "TAX_RULE_NOT_FOUND"));
});

test("不提供的组装形式被拒绝", () => {
  const r = validateSelections(
    ctx, [ok({ moduleId: "m_w3030", width: 30, height: 30, depth: 12, assembly: "assembled" })],
    "ds_shaker_white", "ON", AT,
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === "ASSEMBLY_NOT_OFFERED"));
});

test("空选择被拒绝", () => {
  const r = validateSelections(ctx, [], "ds_shaker_white", "ON", AT);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === "EMPTY_SELECTION"));
});

test("合法选择通过全部校验", () => {
  const r = validateSelections(
    ctx,
    [ok({ hardwareOptionIds: ["hw_softclose"], accessoryOptionIds: ["ac_rollout"] })],
    "ds_shaker_white", "ON", AT,
  );
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test("多个问题会一次性全部报出，不是遇到第一个就停", () => {
  const r = validateSelections(
    ctx, [ok({ width: 99 }), ok({ moduleId: "m_ghost" })], "ds_ghost", "ON", AT,
  );
  assert.ok(r.issues.length >= 3, `期望至少 3 个问题，实际 ${r.issues.length}`);
});
