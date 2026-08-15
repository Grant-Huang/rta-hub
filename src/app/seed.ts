/**
 * 试点公司种子数据 —— MVP-1 的「先跑通 1 家」（REQUIREMENTS 第 9 节）。
 *
 * 型号、尺寸、编码全部取自 rta-generic-spec/ 的通用规范（核实结果见 RENDERING.md 附录）。
 * **价格是虚构的占位值**——真实价目表由该公司通过 FR-2 录入或模板导入。
 */
import { fromDollars } from "../domain/money.js";
import type {
  AccessoryOption, BoxMaterialOption, CabinetCompany, CustomerAccount, DiscountRule,
  DoorStyle, GenericCatalog, HardwareOption, ModuleSpec, PriceGroup, PriceMatrixEntry,
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
  codingRules: {
    usesBoxDoorSuffixes: false,
    prefixGuide: [
      { pattern: "^B\\d", meaning: "base cabinet (1 drawer over door when ≤21\")", mapsToRoles: ["doorStorage", "drawerStorage"] },
      { pattern: "^SB", meaning: "sink base", mapsToRoles: ["sinkBase"] },
      { pattern: "^W\\d", meaning: "wall cabinet", mapsToRoles: ["doorStorage"] },
      { pattern: "^3DB|^DB", meaning: "drawer base", mapsToRoles: ["drawerStorage"] },
      { pattern: "^LSB|^BBC|^BC|^DC", meaning: "lazy susan / blind / diamond corner base", mapsToRoles: ["cornerAccess"] },
      { pattern: "^CW|^LC|^WBC|^WBBC", meaning: "corner / diamond / L / blind wall", mapsToRoles: ["cornerAccess"] },
      { pattern: "^WF|^BF|^TK|^EP", meaning: "filler / toe kick / end panel", mapsToRoles: ["trim"] },
    ],
  },
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
  /** 调料拉篮 / 窄功能柜 —— 客户可要求「把 B12 换成调料拉篮」 */
  ["B09SP", "base", [9], [34.5], [24], "198.00"],
  /** 垃圾桶拉出柜 */
  ["BTC18", "base", [18], [34.5], [24], "248.00"],
  ["3DB24", "base", [24], [34.5], [24], "318.00"],
  ["3DB30", "base", [30], [34.5], [24], "356.00"],
  ["2DB30", "base", [30], [34.5], [24], "342.00"],
  ["2DB24", "base", [24], [34.5], [24], "298.00"],
  ["SB33", "sinkBase", [33], [34.5], [24], "268.00"],
  ["SB36", "sinkBase", [36], [34.5], [24], "284.00"],
  // 转角地柜：盲角 BBC42/45；LSB↔DC 同尺寸可互换（33/36）；均左右通装
  ["BBC42", "corner", [42], [34.5], [24], "352.00"],
  ["BBC45", "corner", [45], [34.5], [24], "398.00"],
  ["LSB33", "corner", [33], [34.5], [24], "418.00"],
  ["LSB36", "corner", [36], [34.5], [24], "448.00"],
  ["DC33", "corner", [33], [34.5], [24], "388.00"],
  ["DC36", "corner", [36], [34.5], [24], "412.00"],
  // 吊柜（规范：深 12"、高 30/36/42"）
  ["W1230", "wall", [12], [30, 36, 42], [12], "118.00"],
  ["W1530", "wall", [15], [30, 36, 42], [12], "126.00"],
  ["W1830", "wall", [18], [30, 36, 42], [12], "138.00"],
  ["W2430", "wall", [24], [30, 36, 42], [12], "162.00"],
  ["W3030", "wall", [30], [30, 36, 42], [12], "178.00"],
  ["W3630", "wall", [36], [30, 36, 42], [12], "204.00"],
  ["W3618", "wall", [36], [12, 15, 18], [12], "132.00"],
  // 吊柜转角：CW↔LC 同尺寸可互换（2412/2430/2436/2442）
  ["CW2412", "corner", [24], [12], [12], "168.00"],
  ["CW2430", "corner", [24], [30], [12], "236.00"],
  ["CW2436", "corner", [24], [36], [12], "258.00"],
  ["CW2442", "corner", [24], [42], [12], "278.00"],
  ["LC2412", "corner", [24], [12], [12], "178.00"],
  ["LC2430", "corner", [24], [30], [12], "248.00"],
  ["LC2436", "corner", [24], [36], [12], "268.00"],
  ["LC2442", "corner", [24], [42], [12], "288.00"],
  // 冰箱上柜：与冰箱齐深（24"），比普通吊柜矮。不做的话冰箱顶上是个积灰空当。
  // 烤箱高柜用已有的 OC3084（见 PILOT_CAPABILITIES）
  ["RFW3615", "wall", [33, 36, 39], [12, 15, 18], [24], "268.00"],
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
  // 冰箱侧通高收口板：冰箱比两边的柜子高，只贴地柜那一截会露出上面半截刨花板边
  ["REP24", "panel", [24], [84, 90, 96], [0.25], "148.00"],
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
 * 价格**不随门板花色变**的类别（REQUIREMENTS §3.5.5）。
 *
 * 只有塑料地脚。它藏在踢脚板后面，没人看得见——黑色塑料件，一个价。
 * 踢脚板与顶线虽然也"没有脸"，但它们**要与门同色**，那正是它们存在的理由，
 * 所以仍然随花色变。"看不看得见"与"有没有脸"是两件事。
 */
const FINISH_INDEPENDENT_TYPES: ReadonlySet<ModuleSpec["type"]> = new Set(["leg"]);

/**
 * 试点公司**直接声明**的能力（CATALOG_MODEL §2.2 的第一档可信度）。
 *
 * 只声明推不出来的那些。`OC3084` 从脸型只能推出"是个家电柜"，推不出配哪种
 * 家电——而开洞高度、周边配件都取决于这一点。按行业惯例 `OC` = oven cabinet，
 * 但靠码前缀猜正是能力标签这层要消除的东西，所以在这里显式写下来。
 */
const PILOT_CAPABILITIES: Record<string, ModuleSpec["capabilities"]> = {
  OC3084: { roles: ["applianceHousing"], servesAppliance: "wallOven" },
  // 配套柜：排布器按 servesAppliance 找它们，不按型号码前缀猜
  RFW3615: { roles: ["doorStorage"], servesAppliance: "refrigerator" },
  // 窄功能件：调料拉篮 / 垃圾桶拉出——装箱时不按「凑数窄柜」惩罚
  B09SP: { roles: ["openDisplay", "doorStorage"] },
  BTC18: { roles: ["openDisplay", "doorStorage"] },
  // 转角做法（码宽即占墙宽；左右通装）
  BBC42: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "blind" },
  BBC45: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "blind" },
  LSB33: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "lazySusan" },
  LSB36: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "lazySusan" },
  DC33: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "diagonal" },
  DC36: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "diagonal" },
  CW2412: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "diagonal" },
  CW2430: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "diagonal" },
  CW2436: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "diagonal" },
  CW2442: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "diagonal" },
  LC2412: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "lShape" },
  LC2430: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "lShape" },
  LC2436: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "lShape" },
  LC2442: { roles: ["cornerAccess", "doorStorage"], cornerStyle: "lShape" },
};

/**
 * 试点公司**显式指定**的脸型。
 *
 * `RFW` 这个前缀不在通用命名规则里——而给它编一条规则等于让规则去迁就一家公司的
 * 命名习惯。公司自己声明脸型是 FR-2 早就提供的路径（`CompanyOverrides`），
 * 这里用的是同一条路。
 */
const PILOT_FACES: Record<string, string> = {
  RFW3615: "F2_DOUBLE_DOOR",
  B09SP: "F1_SINGLE_DOOR",
  BTC18: "F1_SINGLE_DOOR",
  "2DB24": "F6_DRAWER_STACK",
  // L 形转角吊柜：迎面两翼，正视图按单门示意
  LC2412: "F1_SINGLE_DOOR",
  LC2430: "F1_SINGLE_DOOR",
  LC2436: "F1_SINGLE_DOOR",
  LC2442: "F1_SINGLE_DOOR",
};

export const pilotModules: ModuleSpec[] = MODULE_DEFS.map(([code, type, w, h, d]) => {
  const faceless = FACELESS_TYPES.has(type);
  const declaredFace = PILOT_FACES[code];
  const match = declaredFace
    ? { templateId: declaredFace }
    : matchFaceTemplate(code);
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
    ...(FINISH_INDEPENDENT_TYPES.has(type) ? { finishDependent: false } : {}),
    assemblyOptions: type === "base" || type === "sinkBase" ? ["RTA", "assembled"] : ["RTA"],
  };
});

/** Premium 组按 Standard 的 1.62 倍定价（行业里价格组间的典型跨度）。 */
export const pilotPriceMatrix: PriceMatrixEntry[] = MODULE_DEFS.flatMap(([code, type, , , , std]) => {
  const id = `m_${code.toLowerCase()}`;
  const stdCents = fromDollars(std);
  const premCents = fromDollars((Number(std) * 1.62).toFixed(2));
  // 塑料地脚只有一行：它的价格不随花色变，编一个"高级花色版"的价格
  // 是凭空加价（§3.5.5）。FR-8 的完整性校验对它相应放宽。
  if (FINISH_INDEPENDENT_TYPES.has(type)) {
    return [{ ...base, moduleId: id, priceGroupId: "pg_std", listPrice: stdCents }];
  }
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

/**
 * 箱体板材 —— 三档，与门板花色**互不相干**。
 *
 * 这三档是加拿大 RTA 市场上真实存在的分法：
 *   - 颗粒板（particle board / furniture board）：基础档，绝大多数标价针对它；
 *   - 全夹板（all-plywood box）：最常见的升级项，行业里普遍报 +15%~+25%；
 *   - 实木箱体：小众，多数商家不做；这一家做，用来验证三档都跑得通。
 *
 * 加价是**百分比**而不是每柜定额：夹板贵在板材面积上，一个 36" 的柜子
 * 比 12" 的多用三倍板，按柜收同样的钱对两边都不对。
 */
export const pilotBoxMaterials: BoxMaterialOption[] = [
  {
    ...base, id: "bm_particle", code: "particleBoard", name: "颗粒板箱体",
    priceModifier: { kind: "percent", value: 0 },
    isDefault: true,
    note: "5/8\" 环保级颗粒板，PVC 封边。标价默认按这一档。",
  },
  {
    ...base, id: "bm_plywood", code: "plywood", name: "全夹板箱体",
    priceModifier: { kind: "percent", value: 18 },
    note: "1/2\" 夹板箱体 + 3/4\" 夹板层板。更抗潮、螺丝咬合更牢，水槽柜下方尤其明显。",
  },
  {
    ...base, id: "bm_solid", code: "solidWood", name: "实木箱体",
    priceModifier: { kind: "percent", value: 42 },
    note: "箱体侧板为实木拼板。重量与价格都明显上去，多数厨房用不到这一档。",
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
    stackable: true, description: "Whole-kitchen spend discount",
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
  {
    id: "ca_demo_admin",
    accountType: "consumer",
    email: "ops@example.com",
    displayName: "Platform Ops",
    province: "ON",
    platformRoles: ["platform_admin"],
    consentRecords: [{ termsVersion: "2026-01", consentedAt: NOW, channel: "web_signup" }],
  },
  {
    id: "ca_test",
    accountType: "consumer",
    email: "test@rta-hub.local",
    displayName: "test",
    province: "ON",
    consentRecords: [{ termsVersion: "2026-01", consentedAt: NOW, channel: "web_signup" }],
  },
];
