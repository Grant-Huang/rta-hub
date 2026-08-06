/**
 * 邮件列表订阅 —— FR-12、COMPANY_DISCOVERY.md 的合法获客路径。
 *
 * 路径：社媒广告 → 企业**主动**访问 → **主动勾选同意** → 写入 EmailSubscription。
 * 只有走完这条路径的地址才可以收到 invite/mailing 类邮件。
 *
 * CASL 的 Express Consent 要求同意记录可追溯：时间、渠道、条款版本、UA、IP。
 */
import { createHash, randomUUID } from "node:crypto";
import type { EmailSubscription } from "../domain/types.js";

export class SubscriptionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SubscriptionError";
  }
}

export interface SubscribeInput {
  email: string;
  companyName: string;
  /** 必须是 true —— 主动勾选，不接受默认勾选或"继续即代表同意"。 */
  consentGiven: boolean;
  termsVersion: string;
  userAgent?: string;
  ipAddress?: string;
  at: string;
}

/**
 * IP 脱敏：IPv4 末段置零、IPv6 保留前 3 组。
 *
 * 同意记录需要 IP 作为凭据，但完整 IP 属于个人信息，按 PIPEDA 的最小化原则脱敏存储。
 */
export function anonymizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (!trimmed) return "";
  if (trimmed.includes(":")) {
    const groups = trimmed.split(":");
    return [...groups.slice(0, 3), "0", "0", "0", "0", "0"].slice(0, 8).join(":");
  }
  const parts = trimmed.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  return trimmed;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function subscribe(input: SubscribeInput): EmailSubscription {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new SubscriptionError(`邮箱格式不合法：${input.email}`, "INVALID_EMAIL");
  }
  if (!input.companyName.trim()) {
    throw new SubscriptionError("必须填写公司名称", "MISSING_COMPANY");
  }
  // ★ CASL：同意必须是主动的
  if (!input.consentGiven) {
    throw new SubscriptionError(
      "必须主动勾选同意才能加入邮件列表（CASL Express Consent）",
      "CONSENT_REQUIRED",
    );
  }
  if (!input.termsVersion) {
    throw new SubscriptionError("同意记录必须带条款版本号", "MISSING_TERMS_VERSION");
  }

  return {
    id: `sub_${randomUUID().slice(0, 8)}`,
    email,
    companyName: input.companyName.trim(),
    consentDate: input.at,
    consentChannel: "web_form",
    termsVersion: input.termsVersion,
    ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 256) } : {}),
    ...(input.ipAddress ? { ipAddress: anonymizeIp(input.ipAddress) } : {}),
    unsubscribeToken: createHash("sha256")
      .update(`${email}|${randomUUID()}`).digest("hex").slice(0, 32),
    status: "active",
  };
}

/** CASL 要求退订请求 10 个工作日内生效——这里是立即生效。 */
export function unsubscribeByToken(
  subscriptions: readonly EmailSubscription[],
  token: string,
  at: string,
): EmailSubscription {
  const sub = subscriptions.find((s) => s.unsubscribeToken === token);
  if (!sub) throw new SubscriptionError("退订链接无效或已失效", "INVALID_TOKEN");
  return { ...sub, status: "unsubscribed", unsubscribedAt: at };
}

export function unsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/unsubscribe?token=${token}`;
}

/** 可投递的收件人 —— 只有 active 订阅者。 */
export function deliverableRecipients(subscriptions: readonly EmailSubscription[]): EmailSubscription[] {
  return subscriptions.filter((s) => s.status === "active");
}

/**
 * 条款更新且涉及用途变更时，需要重新取得同意。
 *
 * 返回同意记录停留在旧版本的订阅者——他们在重新同意前不应收到新用途的邮件。
 */
export function needsReconsent(
  subscriptions: readonly EmailSubscription[],
  currentTermsVersion: string,
): EmailSubscription[] {
  return subscriptions.filter((s) => s.status === "active" && s.termsVersion !== currentTermsVersion);
}
