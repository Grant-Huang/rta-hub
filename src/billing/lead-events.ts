/**
 * 线索计费 —— REQUIREMENTS FR-7 计费小节、第 8.1 节。
 *
 * 两个必须做对的点：
 *   1. **去重**：同一 (companyId, conversationId) 在 30 天窗口内只计一次。
 *      窗口内的重复发送**照常发邮件**（客户改了设计再发一次是正常行为），
 *      只是不再产生新的计费事件。
 *   2. **争议**：14 天窗口内公司可提起争议；争议期内不得进入 invoiced。
 *
 * 去重靠 `dedupeKey` + 数据层唯一约束兜底，不依赖应用代码"记得判重"
 * （与 3.4 的双重防线原则一致）。
 */
import { createHash } from "node:crypto";
import type { Money } from "../domain/money.js";
import type {
  DisputeReason, FeeStatus, LeadBillingEvent, Quote,
} from "../domain/types.js";

export const LEAD_DEDUPE_WINDOW_DAYS = 30;
export const LEAD_DISPUTE_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 计算去重键。
 *
 * 窗口用「自纪元起的第 N 个 30 天桶」实现。注意这是**固定边界**分桶，
 * 不是滑动窗口——两次发送若恰好跨桶边界仍会各计一次费。选固定桶是因为它能
 * 直接映射成数据库唯一约束；滑动窗口需要范围查询，无法用唯一索引兜底。
 * 代价（跨边界重复计费）由争议流程 `reason: "duplicate"` 兜底。
 */
export function computeDedupeKey(
  companyId: string,
  conversationId: string,
  sentAt: string,
  windowDays = LEAD_DEDUPE_WINDOW_DAYS,
): string {
  const bucket = Math.floor(Date.parse(sentAt) / (windowDays * DAY_MS));
  return createHash("sha256")
    .update(`${companyId}|${conversationId}|${bucket}`)
    .digest("hex")
    .slice(0, 32);
}

export type BillingOutcome =
  | { kind: "created"; event: LeadBillingEvent }
  | { kind: "suppressedDuplicate"; existing: LeadBillingEvent };

let seq = 0;

/**
 * 发送成功后登记计费事件。
 *
 * 若窗口内已有同键事件，返回 `suppressedDuplicate`——调用方应据此写一条
 * `QuoteAuditEvent(suppressedDuplicateBilling)`，而不是静默忽略。
 */
export function recordLeadBilling(
  existingEvents: readonly LeadBillingEvent[],
  quote: Quote,
  feeAmount: Money,
  sentAt: string,
  windowDays = LEAD_DEDUPE_WINDOW_DAYS,
): BillingOutcome {
  const dedupeKey = computeDedupeKey(quote.companyId, quote.conversationId, sentAt, windowDays);
  const existing = existingEvents.find((e) => e.dedupeKey === dedupeKey);
  if (existing) return { kind: "suppressedDuplicate", existing };

  const event: LeadBillingEvent = {
    id: `lbe_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    companyId: quote.companyId,
    conversationId: quote.conversationId,
    quoteId: quote.id,
    customerAccountId: quote.customerAccountId,
    sentAt,
    dedupeKey,
    feeAmount,
    currency: quote.currency,
    feeStatus: "pending",
  };
  return { kind: "created", event };
}

export class BillingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "BillingError";
  }
}

export function disputeWindowEndsAt(event: LeadBillingEvent, windowDays = LEAD_DISPUTE_WINDOW_DAYS): string {
  return new Date(Date.parse(event.sentAt) + windowDays * DAY_MS).toISOString();
}

export function isWithinDisputeWindow(
  event: LeadBillingEvent,
  at: string,
  windowDays = LEAD_DISPUTE_WINDOW_DAYS,
): boolean {
  return Date.parse(at) < Date.parse(disputeWindowEndsAt(event, windowDays));
}

/** 公司提起争议。窗口外拒绝受理。 */
export function openDispute(
  event: LeadBillingEvent,
  input: { openedBy: string; reason: DisputeReason; evidence: string; at: string },
  windowDays = LEAD_DISPUTE_WINDOW_DAYS,
): LeadBillingEvent {
  if (!isWithinDisputeWindow(event, input.at, windowDays)) {
    throw new BillingError(
      `争议窗口已于 ${disputeWindowEndsAt(event, windowDays)} 关闭`,
      "DISPUTE_WINDOW_CLOSED",
    );
  }
  if (event.feeStatus === "paid" || event.feeStatus === "refunded") {
    throw new BillingError(`费用状态为 ${event.feeStatus}，不可再提起争议`, "DISPUTE_NOT_ALLOWED");
  }
  return {
    ...event,
    feeStatus: "disputed",
    dispute: {
      openedAt: input.at,
      openedBy: input.openedBy,
      reason: input.reason,
      evidence: input.evidence,
    },
  };
}

/** 运营裁定争议。 */
export function resolveDispute(
  event: LeadBillingEvent,
  input: { resolvedBy: string; resolution: "upheld" | "refunded" | "partialRefund"; at: string },
): LeadBillingEvent {
  if (!event.dispute) {
    throw new BillingError("该计费事件没有待裁定的争议", "NO_OPEN_DISPUTE");
  }
  const feeStatus: FeeStatus = input.resolution === "upheld" ? "pending" : "refunded";
  return {
    ...event,
    feeStatus,
    dispute: {
      ...event.dispute,
      resolvedAt: input.at,
      resolvedBy: input.resolvedBy,
      resolution: input.resolution,
    },
  };
}

/**
 * 出账。**争议期内、以及处于 disputed 状态的费用不得出账**（REQUIREMENTS 8.1）。
 */
export function invoice(
  event: LeadBillingEvent,
  at: string,
  windowDays = LEAD_DISPUTE_WINDOW_DAYS,
): LeadBillingEvent {
  if (event.feeStatus === "disputed") {
    throw new BillingError("争议未裁定，不能出账", "DISPUTED_CANNOT_INVOICE");
  }
  if (event.feeStatus !== "pending") {
    throw new BillingError(`费用状态为 ${event.feeStatus}，不能出账`, "NOT_PENDING");
  }
  if (isWithinDisputeWindow(event, at, windowDays)) {
    throw new BillingError(
      `争议窗口至 ${disputeWindowEndsAt(event, windowDays)} 才结束，期间不得出账`,
      "DISPUTE_WINDOW_OPEN",
    );
  }
  return { ...event, feeStatus: "invoiced" };
}
