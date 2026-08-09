/**
 * 从客户会话/修订话术识别可入 L1 队列的纠错信号（仍 draft，需人工确认）。
 *
 * 不读跨厂数据；调用方按 companyId 隔离写入。
 */
import type { Conversation } from "../domain/types.js";
import type { PlanRevisionRequest } from "../design/stages.js";

export interface DetectedSessionCorrection {
  summary: string;
  conversationId: string;
  codingHint?: { pattern: string; meaning: string };
  /** 稳定去重用的片段（不含随机）。 */
  signalKey: string;
}

const CORRECTION_RE =
  /(?:不对|错了|应该是|其实是|不是这样|改成|纠正|更正|纠正一下|actually|correction|should be|not\s+(?:a\s+)?|wrong|instead of|meant to be|你们(?:型号|编码|前缀)|prefix\s+(?:means|is)|coding)/i;

const CODING_HINT_RE =
  /(?:^|[\s,;:：])([A-Z]{1,3}\d{0,4}|[\^]?[A-Z]{1,3}\\?d?\*?)[^\n]{0,40}(?:means?|是|表示|代表|=)\s*([^\n.;。]{2,60})/i;

/**
 * 单句是否像纠错（客户纠正系统/型号/前缀语义）。
 */
export function looksLikeSessionCorrection(text: string): boolean {
  const t = text.trim();
  if (t.length < 6 || t.length > 500) return false;
  return CORRECTION_RE.test(t);
}

/** 尝试从纠错句抽出 codingRules 候选（很保守）。 */
export function extractCodingHint(
  text: string,
): { pattern: string; meaning: string } | undefined {
  const m = text.match(CODING_HINT_RE);
  if (!m) return undefined;
  const raw = (m[1] ?? "").trim();
  const meaning = (m[2] ?? "").trim();
  if (!raw || meaning.length < 2) return undefined;
  const pattern = raw.startsWith("^") ? raw : `^${raw.replace(/\*$/, "")}`;
  return { pattern, meaning: meaning.slice(0, 80) };
}

export function detectCorrectionFromText(
  text: string,
  conversationId: string,
): DetectedSessionCorrection | undefined {
  if (!looksLikeSessionCorrection(text)) return undefined;
  const summary = text.trim().replace(/\s+/g, " ").slice(0, 240);
  const codingHint = extractCodingHint(text);
  return {
    summary,
    conversationId,
    ...(codingHint ? { codingHint } : {}),
    signalKey: summary.slice(0, 80),
  };
}

/**
 * 从会话用户消息 + 近期修订 note 收集纠错（供 scan / 自动入队）。
 */
export function collectSessionCorrections(input: {
  companyId: string;
  conversations: readonly Conversation[];
  /** conversationId → 修订请求（来自 DesignSession）。 */
  revisionsByConversation?: ReadonlyMap<string, readonly PlanRevisionRequest[]>;
}): {
  summary: string;
  conversationId?: string;
  codingHint?: { pattern: string; meaning: string };
}[] {
  const out: {
    summary: string;
    conversationId?: string;
    codingHint?: { pattern: string; meaning: string };
  }[] = [];
  const seen = new Set<string>();

  for (const conv of input.conversations) {
    // 仅已 @ 该公司的会话
    const bound = conv.perCompanyThreads.some((t) => t.companyId === input.companyId);
    if (!bound) continue;

    for (const m of conv.messages) {
      if (m.role !== "user") continue;
      const hit = detectCorrectionFromText(m.content, conv.id);
      if (!hit) continue;
      const key = `${conv.id}|${hit.signalKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        summary: hit.summary,
        conversationId: conv.id,
        ...(hit.codingHint ? { codingHint: hit.codingHint } : {}),
      });
    }

    const revs = input.revisionsByConversation?.get(conv.id) ?? [];
    for (const r of revs) {
      if (!r.note) continue;
      const hit = detectCorrectionFromText(r.note, conv.id);
      if (!hit) continue;
      const key = `${conv.id}|rev|${hit.signalKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        summary: hit.summary,
        conversationId: conv.id,
        ...(hit.codingHint ? { codingHint: hit.codingHint } : {}),
      });
    }
  }
  return out;
}
