/**
 * FR-8 硬校验 —— REQUIREMENTS FR-8 第 1、2 条。
 *
 * 两件事：
 *   1. `stripPriceFields`：把 LLM 输出里任何形如价格的字段**丢弃**。
 *      只校验「型号 id 存在」挡不住「存在的型号 id + 编造的价格」，后者更危险，
 *      因为它能通过所有 id 校验并被发送出去。
 *   2. `validateSelections`：6 项硬校验，任一失败即拒绝，**不做「自动修正后继续」**。
 */
import { priceEntryFor } from "./finish.js";
import type {
  AccessoryOption, BoxMaterialOption, CompanyCodingRules, DoorStyle, HardwareOption,
  ModuleSelection, ModuleSpec, PriceMatrixEntry, Province, TaxRule,
} from "../domain/types.js";
import {
  priceGroupLooksLikeBoxDoorSuffix, resolveModuleSellUnit,
} from "./sku-semantics.js";

/** 出现在模型输出里就要被丢弃的字段名（不区分大小写）。 */
const PRICE_FIELD_PATTERN =
  /^(unit)?(list|net|retail|trade)?price$|^amount$|^subtotal$|^total$|^cost$|^fee$|^lineSubtotal$|^unitPrice$|^priceRange$|^estimatedPrice$/i;

export interface StripResult {
  selections: ModuleSelection[];
  /** 被丢弃的字段路径，用于审计——模型试图报价这件事本身值得记录。 */
  strippedPaths: string[];
}

/**
 * 从 LLM 的原始输出中提取合法的「选择」，丢弃一切价格字段。
 *
 * 这是 LLM 输出进入系统的唯一入口，故意写成白名单：只有列出的字段会被保留。
 */
export function stripPriceFields(raw: unknown): StripResult {
  const strippedPaths: string[] = [];
  const rows = Array.isArray(raw) ? raw : [];
  const selections: ModuleSelection[] = [];

  rows.forEach((row, i) => {
    if (typeof row !== "object" || row === null) return;
    const r = row as Record<string, unknown>;

    for (const key of Object.keys(r)) {
      if (PRICE_FIELD_PATTERN.test(key)) strippedPaths.push(`[${i}].${key}`);
    }

    const moduleId = typeof r["moduleId"] === "string" ? r["moduleId"] : undefined;
    if (!moduleId) return;

    selections.push({
      moduleId,
      qty: toPositiveInt(r["qty"]) ?? 1,
      width: toNumber(r["width"]) ?? 0,
      height: toNumber(r["height"]) ?? 0,
      depth: toNumber(r["depth"]) ?? 0,
      assembly: r["assembly"] === "assembled" ? "assembled" : "RTA",
      hardwareOptionIds: toStringArray(r["hardwareOptionIds"]),
      accessoryOptionIds: toStringArray(r["accessoryOptionIds"]),
    });
  });

  return { selections, strippedPaths };
}

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function toPositiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}
function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ── 6 项硬校验 ────────────────────────────────────────────────────────────

export type ValidationCode =
  | "MODULE_NOT_IN_PUBLISHED_SPEC"
  | "DIMENSION_NOT_IN_OPTIONS"
  | "DOOR_STYLE_NOT_IN_SPEC"
  | "BOX_MATERIAL_NOT_IN_SPEC"
  | "PRICE_MATRIX_HOLE"
  | "OPTION_NOT_IN_SPEC"
  | "OPTION_NOT_APPLICABLE"
  | "TAX_RULE_NOT_FOUND"
  | "ASSEMBLY_NOT_OFFERED"
  | "EMPTY_SELECTION";

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  selectionIndex?: number;
}

export interface ValidationContext {
  specVersionId: string;
  companyId: string;
  modules: readonly ModuleSpec[];
  doorStyles: readonly DoorStyle[];
  priceMatrix: readonly PriceMatrixEntry[];
  hardwareOptions: readonly HardwareOption[];
  accessoryOptions: readonly AccessoryOption[];
  /** 箱体板材档位。老规格版本没有这一维，缺省当作空。 */
  boxMaterialOptions?: readonly BoxMaterialOption[];
  taxRules: readonly TaxRule[];
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * 生成 Quote 前的硬校验。全部通过才允许继续。
 *
 * 对应 FR-8 第 2 条的 6 项：
 *   1. 型号存在于该公司的 published 规格版本
 *   2. 尺寸落在离散候选集内（不接受「接近的尺寸」）
 *   3. 门板属于该公司同一版本，且其价格组对该型号有价格条目
 *   4. 五金/配件属于该公司、同版本、且适用于该型号
 *   5. 客户省份能查到当时生效的税率
 *   6. 引擎重算与快照一致（由调用方在写入前用 verifySnapshot 完成）
 */
export function validateSelections(
  ctx: ValidationContext,
  selections: readonly ModuleSelection[],
  doorStyleId: string,
  province: Province,
  at: string,
  boxMaterialId?: string,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // 箱体板材：客户明确选了一档，那一档就必须属于这家公司的这一版规格。
  // 与门板同样的口径——放行一个不存在的 id，定价那边会当场抛，
  // 而客户看到的只是一句"报价校验未通过"。
  if (boxMaterialId !== undefined) {
    const box = (ctx.boxMaterialOptions ?? []).find(
      (o) => o.id === boxMaterialId
        && o.specVersionId === ctx.specVersionId && o.companyId === ctx.companyId);
    if (!box) {
      issues.push({
        code: "BOX_MATERIAL_NOT_IN_SPEC",
        message: `Box material ${boxMaterialId} is not in this company's current published spec`,
      });
    }
  }

  if (selections.length === 0) {
    issues.push({ code: "EMPTY_SELECTION", message: "A quote requires at least one module" });
  }

  // 校验 3（上半）：门板必须属于该公司的这一版规格
  const doorStyle = ctx.doorStyles.find(
    (d) => d.id === doorStyleId && d.specVersionId === ctx.specVersionId && d.companyId === ctx.companyId,
  );
  if (!doorStyle) {
    issues.push({
      code: "DOOR_STYLE_NOT_IN_SPEC",
      message: `Door style ${doorStyleId} is not in this company's current published spec`,
    });
  }

  selections.forEach((sel, i) => {
    // 校验 1
    const mod = ctx.modules.find(
      (m) => m.id === sel.moduleId && m.specVersionId === ctx.specVersionId && m.companyId === ctx.companyId,
    );
    if (!mod) {
      issues.push({
        code: "MODULE_NOT_IN_PUBLISHED_SPEC",
        message: `Module ${sel.moduleId} is not in this company's current published spec`,
        selectionIndex: i,
      });
      return; // 型号都不存在，后续校验无从谈起
    }

    // 校验 2：尺寸必须是候选集里的离散值
    for (const [dim, value, options] of [
      ["width", sel.width, mod.widthOptions],
      ["height", sel.height, mod.heightOptions],
      ["depth", sel.depth, mod.depthOptions],
    ] as const) {
      if (!options.includes(value)) {
        issues.push({
          code: "DIMENSION_NOT_IN_OPTIONS",
          message: `Module ${mod.code}: ${dim} ${value}" is not in options [${options.join(", ")}]`,
          selectionIndex: i,
        });
      }
    }

    if (!mod.assemblyOptions.includes(sel.assembly)) {
      issues.push({
        code: "ASSEMBLY_NOT_OFFERED",
        message: `Module ${mod.code} does not offer ${sel.assembly} assembly`,
        selectionIndex: i,
      });
    }

    // 校验 3（下半）：价格矩阵在该 (型号 × 价格组) 上必须有条目。
    //
    // `finishDependent: false` 的型号（塑料地脚）只需要一行——它的价格不随
    // 花色变，要求逐花色都有价会把"本来就不需要多行"误报成价格空洞（§3.5.5）。
    // 判断与定价引擎共用 `priceEntryFor`，不在这里再写一遍。
    if (doorStyle) {
      const entry = priceEntryFor(
        mod, doorStyle.priceGroupId,
        ctx.priceMatrix.filter((e) => e.specVersionId === ctx.specVersionId),
      );
      if (!entry) {
        issues.push({
          code: "PRICE_MATRIX_HOLE",
          message: `Module ${mod.code} has no price for door style ${doorStyle.name}'s price group`,
          selectionIndex: i,
        });
      }
    }

    // 校验 4：五金/配件归属与适用性
    for (const hwId of sel.hardwareOptionIds) {
      const hw = ctx.hardwareOptions.find(
        (h) => h.id === hwId && h.specVersionId === ctx.specVersionId && h.companyId === ctx.companyId,
      );
      if (!hw) {
        issues.push({
          code: "OPTION_NOT_IN_SPEC",
          message: `Hardware option ${hwId} is not in this company's current published spec`,
          selectionIndex: i,
        });
      } else if (hw.appliesToModuleTypes && !hw.appliesToModuleTypes.includes(mod.type)) {
        issues.push({
          code: "OPTION_NOT_APPLICABLE",
          message: `Hardware ${hw.name} does not apply to ${mod.type} module ${mod.code}`,
          selectionIndex: i,
        });
      }
    }
    for (const acId of sel.accessoryOptionIds) {
      const ac = ctx.accessoryOptions.find(
        (a) => a.id === acId && a.specVersionId === ctx.specVersionId && a.companyId === ctx.companyId,
      );
      if (!ac) {
        issues.push({
          code: "OPTION_NOT_IN_SPEC",
          message: `Accessory option ${acId} is not in this company's current published spec`,
          selectionIndex: i,
        });
      } else if (ac.appliesToModuleIds && !ac.appliesToModuleIds.includes(mod.id)) {
        issues.push({
          code: "OPTION_NOT_APPLICABLE",
          message: `Accessory ${ac.name} does not apply to module ${mod.code}`,
          selectionIndex: i,
        });
      }
    }
  });

  // 校验 5：税率可查
  const t = Date.parse(at);
  const taxHit = ctx.taxRules.find(
    (r) =>
      r.province === province &&
      Date.parse(r.effectiveFrom) <= t &&
      (r.effectiveTo === undefined || t < Date.parse(r.effectiveTo)),
  );
  if (!taxHit) {
    issues.push({
      code: "TAX_RULE_NOT_FOUND",
      message: `No tax rule found for ${province} effective at ${at}`,
    });
  }

  return { ok: issues.length === 0, issues };
}

// ── FR-16 规格语义校验（导入/发布门槛）────────────────────────────────────

export type SpecSemanticsCode =
  | "PRICE_GROUP_MASQUERADES_BOX_DOOR"
  | "SELL_UNIT_CONTRADICTS_TYPE"
  | "SELL_UNIT_INFERRED";

export interface SpecSemanticsIssue {
  code: SpecSemanticsCode;
  message: string;
  /** inferred 为提示；其余为阻断。 */
  severity: "blocking" | "advisory";
  ref?: string;
}

/**
 * 发布前的 FR-16 语义检查：
 * - PriceGroup 不得用 BOX/DOOR 后缀冒充售卖单元
 * - trim 类型不得声明为 combo/box/door（与 trim BOM 自相矛盾）
 * - 未声明 sellUnit 的推断结果标 advisory（待确认）
 */
export function validateSpecSemantics(input: {
  modules: readonly ModuleSpec[];
  priceGroups: readonly { code: string; id?: string }[];
  codingRules?: CompanyCodingRules;
}): SpecSemanticsIssue[] {
  const issues: SpecSemanticsIssue[] = [];

  for (const pg of input.priceGroups) {
    if (priceGroupLooksLikeBoxDoorSuffix(pg.code)) {
      issues.push({
        code: "PRICE_GROUP_MASQUERADES_BOX_DOOR",
        severity: "blocking",
        ref: pg.code,
        message: `PriceGroup "${pg.code}" looks like a BOX/DOOR sell-unit suffix — ` +
          `use real module rows (e.g. B12-PLY-BOX) instead of PriceGroup masquerading`,
      });
    }
  }

  for (const mod of input.modules) {
    const resolved = resolveModuleSellUnit(mod, input.codingRules);
    const trimType = ["filler", "panel", "toeKick", "crown", "leg"].includes(mod.type);
    if (trimType && mod.sellUnit && mod.sellUnit !== "standalone") {
      issues.push({
        code: "SELL_UNIT_CONTRADICTS_TYPE",
        severity: "blocking",
        ref: mod.code,
        message: `Module ${mod.code} is type ${mod.type} but declares sellUnit=${mod.sellUnit}; ` +
          `trim types must be standalone`,
      });
    }
    if (!mod.sellUnit && resolved.inferred) {
      issues.push({
        code: "SELL_UNIT_INFERRED",
        severity: "advisory",
        ref: mod.code,
        message: `Module ${mod.code}: sellUnit inferred as ${resolved.sellUnit} (${resolved.reason})`,
      });
    }
  }

  return issues;
}
