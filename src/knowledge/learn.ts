/**
 * 学习闭环雏形（FR-22 P1）—— 从 audit / 模拟失败自动提议 draft，不自动 publish。
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AuditReport } from "../delivery/audit.js";
import { createDraftCard } from "./cards.js";
import type { PlatformKnowledgeCard } from "./types.js";

export interface LearnSignal {
  source: "audit" | "simulate" | "session";
  conversationId?: string;
  deliverable?: string;
  summary: string;
  ruleIds?: string[];
  at?: string;
}

/** 从 audit 阻断项提议 review.rule / handbook 草案（永不 publish）。 */
export function proposeDraftsFromAudit(input: {
  audit: AuditReport;
  taughtBy?: string;
  trainerConversationId?: string;
  conversationId?: string;
}): PlatformKnowledgeCard[] {
  if (input.audit.ok || input.audit.blockers.length === 0) return [];
  const taughtBy = input.taughtBy ?? "system:learn";
  const trainerConversationId =
    input.trainerConversationId ?? `learn_${input.conversationId ?? "anon"}`;
  const prov = {
    trainerConversationId,
    taughtBy,
    taughtAt: new Date().toISOString(),
  };
  const rules = [...new Set(
    input.audit.blockers.map((b) => b.rule).filter((r) => Boolean(r)),
  )] as string[];
  const title = rules.length
    ? `Auto candidate from ${rules.slice(0, 3).join("/")}`
    : "Auto candidate from audit blockers";
  const detail = input.audit.blockers
    .slice(0, 5)
    .map((b) => `[${b.rule ?? b.code}] ${b.message}`)
    .join("\n");

  // 稳定 id：同一会话同类阻断不刷屏
  const digest = createHash("sha1")
    .update(`${trainerConversationId}|${[...rules].sort().join(",")}|${title}`)
    .digest("hex")
    .slice(0, 12);
  return [
    createDraftCard({
      id: `kc_learn_${digest}`,
      kind: "correction",
      scope: ["design", "layout", "all"],
      settleTarget: "review.rule",
      title,
      body: {
        en:
          `Session signal (not published). Blocking findings suggest a review-rule candidate:\n${detail}`,
        zh: `会话信号（未发布）。阻断项提示可能需要沉淀评审规则：\n${detail}`,
      },
      structured: {
        reviewRule: {
          proposedId: rules[0] ? `${rules[0]}-followup` : undefined,
          title,
          severity: "blocking",
          criterion: detail,
          why: "Auto-proposed from repeated or blocking audit findings; human must confirm.",
          enforcedBy: "audit",
          suggestedAuditCode: input.audit.blockers[0]?.code,
        },
      },
      provenance: prov,
    }),
  ];
}

/** 极简指标日志（JSONL），便于以后看板。 */
export function appendKnowledgeMetric(
  dataDir: string,
  event: {
    type: "reask" | "audit_blocking" | "draft_proposed" | "publish";
    conversationId?: string;
    count?: number;
    detail?: string;
    at?: string;
  },
): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const line = JSON.stringify({
      ...event,
      at: event.at ?? new Date().toISOString(),
    });
    appendFileSync(path.join(dataDir, "knowledge-metrics.jsonl"), `${line}\n`, "utf-8");
  } catch {
    // 指标失败不得影响主路径
  }
}
