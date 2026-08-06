/**
 * 领域实体定义 —— 对应 docs/REQUIREMENTS.md 第 6 节数据模型（v0.4）。
 *
 * 命名与文档保持一致，便于对照 review。所有金额字段类型为 Money（分，整数）。
 */
import type { Money } from "./money.js";

// ── 通用 ──────────────────────────────────────────────────────────────────

/** 加拿大省/地区代码。定价必需——决定税率。 */
export type Province =
  | "AB" | "BC" | "MB" | "NB" | "NL" | "NS"
  | "NT" | "NU" | "ON" | "PE" | "QC" | "SK" | "YT";

export const ALL_PROVINCES: readonly Province[] = [
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
];

export type Currency = "CAD";

/** ISO-8601 时间戳字符串。 */
export type Timestamp = string;

/** 加价/折扣修饰量：定额（分）或百分比。 */
export type Modifier =
  | { kind: "flat"; value: Money }
  | { kind: "percent"; value: number };

// ── 需求侧 ────────────────────────────────────────────────────────────────

export type AccountType = "consumer" | "trade";

export interface ConsentRecord {
  termsVersion: string;
  consentedAt: Timestamp;
  channel: string;
}

export interface CustomerAccount {
  id: string;
  accountType: AccountType;
  email: string;
  displayName: string;
  /** 定价必需（决定税率）。 */
  province: Province;
  companyName?: string;
  subscriptionStatus?: "none" | "trial" | "active";
  consentRecords: ConsentRecord[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** 该条消息路由到的公司（@ 路由结果）；总控助手为 undefined。 */
  companyId?: string;
  at: Timestamp;
}

export interface Conversation {
  id: string;
  customerAccountId: string;
  messages: ChatMessage[];
  designRequirements: string;
  perCompanyThreads: { companyId: string; messages: ChatMessage[] }[];
  createdAt: Timestamp;
  /**
   * 客户对价格与偏好的选择结果（`preferences/questions.ts`）。
   *
   * 按**公司**分开存：门板样式、五金、配件都是公司规格库里的实体 id，
   * 换一家公司这些 id 就没有意义了。跨公司通用的项（预算档位、储物偏好、
   * 取舍优先级）存在 `shared` 下，比价时才不会因为"在 A 家选过、B 家没选"
   * 而拿两套不同偏好出来的方案比价。
   */
  preferences?: {
    shared?: SharedPreferences;
    byCompany?: Record<string, CompanyPreferences>;
  };
}

/** 跨公司通用的偏好——换公司不失效。 */
export interface SharedPreferences {
  budgetBand?: "economy" | "standard" | "premium" | "unsure";
  storage?: "drawers" | "doors" | "balanced";
  tradeoff?: "price" | "quality" | "lookAndFeel";
  assembly?: AssemblyOption;
}

/** 绑定到某家公司规格库的偏好——实体 id 只在该公司下有意义。 */
export interface CompanyPreferences {
  doorStyleId?: string;
  hardwareOptionIds?: string[];
  accessoryOptionIds?: string[];
}

// ── 供给侧：公司 ──────────────────────────────────────────────────────────

export type CompanyStatus = "prospect" | "onboarding" | "active" | "inactive";

export interface BillingPlan {
  leadFeeEnabled: boolean;
  personalizationSubscription: "none" | "trial" | "active";
}

export interface CabinetCompany {
  id: string;
  name: string;
  /** 确定性 @ 路由用（FR-1）：常见简称、中英文名、旧品牌名。 */
  aliases: string[];
  quoteEmail: string;
  website?: string;
  contactName?: string;
  province: Province;
  serviceAreas: string[];
  billingPlan: BillingPlan;
  /** 当前生效的规格版本；无则表示尚未发布过。 */
  currentPublishedSpecVersionId?: string;
  /** 曾经 active 后被停用。status 由此标记与发布/订阅状态共同派生。 */
  deactivated?: boolean;
  /**
   * 公司侧端点的访问令牌（`X-Company-Token`）。
   *
   * 没有它，`/api/company/:companyId/*` 就是「谁填哪个 id 就读哪家数据」，
   * 租户隔离只是装饰。这**不是**公司账号体系（那属于检查清单 E1），
   * 只是让隔离先真的成立。
   */
  accessToken?: string;
  createdAt: Timestamp;
}

// ── 供给侧：规格版本 ──────────────────────────────────────────────────────

export type SpecVersionStatus = "draft" | "published" | "archived";

export interface ProductSpecVersion {
  id: string;
  companyId: string;
  versionNo: number;
  status: SpecVersionStatus;
  currency: Currency;
  /** 面框柜 vs 无框柜——影响正视图渲染（见 RENDERING.md 第 2 节）。 */
  construction: "framed" | "frameless";
  /** 门板覆盖方式——决定门缝留边（见 RENDERING.md 4.1）。 */
  overlay: "full" | "partial" | "inset";
  effectiveFrom: Timestamp;
  effectiveTo?: Timestamp;
  publishedAt?: Timestamp;
  publishedBy?: string;
  changeNote?: string;
}

export type ModuleType =
  | "base" | "wall" | "tall" | "corner" | "sinkBase"
  | "filler" | "panel" | "toeKick" | "crown";

export type AssemblyOption = "RTA" | "assembled";

export interface ModuleSpec {
  id: string;
  specVersionId: string;
  companyId: string;
  /** 型号码，如 B12 / W2430 / SB36。 */
  code: string;
  type: ModuleType;
  /** 离散尺寸候选集，单位英寸。FR-8 校验 2 会拒绝不在集合内的尺寸。 */
  widthOptions: number[];
  heightOptions: number[];
  depthOptions: number[];
  faceTemplateId: string;
  assemblyOptions: AssemblyOption[];
}

export interface PriceGroup {
  id: string;
  specVersionId: string;
  companyId: string;
  code: string;
  displayName: string;
  rank: number;
}

export interface DoorStyle {
  id: string;
  specVersionId: string;
  companyId: string;
  name: string;
  /** 每种门板属于且仅属于一个价格组。 */
  priceGroupId: string;
  material?: string;
  color?: string;
}

/**
 * 价格矩阵条目 —— (型号 × 价格组) → 标价，价格的唯一真相来源。
 * 矩阵允许有空洞：某型号不供应某价格组时不存在条目，FR-8 校验 3 会拒绝该组合。
 */
export interface PriceMatrixEntry {
  specVersionId: string;
  companyId: string;
  moduleId: string;
  priceGroupId: string;
  /** RTA（未组装）标价。 */
  listPrice: Money;
  assembledUpcharge?: Modifier;
  /** 少数公司维护独立贸易价矩阵时使用；否则贸易价走 DiscountRule。 */
  tradePrice?: Money;
}

export interface HardwareOption {
  id: string;
  specVersionId: string;
  companyId: string;
  name: string;
  priceModifier: Modifier;
  appliesToModuleTypes?: ModuleType[];
}

export interface AccessoryOption {
  id: string;
  specVersionId: string;
  companyId: string;
  name: string;
  priceModifier: Modifier;
  appliesToModuleIds?: string[];
}

export interface DiscountTier {
  minSubtotal: Money;
  percentOff: number;
}

export interface DiscountRule {
  id: string;
  specVersionId: string;
  companyId: string;
  audience: AccountType;
  kind: "percentOffList" | "tieredByOrderValue";
  value?: number;
  tiers?: DiscountTier[];
  /** 留空 = 全部价格组。 */
  appliesToPriceGroupIds?: string[];
  stackable: boolean;
  description: string;
}

export type ShippingRule =
  | { id: string; specVersionId: string; companyId: string; kind: "flat"; flatAmount: Money }
  | {
      id: string; specVersionId: string; companyId: string; kind: "freeOver";
      freeOverThreshold: Money; belowThresholdAmount: Money;
    }
  | {
      id: string; specVersionId: string; companyId: string; kind: "byRegion";
      regionTable: { province: Province; amount: Money }[];
      fallbackAmount: Money;
    };

// ── 平台共享层 ────────────────────────────────────────────────────────────

export type ViewKind = "front" | "topBase" | "topWall" | "side";

export interface TaxComponent {
  name: "GST" | "PST" | "HST" | "QST";
  ratePercent: number;
}

export interface TaxRule {
  id: string;
  province: Province;
  components: TaxComponent[];
  /** QST 历史上曾以含 GST 的金额为基数计算；现行为非复合。 */
  compounded: boolean;
  effectiveFrom: Timestamp;
  effectiveTo?: Timestamp;
}

// ── 设计与报价 ────────────────────────────────────────────────────────────

/** 客户在设计中做出的一组「选择」——这是 LLM 唯一被允许产出的东西（FR-8 第 1 条）。 */
export interface ModuleSelection {
  moduleId: string;
  qty: number;
  width: number;
  height: number;
  depth: number;
  assembly: AssemblyOption;
  hardwareOptionIds: string[];
  accessoryOptionIds: string[];
}

export interface DesignRevision {
  id: string;
  designLayoutId: string;
  revisionNo: number;
  selections: ModuleSelection[];
  createdAt: Timestamp;
  triggeredBy: "auto" | "customerRequest";
  changeSummary: string;
}

export interface DesignLayout {
  id: string;
  companyId: string;
  conversationId: string;
  specVersionId: string;
  floorPlanId?: string;
  currentRevisionNo: number;
  status: "draft" | "confirmed";
}

export interface QuoteLineModifier {
  kind: "hardware" | "accessory" | "assembly";
  refId: string;
  name: string;
  amount: Money;
}

export interface QuoteLineItem {
  moduleId: string;
  moduleCode: string;
  qty: number;
  width: number;
  height: number;
  depth: number;
  assembly: AssemblyOption;
  /** 快照：下单当时的标价。 */
  unitListPrice: Money;
  modifiers: QuoteLineModifier[];
  unitNetPrice: Money;
  lineSubtotal: Money;
}

export interface AppliedDiscount {
  ruleId: string;
  description: string;
  amount: Money;
}

export interface QuoteTax {
  name: TaxComponent["name"];
  ratePercent: number;
  amount: Money;
}

export type QuoteStatus = "draft" | "confirmed" | "sent" | "failed" | "expired";

export interface Quote {
  id: string;
  designLayoutId: string;
  designRevisionNo: number;
  companyId: string;
  conversationId: string;
  customerAccountId: string;
  // ── 快照字段（REQUIREMENTS 3.6）──
  specVersionId: string;
  accountTypeAtQuote: AccountType;
  doorStyleId: string;
  priceGroupId: string;
  currency: Currency;
  province: Province;
  taxRuleSnapshot: TaxRule;
  shippingRuleSnapshot?: ShippingRule;
  appliedDiscountRuleIds: string[];
  // ── 明细 ──
  lineItems: QuoteLineItem[];
  subtotal: Money;
  discounts: AppliedDiscount[];
  shipping: { ruleId?: string; amount: Money };
  taxes: QuoteTax[];
  total: Money;
  createdAt: Timestamp;
  validUntil: Timestamp;
  status: QuoteStatus;
}

export type QuoteAuditAction =
  | "created" | "revised" | "validationRejected" | "confirmed"
  | "sent" | "sendFailed" | "suppressedDuplicateBilling" | "expired";

export interface QuoteAuditEvent {
  id: string;
  quoteId: string;
  companyId: string;
  at: Timestamp;
  actor: "customer" | "system" | "operator";
  action: QuoteAuditAction;
  /** 当时报价内容的哈希，事后争议裁定的凭据。 */
  contentHash: string;
  details?: string;
}

export interface EstimateDraftLine {
  moduleType: ModuleType;
  qty: number;
  estimatedPriceRange: { low: Money; high: Money };
}

/**
 * 冷启动通用预估。**没有 companyId** —— 结构上就不可能进入发送闸门（FR-8 第 4 条）。
 */
export interface EstimateDraft {
  id: string;
  conversationId: string;
  basedOn: "genericCatalog";
  lineItems: EstimateDraftLine[];
  totalRange: { low: Money; high: Money };
  disclaimer: string;
  createdAt: Timestamp;
}

export interface GenericCatalogModule {
  type: ModuleType;
  widthOptions: number[];
  heightOptions: number[];
  depthOptions: number[];
  typicalPriceRange: { low: Money; high: Money };
}

export interface GenericCatalog {
  id: string;
  modules: GenericCatalogModule[];
  sourceNote: string;
}

// ── 销售信号与计费 ────────────────────────────────────────────────────────

export type MentionResolution =
  | "matchedActive" | "matchedInactive" | "matchedProspect" | "unknown";

export interface CompanyMentionSignal {
  id: string;
  conversationId: string;
  customerAccountId: string;
  rawMentionText: string;
  /** 归一化名称——销售看板按此聚合，避免同一家公司碎成多条。 */
  normalizedName: string;
  resolvedCompanyId?: string;
  resolvedProspectId?: string;
  resolutionStatus: MentionResolution;
  createdAt: Timestamp;
}

export type FeeStatus =
  | "pending" | "invoiced" | "paid" | "disputed" | "refunded" | "waived";

export type DisputeReason =
  | "duplicate" | "invalidContact" | "outOfServiceArea" | "spam" | "other";

export interface LeadDispute {
  openedAt: Timestamp;
  openedBy: string;
  reason: DisputeReason;
  evidence: string;
  resolvedAt?: Timestamp;
  resolvedBy?: string;
  resolution?: "upheld" | "refunded" | "partialRefund";
}

export interface LeadBillingEvent {
  id: string;
  companyId: string;
  conversationId: string;
  quoteId: string;
  customerAccountId: string;
  sentAt: Timestamp;
  /** 去重键，数据层唯一约束兜底（FR-7）。 */
  dedupeKey: string;
  feeAmount: Money;
  currency: Currency;
  feeStatus: FeeStatus;
  dispute?: LeadDispute;
}

// ── 公司发现与邮件列表（FR-12）────────────────────────────────────────────

export interface CompanyProspect {
  id: string;
  name: string;
  email: string;
  website?: string;
  phone?: string;
  city?: string;
  province?: Province;
  sourceType: "web_scrape" | "manual";
  importedAt: Timestamp;
  lastUpdated: Timestamp;
  status: "prospect" | "contacted" | "subscribed" | "archived";
  notes?: string;
}

export interface EmailSubscription {
  id: string;
  email: string;
  companyName: string;
  consentDate: Timestamp;
  consentChannel: "web_form";
  termsVersion: string;
  userAgent?: string;
  /** 脱敏后的 IP（末段置零）。 */
  ipAddress?: string;
  unsubscribeToken: string;
  status: "active" | "unsubscribed";
  unsubscribedAt?: Timestamp;
}
