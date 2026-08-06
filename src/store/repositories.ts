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
  CabinetCompany, CompanyMentionSignal, CompanyProspect, Conversation,
  CustomerAccount, DesignLayout, DesignRevision, EmailSubscription, EstimateDraft,
  LeadBillingEvent, ProductSpecVersion, Quote, QuoteAuditEvent,
} from "../domain/types.js";
import type { SpecBundle } from "../spec/bundle.js";

export interface Repositories {
  companies: JsonCollection<CabinetCompany>;
  accounts: JsonCollection<CustomerAccount>;
  conversations: JsonCollection<Conversation>;
  specVersions: JsonCollection<ProductSpecVersion>;
  /** 规格内容按版本整包存放，避免为每类子实体单开一个文件。 */
  specBundles: JsonCollection<SpecBundle>;
  designLayouts: JsonCollection<DesignLayout>;
  designRevisions: JsonCollection<DesignRevision>;
  quotes: JsonCollection<Quote>;
  auditEvents: JsonCollection<QuoteAuditEvent>;
  billingEvents: JsonCollection<LeadBillingEvent>;
  mentionSignals: JsonCollection<CompanyMentionSignal>;
  estimates: JsonCollection<EstimateDraft>;
  prospects: JsonCollection<CompanyProspect>;
  subscriptions: JsonCollection<EmailSubscription>;
}

export function openRepositories(dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data")): Repositories {
  const f = (name: string) => path.join(dataDir, `${name}.json`);

  return {
    companies: new JsonCollection<CabinetCompany>(f("companies")),
    accounts: new JsonCollection<CustomerAccount>(f("accounts"))
      .addUniqueKey("email", (a) => a.email.toLowerCase()),
    conversations: new JsonCollection<Conversation>(f("conversations")),
    specVersions: new JsonCollection<ProductSpecVersion>(f("spec-versions"))
      .addUniqueKey("companyId+versionNo", (v) => `${v.companyId}:${v.versionNo}`),
    specBundles: new JsonCollection<SpecBundle>(f("spec-bundles")),
    designLayouts: new JsonCollection<DesignLayout>(f("design-layouts")),
    designRevisions: new JsonCollection<DesignRevision>(f("design-revisions"))
      .addUniqueKey("layout+revision", (r) => `${r.designLayoutId}:${r.revisionNo}`),
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
  };
}
