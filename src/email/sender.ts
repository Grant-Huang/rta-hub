/**
 * 邮件发送 —— FR-7、FR-12、CASL 合规。
 *
 * 三类邮件（REQUIREMENTS 第 10 节）：
 *   LeadEmail    —— 客户确认后的报价发送（FR-7）
 *   InviteEmail  —— 招商邀约，仅发给已订阅邮件列表的企业（FR-12）
 *   MailingEmail —— 订阅列表的产品更新（FR-12）
 *
 * CASL 要求在类型层面强制：
 *   - 每封邮件必须有**发件人身份**（名称 + 联系方式）；
 *   - `InviteEmail`/`MailingEmail` 必须有**可用的退订链接**，且只能发给
 *     `EmailSubscription.status === "active"` 的地址；
 *   - `LeadEmail` 是客户主动发起的一次性询价，不需要退订链接，但仍需身份披露。
 */
import type { EmailSubscription } from "../domain/types.js";

export type EmailKind = "lead" | "invite" | "mailing";

export interface SenderIdentity {
  /** CASL 要求：发件人名称。 */
  name: string;
  email: string;
  /** CASL 要求：可联系的邮寄地址或电话。 */
  contact: string;
}

export interface OutboundEmail {
  kind: EmailKind;
  to: string;
  subject: string;
  /** 纯文本兜底版本 —— 始终必填，内容必须完整（FR-7）。 */
  text: string;
  /** HTML 正文（可选）。CID 内嵌图片引用 attachments 里的 cid。 */
  html?: string;
  /** 附件。既作 CID 内嵌源，也作图片被拦截时的兜底（FR-7）。 */
  attachments?: {
    filename: string; cid?: string; contentType: string;
    content: string; encoding?: "utf-8" | "base64";
  }[];
  /** 退订链接；invite/mailing 必填。 */
  unsubscribeUrl?: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export function resolveSmtpConfig(env = process.env): SmtpConfig | null {
  const host = env["SMTP_HOST"];
  const user = env["SMTP_USER"];
  const pass = env["SMTP_PASS"];
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(env["SMTP_PORT"] || 587),
    secure: env["SMTP_SECURE"] === "true",
    user,
    pass,
    from: env["SMTP_FROM"] || user,
  };
}

export function isSendConfigured(env = process.env): boolean {
  return resolveSmtpConfig(env) !== null;
}

export function resolveSenderIdentity(env = process.env): SenderIdentity {
  return {
    name: env["SENDER_NAME"] || "RTA-Hub",
    email: env["SMTP_FROM"] || env["SMTP_USER"] || "",
    contact: env["SENDER_PHONE"] || env["SENDER_ADDRESS"] || "",
  };
}

export class CaslComplianceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CaslComplianceError";
  }
}

/**
 * 发送前的 CASL 合规校验。
 *
 * 这些检查放在发送路径上而不是文档里——文档挡不住一次疏忽的部署。
 */
export function assertCaslCompliant(email: OutboundEmail, sender: SenderIdentity): void {
  if (!sender.name || !sender.email) {
    throw new CaslComplianceError("发件人身份不完整（CASL 要求披露发件人名称与联系方式）", "MISSING_IDENTITY");
  }
  if (email.kind !== "lead") {
    if (!email.unsubscribeUrl) {
      throw new CaslComplianceError(
        `${email.kind} 类邮件必须带可用的退订链接（CASL）`,
        "MISSING_UNSUBSCRIBE",
      );
    }
    // 两个版本都要有 —— 只在其中一个里放退订链接，另一版的收件人就无从退订
    if (!email.text.includes(email.unsubscribeUrl)) {
      throw new CaslComplianceError("退订链接必须出现在纯文本正文里", "UNSUBSCRIBE_NOT_IN_BODY");
    }
    if (email.html && !email.html.includes(email.unsubscribeUrl)) {
      throw new CaslComplianceError("退订链接必须出现在 HTML 正文里", "UNSUBSCRIBE_NOT_IN_BODY");
    }
  }
  if (!email.text.includes(sender.name)) {
    throw new CaslComplianceError("纯文本正文必须包含发件人身份", "IDENTITY_NOT_IN_BODY");
  }
  if (email.html && !email.html.includes(sender.name)) {
    throw new CaslComplianceError("HTML 正文必须包含发件人身份", "IDENTITY_NOT_IN_BODY");
  }
}

/** 给营销类邮件只发给 active 订阅者 —— 退订后必须真的收不到。 */
export function assertSubscribed(
  to: string,
  subscriptions: readonly EmailSubscription[],
): EmailSubscription {
  const sub = subscriptions.find((s) => s.email.toLowerCase() === to.toLowerCase());
  if (!sub) {
    throw new CaslComplianceError(`${to} 不在邮件列表中，不得发送营销类邮件`, "NOT_SUBSCRIBED");
  }
  if (sub.status !== "active") {
    throw new CaslComplianceError(`${to} 已退订，不得再发送`, "UNSUBSCRIBED");
  }
  return sub;
}

export type SendResult =
  | { delivered: true; dryRun: boolean }
  | { delivered: false; dryRun: boolean; error: string };

export interface SendOptions {
  smtp?: SmtpConfig | null;
  sender?: SenderIdentity;
  /** 逐封间隔，避免触发供应商侧风控。 */
  delayMs?: number;
  /** 注入用于测试的传输器。 */
  transport?: { sendMail(msg: Record<string, unknown>): Promise<unknown> };
}

/**
 * 发送一封邮件。
 *
 * 未配置 SMTP → dry-run，**不发起任何网络请求**（发送闸门的第二道防线）。
 * 注意第一道防线在 Quote 状态机里，不在这。
 */
export async function sendEmail(email: OutboundEmail, opts: SendOptions = {}): Promise<SendResult> {
  const sender = opts.sender ?? resolveSenderIdentity();
  const smtp = opts.smtp === undefined ? resolveSmtpConfig() : opts.smtp;
  const dryRun = !smtp && !opts.transport;

  // CASL 校验**在 dry-run 下也跑**，好让配置问题在开发期就暴露；
  // 但它是一次「发送失败」而不是服务端异常——缺配置不该让接口 500。
  try {
    assertCaslCompliant(email, sender);
  } catch (e) {
    if (e instanceof CaslComplianceError) {
      return { delivered: false, dryRun, error: `CASL 校验未通过：${e.message}` };
    }
    throw e;
  }

  if (dryRun) {
    return { delivered: false, dryRun: true, error: "SMTP 未配置：dry-run，未发送任何邮件" };
  }

  try {
    const transport = opts.transport ?? (await createTransport(smtp!));
    await transport.sendMail({
      from: `"${sender.name}" <${smtp?.from ?? sender.email}>`,
      to: email.to,
      subject: email.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
      ...(email.attachments?.length
        ? {
            attachments: email.attachments.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              content: a.content,
              ...(a.encoding === "base64" ? { encoding: "base64" as const } : {}),
              // 有 cid 的附件同时作为正文内嵌图；没有 cid 的是纯附件
              ...(a.cid ? { cid: a.cid, contentDisposition: "inline" as const } : {}),
            })),
          }
        : {}),
      ...(email.unsubscribeUrl
        ? { headers: { "List-Unsubscribe": `<${email.unsubscribeUrl}>` } }
        : {}),
    });
    return { delivered: true, dryRun: false };
  } catch (e) {
    return { delivered: false, dryRun: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function createTransport(smtp: SmtpConfig) {
  const nodemailer = await import("nodemailer");
  return nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });
}

// ── 正文构造 ──────────────────────────────────────────────────────────────

export interface QuoteEmailInput {
  companyName: string;
  customerName: string;
  customerEmail: string;
  province: string;
  /** 已格式化好的报价明细文本。 */
  quoteText: string;
  quoteId: string;
}

/**
 * 报价邮件（LeadEmail）。
 *
 * MVP-1 是纯文本版；HTML 内嵌四视图 + 表格属 MVP-2（FR-7）。
 */
export function buildQuoteEmail(input: QuoteEmailInput, sender: SenderIdentity): OutboundEmail {
  const text = [
    `${input.companyName} 团队您好，`,
    "",
    `我们平台上的一位客户（${input.customerName}，${input.province}）完成了一版厨房橱柜设计，`,
    "并确认将报价请求发送给贵司。明细如下：",
    "",
    input.quoteText,
    "",
    `客户联系邮箱：${input.customerEmail}`,
    `报价单编号：${input.quoteId}`,
    "",
    "这是客户本人确认后发出的一次性询价，不是营销邮件。",
    "",
    "———",
    `${sender.name}`,
    sender.contact ? `联系方式：${sender.contact}` : "",
    sender.email ? `邮箱：${sender.email}` : "",
  ].filter(Boolean).join("\n");

  return {
    kind: "lead",
    to: "", // 由调用方填公司报价邮箱
    subject: `[询价] 厨房橱柜报价请求 · ${input.quoteId}`,
    text,
  };
}

export interface InviteEmailInput {
  companyName: string;
  /** 去标识化的需求线索描述——**不得包含客户身份**（FR-13 第 3 条）。 */
  deIdentifiedSignal: string;
  unsubscribeUrl: string;
}

/**
 * 招商邀约（InviteEmail）。
 *
 * 只能发给已主动注册邮件列表的企业。正文里的线索描述必须是去标识化的——
 * 「近期有客户点名寻找贵司」可以，客户姓名邮箱不行。
 */
export function buildInviteEmail(input: InviteEmailInput, sender: SenderIdentity): OutboundEmail {
  const text = [
    `${input.companyName} 您好，`,
    "",
    "感谢订阅 RTA-Hub 的合作资讯。",
    "",
    input.deIdentifiedSignal,
    "",
    "入驻后，客户在平台上完成设计并确认后，报价请求会直接发到贵司登记的邮箱。",
    "我们按成交线索计费，入驻与规格录入不收费。",
    "",
    "———",
    `${sender.name}`,
    sender.contact ? `联系方式：${sender.contact}` : "",
    "",
    `不想再收到这类邮件？点此退订：${input.unsubscribeUrl}`,
  ].filter(Boolean).join("\n");

  return {
    kind: "invite",
    to: "",
    subject: "RTA-Hub 合作机会",
    text,
    unsubscribeUrl: input.unsubscribeUrl,
  };
}

/** 去标识化的销售信号描述（FR-13 第 3 条的执行点）。 */
export function deIdentifySignal(mentionCount: number, region?: string): string {
  const where = region ? `${region}地区` : "平台上";
  return mentionCount > 1
    ? `近期${where}有 ${mentionCount} 位客户在设计过程中点名寻找贵司。`
    : `近期${where}有客户在设计过程中点名寻找贵司。`;
}
