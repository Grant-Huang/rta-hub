/**
 * 测试夹具 —— 一家虚构的试点公司，规格数据取自 rta-generic-spec 的真实型号与尺寸。
 */
import { fromDollars } from "../src/domain/money.js";
import type {
  AccessoryOption, CabinetCompany, DiscountRule, DoorStyle, HardwareOption,
  ModuleSpec, PriceGroup, PriceMatrixEntry, ProductSpecVersion, ShippingRule,
} from "../src/domain/types.js";
import type { PricingContext } from "../src/pricing/engine.js";
import { SEED_TAX_RULES } from "../src/pricing/tax.js";

export const COMPANY_ID = "co_maple";
export const SPEC_V1 = "spec_maple_v1";

export const company: CabinetCompany = {
  id: COMPANY_ID,
  name: "Maple Cabinetry",
  aliases: ["枫叶橱柜", "Maple"],
  quoteEmail: "quotes@maple.example",
  province: "ON",
  serviceAreas: ["ON"],
  billingPlan: { leadFeeEnabled: true, personalizationSubscription: "active" },
  currentPublishedSpecVersionId: SPEC_V1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

export const specVersion: ProductSpecVersion = {
  id: SPEC_V1,
  companyId: COMPANY_ID,
  versionNo: 1,
  status: "published",
  currency: "CAD",
  construction: "framed",
  overlay: "full",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  publishedAt: "2026-01-01T00:00:00.000Z",
  publishedBy: "ops@maple.example",
};

const base = { specVersionId: SPEC_V1, companyId: COMPANY_ID };

export const priceGroups: PriceGroup[] = [
  { ...base, id: "pg_a", code: "A", displayName: "Standard", rank: 1 },
  { ...base, id: "pg_b", code: "B", displayName: "Premium", rank: 2 },
];

export const doorStyles: DoorStyle[] = [
  { ...base, id: "ds_shaker_white", name: "Shaker White", priceGroupId: "pg_a" },
  { ...base, id: "ds_maple_glaze", name: "Maple Glaze", priceGroupId: "pg_b" },
];

export const modules: ModuleSpec[] = [
  {
    ...base, id: "m_b12", code: "B12", type: "base",
    widthOptions: [12], heightOptions: [34.5], depthOptions: [24],
    faceTemplateId: "F3_DRAWER_OVER_DOOR", assemblyOptions: ["RTA", "assembled"],
  },
  {
    ...base, id: "m_b30", code: "B30", type: "base",
    widthOptions: [30], heightOptions: [34.5], depthOptions: [24],
    faceTemplateId: "F5_TWO_DRAWERS_OVER_DOUBLE", assemblyOptions: ["RTA", "assembled"],
  },
  {
    ...base, id: "m_w3030", code: "W3030", type: "wall",
    widthOptions: [30], heightOptions: [30, 36, 42], depthOptions: [12],
    faceTemplateId: "F2_DOUBLE_DOOR", assemblyOptions: ["RTA"],
  },
  {
    ...base, id: "m_sb36", code: "SB36", type: "sinkBase",
    widthOptions: [36], heightOptions: [34.5], depthOptions: [24],
    faceTemplateId: "F7_FALSE_FRONT_DOUBLE", assemblyOptions: ["RTA"],
  },
];

/**
 * 价格矩阵。**故意留一个空洞**：SB36 只供应价格组 A，不供应 B——
 * 用来验证 FR-8 校验 3 会拒绝该组合，而不是回退到某个默认价。
 */
export const priceMatrix: PriceMatrixEntry[] = [
  { ...base, moduleId: "m_b12", priceGroupId: "pg_a", listPrice: fromDollars("120.00"), assembledUpcharge: { kind: "percent", value: 15 } },
  { ...base, moduleId: "m_b12", priceGroupId: "pg_b", listPrice: fromDollars("186.00") },
  { ...base, moduleId: "m_b30", priceGroupId: "pg_a", listPrice: fromDollars("245.50") },
  { ...base, moduleId: "m_b30", priceGroupId: "pg_b", listPrice: fromDollars("398.75") },
  { ...base, moduleId: "m_w3030", priceGroupId: "pg_a", listPrice: fromDollars("178.00") },
  { ...base, moduleId: "m_w3030", priceGroupId: "pg_b", listPrice: fromDollars("289.00") },
  { ...base, moduleId: "m_sb36", priceGroupId: "pg_a", listPrice: fromDollars("310.00") },
  // m_sb36 × pg_b 缺失 —— 价格矩阵空洞
];

export const hardwareOptions: HardwareOption[] = [
  {
    ...base, id: "hw_softclose", name: "Soft-close hinge",
    priceModifier: { kind: "flat", value: fromDollars("18.00") },
    appliesToModuleTypes: ["base", "wall", "tall", "corner", "sinkBase"],
  },
  {
    ...base, id: "hw_wall_only", name: "Wall-only bracket",
    priceModifier: { kind: "flat", value: fromDollars("9.00") },
    appliesToModuleTypes: ["wall"],
  },
];

export const accessoryOptions: AccessoryOption[] = [
  {
    ...base, id: "ac_rollout", name: "Roll-out tray",
    priceModifier: { kind: "percent", value: 10 },
    appliesToModuleIds: ["m_b30"],
  },
];

export const discountRules: DiscountRule[] = [
  {
    ...base, id: "dr_trade_15", audience: "trade", kind: "percentOffList",
    value: 15, stackable: true, description: "贸易账号标价 15% off",
  },
  {
    ...base, id: "dr_volume", audience: "consumer", kind: "tieredByOrderValue",
    tiers: [
      { minSubtotal: fromDollars("1000.00"), percentOff: 5 },
      { minSubtotal: fromDollars("5000.00"), percentOff: 10 },
    ],
    stackable: true, description: "满额折扣",
  },
];

export const shippingFreeOver: ShippingRule = {
  ...base, id: "sr_free_over", kind: "freeOver",
  freeOverThreshold: fromDollars("2000.00"),
  belowThresholdAmount: fromDollars("150.00"),
};

export function makeContext(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    specVersionId: SPEC_V1,
    companyId: COMPANY_ID,
    modules,
    doorStyles,
    priceMatrix,
    hardwareOptions,
    accessoryOptions,
    discountRules,
    shippingRule: shippingFreeOver,
    taxRules: SEED_TAX_RULES,
    ...overrides,
  };
}
