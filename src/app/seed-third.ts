/**
 * 第三家试点公司 —— **本轮的验收标准**（DEV_PLAN M5-12、SCENARIOS 场景 K）。
 *
 * ## 前两家证明了什么，这一家要证明什么
 *
 * - 第一家（Maple Ridge）：面框柜 + 全覆盖门板，型号码用通用命名；
 * - 第二家（Lakeside）：无框柜 + 半覆盖，**自有命名体系**（`NW-` 前缀），
 *   走完整的模板导入路径建立。它证明的是「命名体系不同也能接入」。
 *
 * 这一家要证明更难的一条：**设计本身不同也能接入**。
 *
 * | | 前两家 | 这一家（Birchline） |
 * |---|---|---|
 * | pantry | 连体 `PANTRY1884`，一个 SKU、一扇通高门 | **分体** `BL-PC1842` × 2，叠装 |
 * | 吊柜最高 | 42" | **39"** |
 * | 吊柜矮档 | 12/15/18（只有 36" 宽有） | 15/18/21（各宽度都有） |
 *
 * 判据很直接：**加这一家不能改排布算法的代码**。要是得改，说明能力标签
 * （`spec/capabilities.ts`）这层没做对——排布器应该问「有没有 18" 宽、84" 高的
 * 储物高柜」，而不是问「有没有 PANTRY1884」。
 *
 * ## 39" 上限会真的改变结果
 *
 * 108" 层高的可用高度是 48"。前两家有 42"，但没有 6" 的档位去补，
 * 只能解出「42 单柜 + 6" 顶线」；这一家最高只有 39"，反而因为矮档齐全
 * 能解出 **30+18 = 48**，做到顶。**上限低的那家做出了更贴合的结果**——
 * 这正说明排布器读的是档位集合而不是"谁的柜子更高"。
 * 两家的报价**件数不同、行数不同、外观不同**——那是正确的结果，不是 bug
 * （SCENARIOS 场景 K 第 4 点）。
 */
import type { CabinetCompany, DiscountRule, ProductSpecVersion, ShippingRule } from "../domain/types.js";
import { fromDollars } from "../domain/money.js";
import { importSpecTemplates, type ImportSources } from "../spec/import.js";
import type { CompanyOverrides } from "../render/templates.js";
import type { SpecBundle } from "../spec/bundle.js";

export const THIRD_COMPANY_ID = "co_birchline";
export const THIRD_SPEC_VERSION_ID = "spec_birchline_v1";
const NOW = "2026-01-01T00:00:00.000Z";

export const thirdCompany: CabinetCompany = {
  id: THIRD_COMPANY_ID,
  name: "Birchline Cabinet Co.",
  aliases: ["白桦橱柜", "Birchline", "BLC"],
  quoteEmail: "quotes@birchline.example",
  website: "https://birchline.example",
  contactName: "Wei Zhang",
  province: "BC",
  serviceAreas: ["BC", "AB"],
  billingPlan: { leadFeeEnabled: true, personalizationSubscription: "active" },
  currentPublishedSpecVersionId: THIRD_SPEC_VERSION_ID,
  createdAt: NOW,
};

export const thirdSpecVersion: ProductSpecVersion = {
  id: THIRD_SPEC_VERSION_ID,
  companyId: THIRD_COMPANY_ID,
  versionNo: 1,
  status: "published",
  currency: "CAD",
  construction: "frameless",
  overlay: "full",
  effectiveFrom: NOW,
  publishedAt: NOW,
  publishedBy: "ops@birchline.example",
  changeNote: "第三家试点：分体 pantry + 39\" 吊柜上限",
};

/** 又一套自有命名。`BL-PC` 是分体 pantry 的两段之一，不是普通吊柜。 */
export const thirdCompanyFaceOverrides: CompanyOverrides = {
  "BL-B12": { templateId: "F3_DRAWER_OVER_DOOR" },
  "BL-B15": { templateId: "F3_DRAWER_OVER_DOOR" },
  "BL-B18": { templateId: "F3_DRAWER_OVER_DOOR" },
  "BL-B21": { templateId: "F3_DRAWER_OVER_DOOR" },
  "BL-B24": { templateId: "F4_DRAWER_OVER_DOUBLE" },
  "BL-B30": { templateId: "F5_TWO_DRAWERS_OVER_DOUBLE" },
  "BL-B36": { templateId: "F5_TWO_DRAWERS_OVER_DOUBLE" },
  "BL-D": { templateId: "F6_DRAWER_STACK", params: { drawerCount: 3 } },
  "BL-SK": { templateId: "F7_FALSE_FRONT_DOUBLE" },
  "BL-W": { templateId: "F2_DOUBLE_DOOR" },
  "BL-PC": { templateId: "F2_DOUBLE_DOOR" },
  "BL-LS": { templateId: "F1_SINGLE_DOOR" },
  "BL-CW": { templateId: "F1_SINGLE_DOOR" },
  "BL-RFW": { templateId: "F2_DOUBLE_DOOR" },
  "BL-F": { templateId: "F15_PLAIN_PANEL" },
  // 收口件没有"脸"，但**也必须给一个模板**：导入时判不出脸型的型号会被整行丢掉，
  // 连带它的价格行一起。踢脚板被丢掉的后果不是"图上少一条线"，
  // 而是物料清单缺件、客户装不上（SR-M1）。
  "BL-TK": { templateId: "F15_PLAIN_PANEL" },
  "BL-CR": { templateId: "F15_PLAIN_PANEL" },
  "BL-EP": { templateId: "F15_PLAIN_PANEL" },
};

export const thirdCompanyTemplates: ImportSources = {
  priceGroups: [
    "code,displayName,rank",
    "CORE,Core,1",
    "SELECT,Select,2",
  ].join("\n"),

  doorStyles: [
    "name,priceGroup,material,color",
    "Birch Shaker Natural,CORE,Birch,Natural",
    "Birch Shaker Ink,CORE,Birch,Ink",
    "Rift Oak Slab,SELECT,White Oak,Rift",
  ].join("\n"),

  modules: [
    "code,type,widths,heights,depths,assembly",
    "BL-B12,base,12,34-1/2,24,RTA|assembled",
    "BL-B15,base,15,34-1/2,24,RTA|assembled",
    "BL-B18,base,18,34-1/2,24,RTA|assembled",
    "BL-B21,base,21,34-1/2,24,RTA|assembled",
    "BL-B24,base,24,34-1/2,24,RTA|assembled",
    "BL-B30,base,30,34-1/2,24,RTA|assembled",
    "BL-B36,base,36,34-1/2,24,RTA|assembled",
    "BL-D24,base,24,34-1/2,24,RTA|assembled",
    "BL-D30,base,30,34-1/2,24,RTA|assembled",
    "BL-SK30,sinkBase,30,34-1/2,24,RTA",
    "BL-SK36,sinkBase,36,34-1/2,24,RTA",
    // 转角柜：斜切转角，与前两家的盲角柜是不同做法
    "BL-LS36,corner,36,34-1/2,24,RTA",
    "BL-CW24,corner,24,30/39,12,RTA",
    // ⚠️ 吊柜最高 39"，不是 42"。矮档 15/21 **每个宽度都有**——
    // 这正是叠装能解出与前两家不同结果的原因。
    "BL-W12,wall,12,15/18/21/30/39,12,RTA",
    "BL-W15,wall,15,15/18/21/30/39,12,RTA",
    "BL-W18,wall,18,15/18/21/30/39,12,RTA",
    "BL-W24,wall,24,15/18/21/30/39,12,RTA",
    "BL-W30,wall,30,15/18/21/30/39,12,RTA",
    "BL-W36,wall,36,15/18/21/30/39,12,RTA",
    // 分体 pantry：两段 42" 叠成 84"，**不是一个通高箱体**。
    // 类型是 tall（它是储物高柜，24" 深，不是吊柜）——写成 wall 的话，
    // 通用吊柜装箱会把它当成一个 42" 高的普通上柜排到墙上去。
    "BL-PC1842,tall,18,42,24,RTA",
    "BL-RFW3615,wall,36,15,24,RTA",
    "BL-F03,filler,3,34-1/2,3/4,RTA",
    "BL-TK96,toeKick,96,4-1/2,3/4,RTA",
    "BL-CR96,crown,96,3,3/4,RTA",
    "BL-EP,panel,24,34-1/2,3/4,RTA",
  ].join("\n"),

  // 第三家做三档，实木那一档贵得多——三家的档数与加价各不相同，
  // 那正是"照商家给的样子建模"该有的样子
  boxMaterials: [
    "code,name,upcharge,default,note",
    "particleBoard,Birch Core Board,0%,yes,标价按这一档",
    "plywood,Baltic Birch Plywood,26%,,桦木夹板箱体",
    "solidWood,Solid Birch Box,55%,,实木拼板侧板",
  ].join("\n"),

  priceMatrix: [
    "moduleCode,priceGroup,listPrice,assembledUpcharge",
    "BL-B12,CORE,131.00,14%", "BL-B12,SELECT,236.00,14%",
    "BL-B15,CORE,144.00,14%", "BL-B15,SELECT,259.00,14%",
    "BL-B18,CORE,157.00,14%", "BL-B18,SELECT,283.00,14%",
    "BL-B21,CORE,171.00,14%", "BL-B21,SELECT,308.00,14%",
    "BL-B24,CORE,194.00,14%", "BL-B24,SELECT,349.00,14%",
    "BL-B30,CORE,226.00,14%", "BL-B30,SELECT,407.00,14%",
    "BL-B36,CORE,266.00,14%", "BL-B36,SELECT,479.00,14%",
    "BL-D24,CORE,281.00,14%", "BL-D24,SELECT,506.00,14%",
    "BL-D30,CORE,318.00,14%", "BL-D30,SELECT,572.00,14%",
    "BL-SK30,CORE,239.00,",   "BL-SK30,SELECT,430.00,",
    "BL-SK36,CORE,262.00,",   "BL-SK36,SELECT,472.00,",
    "BL-LS36,CORE,441.00,",   "BL-LS36,SELECT,794.00,",
    "BL-CW24,CORE,248.00,",   "BL-CW24,SELECT,446.00,",
    "BL-W12,CORE,104.00,",    "BL-W12,SELECT,187.00,",
    "BL-W15,CORE,116.00,",    "BL-W15,SELECT,209.00,",
    "BL-W18,CORE,129.00,",    "BL-W18,SELECT,232.00,",
    "BL-W24,CORE,151.00,",    "BL-W24,SELECT,272.00,",
    "BL-W30,CORE,172.00,",    "BL-W30,SELECT,310.00,",
    "BL-W36,CORE,198.00,",    "BL-W36,SELECT,356.00,",
    "BL-PC1842,CORE,286.00,", "BL-PC1842,SELECT,515.00,",
    "BL-RFW3615,CORE,161.00,", "BL-RFW3615,SELECT,290.00,",
    "BL-F03,CORE,29.00,",     "BL-F03,SELECT,52.00,",
    "BL-TK96,CORE,46.00,",    "BL-TK96,SELECT,83.00,",
    "BL-CR96,CORE,58.00,",    "BL-CR96,SELECT,104.00,",
    "BL-EP,CORE,88.00,",      "BL-EP,SELECT,158.00,",
  ].join("\n"),
};

const base = { specVersionId: THIRD_SPEC_VERSION_ID, companyId: THIRD_COMPANY_ID };

export const thirdDiscounts: DiscountRule[] = [
  {
    ...base, id: "dr_birchline_trade", audience: "trade", kind: "percentOffList", value: 18,
    stackable: true, description: "贸易账号标价 18% off",
  },
];

export const thirdShipping: ShippingRule = {
  ...base, id: "sr_birchline", kind: "flat", flatAmount: fromDollars("145.00"),
};

/**
 * 走完整的导入路径建立这家公司的规格整包。
 *
 * 与第二家同一条路径、同一个函数——**这本身就是验收的一部分**：
 * 第三家接入没有引入任何新的建立方式。
 */
export function buildThirdCompanyBundle(): {
  bundle: SpecBundle; unresolvedCount: number; ruleHits: number;
} {
  const result = importSpecTemplates(
    THIRD_SPEC_VERSION_ID, THIRD_COMPANY_ID,
    thirdCompanyTemplates, thirdCompanyFaceOverrides,
  );
  return {
    bundle: {
      ...result.bundle,
      discountRules: thirdDiscounts,
      shippingRule: thirdShipping,
    },
    unresolvedCount: result.unresolved.length,
    ruleHits: result.stats.faceTemplateRuleHits,
  };
}
