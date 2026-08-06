/**
 * 贸易账号的多项目管理 —— FR-11、SCENARIOS 场景 F。
 *
 * `trade` 账号一个月可能接好几单，每单都要单独比价。差异只在账号层面多了
 * 「项目列表/切换」这一层——底层引擎（对话、排布、报价、闸门）完全复用
 * （场景 F 第 3 点）。
 */
import { format, type Money } from "../domain/money.js";
import type { Conversation, CustomerAccount, Quote } from "../domain/types.js";

export type ProjectStatus =
  | "collecting"   // 还在聊需求
  | "designing"    // 已出方案
  | "quoted"       // 已有报价
  | "sent"         // 已发给公司
  | "dormant";     // 30 天没动静

/** 超过这个天数没有新消息就算沉寂——建商项目多，需要提醒哪些卡住了。 */
export const DORMANT_DAYS = 30;

export interface ProjectSummary {
  conversationId: string;
  /** 项目名：取需求摘要首行，没有就用创建日期。 */
  title: string;
  status: ProjectStatus;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  /** 涉及的公司数量。 */
  companyCount: number;
  quoteCount: number;
  /** 最低报价，便于在列表里横向看。 */
  lowestQuote?: { companyId: string; total: Money; formatted: string };
  /** 已发送的报价数——对应会产生线索费的动作。 */
  sentCount: number;
  daysIdle: number;
}

export interface ProjectListInput {
  account: CustomerAccount;
  conversations: readonly Conversation[];
  quotes: readonly Quote[];
  at: string;
}

const DAY_MS = 86_400_000;

export function listProjects(input: ProjectListInput): ProjectSummary[] {
  const mine = input.conversations.filter((c) => c.customerAccountId === input.account.id);

  return mine
    .map((conv) => {
      const quotes = input.quotes.filter((q) => q.conversationId === conv.id);
      const lastMsg = conv.messages[conv.messages.length - 1];
      const lastActivityAt = lastMsg?.at ?? conv.createdAt;
      const daysIdle = Math.floor((Date.parse(input.at) - Date.parse(lastActivityAt)) / DAY_MS);
      const sentCount = quotes.filter((q) => q.status === "sent").length;

      const lowest = quotes.length
        ? quotes.reduce((a, b) => (b.total < a.total ? b : a))
        : undefined;

      return {
        conversationId: conv.id,
        title: projectTitle(conv),
        status: deriveStatus({ quotes, sentCount, daysIdle, conv }),
        createdAt: conv.createdAt,
        lastActivityAt,
        messageCount: conv.messages.length,
        companyCount: conv.perCompanyThreads.length,
        quoteCount: quotes.length,
        ...(lowest
          ? { lowestQuote: { companyId: lowest.companyId, total: lowest.total, formatted: format(lowest.total) } }
          : {}),
        sentCount,
        daysIdle,
      };
    })
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

/** 项目名取需求摘要的首行——建商记不住 `cv_a1b2c3d4`。 */
function projectTitle(conv: Conversation): string {
  const firstLine = conv.designRequirements.split("\n")[0]?.trim();
  if (firstLine) return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
  const firstUser = conv.messages.find((m) => m.role === "user")?.content.trim();
  if (firstUser) return firstUser.length > 40 ? `${firstUser.slice(0, 39)}…` : firstUser;
  return `项目 ${conv.createdAt.slice(0, 10)}`;
}

function deriveStatus(input: {
  quotes: readonly Quote[];
  sentCount: number;
  daysIdle: number;
  conv: Conversation;
}): ProjectStatus {
  if (input.sentCount > 0) return "sent";
  if (input.daysIdle >= DORMANT_DAYS) return "dormant";
  if (input.quotes.length > 0) return "quoted";
  if (input.conv.perCompanyThreads.length > 0) return "designing";
  return "collecting";
}

/** 账号层面的汇总——建商想一眼看到"手上几单、卡住几单"。 */
export interface PortfolioSummary {
  total: number;
  byStatus: Record<ProjectStatus, number>;
  dormant: ProjectSummary[];
  /** 所有已发送报价的合计（建商的采购量级）。 */
  sentValue: Money;
}

export function summarizePortfolio(projects: readonly ProjectSummary[], quotes: readonly Quote[]): PortfolioSummary {
  const byStatus: Record<ProjectStatus, number> = {
    collecting: 0, designing: 0, quoted: 0, sent: 0, dormant: 0,
  };
  for (const p of projects) byStatus[p.status]++;

  const projectIds = new Set(projects.map((p) => p.conversationId));
  const sentValue = quotes
    .filter((q) => q.status === "sent" && projectIds.has(q.conversationId))
    .reduce((sum, q) => sum + q.total, 0) as Money;

  return {
    total: projects.length,
    byStatus,
    dormant: projects.filter((p) => p.status === "dormant"),
    sentValue,
  };
}

// 交互模式见 ./interaction.ts，资质核实见 ./verification.ts——
// 这个文件只管「有哪些项目、各自到哪一步了」。
