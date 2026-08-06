/**
 * 报价单状态机 + 快照复算校验 —— REQUIREMENTS FR-8 第 3 条、3.6 第 (2) 条。
 *
 * 关键点：**发送闸门是服务端状态机，不是请求体里的 `confirm` 布尔字段**。
 * 旧实现把闸门交给调用方，任何能访问接口的人都能绕过。这里状态迁移只能通过
 * 显式的迁移函数完成，每次迁移都写审计事件。
 */
import { createHash } from "node:crypto";
import type {
  Quote, QuoteAuditAction, QuoteAuditEvent, QuoteStatus,
} from "../domain/types.js";
import { computePrice, type PricingContext, type PriceBreakdown } from "../pricing/engine.js";

export class QuoteStateError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "QuoteStateError";
  }
}

/** 允许的状态迁移。未列出的迁移一律拒绝。 */
const ALLOWED: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ["confirmed", "expired"],
  confirmed: ["sent", "failed", "expired"],
  sent: [],          // 终态
  failed: ["confirmed"], // 允许修正后重新确认发送
  expired: [],       // 终态，需重新生成报价
};

export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (!canTransition(from, to)) {
    throw new QuoteStateError(`不允许的状态迁移：${from} → ${to}`, "ILLEGAL_TRANSITION");
  }
}

/**
 * 报价内容的哈希 —— 争议裁定的凭据（REQUIREMENTS 8.1）。
 *
 * 只覆盖**价格相关**的字段，不含 status 与审计信息，这样同一份报价在
 * draft/confirmed/sent 各阶段哈希一致，可以证明「发出去的就是客户确认的那一份」。
 */
export function quoteContentHash(quote: Quote): string {
  const material = {
    specVersionId: quote.specVersionId,
    companyId: quote.companyId,
    doorStyleId: quote.doorStyleId,
    priceGroupId: quote.priceGroupId,
    accountTypeAtQuote: quote.accountTypeAtQuote,
    province: quote.province,
    lineItems: quote.lineItems,
    subtotal: quote.subtotal,
    discounts: quote.discounts,
    shipping: quote.shipping,
    taxes: quote.taxes,
    total: quote.total,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

let auditSeq = 0;
export function makeAuditEvent(
  quote: Quote,
  action: QuoteAuditAction,
  actor: QuoteAuditEvent["actor"],
  at: string,
  details?: string,
): QuoteAuditEvent {
  return {
    id: `qae_${Date.now().toString(36)}_${(auditSeq++).toString(36)}`,
    quoteId: quote.id,
    companyId: quote.companyId,
    at,
    actor,
    action,
    contentHash: quoteContentHash(quote),
    details,
  };
}

export interface TransitionResult {
  quote: Quote;
  event: QuoteAuditEvent;
}

/** 客户确认（draft → confirmed）。这是一次留痕的服务端状态变更。 */
export function confirmQuote(quote: Quote, at: string, actor: QuoteAuditEvent["actor"] = "customer"): TransitionResult {
  assertNotExpired(quote, at);
  assertTransition(quote.status, "confirmed");
  const next: Quote = { ...quote, status: "confirmed" };
  return {
    quote: next,
    event: makeAuditEvent(next, "confirmed", actor, at, "客户在发送披露页确认"),
  };
}

/** 标记发送成功（confirmed → sent）。 */
export function markSent(quote: Quote, at: string): TransitionResult {
  assertTransition(quote.status, "sent");
  const next: Quote = { ...quote, status: "sent" };
  return { quote: next, event: makeAuditEvent(next, "sent", "system", at) };
}

/** 标记发送失败（confirmed → failed）。 */
export function markSendFailed(quote: Quote, at: string, reason: string): TransitionResult {
  assertTransition(quote.status, "failed");
  const next: Quote = { ...quote, status: "failed" };
  return { quote: next, event: makeAuditEvent(next, "sendFailed", "system", at, reason) };
}

/** 过期（draft/confirmed → expired）。 */
export function expireQuote(quote: Quote, at: string): TransitionResult {
  assertTransition(quote.status, "expired");
  const next: Quote = { ...quote, status: "expired" };
  return { quote: next, event: makeAuditEvent(next, "expired", "system", at) };
}

export function isExpired(quote: Quote, at: string): boolean {
  return Date.parse(at) >= Date.parse(quote.validUntil);
}

function assertNotExpired(quote: Quote, at: string): void {
  if (isExpired(quote, at)) {
    throw new QuoteStateError(
      `报价已于 ${quote.validUntil} 过期，需重新生成`,
      "QUOTE_EXPIRED",
    );
  }
}

/**
 * 快照复算校验 —— FR-8 校验第 6 项 / 3.6。
 *
 * 用报价冻结的 specVersionId 与选择重跑引擎，结果必须与快照**逐项一致**。
 * 不一致说明数据被篡改或引擎有回归，属于事故（PRE_LAUNCH_CHECKLIST H3：
 * 这项指标应该永远为 0）。
 */
export function verifySnapshot(
  quote: Quote,
  ctx: PricingContext,
  at: string,
): { ok: true } | { ok: false; mismatches: string[] } {
  let recomputed: PriceBreakdown;
  try {
    recomputed = computePrice(ctx, {
      selections: quote.lineItems.map((l) => ({
        moduleId: l.moduleId,
        qty: l.qty,
        width: l.width,
        height: l.height,
        depth: l.depth,
        assembly: l.assembly,
        hardwareOptionIds: l.modifiers.filter((m) => m.kind === "hardware").map((m) => m.refId),
        accessoryOptionIds: l.modifiers.filter((m) => m.kind === "accessory").map((m) => m.refId),
      })),
      doorStyleId: quote.doorStyleId,
      accountType: quote.accountTypeAtQuote,
      province: quote.province,
      at,
    });
  } catch (e) {
    return { ok: false, mismatches: [`复算失败：${e instanceof Error ? e.message : String(e)}`] };
  }

  const mismatches: string[] = [];
  if (recomputed.subtotal !== quote.subtotal) {
    mismatches.push(`subtotal 快照 ${quote.subtotal} ≠ 复算 ${recomputed.subtotal}`);
  }
  if (recomputed.total !== quote.total) {
    mismatches.push(`total 快照 ${quote.total} ≠ 复算 ${recomputed.total}`);
  }
  if (recomputed.lineItems.length !== quote.lineItems.length) {
    mismatches.push(`行数 快照 ${quote.lineItems.length} ≠ 复算 ${recomputed.lineItems.length}`);
  } else {
    recomputed.lineItems.forEach((line, i) => {
      const snap = quote.lineItems[i]!;
      if (line.unitListPrice !== snap.unitListPrice) {
        mismatches.push(`第 ${i + 1} 行 unitListPrice 快照 ${snap.unitListPrice} ≠ 复算 ${line.unitListPrice}`);
      }
      if (line.lineSubtotal !== snap.lineSubtotal) {
        mismatches.push(`第 ${i + 1} 行 lineSubtotal 快照 ${snap.lineSubtotal} ≠ 复算 ${line.lineSubtotal}`);
      }
    });
  }
  const snapTax = quote.taxes.reduce((s, t) => s + t.amount, 0);
  if (recomputed.taxTotal !== snapTax) {
    mismatches.push(`税额 快照 ${snapTax} ≠ 复算 ${recomputed.taxTotal}`);
  }

  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}
