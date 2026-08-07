/**
 * 箱体 —— 哪些件有"盒子"，以及箱体板材怎么作用到价格上。
 *
 * 这是 `spec/finish.ts` 的兄弟模块，两者回答的是同一形状的问题：
 *
 *   - `finish.ts`：这个件的价格**随不随门板花色**变？
 *   - `carcass.ts`：这个件**有没有箱体**、因而随不随箱体板材变？
 *
 * 两条判定都只写一处，定价与校验共用。各写一份的代价前面已经付过一次：
 * 「校验放行、定价当场抛价格空洞」，而客户看到的只是一句"报价校验未通过"。
 */
import { percentOf, type Money } from "../domain/money.js";
import type { BoxMaterialOption, ModuleSpec, Modifier } from "../domain/types.js";

/**
 * 没有箱体的类别。
 *
 * 填缝条、收口板、踢脚板、顶线是**一块板**；塑料地脚是**一个塑料件**。
 * 它们都谈不上"用什么板做盒子"，所以升级全夹板时它们不加价。
 *
 * 给它们乘上全夹板的加价是凭空加价——和当初给塑料地脚编一个
 * "高级花色版价格"是同一类错（见 `finish.ts`）。
 */
const CARCASSLESS_TYPES: ReadonlySet<ModuleSpec["type"]> = new Set([
  "filler", "panel", "toeKick", "crown", "leg",
]);

/** 这个型号有没有箱体。 */
export function hasCarcass(module: ModuleSpec): boolean {
  return !CARCASSLESS_TYPES.has(module.type);
}

/**
 * 选出这份报价该用哪一档箱体板材。
 *
 * 客户没选就用商家的默认档；商家一档都没给（老的规格版本、或者只做一种板材）
 * 返回 `undefined`——那时候不加任何修饰项，报价与从前完全一致。
 *
 * **不静默回退到"最便宜的那档"**：客户明确选了某一档而那一档不存在，
 * 是数据错误，该由校验拦下来说清楚，不是在这里挑一个凑合的。
 */
export function resolveBoxMaterial(
  options: readonly BoxMaterialOption[],
  chosenId: string | undefined,
): BoxMaterialOption | undefined {
  if (chosenId) return options.find((o) => o.id === chosenId);
  return options.find((o) => o.isDefault) ?? options[0];
}

/**
 * 箱体板材加在这一行上的金额。
 *
 * 基数是**标价**，与五金/配件同口径——所有百分比修饰项都以标价为基数、不叠乘，
 * 修饰项的顺序才不影响结果，报价才可复算（`pricing/engine.ts` 的运算顺序约定）。
 *
 * 没箱体的件、或者加价为零的档，返回 `undefined`：不往报价行上挂一条
 * "$0 颗粒板箱体"。逐行都挂一条 0 元修饰项，客户读到的是噪音，
 * 而真正该说的那句「这份价按的是哪一档箱体」在报价单抬头上。
 */
export function boxMaterialCharge(
  module: ModuleSpec,
  option: BoxMaterialOption | undefined,
  unitListPrice: Money,
): Money | undefined {
  if (!option || !hasCarcass(module)) return undefined;
  const amount = applyModifier(unitListPrice, option.priceModifier);
  return amount === 0 ? undefined : amount;
}

function applyModifier(base: Money, modifier: Modifier): Money {
  return modifier.kind === "flat" ? modifier.value : percentOf(base, modifier.value);
}

/** 归一化类别 → 中文名。商家没给 `name` 时兜底，也用于排序说明。 */
export const BOX_MATERIAL_LABEL: Record<BoxMaterialOption["code"], string> = {
  particleBoard: "颗粒板",
  plywood: "夹板",
  solidWood: "实木",
};

/**
 * 归一化类别 → 英文名。**PDF 专用。**
 *
 * PDF 用的是 base-14 字体，只覆盖 Latin-1——把商家的中文名直接印上去会变成
 * 一串 `?`。而 PDF 是发给商家、也是客户拿去下单的那一份，印成问号比不印更糟。
 *
 * 所以那一份印**归一化类别的英文名**：商家的叫法各不相同（「全夹板箱体」
 * 「Baltic Birch Box」），但 `code` 是同一个，英文名因此稳定且可比。
 */
export const BOX_MATERIAL_LABEL_EN: Record<BoxMaterialOption["code"], string> = {
  particleBoard: "Particle board box",
  plywood: "Plywood box",
  solidWood: "Solid wood box",
};

/** 由便宜到贵的常规顺序。选项按它排，客户从左到右就是从基础到高配。 */
const ORDER: BoxMaterialOption["code"][] = ["particleBoard", "plywood", "solidWood"];

export function sortBoxMaterials(
  options: readonly BoxMaterialOption[],
): BoxMaterialOption[] {
  return [...options].sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
}
