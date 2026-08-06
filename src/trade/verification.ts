/**
 * 贸易资质核实 —— 开放问题 7 的定案。
 *
 * 定案：**人工审核 + 付费订阅，两道门槛都过了才给贸易价。**
 *
 * 理由：不核实等于任何消费者注册时勾一个「我是建商」就能拿贸易价，
 * 「贸易价」这个概念本身就失效；而且入驻公司发现后会有强烈反弹——
 * 他们给建商的折扣是基于走量的商业约定，不是给所有人的价。
 * MVP 阶段建商数量有限，人工审核量可控。
 */
import type { AccountType, CustomerAccount, Timestamp } from "../domain/types.js";

export type VerificationStatus = "unverified" | "pending" | "verified" | "rejected";

export interface TradeVerification {
  /** 与 accountId 同值，便于直接走 JsonCollection 的 byId。 */
  id: string;
  accountId: string;
  status: VerificationStatus;
  /**
   * 营业执照号 / GST 号等。
   * **只存编号，不存证件影像**——PIPEDA 最小化原则（FR-13 第 1 条）：
   * 核实只需要一个可查证的号码，留存影像会平白扩大泄露面。
   */
  businessNumber?: string;
  legalName?: string;
  submittedAt?: Timestamp;
  reviewedAt?: Timestamp;
  reviewedBy?: string;
  /** 驳回原因要能原样展示给申请人，不能只留内部代码。 */
  rejectionReason?: string;
}

export class VerificationError extends Error {}

/** GST/HST 号：9 位数字 + RT + 4 位。营业执照号各省格式不一，只做非空与长度检查。 */
const GST_RE = /^\d{9}\s?RT\s?\d{4}$/i;

export function normalizeBusinessNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toUpperCase();
}

export function submitVerification(
  existing: TradeVerification | undefined,
  input: { accountId: string; businessNumber: string; legalName: string; at: Timestamp },
): TradeVerification {
  if (existing?.status === "verified") {
    throw new VerificationError("该账号已通过资质审核，无需重复提交");
  }
  const bn = normalizeBusinessNumber(input.businessNumber);
  if (bn.length < 9) {
    throw new VerificationError("请提供有效的营业执照号或 GST/HST 号（至少 9 位）");
  }
  const legalName = input.legalName.trim();
  if (!legalName) throw new VerificationError("请提供公司注册名称");

  return {
    id: input.accountId,
    accountId: input.accountId,
    status: "pending",
    businessNumber: bn,
    legalName,
    submittedAt: input.at,
  };
}

/** 号码看起来像标准 GST 号时给运营一个提示，减少人工比对的工作量。 */
export function looksLikeGstNumber(businessNumber: string): boolean {
  return GST_RE.test(businessNumber);
}

export function reviewVerification(
  current: TradeVerification,
  input: { approve: boolean; reviewedBy: string; reason?: string; at: Timestamp },
): TradeVerification {
  if (current.status !== "pending") {
    throw new VerificationError(`当前状态为 ${current.status}，只有 pending 的申请可以审核`);
  }
  if (!input.approve && !input.reason?.trim()) {
    throw new VerificationError("驳回必须给出原因——申请人要据此知道该补什么");
  }
  return {
    ...current,
    status: input.approve ? "verified" : "rejected",
    reviewedAt: input.at,
    reviewedBy: input.reviewedBy,
    ...(input.approve ? {} : { rejectionReason: input.reason!.trim() }),
  };
}

export interface TradeGate {
  allowed: boolean;
  /** 直接可以展示给用户的说明；allowed 时为 undefined。 */
  reason?: string;
  /** 前端据此决定引导到哪一步。 */
  nextStep?: "submitVerification" | "awaitReview" | "resubmit" | "subscribe" | "none";
}

/** 贸易价的可见性门槛。两道门槛都过才给。 */
export function canSeeTradePricing(
  account: CustomerAccount,
  verification: TradeVerification | undefined,
): TradeGate {
  if (account.accountType !== "trade") {
    return { allowed: false, reason: "非贸易账号", nextStep: "none" };
  }

  const status = verification?.status ?? "unverified";
  if (status === "unverified") {
    return {
      allowed: false,
      reason: "贸易价需要先通过资质核实。请提交公司注册名称与营业执照号 / GST 号。",
      nextStep: "submitVerification",
    };
  }
  if (status === "pending") {
    return {
      allowed: false,
      reason: "资质材料已收到，我们会在 2 个工作日内完成审核。审核期间按标准零售价报价。",
      nextStep: "awaitReview",
    };
  }
  if (status === "rejected") {
    return {
      allowed: false,
      reason: `资质审核未通过：${verification?.rejectionReason ?? "未说明原因"}。补齐后可重新提交。`,
      nextStep: "resubmit",
    };
  }

  if (account.subscriptionStatus !== "active" && account.subscriptionStatus !== "trial") {
    return {
      allowed: false,
      reason: "资质已通过，但贸易账号订阅未生效。订阅恢复后自动按贸易价报价。",
      nextStep: "subscribe",
    };
  }
  return { allowed: true };
}

/**
 * 定价时**实际**使用的账号类型。
 *
 * 未通过门槛的 trade 账号按 `consumer` 定价。这是把开放问题 7 的决策
 * 落到定价链路上的执行点——不能只在界面上把贸易价藏起来，
 * 否则任何直接打 API 的人都能拿到本不该给的价。
 */
export function effectiveAccountType(
  account: CustomerAccount,
  verification: TradeVerification | undefined,
): AccountType {
  return canSeeTradePricing(account, verification).allowed ? "trade" : "consumer";
}
