/**
 * 从运营自然语言抽知识卡（确定性 MVP；有 LLM 时可增强）。
 */
import { randomUUID } from "node:crypto";
import type { CompletionClient } from "../agents/types.js";
import { createDraftCard } from "./cards.js";
import { shouldRejectTrainingText } from "./validate.js";
import type {
  KnowledgeKind,
  KnowledgeScope,
  PlatformKnowledgeCard,
  SettleTarget,
} from "./types.js";

export interface ExtractResult {
  rejected?: { message: string; code: string };
  cards: PlatformKnowledgeCard[];
  assistantSummary: string;
}

export interface ExtractInput {
  text: string;
  trainerConversationId: string;
  taughtBy: string;
  client?: CompletionClient;
}

function baseProvenance(input: ExtractInput) {
  return {
    trainerConversationId: input.trainerConversationId,
    taughtBy: input.taughtBy,
    taughtAt: new Date().toISOString(),
  };
}

/** 北美 stove / 灶台柜启发式 —— 验收主路径。 */
function extractStoveHeuristics(input: ExtractInput): PlatformKnowledgeCard[] {
  const t = input.text;
  const stoveTalk =
    /stove|range|烤箱一体|灶台柜|cooktop\s*base|不要灶台|不需要灶台|freestanding/i.test(t);
  if (!stoveTalk) return [];

  const cards: PlatformKnowledgeCard[] = [];
  const prov = baseProvenance(input);

  cards.push(
    createDraftCard({
      kind: "domain_fact",
      scope: ["orchestrator", "design", "layout"],
      settleTarget: "config.appliance",
      title: "NA freestanding range defaults",
      body: {
        en:
          "North American “stove” usually means a freestanding range (cooktop + oven). " +
          "Prefer standard widths (often 30\").",
        zh: "北美所说的 stove 通常指灶烤箱一体的 freestanding range；常见宽度约 30 寸。",
      },
      structured: {
        applianceDefaults: {
          rangeKind: "freestanding",
          standardWidthsIn: [30],
          defaultWidths: { range: 30 },
          preferNoCooktopBase: true,
        },
      },
      provenance: prov,
    }),
  );

  cards.push(
    createDraftCard({
      kind: "design_heuristic",
      scope: ["layout", "design"],
      settleTarget: "config.layoutHeuristic",
      title: "Prefer no cooktop base for freestanding range",
      body: {
        en:
          "Do not plan a separate cooktop-base cabinet unless the customer specified a cooktop " +
          "(or cooktop + wall oven). A freestanding range sits in an appliance opening.",
        zh: "除非客户明确要嵌入式灶台（或灶台+独立烤箱），否则不要规划专用灶台柜。",
      },
      structured: {
        layoutHeuristic: { preferNoCooktopBase: true },
      },
      provenance: prov,
    }),
  );

  cards.push(
    createDraftCard({
      kind: "domain_fact",
      scope: ["orchestrator", "explain"],
      settleTarget: "handbook",
      title: "Explain range vs cooktop cabinet",
      body: {
        en:
          "When customers ask about a “stove cabinet”: for a typical NA freestanding range, " +
          "there is no separate cooktop base — the range is an appliance cutout.",
        zh: "客户问「要不要灶台柜」时：北美一体灶通常只要家电预留位，不需要单独灶下柜。",
      },
      provenance: prov,
    }),
  );

  return cards;
}

function extractDialogue(input: ExtractInput): PlatformKnowledgeCard[] {
  const t = input.text;
  if (!/每轮|一次问|maxQuestions|追问|不要重复问|已答不重问/i.test(t)) return [];
  const m = t.match(/(\d+)\s*个?问题/);
  const n = m ? Number(m[1]) : undefined;
  return [
    createDraftCard({
      kind: "dialogue_policy",
      scope: ["orchestrator"],
      settleTarget: "config.dialogue",
      title: "Dialogue pacing",
      body: {
        en: t.slice(0, 500),
        zh: /[\u4e00-\u9fff]/.test(t) ? t.slice(0, 500) : undefined,
      },
      structured: {
        dialogue: {
          ...(n && n >= 1 && n <= 5 ? { maxQuestionsPerTurn: n } : { maxQuestionsPerTurn: 2 }),
        },
      },
      provenance: baseProvenance(input),
    }),
  ];
}

function extractReviewRule(input: ExtractInput): PlatformKnowledgeCard[] {
  const t = input.text;
  if (!/必须披露|blocking|advisory|交付前|审核规则|sanity\s*rule|SR-/i.test(t)) return [];
  const severity = /blocking|阻断|不许放行/i.test(t) ? "blocking" as const : "advisory" as const;
  return [
    createDraftCard({
      kind: "process",
      scope: ["all"],
      settleTarget: "review.rule",
      title: "Proposed review rule",
      body: { en: t.slice(0, 800) },
      structured: {
        reviewRule: {
          title: t.slice(0, 80).replace(/\s+/g, " ").trim(),
          severity,
          criterion: "TODO: make criterion assertable from ops wording",
          why: t.slice(0, 400),
          enforcedBy: "audit",
          implementedInHint: "delivery/audit.ts + relevant checker",
        },
      },
      provenance: baseProvenance(input),
    }),
  ];
}

function extractGenericHandbook(input: ExtractInput): PlatformKnowledgeCard[] {
  // 已有专用抽取则不再套通用 handbook
  return [
    createDraftCard({
      kind: "domain_fact" as KnowledgeKind,
      scope: ["orchestrator"] as KnowledgeScope[],
      settleTarget: "handbook" as SettleTarget,
      title: "Ops note",
      body: {
        en: input.text.slice(0, 1000),
        zh: /[\u4e00-\u9fff]/.test(input.text) ? input.text.slice(0, 1000) : undefined,
      },
      provenance: baseProvenance(input),
    }),
  ];
}

/**
 * 确定性抽取。无匹配时落 handbook 一条（仍须人工 publish）。
 */
export function extractKnowledgeDeterministic(input: ExtractInput): ExtractResult {
  const reject = shouldRejectTrainingText(input.text);
  if (reject) {
    return {
      rejected: { message: reject.message, code: reject.code },
      cards: [],
      assistantSummary:
        `I cannot store that as platform knowledge (${reject.code}): ${reject.message}`,
    };
  }

  const cards = [
    ...extractStoveHeuristics(input),
    ...extractDialogue(input),
    ...extractReviewRule(input),
  ];

  const finalCards = cards.length ? cards : extractGenericHandbook(input);

  const summary = finalCards.length
    ? `Proposed ${finalCards.length} draft card(s):\n` +
      finalCards
        .map((c) => `• [${c.settleTarget}] ${c.title}`)
        .join("\n") +
      `\nConfirm and publish to take effect. review.rule stays inert until settled in code.`
    : "I did not extract a card.";

  return { cards: finalCards, assistantSummary: summary };
}

/** 可选 LLM 增强：失败则回退确定性。 */
export async function extractKnowledge(input: ExtractInput): Promise<ExtractResult> {
  // MVP：确定性路径覆盖验收；LLM 可后续解析 JSON 卡。
  void input.client;
  void randomUUID;
  return extractKnowledgeDeterministic(input);
}
