/**
 * DesignCritic —— 运营侧专家挑刺（FR-21）。
 *
 * 硬边界：
 *   - 只读客户会话与设计产物；只写 CritiqueReview
 *   - 不进客户 Conversation.messages，不注入客户侧 prompt
 *   - 不自动写 L0 / Trainer 知识卡
 *   - FR-14 硬闸门仍以 auditDeliverable 为准；本层是专家意见
 */
import { randomUUID } from "node:crypto";
import type {
  Conversation, CritiqueFinding, CritiqueMessage, CritiqueReview,
  CritiqueTrigger, DeliveryAuditRecord,
} from "../domain/types.js";
import type { DesignSession } from "../design/stages.js";
import type { FloorPlan } from "../floorplan/types.js";
import { evaluateDesignReadiness } from "../design/readiness.js";
import { missingFields } from "./orchestrator.js";
import type { CompletionClient } from "./types.js";
import type { Repositories } from "../store/repositories.js";

export interface CritiqueBundle {
  conversation: Conversation;
  designSession?: DesignSession;
  floorPlan?: FloorPlan;
  audits: DeliveryAuditRecord[];
  quoteCount: number;
  layoutCount: number;
  /** 同 run 内简短统计（不含其他客户全文）。 */
  runStats?: { conversationCount: number; openCritiqueCount: number };
}

export interface RunCritiqueInput {
  repos: Repositories;
  conversationId: string;
  trigger: CritiqueTrigger;
  llm?: CompletionClient;
  runStats?: CritiqueBundle["runStats"];
}

function findingId(): string {
  return `cf_${randomUUID().slice(0, 8)}`;
}

/** 无 LLM 时的确定性挑刺——保证流水线可测。 */
export function deterministicCritique(bundle: CritiqueBundle, trigger: CritiqueTrigger): {
  summary: string;
  findings: CritiqueFinding[];
} {
  const findings: CritiqueFinding[] = [];
  const conv = bundle.conversation;
  const msgs = conv.messages;

  // 过程：助手是否重复追问同一主题（粗启发式）
  const assistantTexts = msgs.filter((m) => m.role === "assistant").map((m) => m.content.toLowerCase());
  const askSize = assistantTexts.filter((t) =>
    /how (big|large)|kitchen size|厨房.*尺寸|多大|几米/.test(t)).length;
  if (askSize >= 2) {
    findings.push({
      id: findingId(),
      severity: "minor",
      category: "dialogue",
      target: { kind: "session" },
      title: "Repeated size questions",
      body: "Assistant asked about kitchen size more than once. Prefer confirming once and moving on once dimensions exist.",
      suggestedFix: "After floor-plan walls are resolved, suppress size quick-replies and do not re-ask.",
    });
  }

  // 过程：未 @ 厂商却谈具体公司价（粗检）
  const userJoined = msgs.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const hasAt = /@\S+/.test(userJoined);
  const assistantMentionsPrice = assistantTexts.some((t) =>
    /\$\d|price for|报价|单价|门板.*价/.test(t));
  if (!hasAt && assistantMentionsPrice) {
    findings.push({
      id: findingId(),
      severity: "major",
      category: "process",
      target: { kind: "session" },
      title: "Company pricing without @ seller",
      body: "Assistant discussed pricing-like content before the customer @-mentioned a seller (FR-18).",
      suggestedFix: "Keep GenericCatalog estimates only; defer company SKU/price talk until @ routing.",
    });
  }

  // 完备性：就绪检查表缺口
  const readiness = evaluateDesignReadiness({
    conversation: conv,
    plan: bundle.floorPlan,
  });
  const openIds = readiness.openItems.map((i) => i.id);
  const fields = missingFields(conv.designRequirements);
  if (
    (openIds.length > 0 || fields.length > 0)
    && (trigger === "planView" || trigger === "fourViews" || trigger === "quote")
  ) {
    findings.push({
      id: findingId(),
      severity: "minor",
      category: "completeness",
      target: { kind: "session" },
      title: "Design requirements still incomplete",
      body: `Open readiness items at ${trigger}: ${(openIds.length ? openIds : fields).slice(0, 6).join(", ")}.`,
      suggestedFix: "Either collect before drawing or explicitly document assumptions in the explanation.",
    });
  }

  // FR-14 旁路：未通过项升级为专家意见（即便闸门已拦，sessionEnd/manual 仍可见历史）
  for (const audit of bundle.audits.slice(-3)) {
    for (const f of audit.findings.filter((x) => x.severity === "blocking")) {
      findings.push({
        id: findingId(),
        severity: "major",
        category: f.code === "ERGONOMICS" || f.code === "DOOR_CLEARANCE" ? "ergonomics" : "design_output",
        target: {
          kind: audit.deliverable === "quoteList" ? "quote" : "layout",
          ref: audit.id,
        },
        title: `Delivery audit blocker: ${f.code}`,
        body: f.message,
        suggestedFix: "Fix the underlying layout/BOM/quote issue before re-releasing to the customer.",
      });
    }
    for (const f of audit.findings.filter((x) => x.severity === "advisory").slice(0, 3)) {
      findings.push({
        id: findingId(),
        severity: "nit",
        category: "explain",
        target: { kind: "session", ref: audit.id },
        title: `Advisory: ${f.code}`,
        body: f.message,
      });
    }
  }

  if (!bundle.floorPlan && (trigger === "planView" || trigger === "fourViews")) {
    findings.push({
      id: findingId(),
      severity: "major",
      category: "process",
      target: { kind: "floorPlan" },
      title: "Drawing without a floor plan record",
      body: "A drawing trigger fired but no floor plan is attached to this conversation.",
    });
  }

  if (bundle.designSession && bundle.designSession.stage === "collecting" && trigger === "quote") {
    findings.push({
      id: findingId(),
      severity: "major",
      category: "process",
      target: { kind: "stage", ref: bundle.designSession.stage },
      title: "Quote while still collecting",
      body: "Quote trigger occurred while design session is still in collecting.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      id: findingId(),
      severity: "nit",
      category: "process",
      target: { kind: "session" },
      title: "No major issues in deterministic pass",
      body: `Trigger ${trigger}: no heuristic findings. LLM critique skipped or unavailable.`,
    });
  }

  const majors = findings.filter((f) => f.severity === "major").length;
  const summary = majors > 0
    ? `DesignCritic (${trigger}): ${majors} major / ${findings.length} findings.`
    : `DesignCritic (${trigger}): ${findings.length} finding(s), none major.`;

  return { summary, findings };
}

function formatFindingsMessage(summary: string, findings: CritiqueFinding[]): string {
  const lines = [
    summary,
    "",
    ...findings.map((f, i) =>
      `${i + 1}. [${f.severity}/${f.category}] ${f.title}\n   ${f.body}`
      + (f.suggestedFix ? `\n   → ${f.suggestedFix}` : "")),
  ];
  return lines.join("\n");
}

async function llmCritique(
  client: CompletionClient,
  bundle: CritiqueBundle,
  trigger: CritiqueTrigger,
  seed: { summary: string; findings: CritiqueFinding[] },
): Promise<{ summary: string; findings: CritiqueFinding[] }> {
  const transcript = bundle.conversation.messages
    .slice(-24)
    .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
    .join("\n");
  const auditBrief = bundle.audits.slice(-2).map((a) =>
    `${a.deliverable} ok=${a.ok} blockers=${a.findings.filter((f) => f.severity === "blocking").length}`,
  ).join("; ");

  const system = [
    "You are DesignCritic, an expert kitchen-cabinet design reviewer for platform operators.",
    "Critique the session PROCESS and design OUTPUTS. Do not invent prices.",
    "Return JSON only: {\"summary\":string,\"findings\":[{\"severity\":\"major|minor|nit\",\"category\":\"process|design_output|dialogue|ergonomics|completeness|explain\",\"title\":string,\"body\":string,\"suggestedFix\"?:string,\"targetKind\":\"session|message|floorPlan|layout|quote|stage\"}]}",
    "Max 8 findings. Prefer actionable suggestedFix. Chinese or English matching the transcript.",
  ].join("\n");

  const user = [
    `trigger: ${trigger}`,
    `stage: ${bundle.designSession?.stage ?? "n/a"}`,
    `quotes: ${bundle.quoteCount}, layouts: ${bundle.layoutCount}`,
    `recent audits: ${auditBrief || "none"}`,
    `deterministic seed findings: ${seed.findings.map((f) => f.title).join("; ")}`,
    `runStats: ${JSON.stringify(bundle.runStats ?? {})}`,
    "--- transcript ---",
    transcript || "(empty)",
  ].join("\n");

  try {
    const text = await client.complete({
      system,
      messages: [{ role: "user", content: user }],
      callSite: "designCritique",
      temperature: 0.2,
    });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return seed;
    const parsed = JSON.parse(match[0]) as {
      summary?: string;
      findings?: Array<{
        severity?: string;
        category?: string;
        title?: string;
        body?: string;
        suggestedFix?: string;
        targetKind?: string;
      }>;
    };
    const findings: CritiqueFinding[] = (parsed.findings ?? []).slice(0, 8).map((f) => ({
      id: findingId(),
      severity: (["major", "minor", "nit"].includes(f.severity ?? "")
        ? f.severity : "minor") as CritiqueFinding["severity"],
      category: ([
        "process", "design_output", "dialogue", "ergonomics", "completeness", "explain",
      ].includes(f.category ?? "") ? f.category : "process") as CritiqueFinding["category"],
      target: {
        kind: ([
          "message", "floorPlan", "layout", "quote", "stage", "session",
        ].includes(f.targetKind ?? "") ? f.targetKind : "session") as CritiqueFinding["target"]["kind"],
      },
      title: f.title || "Finding",
      body: f.body || "",
      ...(f.suggestedFix ? { suggestedFix: f.suggestedFix } : {}),
    }));
    if (findings.length === 0) return seed;
    return {
      summary: parsed.summary || seed.summary,
      findings,
    };
  } catch {
    return seed;
  }
}

export function buildCritiqueBundle(
  repos: Repositories,
  conversationId: string,
  runStats?: CritiqueBundle["runStats"],
): CritiqueBundle | undefined {
  const conversation = repos.conversations.byId(conversationId);
  if (!conversation) return undefined;
  const designSession = repos.designSessions.byId(conversationId);
  const floorPlans = repos.floorPlans.filter((p) => p.conversationId === conversationId);
  const floorPlan = floorPlans.length === 0
    ? undefined
    : floorPlans.reduce((best, p) => (p.updatedAt >= best.updatedAt ? p : best));
  const audits = repos.deliveryAudits
    .filter((a) => a.conversationId === conversationId)
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const quoteCount = repos.quotes.filter((q) => q.conversationId === conversationId).length;
  const layoutCount = repos.designLayouts.filter((l) => l.conversationId === conversationId).length;
  return {
    conversation,
    ...(designSession ? { designSession } : {}),
    ...(floorPlan ? { floorPlan } : {}),
    audits,
    quoteCount,
    layoutCount,
    ...(runStats ? { runStats } : {}),
  };
}

/**
 * 跑一轮评审并持久化。永不修改客户 messages。
 */
export async function runDesignCritique(input: RunCritiqueInput): Promise<CritiqueReview | undefined> {
  const bundle = buildCritiqueBundle(input.repos, input.conversationId, input.runStats);
  if (!bundle) return undefined;

  const seed = deterministicCritique(bundle, input.trigger);
  const result = input.llm
    ? await llmCritique(input.llm, bundle, input.trigger, seed)
    : seed;

  const at = new Date().toISOString();
  const criticMsg: CritiqueMessage = {
    role: "critic",
    content: formatFindingsMessage(result.summary, result.findings),
    at,
  };

  const review: CritiqueReview = {
    id: `cr_${randomUUID().slice(0, 8)}`,
    conversationId: input.conversationId,
    ...(bundle.conversation.runId ? { runId: bundle.conversation.runId } : {}),
    trigger: input.trigger,
    summary: result.summary,
    findings: result.findings,
    messages: [criticMsg],
    auditSnapshotIds: bundle.audits.slice(-3).map((a) => a.id),
    createdAt: at,
    status: "open",
  };

  await input.repos.critiqueReviews.insert(review);
  return review;
}

/** 运营在评审框追问；追加消息，可选再跑一轮确定性补充。 */
export async function appendOperatorCritiqueMessage(
  repos: Repositories,
  critiqueId: string,
  text: string,
  llm?: CompletionClient,
): Promise<CritiqueReview | undefined> {
  const review = repos.critiqueReviews.byId(critiqueId);
  if (!review) return undefined;
  const at = new Date().toISOString();
  const messages: CritiqueMessage[] = [
    ...review.messages,
    { role: "operator", content: text, at },
  ];

  const bundle = buildCritiqueBundle(repos, review.conversationId);
  let reply = "Noted. Promote actionable items to the Platform Trainer manually if they should become L0 policy.";
  if (bundle) {
    const seed = deterministicCritique(bundle, "manual");
    if (llm) {
      try {
        reply = await llm.complete({
          system: "You are DesignCritic answering an operator follow-up. Be concise. No customer-facing prose.",
          messages: [
            { role: "user", content: `Prior summary: ${review.summary}\nOperator: ${text}` },
          ],
          callSite: "designCritique",
          temperature: 0.2,
        });
      } catch {
        reply = `${seed.summary}\n(Operator note recorded; LLM unavailable.)`;
      }
    } else {
      reply = `${seed.summary}\n(Operator note recorded; deterministic mode.)`;
    }
  }

  messages.push({ role: "critic", content: reply, at: new Date().toISOString() });
  return repos.critiqueReviews.update(critiqueId, { ...review, messages });
}

export async function persistDeliveryAudit(
  repos: Repositories,
  record: Omit<DeliveryAuditRecord, "id"> & { id?: string },
): Promise<DeliveryAuditRecord> {
  const full: DeliveryAuditRecord = {
    id: record.id ?? `da_${randomUUID().slice(0, 8)}`,
    conversationId: record.conversationId,
    deliverable: record.deliverable,
    ok: record.ok,
    findings: record.findings,
    checked: record.checked,
    at: record.at,
    ...(record.designLayoutId ? { designLayoutId: record.designLayoutId } : {}),
    ...(record.quoteId ? { quoteId: record.quoteId } : {}),
  };
  await repos.deliveryAudits.insert(full);
  return full;
}
