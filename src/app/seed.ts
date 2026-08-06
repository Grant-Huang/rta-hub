/**
 * 试点公司种子数据 —— MVP-1 的「先跑通 1 家」（REQUIREMENTS 第 9 节）。
 *
 * 型号、尺寸、编码全部取自 rta-generic-spec/ 的通用规范（核实结果见 RENDERING.md 附录）。
 * **价格是虚构的占位值**——真实价目表由该公司通过 FR-2 录入或模板导入。
 */
import { fromDollars } from "../domain/money.js";
import type {
  AccessoryOption, CabinetCompany, CustomerAccount, DiscountRule, DoorStyle,
  GenericCatalog, HardwareOption, ModuleSpec, PriceGroup, PriceMatrixEntry,
  ProductSpecVersion, ShippingRule,
} from "../domain/types.js";
import { matchFaceTemplate } from "../render/templates.js";

export const PILOT_COMPANY_ID = "co_pilot";
export const PILOT_SPEC_VERSION_ID = "spec_pilot_v1";
const NOW = "2026-01-01T00:00:00.000Z";
const base = { specVersionId: PILOT_SPEC_VERSION_ID, companyId: PILOT_COMPANY_ID };

export const pilotCompany: CabinetCompany = {
  id: PILOT_COMPANY_ID,
  name: "Maple Ridge Cabinetry",
  aliases: ["枫岭橱柜", "Maple Ridge", "MRC"],
  quoteEmail: "quotes@mapleridge.example",
  website: "https://mapleridge.example",
  contactName: "Sam Chen",
  province: "ON",
  serviceAreas: ["ON", "QC"],
  billingPlan: { leadFeeEnabled: true, personalizationSubscription: "active" },
  currentPublishedSpecVersionId: PILOT_SPEC_VERSION_ID,
  createdAt: NOW,
};

/** 一家已完成入驻但**未订阅**的公司——用于验证 FR-10 的降级路径。 */
export const unsubscribedCompany: CabinetCompany = {
  id: "co_northern",
  name: "Northern Wood Kitchens",
  aliases: ["北木厨柜"],
  quoteEmail: "info@northernwood.example",
  province: "BC",
  serviceAreas: ["BC"],
  billingPlan: { leadFeeEnabled: false, personalizationSubscription: "none" },
  currentPublishedSpecVersionId: "spec_northern_v1",
  createdAt: NOW,
};

export const pilotSpecVersion: ProductSpecVersion = {
  id: PILOT_SPEC_VERSION_ID,
  companyId: PILOT_COMPANY_ID,
  versionNo: 1,
  status: "published",
  currency: "CAD",
  construction: "framed",
  overlay: "full",
  effectiveFrom: NOW,
  publishedAt: NOW,
  publishedBy: "ops@mapleridge.example",
  changeNote: "MVP-1 试点初始版本",
};

export const pilotPriceGroups: PriceGroup[] = [
  { ...base, id: "pg_std", code: "A", displayName: "Standard", rank: 1 },
  { ...base, id: "pg_prem", code: "B", displayName: "Premium", rank: 2 },
];

export const pilotDoorStyles: DoorStyle[] = [
  { ...base, id: "ds_shaker_white", name: "Shaker White", priceGroupId: "pg_std", material: "Maple", color: "White" },
  { ...base, id: "ds_shaker_grey", name: "Shaker Grey", priceGroupId: "pg_std", material: "Maple", color: "Grey" },
  { ...base, id: "ds_maple_glaze", name: "Maple Glaze", priceGroupId: "pg_prem", material: "Maple", color: "Antique Glaze" },
  { ...base, id: "ds_navy", name: "Navy Shaker", priceGroupId: "pg_prem", material: "Maple", color: "Navy" },
];

/** 型号定义：(code, type, 宽度候选, 高度候选, 深度候选, Standard 价) */
const MODULE_DEFS: [string, ModuleSpec["type"], number[], number[], number[], string][] = [
  // 地柜（规范：深 24"、高 34.5"）
  ["B12", "base", [12], [34.5], [24], "142.00"],
  ["B15", "base", [15], [34.5], [24], "156.00"],
  ["B18", "base", [18], [34.5], [24], "171.00"],
  ["B21", "base", [21], [34.5], [24], "188.00"],
  ["B24", "base", [24], [34.5], [24], "212.00"],
  ["B30", "base", [30], [34.5], [24], "245.50"],
  ["B36", "base", [36], [34.5], [24], "289.00"],
  ["3DB24", "base", [24], [34.5], [24], "318.00"],
  ["3DB30", "base", [30], [34.5], [24], "356.00"],
  ["2DB30", "base", [30], [34.5], [24], "342.00"],
  ["SB33", "sinkBase", [33], [34.5], [24], "268.00"],
  ["SB36", "sinkBase", [36], [34.5], [24], "284.00"],
  ["BBC36", "corner", [36], [34.5], [24], "352.00"],
  ["LSB33", "corner", [33], [34.5], [24], "418.00"],
  // 吊柜（规范：深 12"、高 30/36/42"）
  ["W1230", "wall", [12], [30, 36, 42], [12], "118.00"],
  ["W1530", "wall", [15], [30, 36, 42], [12], "126.00"],
  ["W1830", "wall", [18], [30, 36, 42], [12], "138.00"],
  ["W2430", "wall", [24], [30, 36, 42], [12], "162.00"],
  ["W3030", "wall", [30], [30, 36, 42], [12], "178.00"],
  ["W3630", "wall", [36], [30, 36, 42], [12], "204.00"],
  ["W3618", "wall", [36], [12, 15, 18], [12], "132.00"],
  ["CW2430", "corner", [24], [30, 36, 42], [12], "236.00"],
  // 高柜（规范：深 24"、高 84/90/96"）
  ["PC1884", "tall", [18], [84, 90, 96], [24], "512.00"],
  ["PC2484", "tall", [24], [84, 90, 96], [24], "596.00"],
  ["OC3084", "tall", [30], [84, 90, 96], [24], "648.00"],
  // 线条与饰面板
  ["BF3", "filler", [3], [34.5], [0.75], "38.00"],
  ["WF3", "filler", [3], [30, 36, 42], [0.75], "34.00"],
  ["TK8", "toeKick", [96], [4.5], [0.25], "42.00"],
  // 塑料可调地脚：单个计价，按柜体数量配（见 ToeKickSystem）
  ["LEG", "leg", [2], [4.5], [2], "3.50"],
  // 配塑料地脚时的踢脚扣板——扣在腿上，不是整体底座
  ["TKC8", "toeKick", [96], [4.5], [0.125], "36.00"],
  ["CM8", "crown", [96], [4.25], [0.75], "58.00"],
  ["BEP", "panel", [24], [34.5], [0.25], "76.00"],
  ["WEP", "panel", [12], [30, 36, 42], [0.25], "62.00"],
];

/**
 * 本来就没有「脸」的类别。
 *
 * 地脚是柜子底下的一根塑料柱，踢脚板是一条贴面板，顶线是一条装饰线——
 * 它们在正视图上不是一个带门缝的面。要求它们匹配脸型模板是把渲染的
 * 概念套到了不适用的东西上；给它们编一个脸才是错的。
 */
const FACELESS_TYPES: ReadonlySet<ModuleSpec["type"]> = new Set(["leg", "toeKick", "crown"]);

/**
 * 试点公司**直接声明**的能力（CATALOG_MODEL §2.2 的第一档可信度）。
 *
 * 只声明推不出来的那些。`OC3084` 从脸型只能推出"是个家电柜"，推不出配哪种
 * 家电——而开洞高度、周边配件都取决于这一点。按行业惯例 `OC` = oven cabinet，
 * 但靠码前缀猜正是能力标签这层要消除的东西，所以在这里显式写下来。
 */
const PILOT_CAPABILITIES: Record<string, ModuleSpec["capabilities"]> = {
  OC3084: { roles: ["applianceHousing"], servesAppliance: "wallOven" },
};

export const pilotModules: ModuleSpec[] = MODULE_DEFS.map(([code, type, w, h, d]) => {
  const faceless = FACELESS_TYPES.has(type);
  const match = matchFaceTemplate(code);
  if (!match && !faceless) {
    // FR-2 的「零静默失败」：**有脸的**型号匹配不到脸型就不允许静默进入规格库
    throw new Error(`型号 ${code} 未能匹配脸型模板，需人工确认后才能发布`);
  }
  return {
    ...base,
    id: `m_${code.toLowerCase()}`,
    code,
    type,
    widthOptions: w,
    heightOptions: h,
    depthOptions: d,
    ...(match ? { faceTemplateId: match.templateId } : {}),
    ...(PILOT_CAPABILITIES[code] ? { capabilities: PILOT_CAPABILITIES[code] } : {}),
    assemblyOptions: type === "base" || type === "sinkBase" ? ["RTA", "assembled"] : ["RTA"],
  };
});

/** Premium 组按 Standard 的 1.62 倍定价（行业里价格组间的典型跨度）。 */
export const pilotPriceMatrix: PriceMatrixEntry[] = MODULE_DEFS.flatMap(([code, , , , , std]) => {
  const id = `m_${code.toLowerCase()}`;
  const stdCents = fromDollars(std);
  const premCents = fromDollars((Number(std) * 1.62).toFixed(2));
  return [
    {
      ...base, moduleId: id, priceGroupId: "pg_std", listPrice: stdCents,
      assembledUpcharge: { kind: "percent" as const, value: 15 },
    },
    {
      ...base, moduleId: id, priceGroupId: "pg_prem", listPrice: premCents,
      assembledUpcharge: { kind: "percent" as const, value: 15 },
    },
  ];
});

export const pilotHardware: HardwareOption[] = [
  {
    ...base, id: "hw_softclose", name: "Soft-close 铰链与滑轨升级",
    priceModifier: { kind: "flat", value: fromDollars("22.00") },
    appliesToModuleTypes: ["base", "wall", "tall", "corner", "sinkBase"],
  },
  {
    ...base, id: "hw_handle_bar", name: "不锈钢横把手",
    priceModifier: { kind: "flat", value: fromDollars("8.50") },
    appliesToModuleTypes: ["base", "wall", "tall", "corner", "sinkBase"],
  },
];

export const pilotAccessories: AccessoryOption[] = [
  {
    ...base, id: "ac_rollout", name: "抽拉层板 (Roll-out Tray)",
    priceModifier: { kind: "percent", value: 12 },
    appliesToModuleIds: ["m_b24", "m_b30", "m_b36", "m_pc1884", "m_pc2484"],
  },
  {
    ...base, id: "ac_lazy_susan", name: "360° 转盘",
    priceModifier: { kind: "flat", value: fromDollars("95.00") },
    appliesToModuleIds: ["m_lsb33"],
  },
];

export const pilotDiscounts: DiscountRule[] = [
  {
    ...base, id: "dr_trade", audience: "trade", kind: "percentOffList", value: 18,
    stackable: true, description: "贸易账号标价 18% off",
  },
  {
    ...base, id: "dr_volume", audience: "consumer", kind: "tieredByOrderValue",
    tiers: [
      { minSubtotal: fromDollars("3000.00"), percentOff: 4 },
      { minSubtotal: fromDollars("8000.00"), percentOff: 7 },
      { minSubtotal: fromDollars("15000.00"), percentOff: 10 },
    ],
    stackable: true, description: "整厨满额折扣",
  },
];

export const pilotShipping: ShippingRule = {
  ...base, id: "sr_pilot", kind: "freeOver",
  freeOverThreshold: fromDollars("3500.00"),
  belowThresholdAmount: fromDollars("185.00"),
};

/**
 * 冷启动通用目录（FR-10）。
 *
 * ⚠️ 价格区间是**按行业常见跨度构造的占位值**，不是调研数据。
 * 上线前必须定案真实来源（PRE_LAUNCH_CHECKLIST A4 / 开放问题 5），
 * 并让 EstimateDraft 的 disclaimer 与实际来源相符。
 */
export const genericCatalog: GenericCatalog = {
  id: "gc_v1",
  sourceNote: "占位数据：按 rta-generic-spec 的尺寸档位 + 行业常见价格跨度构造，待替换为核实过的来源",
  modules: [
    { type: "base", widthOptions: [9, 12, 15, 18, 21, 24, 27, 30, 33, 36], heightOptions: [34.5], depthOptions: [24], typicalPriceRange: { low: fromDollars("120.00"), high: fromDollars("480.00") } },
    { type: "wall", widthOptions: [9, 12, 15, 18, 21, 24, 27, 30, 33, 36], heightOptions: [12, 15, 18, 24, 30, 36, 42], depthOptions: [12, 15, 24], typicalPriceRange: { low: fromDollars("95.00"), high: fromDollars("360.00") } },
    { type: "tall", widthOptions: [18, 24, 30, 36], heightOptions: [84, 90, 96], depthOptions: [24], typicalPriceRange: { low: fromDollars("420.00"), high: fromDollars("1150.00") } },
    { type: "sinkBase", widthOptions: [30, 33, 36, 42], heightOptions: [34.5], depthOptions: [24], typicalPriceRange: { low: fromDollars("220.00"), high: fromDollars("560.00") } },
    { type: "corner", widthOptions: [33, 36, 42], heightOptions: [34.5], depthOptions: [24], typicalPriceRange: { low: fromDollars("290.00"), high: fromDollars("820.00") } },
  ],
};

export const demoAccounts: CustomerAccount[] = [
  {
    id: "ca_demo_consumer", accountType: "consumer",
    email: "alex@example.com", displayName: "Alex", province: "ON",
    consentRecords: [{ termsVersion: "2026-01", consentedAt: NOW, channel: "web_signup" }],
  },
  {
    id: "ca_demo_trade", accountType: "trade",
    email: "builder@example.com", displayName: "Riverside Builders", province: "ON",
    companyName: "Riverside Builders Ltd", subscriptionStatus: "active",
    consentRecords: [{ termsVersion: "2026-01", consentedAt: NOW, channel: "web_signup" }],
  },
];
