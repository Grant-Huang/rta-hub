/**
 * 仓储集合 —— 把领域实体接到平面文件持久化上（REQUIREMENTS 6.7、MVP-1 的 M5）。
 *
 * 唯一约束一律声明在**数据层**，不依赖调用方"记得判重"：
 *   - `LeadBillingEvent.dedupeKey`：计费去重的第二道防线（FR-7）
 *   - `CompanyProspect.email`：公司发现库去重（FR-12.1）
 *   - `EmailSubscription.email`：邮件列表去重（FR-12）
 *   - `ProductSpecVersion` 的 (companyId, versionNo)：版本号不得重复（§3.6）
 */
import path from "node:path";
import { JsonCollection } from "./json-store.js";
import type {
  CabinetCompany, CompanyMentionSignal, CompanyProspect, CompanyStaffThread, Conversation,
  CritiqueReview, CustomerAccount, DeliveryAuditRecord, DesignLayout, DesignRevision,
  EmailSubscription, EstimateDraft, LeadBillingEvent, ProductSpecVersion, Quote,
  QuoteAuditEvent, SessionRun,
} from "../domain/types.js";
import type { SpecBundle } from "../spec/bundle.js";
import type { FloorPlan } from "../floorplan/types.js";
import type { StoredLayout } from "../layout/store.js";
import type { TradeVerification } from "../trade/verification.js";
import type { DesignSession } from "../design/stages.js";
import type { OnboardingSession } from "../spec/onboarding.js";
import type { PlatformKnowledgeCard, TrainerConversation } from "../knowledge/types.js";
import type { CompanyLearningItem } from "../knowledge/l1-types.js";
import type { TestUserRun } from "../testing/types.js";

export interface Repositories {
  companies: JsonCollection<CabinetCompany>;
  accounts: JsonCollection<CustomerAccount>;
  /** 贸易资质核实记录，一账号一条（开放问题 7）。 */
  tradeVerifications: JsonCollection<TradeVerification>;
  conversations: JsonCollection<Conversation>;
  specVersions: JsonCollection<ProductSpecVersion>;
  /** 规格内容按版本整包存放，避免为每类子实体单开一个文件。 */
  specBundles: JsonCollection<SpecBundle>;
  designLayouts: JsonCollection<DesignLayout>;
  designRevisions: JsonCollection<DesignRevision>;
  floorPlans: JsonCollection<FloorPlan>;
  /** 排布结果（含 placements 与评分）。按 (floorPlanId, companyId) 唯一。 */
  storedLayouts: JsonCollection<StoredLayout>;
  /** 设计会话阶段（先问再画、全局俯视图评审）。 */
  designSessions: JsonCollection<DesignSession>;
  /** 商家入驻的规格录入会话（FR-2）。一个草稿版本对应一段会话。 */
  onboardingSessions: JsonCollection<OnboardingSession>;
  quotes: JsonCollection<Quote>;
  auditEvents: JsonCollection<QuoteAuditEvent>;
  billingEvents: JsonCollection<LeadBillingEvent>;
  mentionSignals: JsonCollection<CompanyMentionSignal>;
  estimates: JsonCollection<EstimateDraft>;
  prospects: JsonCollection<CompanyProspect>;
  subscriptions: JsonCollection<EmailSubscription>;
  /** 可回放运行索引（FR-21）。 */
  sessionRuns: JsonCollection<SessionRun>;
  /** 运营侧 DesignCritic 评审（FR-21）。 */
  critiqueReviews: JsonCollection<CritiqueReview>;
  /** FR-14 交付审核旁路落盘，供 Critic 引用。 */
  deliveryAudits: JsonCollection<DeliveryAuditRecord>;
  /** FR-22：平台可训练知识卡。 */
  knowledgeCards: JsonCollection<PlatformKnowledgeCard>;
  /** FR-22：运营训练会话。 */
  trainerConversations: JsonCollection<TrainerConversation>;
  /** FR-22.2：厂商 L1 学习队列（按 companyId 隔离）。 */
  l1LearningQueue: JsonCollection<CompanyLearningItem>;
  /** 测试用户 Agent 套件（可切割 src/testing）。 */
  testUserRuns: JsonCollection<TestUserRun>;
  /** 厂商员工会话（Type2）——一家公司一条常驻线程，id = companyId。 */
  companyStaffThreads: JsonCollection<CompanyStaffThread>;
}

export function openRepositories(dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data")): Repositories {
  const f = (name: string) => path.join(dataDir, `${name}.json`);

  return {
    companies: new JsonCollection<CabinetCompany>(f("companies")),
    accounts: new JsonCollection<CustomerAccount>(f("accounts"))
      .addUniqueKey("email", (a) => a.email.toLowerCase()),
    tradeVerifications: new JsonCollection<TradeVerification>(f("trade-verifications"))
      .addUniqueKey("accountId", (v) => v.accountId),
    conversations: new JsonCollection<Conversation>(f("conversations")),
    specVersions: new JsonCollection<ProductSpecVersion>(f("spec-versions"))
      .addUniqueKey("companyId+versionNo", (v) => `${v.companyId}:${v.versionNo}`),
    specBundles: new JsonCollection<SpecBundle>(f("spec-bundles")),
    designLayouts: new JsonCollection<DesignLayout>(f("design-layouts")),
    designRevisions: new JsonCollection<DesignRevision>(f("design-revisions"))
      .addUniqueKey("layout+revision", (r) => `${r.designLayoutId}:${r.revisionNo}`),
    floorPlans: new JsonCollection<FloorPlan>(f("floor-plans")),
    storedLayouts: new JsonCollection<StoredLayout>(f("layouts"))
      .addUniqueKey("plan+company", (l) => `${l.floorPlanId}:${l.companyId}`),
    designSessions: new JsonCollection<DesignSession>(f("design-sessions")),
    // 一个草稿版本只能有一段录入会话——两段会话往同一个版本里写，
    // 后写的会静默盖掉前一段回答过的待确认项
    onboardingSessions: new JsonCollection<OnboardingSession>(f("onboarding-sessions"))
      .addUniqueKey("specVersionId", (s) => s.specVersionId),
    quotes: new JsonCollection<Quote>(f("quotes")),
    auditEvents: new JsonCollection<QuoteAuditEvent>(f("audit-events")),
    // ★ 计费去重的数据层兜底
    billingEvents: new JsonCollection<LeadBillingEvent>(f("billing-events"))
      .addUniqueKey("dedupeKey", (e) => e.dedupeKey),
    mentionSignals: new JsonCollection<CompanyMentionSignal>(f("mention-signals")),
    estimates: new JsonCollection<EstimateDraft>(f("estimates")),
    prospects: new JsonCollection<CompanyProspect>(f("prospects"))
      .addUniqueKey("email", (p) => p.email.toLowerCase()),
    subscriptions: new JsonCollection<EmailSubscription>(f("subscriptions"))
      .addUniqueKey("email", (s) => s.email.toLowerCase()),
    sessionRuns: new JsonCollection<SessionRun>(f("session-runs")),
    critiqueReviews: new JsonCollection<CritiqueReview>(f("critique-reviews")),
    deliveryAudits: new JsonCollection<DeliveryAuditRecord>(f("delivery-audits")),
    knowledgeCards: new JsonCollection<PlatformKnowledgeCard>(f("knowledge-cards")),
    trainerConversations: new JsonCollection<TrainerConversation>(f("trainer-conversations")),
    l1LearningQueue: new JsonCollection<CompanyLearningItem>(f("l1-learning-queue")),
    testUserRuns: new JsonCollection<TestUserRun>(f("test-user-runs")),
    companyStaffThreads: new JsonCollection<CompanyStaffThread>(f("company-staff-threads")),
  };
}
