/**
 * 第二家试点公司 —— MVP-2「试点公司扩到 2-3 家，验证 FR-2 的可复制性」。
 *
 * 关键点：这家公司**完全通过 FR-2 的模板导入路径建立**，不像第一家那样在代码里
 * 硬写实体。这正是验证「新公司入驻 = 走一遍录入流程即可上线，不需要改代码」
 * （REQUIREMENTS 第 7 节可扩展性）的方式。
 *
 * 而且它故意用**自有命名体系**（`NW-` 前缀），以此验证脸型规则的公司级覆盖表
 * 确实能救回规则匹配率（RENDERING.md 第 5 节的重要例外）。
 */
import type { CabinetCompany, DiscountRule, ProductSpecVersion, ShippingRule } from "../domain/types.js";
import { fromDollars } from "../domain/money.js";
import { importSpecTemplates, type ImportSources } from "../spec/import.js";
import type { CompanyOverrides } from "../render/templates.js";
import type { SpecBundle } from "../spec/bundle.js";

export const SECOND_COMPANY_ID = "co_lakeside";
export const SECOND_SPEC_VERSION_ID = "spec_lakeside_v1";
const NOW = "2026-01-01T00:00:00.000Z";

export const secondCompany: CabinetCompany = {
  id: SECOND_COMPANY_ID,
  name: "Lakeside Kitchen Works",
  aliases: ["湖畔厨柜", "Lakeside", "LKW"],
  quoteEmail: "rfq@lakeside.example",
  website: "https://lakeside.example",
  contactName: "Dana Park",
  province: "ON",
  serviceAreas: ["ON"],
  billingPlan: { leadFeeEnabled: true, personalizationSubscription: "active" },
  currentPublishedSpecVersionId: SECOND_SPEC_VERSION_ID,
  createdAt: NOW,
};

export const secondSpecVersion: ProductSpecVersion = {
  id: SECOND_SPEC_VERSION_ID,
  companyId: SECOND_COMPANY_ID,
  versionNo: 1,
  status: "published",
  currency: "CAD",
  // 与第一家不同：无框柜 + 半覆盖门板，用来验证渲染参数确实生效
  construction: "frameless",
  overlay: "partial",
  effectiveFrom: NOW,
  publishedAt: NOW,
  publishedBy: "ops@lakeside.example",
  changeNote: "通过模板导入建立",
};

/**
 * 这家公司用自有型号命名（`NW-B30` 而不是 `B30`），通用规则匹配不到脸型。
 * 覆盖表把前缀映射过去——这就是 RENDERING.md 第 5 节说的"必须可按公司覆盖"。
 */
export const secondCompanyFaceOverrides: CompanyOverrides = {
  "NW-B09": { templateId: "F3_DRAWER_OVER_DOOR" },
  "NW-B12": { templateId: "F3_DRAWER_OVER_DOOR" },
  "NW-B15": { templateId: "F3_DRAWER_OVER_DOOR" },
  "NW-B18": { templateId: "F3_DRAWER_OVER_DOOR" },
  "NW-B24": { templateId: "F4_DRAWER_OVER_DOUBLE" },
  "NW-B30": { templateId: "F5_TWO_DRAWERS_OVER_DOUBLE" },
  "NW-B36": { templateId: "F5_TWO_DRAWERS_OVER_DOUBLE" },
  "NW-SK": { templateId: "F7_FALSE_FRONT_DOUBLE" },
  "NW-W": { templateId: "F2_DOUBLE_DOOR" },
  "NW-T": { templateId: "F13_TALL_TWO_DOOR" },
  "NW-F": { templateId: "F15_PLAIN_PANEL" },
};

/** 模拟这家公司提交的四张表。 */
export const secondCompanyTemplates: ImportSources = {
  priceGroups: [
    "code,displayName,rank",
    "STD,Essentials,1",
    "DSG,Designer,2",
  ].join("\n"),

  doorStyles: [
    "name,priceGroup,material,color",
    "Flat Slab White,STD,MDF,White",
    "Flat Slab Graphite,STD,MDF,Graphite",
    "Walnut Veneer,DSG,Walnut,Natural",
  ].join("\n"),

  modules: [
    "code,type,widths,heights,depths,assembly",
    "NW-B09,base,9,34-1/2,24,RTA",
    "NW-B12,base,12,34-1/2,24,RTA|assembled",
    "NW-B15,base,15,34-1/2,24,RTA|assembled",
    "NW-B18,base,18,34-1/2,24,RTA|assembled",
    "NW-B24,base,24,34-1/2,24,RTA|assembled",
    "NW-B30,base,30,34-1/2,24,RTA|assembled",
    "NW-B36,base,36,34-1/2,24,RTA|assembled",
    "NW-SK33,sinkBase,33,34-1/2,24,RTA",
    "NW-SK36,sinkBase,36,34-1/2,24,RTA",
    "NW-W12,wall,12,30/36,12,RTA",
    "NW-W18,wall,18,30/36,12,RTA",
    "NW-W24,wall,24,30/36,12,RTA",
    "NW-W30,wall,30,30/36,12,RTA",
    "NW-W36,wall,36,30/36,12,RTA",
    "NW-T24,tall,24,84/90,24,RTA",
    "NW-F03,filler,3,34-1/2,3/4,RTA",
  ].join("\n"),

  // 这一家只做两档箱体，而且叫法与第一家完全不同——归一化靠 `code`，
  // 不靠名字（`spec/carcass.ts`）
  boxMaterials: [
    "code,name,upcharge,default,note",
    "particleBoard,Standard Furniture Board,0%,yes,5/8\" 板材，标价按这一档",
    "plywood,Northwood All-Ply,22%,,整箱 1/2\" 夹板",
  ].join("\n"),

  priceMatrix: [
    "moduleCode,priceGroup,listPrice,assembledUpcharge",
    "NW-B09,STD,128.00,12%", "NW-B09,DSG,224.00,12%",
    "NW-B12,STD,136.00,12%", "NW-B12,DSG,238.00,12%",
    "NW-B15,STD,149.00,12%", "NW-B15,DSG,261.00,12%",
    "NW-B18,STD,163.00,12%", "NW-B18,DSG,285.00,12%",
    "NW-B24,STD,201.00,12%", "NW-B24,DSG,352.00,12%",
    "NW-B30,STD,233.00,12%", "NW-B30,DSG,408.00,12%",
    "NW-B36,STD,274.00,12%", "NW-B36,DSG,479.00,12%",
    "NW-SK33,STD,251.00,",   "NW-SK33,DSG,439.00,",
    "NW-SK36,STD,268.00,",   "NW-SK36,DSG,469.00,",
    "NW-W12,STD,109.00,",    "NW-W12,DSG,191.00,",
    "NW-W18,STD,127.00,",    "NW-W18,DSG,222.00,",
    "NW-W24,STD,152.00,",    "NW-W24,DSG,266.00,",
    "NW-W30,STD,169.00,",    "NW-W30,DSG,296.00,",
    "NW-W36,STD,194.00,",    "NW-W36,DSG,340.00,",
    "NW-T24,STD,562.00,",    "NW-T24,DSG,983.00,",
    "NW-F03,STD,31.00,",     "NW-F03,DSG,54.00,",
  ].join("\n"),
};

const base = { specVersionId: SECOND_SPEC_VERSION_ID, companyId: SECOND_COMPANY_ID };

export const secondDiscounts: DiscountRule[] = [
  {
    ...base, id: "dr_lakeside_trade", audience: "trade", kind: "percentOffList", value: 22,
    stackable: true, description: "贸易账号标价 22% off",
  },
  {
    ...base, id: "dr_lakeside_volume", audience: "consumer", kind: "tieredByOrderValue",
    tiers: [
      { minSubtotal: fromDollars("2500.00"), percentOff: 3 },
      { minSubtotal: fromDollars("6000.00"), percentOff: 6 },
    ],
    stackable: false, description: "整厨满额折扣",
  },
];

export const secondShipping: ShippingRule = {
  ...base, id: "sr_lakeside", kind: "flat", flatAmount: fromDollars("120.00"),
};

/** 走完整的导入路径建立这家公司的规格整包。 */
export function buildSecondCompanyBundle(): { bundle: SpecBundle; unresolvedCount: number; ruleHits: number } {
  const result = importSpecTemplates(
    SECOND_SPEC_VERSION_ID, SECOND_COMPANY_ID,
    secondCompanyTemplates, secondCompanyFaceOverrides,
  );
  return {
    bundle: {
      ...result.bundle,
      discountRules: secondDiscounts,
      shippingRule: secondShipping,
    },
    unresolvedCount: result.unresolved.length,
    ruleHits: result.stats.faceTemplateRuleHits,
  };
}
