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

/** 平台侧角色（与 accountType 正交）；用于主 UI /me 运营入口显隐。 */
export type PlatformRole = "platform_admin";

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
  /** 平台运营角色；缺省无。含 platform_admin 时可进管理台/训练入口。 */
  platformRoles?: PlatformRole[];
  consentRecords: ConsentRecord[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** 该条消息路由到的公司（@ 路由结果）；总控助手为 undefined。 */
  companyId?: string;
  at: Timestamp;
}

/** FR-23：厂商协作子线程消息（与主轨 ChatMessage 分栏）。 */
export type EngagementMessageRole = "user" | "assistant" | "company_human" | "system";

/**
 * 子轨说话人（与 role 兼容层）：
 * - platform = 系统助手（流程/交接）
 * - company_agent = 厂商 Agent
 * - company_human = 厂商员工
 * - user = 客户
 */
export type EngagementSpeaker =
  | "user"
  | "platform"
  | "company_agent"
  | "company_human";

export interface EngagementMessage {
  role: EngagementMessageRole;
  content: string;
  at: Timestamp;
  /** 可选；缺省时由 role 推断（assistant→company_agent，system→platform）。 */
  speaker?: EngagementSpeaker;
}

export type CompanyEngagementStatus = "active" | "closed";

/** 交接包中的一条已确认事实（供 Agent 注入与开线复述）。 */
export interface HandoffConfirmedFact {
  key: string;
  scope: "shared" | "company";
  label: string;
  value: string;
  display: string;
  source: "main_confirmed" | "pulled" | "user_corrected";
}

/** 开线时写入的项目快照；厂商可见，不是主轨回放。 */
export interface CompanyEngagementHandoff {
  at: Timestamp;
  /** 交接修订号；开线=1，每次 pull 共享态 +1。 */
  revision: number;
  sharedSummary: string;
  /**
   * 与父会话对齐的需求原文（供 promote/pull 同步比较）。
   * **不要**直接展示给客户或整段塞进 Agent——展示/复述用 confirmedFacts + requirementsDigest。
   */
  designRequirements: string;
  /** 从 Design Basis brief 提炼的短摘要（给人与 Agent 看）。 */
  requirementsDigest?: string;
  sharedPreferences?: SharedPreferences;
  /** 开线时从父 byCompany[本厂] 冻结的厂专用选型。 */
  companyPreferences?: CompanyPreferences;
  /** 结构化确认清单（与主轨 brief 关键项对齐；Agent 必读）。 */
  confirmedFacts?: HandoffConfirmedFact[];
  floorPlanId?: string;
}

/**
 * 客户项目下的厂商协作永久分支（FR-23）。
 * 同一 conversationId+companyId 至多一条 active。
 */
export interface CompanyEngagement {
  id: string;
  conversationId: string;
  companyId: string;
  status: CompanyEngagementStatus;
  createdAt: Timestamp;
  closedAt?: Timestamp;
  /** 客户左栏二级标题，如 "@Oppein Canada"。 */
  customerTitle: string;
  handoff: CompanyEngagementHandoff;
  /** 子轨共享工作副本；可与父 preferences.shared 不一致。 */
  sharedWorking?: {
    designRequirements?: string;
    preferences?: SharedPreferences;
  };
  /**
   * 厂商员工接管后为 true：客户发言不再自动调厂商 Agent。
   * 员工明确交还或客户侧重置时可清。
   */
  agentPaused?: boolean;
  /** 客户对开线/ pull 复述的确认时间（可选）。 */
  handoffAckAt?: Timestamp;
  messages: EngagementMessage[];
}

/** 会话来源——生产 / 端到端模拟 / 集成测试（FR-21）。 */
export type SessionOrigin = "production" | "simulate" | "test";

/** 客户会话生命周期；缺省按 active（兼容旧数据）。 */
export type ConversationStatus = "active" | "archived";

/**
 * 一次可回放的系统运行（生产长驻、simulate 一次、test 一次）。
 * 索引落在各 dataDir 的 `session-runs.json`，供运营跨会话发现。
 */
export interface SessionRun {
  id: string;
  origin: SessionOrigin;
  dataDir: string;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  conversationIds: string[];
  exitCode?: number;
  scenarioSource?: string;
  note?: string;
}

export interface Conversation {
  id: string;
  customerAccountId: string;
  messages: ChatMessage[];
  designRequirements: string;
  perCompanyThreads: { companyId: string; messages: ChatMessage[] }[];
  createdAt: Timestamp;
  /** 会话来源；缺省按 production 对待（兼容旧数据）。 */
  origin?: SessionOrigin;
  /** 所属 SessionRun.id */
  runId?: string;
  /** 如场景名、测试用例名 */
  tags?: string[];
  /**
   * active = 可聊；archived = 只读，需恢复后才能写。
   * 缺省视为 active。
   */
  status?: ConversationStatus;
  /** 最近一次进入 archived 的时间；恢复后清除。 */
  archivedAt?: Timestamp;
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
  /** FR-23：按厂协作永久分支（与 perCompanyThreads Agent 旁路分轨）。 */
  companyEngagements?: CompanyEngagement[];
}

/** 运营侧专家评审气泡——不进客户 Conversation.messages（FR-21 / 1A）。 */
export interface CritiqueMessage {
  role: "critic" | "operator";
  content: string;
  at: Timestamp;
}

export type CritiqueSeverity = "major" | "minor" | "nit";
export type CritiqueCategory =
  | "process"
  | "design_output"
  | "dialogue"
  | "ergonomics"
  | "completeness"
  | "explain";

export interface CritiqueFinding {
  id: string;
  severity: CritiqueSeverity;
  category: CritiqueCategory;
  target: {
    kind: "message" | "floorPlan" | "layout" | "quote" | "stage" | "session";
    ref?: string;
  };
  title: string;
  body: string;
  suggestedFix?: string;
}

export type CritiqueTrigger =
  | "planView"
  | "fourViews"
  | "quote"
  | "stageAdvance"
  | "sessionEnd"
  | "manual";

export type CritiqueStatus = "open" | "acked" | "promoted_to_trainer";

/** DesignCritic 一轮评审；只写此集合，不改客户数据。 */
export interface CritiqueReview {
  id: string;
  conversationId: string;
  runId?: string;
  trigger: CritiqueTrigger;
  summary: string;
  findings: CritiqueFinding[];
  messages: CritiqueMessage[];
  auditSnapshotIds?: string[];
  createdAt: Timestamp;
  status: CritiqueStatus;
}

/** FR-14 交付审核结果旁路落盘，供 Critic 引用（不替代闸门响应）。 */
export interface DeliveryAuditRecord {
  id: string;
  conversationId: string;
  deliverable: "planView" | "fourViews" | "quoteList";
  ok: boolean;
  findings: { code: string; severity: string; message: string; rule?: string }[];
  checked: string[];
  at: Timestamp;
  designLayoutId?: string;
  quoteId?: string;
}

/** 跨公司通用的偏好——换公司不失效。 */
export interface SharedPreferences {
  budgetBand?: "economy" | "standard" | "premium" | "unsure";
  storage?: "drawers" | "doors" | "balanced";
  tradeoff?: "price" | "quality" | "lookAndFeel";
  assembly?: AssemblyOption;
  /**
   * 客户语言偏好。默认英文；客户用中文交流或明确要求时切中文。
   * 图纸上的文字一律英文，不受此字段影响。
   */
  language?: "en" | "zh";
  /**
   * 排布层提示（修订话术落地）。不进价格矩阵，只影响装箱/岛台尺寸。
   */
  layoutHints?: {
    /** 尽量排进调料拉篮（窄功能柜） */
    includeSpicePullout?: boolean;
    /** 尽量排进垃圾桶拉出柜 */
    includeTrashPullout?: boolean;
    /** 岛台加长（英寸），受过道净空约束 */
    enlargeIslandInches?: number;
    /** 客户点名的柜号（如「把 #12 和 #13 改成一样宽」） */
    matchCabinetNos?: number[];
    /** 「把 #N 改成双抽」 */
    doubleDrawerNos?: number[];
    /** 调料拉篮优先落在柜号（意图化修订，优先于 near） */
    spiceCabinetNo?: number;
    /** 调料拉篮靠近的家电/水槽（无柜号时按空间关系选 base 柜） */
    spiceNear?: "range" | "cooktop" | "sink";
    /** 垃圾桶柜优先落在柜号 */
    trashCabinetNo?: number;
    /** 垃圾桶柜靠近的参照 */
    trashNear?: "range" | "cooktop" | "sink";
  };
}

/** 绑定到某家公司规格库的偏好——实体 id 只在该公司下有意义。 */
export interface CompanyPreferences {
  doorStyleId?: string;
  /** 箱体板材。与门板花色是**两个独立的维度**，见 `BoxMaterialOption`。 */
  boxMaterialId?: string;
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

/**
 * 售卖单元（FR-16 / L0）——「卖的是什么」，与柜型前缀无关。
 * 详见 docs/KNOWLEDGE_LAYERS.md、docs/product-codes.md。
 */
export type SellUnit = "box" | "door" | "combo" | "standalone";

/**
 * 厂商柜型编码规则（FR-16 / L1）——按 companyId 隔离，禁止写入总控。
 */
export interface CompanyCodingRules {
  /** 人类可读：本公司柜型前缀怎么读 */
  prefixGuide: {
    pattern: string;
    meaning: string;
    /** 可选：导入时建议的能力角色，仍须确认 */
    mapsToRoles?: (
      | "doorStorage" | "drawerStorage" | "sinkBase" | "cooktopBase"
      | "applianceHousing" | "cornerAccess" | "openDisplay" | "trim"
    )[];
  }[];
  /** 本公司是否使用系统后缀拆分（-BOX / -DOOR） */
  usesBoxDoorSuffixes: boolean;
  /** 材质段 / 花色段 token 表（本公司字典） */
  materialTokens?: Record<string, string>;
  finishTokens?: Record<string, string>;
}

/** 可选公司手册——仅注入本公司 Agent，不能覆盖矩阵价格。 */
export interface CompanyHandbook {
  text: string;
}

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
  /**
   * 地柜支撑与踢脚做法。缺省 `plywoodPanel`（传统整体底座）。
   *
   * 选 `plasticLegs` 时物料清单里会出现地脚，不出现整体底座——
   * 这是两份不同的清单，不是同一份清单的两种叫法。
   */
  toeKickSystem?: ToeKickSystem;
  /** FR-16：本公司柜型前缀 / 后缀策略 / token 表 */
  codingRules?: CompanyCodingRules;
  /** FR-16：可选，仅注入本公司 Agent */
  handbook?: CompanyHandbook;
  effectiveFrom: Timestamp;
  effectiveTo?: Timestamp;
  publishedAt?: Timestamp;
  publishedBy?: string;
  changeNote?: string;
}

export type ModuleType =
  | "base" | "wall" | "tall" | "corner" | "sinkBase"
  | "filler" | "panel" | "toeKick" | "crown"
  /** 塑料可调地脚（leg leveler）。见 `ToeKickSystem`。 */
  | "leg";

/**
 * 地柜的支撑与踢脚做法。
 *
 * 两种在北美 RTA 里都常见，**决定的是完全不同的一份物料清单**：
 *   - `plywoodPanel`：柜体自带整体底座，另配一条整长的踢脚板贴面；
 *   - `plasticLegs`：柜体靠可调塑料地脚支撑，踢脚板用夹子扣在腿上。
 *     好处是能逐个调平（旧房地面很少是平的），运输体积也小。
 *
 * 选错了做法，报价单上就会少几十条腿或多一条用不上的底座——
 * 所以它是规格版本上的字段，不是渲染参数。
 */
export type ToeKickSystem = "plywoodPanel" | "plasticLegs";

export type AssemblyOption = "RTA" | "assembled";

export interface ModuleSpec {
  id: string;
  specVersionId: string;
  companyId: string;
  /** 型号码，如 B12 / W2430 / SB36 / B12-PLY-BOX。 */
  code: string;
  type: ModuleType;
  /**
   * FR-16 售卖单元。缺省由系统启发式推断（见 `spec/sku-semantics.ts`）。
   * 规格声明优先于启发式。
   */
  sellUnit?: SellUnit;
  /** 离散尺寸候选集，单位英寸。FR-8 校验 2 会拒绝不在集合内的尺寸。 */
  widthOptions: number[];
  heightOptions: number[];
  depthOptions: number[];
  /**
   * 脸型模板 id。**无脸型的类别（地脚、踢脚板、顶线）为空**——
   * 它们在正视图上不是一个带门缝的面，硬给一个脸型才是错的。
   */
  faceTemplateId?: string;
  assemblyOptions: AssemblyOption[];
  /**
   * 这个型号的价格**随不随门板花色变**（REQUIREMENTS §3.5.5）。缺省 `true`。
   *
   * 价格矩阵是 `(型号 × 价格组)`，而价格组来自门板样式——这等于说每个型号的
   * 价格都随花色变。对绝大多数件是对的：柜体的门板就是花色本身，填缝条、
   * 收口板、踢脚板、顶线要与门同色，那正是它们存在的理由。
   *
   * 但**塑料地脚不是**：它藏在踢脚板后面，没人看得见，就是一个黑色塑料件、
   * 一个价。给它编一个"高级花色版"的价格是凭空加价。
   *
   * 标 `false` 的型号在价格矩阵里**只需要一行**，FR-8 的完整性校验相应放宽
   * （`spec/finish.ts` 的 `priceEntryFor`）——否则会把"本来就不需要多行"
   * 误报成价格空洞。
   */
  finishDependent?: boolean;
  /**
   * 商家**直接声明**的能力标签（CATALOG_MODEL.md §2）。
   *
   * 缺省时由 `spec/capabilities.ts` 从 type + 脸型模板推断，推不准的走待确认队列。
   * 排布算法只读这一层，不读 `code`——能力可以跨商家对齐，编码不能。
   *
   * 类型是结构化的字面量而不是引入 `ModuleCapabilities`，是为了不让 domain 层
   * 反向依赖 spec 层；`capabilities.ts` 里的类型与这里逐字段一致。
   */
  capabilities?: {
    roles: (
      | "doorStorage" | "drawerStorage" | "sinkBase" | "cooktopBase"
      | "applianceHousing" | "cornerAccess" | "openDisplay" | "trim"
    )[];
    servesAppliance?:
      | "refrigerator" | "range" | "cooktop" | "wallOven"
      | "rangeHood" | "microwave" | "dishwasher";
    stacking?: { asLower: boolean; asUpper: boolean };
    monolithic?: boolean;
    /**
     * 转角柜做法（角上选型用，不靠码前缀猜）。
     * - blind：盲角（BBC42 / BBC45，左右通装，码宽=占墙宽）
     * - lazySusan：懒人转盘（LSB）
     * - diagonal：钻石/斜切（地柜 DC、吊柜 CW）；与同尺寸 LSB / LC 可互换
     * - lShape：L 形转角迎面（LC）；与同尺寸 CW 可互换
     * - lazySusan：懒人转盘（LSB）；与同尺寸 DC 可互换
     */
    cornerStyle?: "lazySusan" | "blind" | "diagonal" | "lShape";
    /**
     * 沿墙占用（英寸）。缺省等于选用的 widthOptions 箱体宽。
     * 仅当占墙与箱体不一致时才声明（本试点 BBC 码宽即占墙宽，无需另写）。
     */
    cornerOccupyInches?: number;
  };
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
  /** 门板本身的材质（实木/ MDF 烤漆 / 三聚氰胺…）。**与箱体材质无关。** */
  material?: string;
  color?: string;
}

/**
 * 箱体板材 —— 柜体那个"盒子"用什么板做的。
 *
 * ## 为什么它不能塞进门板花色里
 *
 * 客户问的是两件不同的事：「柜门长什么样」和「柜子本身用什么板」。
 * 同一款 Shaker White 门板，配颗粒板箱体和配全夹板箱体是**两个价**，
 * 而且差得不少（行业里全夹板升级通常在 15%~30%）。
 *
 * 价格矩阵是 `(型号 × 价格组)`，价格组来自门板——这条链路里没有箱体的位置。
 * 硬把箱体塞进去，意味着价格组数量翻三倍（每种花色 × 三种板材），
 * 而商家给的价目表根本不是那么组织的：他们给一张门板价目表，
 * 外加一句「全夹板 +20%」。所以这里**照商家给的样子建模**：
 * 箱体是一个作用在标价上的修饰项，与五金、配件同一口径。
 *
 * ## 哪些件不加价
 *
 * 填缝条、收口板、踢脚板、顶线、塑料地脚**没有箱体**——它们是一块板或一个
 * 塑料件，谈不上"用什么板做盒子"。给它们乘上全夹板的加价是凭空加价，
 * 和当初给塑料地脚编"高级花色版价格"是同一类错。判定在 `spec/carcass.ts`。
 */
export type BoxMaterialCode = "particleBoard" | "plywood" | "solidWood";

export interface BoxMaterialOption {
  id: string;
  specVersionId: string;
  companyId: string;
  /** 归一化的板材类别。排序与文案按它走，不按商家自己的叫法。 */
  code: BoxMaterialCode;
  /** 商家自己的叫法，如「全夹板箱体」「Baltic Birch Plywood Box」。 */
  name: string;
  /**
   * 相对**标价**的加价。基数与五金/配件一致（都是标价，不叠乘），
   * 所以修饰项之间可交换、报价可复算。
   */
  priceModifier: Modifier;
  /** 商家的基础档。客户没选时按它算，并在报价上写明按的是哪一档。 */
  isDefault?: boolean;
  /** 一句话说明，如「18mm 环保级颗粒板，封边 PVC」。 */
  note?: string;
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
  kind: "hardware" | "accessory" | "assembly" | "boxMaterial";
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
  /**
   * 这份报价按的是哪一档箱体板材。
   *
   * 是快照字段：商家事后调整加价比例，已发出的报价不能跟着变。
   * 客户没选时记的是商家的默认档——**"没选"和"选了基础档"在报价上没有区别，
   * 但在解释上有**，所以文字里会写明"按基础档算的"。
   */
  boxMaterialId?: string;
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
