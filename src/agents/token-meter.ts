/**
 * Token 计量 —— 一次会话到底烧了多少。
 *
 * ## 为什么要有
 *
 * 这套系统对每个客户会调好几次模型：总控助手每轮一次、公司 Agent 每次 @ 一次、
 * 户型抽取一次、修改要求解析一次。单价看着都不高，但**每个客户的成本是这些的和**，
 * 而线索费是按客户收的——不知道一次会话烧多少 token，就不知道线索费定多少不亏。
 *
 * 所以计量按**调用点**分（`CallSite`），不按"总量"。总量告诉你"贵了"，
 * 分调用点才告诉你"贵在哪"：如果 80% 的 token 花在总控助手的日常闲聊上，
 * 该做的是把那一层压到更便宜的模型（`model-tiers.ts` 已经这么分了），
 * 而不是笼统地"优化 prompt"。
 *
 * ## 没配模型的时候也要记
 *
 * CI 与本地开发都跑在**没有 API key** 的降级路径上（确定性问答）。那时候真实
 * token 是 0，但"这一轮本来会调几次模型、prompt 有多大"是可测的——记下来，
 * 报告里给出**估算**并明确标注是估算。不记的话，场景测试跑一百遍也回答不了
 * 「上线之后一个客户多少钱」。
 */
import type { CallSite } from "./model-tiers.js";

export interface CallRecord {
  callSite: CallSite | "unknown";
  /** 实际用的模型 id。降级路径为空。 */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * 这次调用是真的发出去了，还是走了降级路径。
   *
   * 降级路径的 token 数是**按 prompt 字符数估的**，不是实测——报告里必须分开列，
   * 混在一起会让人以为那是真实开销。
   */
  estimated: boolean;
}

export interface TokenSnapshot {
  calls: number;
  /** 真的调用了模型的次数。 */
  realCalls: number;
  inputTokens: number;
  outputTokens: number;
  get totalTokens(): number;
  /** 按调用点分。**成本花在哪**要看这个，不是看总量。 */
  byCallSite: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  /** 全部是估算值（一次真实调用都没有）。 */
  allEstimated: boolean;
}

let records: CallRecord[] = [];

/**
 * 从字符数估 token 数。
 *
 * ⚠️ **粗估，只用于没有真实用量时的量级参考。** 中文约 1.5 字/token、
 * 英文约 4 字符/token；我们的 prompt 是中英混排，取 2.5 作为折中。
 * 真实值以 API 返回的 usage 为准——所以估算值在报告里单独一列。
 */
export const CHARS_PER_TOKEN = 2.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** 记一次真实调用。`usage` 由 SDK 给。 */
export function recordUsage(input: {
  callSite?: CallSite;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  records.push({
    callSite: input.callSite ?? "unknown",
    ...(input.model ? { model: input.model } : {}),
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    estimated: false,
  });
}

/**
 * 记一次**没有真的发出去**的调用（降级路径）。
 *
 * 传 prompt 的原文，这里按字符数估。记的是"本来会花多少"。
 */
export function recordSkipped(input: {
  callSite?: CallSite;
  prompt: string;
  reply: string;
}): void {
  records.push({
    callSite: input.callSite ?? "unknown",
    inputTokens: estimateTokens(input.prompt),
    outputTokens: estimateTokens(input.reply),
    estimated: true,
  });
}

export function resetTokenMeter(): void {
  records = [];
}

export function tokenSnapshot(): TokenSnapshot {
  const byCallSite: TokenSnapshot["byCallSite"] = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let realCalls = 0;

  for (const r of records) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    if (!r.estimated) realCalls++;
    const bucket = byCallSite[r.callSite] ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
    bucket.calls++;
    bucket.inputTokens += r.inputTokens;
    bucket.outputTokens += r.outputTokens;
  }

  return {
    calls: records.length,
    realCalls,
    inputTokens,
    outputTokens,
    get totalTokens() { return this.inputTokens + this.outputTokens; },
    byCallSite,
    allEstimated: records.length > 0 && realCalls === 0,
  };
}

/** 一行摘要，给控制台用。 */
export function formatTokenSummary(s: TokenSnapshot): string {
  if (s.calls === 0) return "模型调用 0 次";
  const tag = s.allEstimated ? "（估算，未配置模型）" : s.realCalls < s.calls ? "（含估算）" : "";
  return `模型调用 ${s.calls} 次${tag}　输入 ${s.inputTokens} / 输出 ${s.outputTokens} ` +
    `= ${s.totalTokens} token`;
}
