/**
 * 数据留存、删除与数据主体权利 —— FR-13 第 (4)(5) 条、PIPEDA。
 *
 * 留存表（REQUIREMENTS FR-13）：
 *   户型图、上传文件         24 个月
 *   对话记录、需求摘要       24 个月
 *   账号注销后               30 天内清除上述内容
 *   Quote / 计费 / 审计事件  7 年（**去标识化后保存**，财务与法定留存）
 *
 * 关键规则：删除请求与法定留存冲突时，执行"去标识化保留"而不是拒绝删除，
 * 并向请求人说明。
 */
import type {
  Conversation, CustomerAccount, EstimateDraft, LeadBillingEvent, Quote, QuoteAuditEvent,
} from "../domain/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION = {
  /** 户型图与对话：24 个月。 */
  conversationMonths: 24,
  /** 账号注销后清除窗口：30 天（留给误操作恢复）。 */
  accountDeletionGraceDays: 30,
  /** 财务与审计：7 年。 */
  financialYears: 7,
  /** PIPEDA 要求的数据主体请求响应时限。 */
  subjectRequestResponseDays: 30,
} as const;

function monthsBefore(at: string, months: number): number {
  const d = new Date(at);
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

// ── 到期清除 ──────────────────────────────────────────────────────────────

export interface RetentionSweepInput {
  conversations: readonly Conversation[];
  estimates: readonly EstimateDraft[];
  quotes: readonly Quote[];
  billingEvents: readonly LeadBillingEvent[];
  auditEvents: readonly QuoteAuditEvent[];
  /** 已请求注销的账号及其注销时间。 */
  deletedAccounts?: readonly { accountId: string; deletedAt: string }[];
  at: string;
}

export interface RetentionSweepPlan {
  /** 应删除的会话 id。 */
  conversationsToDelete: string[];
  /** 应删除的预估 id。 */
  estimatesToDelete: string[];
  /** 应去标识化的报价 id（不删除——7 年法定留存）。 */
  quotesToDeIdentify: string[];
  /** 应去标识化的计费事件 id。 */
  billingToDeIdentify: string[];
  /** 超过 7 年、可以物理删除的审计事件 id。 */
  auditToDelete: string[];
  notes: string[];
}

/**
 * 计算一次清除计划。
 *
 * 返回计划而不是直接执行，是为了让这件事**可预演、可审计**——
 * 到期清除一旦写错就是不可逆的数据丢失。
 */
export function planRetentionSweep(input: RetentionSweepInput): RetentionSweepPlan {
  const now = Date.parse(input.at);
  const convCutoff = monthsBefore(input.at, RETENTION.conversationMonths);
  const financialCutoff = monthsBefore(input.at, RETENTION.financialYears * 12);

  const plan: RetentionSweepPlan = {
    conversationsToDelete: [],
    estimatesToDelete: [],
    quotesToDeIdentify: [],
    billingToDeIdentify: [],
    auditToDelete: [],
    notes: [],
  };

  // 注销账号的宽限期
  const purgeAccountIds = new Set(
    (input.deletedAccounts ?? [])
      .filter((a) => now - Date.parse(a.deletedAt) >= RETENTION.accountDeletionGraceDays * DAY_MS)
      .map((a) => a.accountId),
  );

  for (const conv of input.conversations) {
    const expired = Date.parse(conv.createdAt) < convCutoff;
    const accountPurged = purgeAccountIds.has(conv.customerAccountId);
    if (expired || accountPurged) {
      plan.conversationsToDelete.push(conv.id);
      plan.estimatesToDelete.push(
        ...input.estimates.filter((e) => e.conversationId === conv.id).map((e) => e.id),
      );
    }
  }

  // 报价与计费不删，去标识化后继续保留到 7 年
  const deletedConvIds = new Set(plan.conversationsToDelete);
  for (const q of input.quotes) {
    if (deletedConvIds.has(q.conversationId) || purgeAccountIds.has(q.customerAccountId)) {
      if (!isDeIdentified(q)) plan.quotesToDeIdentify.push(q.id);
    }
  }
  for (const e of input.billingEvents) {
    if (deletedConvIds.has(e.conversationId) || purgeAccountIds.has(e.customerAccountId)) {
      if (e.customerAccountId !== DEIDENTIFIED) plan.billingToDeIdentify.push(e.id);
    }
  }

  // 超过 7 年的审计事件可以物理删除
  for (const ev of input.auditEvents) {
    if (Date.parse(ev.at) < financialCutoff) plan.auditToDelete.push(ev.id);
  }

  if (plan.quotesToDeIdentify.length > 0) {
    plan.notes.push(
      `${plan.quotesToDeIdentify.length} 份报价因财务/税务法定留存（${RETENTION.financialYears} 年）不予删除，` +
      "改为去标识化保留：移除客户身份，保留金额与型号明细。",
    );
  }

  return plan;
}

// ── 去标识化 ──────────────────────────────────────────────────────────────

export const DEIDENTIFIED = "__deidentified__";

export function isDeIdentified(quote: Quote): boolean {
  return quote.customerAccountId === DEIDENTIFIED;
}

/**
 * 报价去标识化：移除客户身份，保留金额与型号明细。
 *
 * 保留的部分是财务与争议裁定需要的；移除的部分是能指向具体自然人的。
 */
export function deIdentifyQuote(quote: Quote): Quote {
  return {
    ...quote,
    customerAccountId: DEIDENTIFIED,
    conversationId: DEIDENTIFIED,
  };
}

export function deIdentifyBillingEvent(event: LeadBillingEvent): LeadBillingEvent {
  return {
    ...event,
    customerAccountId: DEIDENTIFIED,
    conversationId: DEIDENTIFIED,
  };
}

// ── 数据主体权利（PIPEDA）─────────────────────────────────────────────────

export type SubjectRequestKind = "access" | "correction" | "deletion" | "withdrawConsent";

export interface SubjectRequest {
  id: string;
  accountId: string;
  kind: SubjectRequestKind;
  requestedAt: string;
  respondedAt?: string;
  outcome?: string;
}

export function responseDueBy(request: SubjectRequest): string {
  return new Date(
    Date.parse(request.requestedAt) + RETENTION.subjectRequestResponseDays * DAY_MS,
  ).toISOString();
}

export function isOverdue(request: SubjectRequest, at: string): boolean {
  if (request.respondedAt) return false;
  return Date.parse(at) > Date.parse(responseDueBy(request));
}

export interface AccountExport {
  account: CustomerAccount;
  conversations: Conversation[];
  estimates: EstimateDraft[];
  quotes: Quote[];
  generatedAt: string;
  notes: string[];
}

/** 访问权：导出该账号的全部个人信息。 */
export function exportAccountData(
  account: CustomerAccount,
  data: {
    conversations: readonly Conversation[];
    estimates: readonly EstimateDraft[];
    quotes: readonly Quote[];
  },
  at: string,
): AccountExport {
  const conversations = data.conversations.filter((c) => c.customerAccountId === account.id);
  const convIds = new Set(conversations.map((c) => c.id));
  return {
    account,
    conversations,
    estimates: data.estimates.filter((e) => convIds.has(e.conversationId)),
    quotes: data.quotes.filter((q) => q.customerAccountId === account.id),
    generatedAt: at,
    notes: [
      `本导出包含截至 ${at} 我们持有的与该账号相关的个人信息。`,
      `已发送的报价单因财务法定留存需保留 ${RETENTION.financialYears} 年，删除请求将执行去标识化保留。`,
    ],
  };
}

export interface DeletionOutcome {
  conversationsDeleted: string[];
  estimatesDeleted: string[];
  quotesDeIdentified: string[];
  billingDeIdentified: string[];
  /** 给请求人的说明——必须解释为什么有些数据不能直接删。 */
  explanation: string;
}

/**
 * 删除权。
 *
 * 与法定留存冲突时执行去标识化保留，并如实说明——**不能因为有留存义务就拒绝整个请求**。
 */
export function executeDeletionRequest(
  accountId: string,
  data: {
    conversations: readonly Conversation[];
    estimates: readonly EstimateDraft[];
    quotes: readonly Quote[];
    billingEvents: readonly LeadBillingEvent[];
  },
): DeletionOutcome {
  const conversations = data.conversations.filter((c) => c.customerAccountId === accountId);
  const convIds = new Set(conversations.map((c) => c.id));
  const quotes = data.quotes.filter((q) => q.customerAccountId === accountId);
  const billing = data.billingEvents.filter((e) => e.customerAccountId === accountId);

  const explanation = quotes.length > 0 || billing.length > 0
    ? `已删除你的对话记录与预估共 ${conversations.length + data.estimates.filter((e) => convIds.has(e.conversationId)).length} 项。` +
      `其中 ${quotes.length} 份已发送的报价单与 ${billing.length} 条计费记录因加拿大财务与税务法规要求保留 ` +
      `${RETENTION.financialYears} 年，我们已将其去标识化：移除了你的姓名、邮箱与会话关联，` +
      "仅保留金额与型号明细，无法再关联到你本人。"
    : `已删除你的对话记录与预估共 ${conversations.length} 项。我们不再持有你的个人信息。`;

  return {
    conversationsDeleted: conversations.map((c) => c.id),
    estimatesDeleted: data.estimates.filter((e) => convIds.has(e.conversationId)).map((e) => e.id),
    quotesDeIdentified: quotes.map((q) => q.id),
    billingDeIdentified: billing.map((e) => e.id),
    explanation,
  };
}
