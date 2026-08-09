/**
 * 厂商协作子线程（FR-23）—— 开线、投影、promote/pull、交接包。
 * 厂商侧永不接触父 Conversation.messages。
 */
import { randomUUID } from "node:crypto";
import type {
  CompanyEngagement,
  CompanyEngagementHandoff,
  CompanyEngagementStatus,
  CompanyPreferences,
  Conversation,
  EngagementMessage,
  EngagementSpeaker,
  HandoffConfirmedFact,
  SharedPreferences,
  Timestamp,
} from "../domain/types.js";

export class EngagementError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "CLOSED"
      | "PARENT_ARCHIVED"
      | "COMPANY_MISMATCH"
      | "EMPTY_TEXT" = "NOT_FOUND",
  ) {
    super(message);
    this.name = "EngagementError";
  }
}

export function listEngagements(conv: Conversation): CompanyEngagement[] {
  return [...(conv.companyEngagements ?? [])];
}

export function findEngagement(
  conv: Conversation,
  engagementId: string,
): CompanyEngagement | undefined {
  return listEngagements(conv).find((e) => e.id === engagementId);
}

export function activeEngagementForCompany(
  conv: Conversation,
  companyId: string,
): CompanyEngagement | undefined {
  return listEngagements(conv).find(
    (e) => e.companyId === companyId && e.status === "active",
  );
}

export function inferEngagementSpeaker(msg: EngagementMessage): EngagementSpeaker {
  if (msg.speaker) return msg.speaker;
  if (msg.role === "user") return "user";
  if (msg.role === "company_human") return "company_human";
  if (msg.role === "system") return "platform";
  return "company_agent";
}

export function buildConfirmedFacts(input: {
  /** 短摘要；勿传入整段聊天堆积的 designRequirements。 */
  requirementsDigest?: string;
  sharedPreferences?: SharedPreferences;
  companyPreferences?: CompanyPreferences;
  source?: HandoffConfirmedFact["source"];
  /** doorStyleId → 展示名 */
  doorStyleNames?: Record<string, string>;
  boxMaterialNames?: Record<string, string>;
  /** 来自主轨 Design Basis 的已确认小节（locked/provisional）。 */
  briefFacts?: Array<{ key: string; label: string; display: string }>;
}): HandoffConfirmedFact[] {
  const source = input.source ?? "main_confirmed";
  const facts: HandoffConfirmedFact[] = [];
  for (const b of input.briefFacts ?? []) {
    const display = (b.display ?? "").trim();
    if (!display || /Not discussed yet|还没聊/.test(display)) continue;
    facts.push({
      key: b.key,
      scope: "shared",
      label: b.label,
      value: display,
      display: display.length > 180 ? `${display.slice(0, 177)}…` : display,
      source,
    });
  }
  const digest = (input.requirementsDigest ?? "").trim();
  if (digest && !facts.some((f) => f.key === "requirementsDigest")) {
    facts.push({
      key: "requirementsDigest",
      scope: "shared",
      label: "Requirements",
      value: digest,
      display: digest.length > 180 ? `${digest.slice(0, 177)}…` : digest,
      source,
    });
  }
  const shared = input.sharedPreferences;
  if (shared?.budgetBand) {
    facts.push({
      key: "budgetBand",
      scope: "shared",
      label: "Budget",
      value: shared.budgetBand,
      display: shared.budgetBand,
      source,
    });
  }
  if (shared?.storage) {
    facts.push({
      key: "storage",
      scope: "shared",
      label: "Storage",
      value: shared.storage,
      display: shared.storage,
      source,
    });
  }
  if (shared?.tradeoff) {
    facts.push({
      key: "tradeoff",
      scope: "shared",
      label: "Tradeoff",
      value: shared.tradeoff,
      display: shared.tradeoff,
      source,
    });
  }
  if (shared?.assembly) {
    facts.push({
      key: "assembly",
      scope: "shared",
      label: "Assembly",
      value: shared.assembly,
      display: shared.assembly,
      source,
    });
  }
  const company = input.companyPreferences;
  if (company?.doorStyleId) {
    const display = input.doorStyleNames?.[company.doorStyleId] ?? company.doorStyleId;
    facts.push({
      key: "doorStyleId",
      scope: "company",
      label: "Door style",
      value: company.doorStyleId,
      display,
      source,
    });
  }
  if (company?.boxMaterialId) {
    const display = input.boxMaterialNames?.[company.boxMaterialId] ?? company.boxMaterialId;
    facts.push({
      key: "boxMaterialId",
      scope: "company",
      label: "Box material",
      value: company.boxMaterialId,
      display,
      source,
    });
  }
  if (company?.hardwareOptionIds?.length) {
    facts.push({
      key: "hardwareOptionIds",
      scope: "company",
      label: "Hardware",
      value: company.hardwareOptionIds.join(","),
      display: company.hardwareOptionIds.join(", "),
      source,
    });
  }
  if (company?.accessoryOptionIds?.length) {
    facts.push({
      key: "accessoryOptionIds",
      scope: "company",
      label: "Accessories",
      value: company.accessoryOptionIds.join(","),
      display: company.accessoryOptionIds.join(", "),
      source,
    });
  }
  return facts;
}

/** 从主轨同款 Design Basis sections 提炼交接摘要（跳过未聊项）。 */
export function digestFromBriefSections(
  sections: Array<{ id: string; title: string; body: string; status: string }>,
  language: "en" | "zh" = "en",
): { requirementsDigest: string; briefFacts: Array<{ key: string; label: string; display: string }> } {
  const usable = sections.filter((s) =>
    (s.status === "locked" || s.status === "provisional")
    && s.body
    && !/Not discussed yet|还没聊/.test(s.body));
  const briefFacts = usable.map((s) => ({
    key: `brief_${s.id}`,
    label: s.title,
    display: s.body.replace(/\n+/g, " · ").trim(),
  }));
  const requirementsDigest = briefFacts.map((f) => `${f.label}: ${f.display}`).join(
    language === "zh" ? "；" : "; ",
  );
  return { requirementsDigest, briefFacts };
}

export function buildHandoff(input: {
  at: Timestamp;
  designRequirements: string;
  sharedPreferences?: SharedPreferences;
  companyPreferences?: CompanyPreferences;
  floorPlanId?: string;
  language?: "en" | "zh";
  revision?: number;
  source?: HandoffConfirmedFact["source"];
  doorStyleNames?: Record<string, string>;
  boxMaterialNames?: Record<string, string>;
  requirementsDigest?: string;
  briefFacts?: Array<{ key: string; label: string; display: string }>;
}): CompanyEngagementHandoff {
  const req = (input.designRequirements ?? "").trim();
  const prefs = input.sharedPreferences;
  const companyPrefs = input.companyPreferences;
  const confirmedFacts = buildConfirmedFacts({
    requirementsDigest: input.requirementsDigest,
    sharedPreferences: prefs,
    companyPreferences: companyPrefs,
    source: input.source,
    doorStyleNames: input.doorStyleNames,
    boxMaterialNames: input.boxMaterialNames,
    briefFacts: input.briefFacts,
  });
  const bits: string[] = [];
  if (input.requirementsDigest?.trim()) bits.push(input.requirementsDigest.trim());
  else {
    for (const f of confirmedFacts.filter((x) => x.scope === "shared").slice(0, 4)) {
      bits.push(`${f.label}=${f.display}`);
    }
  }
  if (companyPrefs?.doorStyleId) {
    const name = input.doorStyleNames?.[companyPrefs.doorStyleId] ?? companyPrefs.doorStyleId;
    bits.push(`doorStyle=${name}`);
  }
  if (prefs?.assembly) bits.push(`assembly=${prefs.assembly}`);
  if (prefs?.storage) bits.push(`storage=${prefs.storage}`);
  if (prefs?.tradeoff) bits.push(`tradeoff=${prefs.tradeoff}`);
  if (prefs?.budgetBand) bits.push(`budget=${prefs.budgetBand}`);
  const sharedSummary = bits.join(" · ")
    || (input.language === "zh" ? "（开线时暂无已确认共享摘要）" : "(No shared summary at open)");
  return {
    at: input.at,
    revision: input.revision ?? 1,
    sharedSummary,
    designRequirements: req,
    ...(input.requirementsDigest?.trim()
      ? { requirementsDigest: input.requirementsDigest.trim() }
      : {}),
    ...(prefs ? { sharedPreferences: { ...prefs } } : {}),
    ...(companyPrefs && Object.keys(companyPrefs).length
      ? { companyPreferences: { ...companyPrefs } }
      : {}),
    ...(confirmedFacts.length ? { confirmedFacts } : {}),
    ...(input.floorPlanId ? { floorPlanId: input.floorPlanId } : {}),
  };
}

/** 把交接包渲染成 Agent system 附录（中英）。 */
export function renderHandoffContextNote(
  handoff: CompanyEngagementHandoff,
  language: "en" | "zh" = "en",
): string {
  const facts = handoff.confirmedFacts?.length
    ? handoff.confirmedFacts
    : buildConfirmedFacts({
      requirementsDigest: handoff.requirementsDigest,
      sharedPreferences: handoff.sharedPreferences,
      companyPreferences: handoff.companyPreferences,
    });
  if (language === "zh") {
    const lines = facts.map((f) =>
      `- [${f.scope}] ${f.label}: ${f.display}${f.value !== f.display ? ` (${f.value})` : ""}`);
    return [
      `【交接包 revision ${handoff.revision}——下列项视为已确认，除非用户当场纠正】`,
      ...(handoff.requirementsDigest
        ? [`摘要：${handoff.requirementsDigest}`]
        : []),
      ...lines,
      "规则：",
      "1. 不要重问上面已列出的字段；不要引用主线程闲聊原文。",
      "2. 开线或 pull 后：简短复述要点，再请用户确认是否正确。",
      "3. 用户纠正某字段时先确认理解，再问是否写入已确认。",
      "4. 绝对不要报价格。",
    ].join("\n");
  }
  const lines = facts.map((f) =>
    `- [${f.scope}] ${f.label}: ${f.display}${f.value !== f.display ? ` (${f.value})` : ""}`);
  return [
    `[Handoff revision ${handoff.revision} — treat as already confirmed unless the user corrects]`,
    ...(handoff.requirementsDigest
      ? [`Digest: ${handoff.requirementsDigest}`]
      : []),
    ...lines,
    "Rules:",
    "1. Do not re-ask fields listed above; do not quote main-thread chatter.",
    "2. On open / after pull: briefly restate key points, then ask one yes/correct question.",
    "3. If the user corrects a field, acknowledge and ask whether to update Confirmed.",
    "4. Never quote prices.",
  ].join("\n");
}

/** 无 LLM 时的确定性开线/pull 复述。 */
export function deterministicHandoffRestate(
  companyName: string,
  handoff: CompanyEngagementHandoff,
  language: "en" | "zh" = "en",
  mode: "open" | "pull" = "open",
): string {
  const facts = handoff.confirmedFacts?.length
    ? handoff.confirmedFacts
    : buildConfirmedFacts({
      requirementsDigest: handoff.requirementsDigest,
      sharedPreferences: handoff.sharedPreferences,
      companyPreferences: handoff.companyPreferences,
    });
  const digest = handoff.requirementsDigest?.trim();
  if (language === "zh") {
    if (!facts.length && !digest) {
      return mode === "pull"
        ? `我是${companyName}助手。已采用主项目最新共享确认（修订 #${handoff.revision}），目前清单仍较空。请告诉我您最关心的规格问题。`
        : `我是${companyName}助手。交接包里还没有结构化确认项。请先告诉我房间类型、门板偏好等，我们再推进。`;
    }
    const bullets = facts.map((f) => `· ${f.label}：${f.display}`).join("\n");
    const head = mode === "pull"
      ? `已同步主项目共享确认（修订 #${handoff.revision}）。我按最新理解是：`
      : `根据主项目交接，我理解您这边已确认：`;
    return [
      `我是${companyName}助手。${head}`,
      digest && !facts.some((f) => f.key.startsWith("brief_")) ? digest : "",
      bullets,
      "请确认是否正确；若有出入请直接指出要改的项。",
    ].filter(Boolean).join("\n");
  }
  if (!facts.length && !digest) {
    return mode === "pull"
      ? `I'm the ${companyName} assistant. Pulled the latest shared confirmations (revision #${handoff.revision}); the list is still light. What catalog question should we tackle first?`
      : `I'm the ${companyName} assistant. The handoff has no structured confirmations yet. Tell me room type and door-style preference and we can continue.`;
  }
  const bullets = facts.map((f) => `· ${f.label}: ${f.display}`).join("\n");
  const head = mode === "pull"
    ? `Pulled latest shared confirmations (revision #${handoff.revision}). My updated read:`
    : `From the project handoff, I understand you've already confirmed:`;
  return [
    `I'm the ${companyName} assistant. ${head}`,
    digest && !facts.some((f) => f.key.startsWith("brief_")) ? digest : "",
    bullets,
    "Please confirm this is correct, or tell me what to change.",
  ].filter(Boolean).join("\n");
}

export function openEngagement(input: {
  conversation: Conversation;
  companyId: string;
  companyName: string;
  at: Timestamp;
  floorPlanId?: string;
  doorStyleNames?: Record<string, string>;
  boxMaterialNames?: Record<string, string>;
  requirementsDigest?: string;
  briefFacts?: Array<{ key: string; label: string; display: string }>;
}): { conversation: Conversation; engagement: CompanyEngagement; created: boolean } {
  const conv = input.conversation;
  if (conv.status === "archived") {
    throw new EngagementError("Parent conversation is archived", "PARENT_ARCHIVED");
  }
  const existing = activeEngagementForCompany(conv, input.companyId);
  if (existing) {
    return { conversation: conv, engagement: existing, created: false };
  }

  const companyPreferences = conv.preferences?.byCompany?.[input.companyId];
  const handoff = buildHandoff({
    at: input.at,
    designRequirements: conv.designRequirements ?? "",
    sharedPreferences: conv.preferences?.shared,
    companyPreferences,
    floorPlanId: input.floorPlanId,
    language: conv.preferences?.shared?.language,
    revision: 1,
    source: "main_confirmed",
    doorStyleNames: input.doorStyleNames,
    boxMaterialNames: input.boxMaterialNames,
    requirementsDigest: input.requirementsDigest,
    briefFacts: input.briefFacts,
  });
  const customerTitle = `@${input.companyName}`;
  const openNote = conv.preferences?.shared?.language === "zh"
    ? `已开启与 ${input.companyName} 的协作会话。厂商看不到主线程，仅见下方交接摘要与本线程消息。已载入交接包（修订 #${handoff.revision}）。`
    : `Collaboration with ${input.companyName} is open. The seller cannot see the main thread—only this handoff and thread. Handoff revision #${handoff.revision} loaded.`;

  const engagement: CompanyEngagement = {
    id: `eg_${randomUUID().slice(0, 8)}`,
    conversationId: conv.id,
    companyId: input.companyId,
    status: "active",
    createdAt: input.at,
    customerTitle,
    handoff,
    sharedWorking: {
      designRequirements: handoff.designRequirements,
      ...(handoff.sharedPreferences
        ? { preferences: { ...handoff.sharedPreferences } }
        : {}),
    },
    messages: [{
      role: "system",
      speaker: "platform",
      content: openNote,
      at: input.at,
    }],
  };

  const companyEngagements = [...listEngagements(conv), engagement];
  return {
    conversation: { ...conv, companyEngagements },
    engagement,
    created: true,
  };
}

export function appendEngagementMessage(
  conv: Conversation,
  engagementId: string,
  msg: EngagementMessage,
  opts?: { pauseAgent?: boolean },
): { conversation: Conversation; engagement: CompanyEngagement } {
  if (conv.status === "archived") {
    throw new EngagementError("Parent conversation is archived", "PARENT_ARCHIVED");
  }
  const list = listEngagements(conv);
  const idx = list.findIndex((e) => e.id === engagementId);
  if (idx < 0) throw new EngagementError("Engagement not found", "NOT_FOUND");
  const eg = list[idx]!;
  if (eg.status !== "active") {
    throw new EngagementError("Engagement is closed", "CLOSED");
  }
  const withSpeaker: EngagementMessage = {
    ...msg,
    speaker: msg.speaker ?? inferEngagementSpeaker(msg),
  };
  const next: CompanyEngagement = {
    ...eg,
    messages: [...eg.messages, withSpeaker],
    ...(opts?.pauseAgent || msg.role === "company_human"
      ? { agentPaused: opts?.pauseAgent !== false }
      : {}),
  };
  const companyEngagements = list.map((e, i) => (i === idx ? next : e));
  return { conversation: { ...conv, companyEngagements }, engagement: next };
}

/** 子→主：共享工作副本写入父会话；返回系统摘要文案。 */
export function promoteSharedToParent(
  conv: Conversation,
  engagementId: string,
  at: Timestamp,
): {
  conversation: Conversation;
  engagement: CompanyEngagement;
  systemSummary: string;
  changedKeys: string[];
} {
  if (conv.status === "archived") {
    throw new EngagementError("Parent conversation is archived", "PARENT_ARCHIVED");
  }
  const eg = findEngagement(conv, engagementId);
  if (!eg) throw new EngagementError("Engagement not found", "NOT_FOUND");

  const workingReq = eg.sharedWorking?.designRequirements ?? eg.handoff.designRequirements;
  const workingPrefs = eg.sharedWorking?.preferences ?? eg.handoff.sharedPreferences;
  const changedKeys: string[] = [];
  if ((workingReq ?? "") !== (conv.designRequirements ?? "")) {
    changedKeys.push("designRequirements");
  }
  const prevShared = conv.preferences?.shared ?? {};
  if (JSON.stringify(workingPrefs ?? {}) !== JSON.stringify(prevShared)) {
    changedKeys.push("sharedPreferences");
  }

  const lang = workingPrefs?.language ?? prevShared.language;
  const systemSummary = lang === "zh"
    ? `已从 ${eg.customerTitle} 将共享确认同步到主项目${changedKeys.length ? `（${changedKeys.join("、")}）` : ""}。厂商专用选型未同步。`
    : `Shared confirmations from ${eg.customerTitle} were synced to the main project${changedKeys.length ? ` (${changedKeys.join(", ")})` : ""}. Seller-specific picks were not synced.`;

  const nextConv: Conversation = {
    ...conv,
    designRequirements: workingReq ?? conv.designRequirements,
    preferences: {
      ...(conv.preferences ?? {}),
      shared: { ...prevShared, ...(workingPrefs ?? {}) },
      byCompany: conv.preferences?.byCompany,
    },
    messages: [
      ...conv.messages,
      { role: "assistant", content: systemSummary, at },
    ],
  };
  return { conversation: nextConv, engagement: eg, systemSummary, changedKeys };
}

/** 主→子：父共享态覆盖子轨工作副本；保留厂专用 handoff 快照。 */
export function pullSharedFromParent(
  conv: Conversation,
  engagementId: string,
  at: Timestamp,
  opts?: {
    doorStyleNames?: Record<string, string>;
    boxMaterialNames?: Record<string, string>;
    requirementsDigest?: string;
    briefFacts?: Array<{ key: string; label: string; display: string }>;
  },
): { conversation: Conversation; engagement: CompanyEngagement } {
  if (conv.status === "archived") {
    throw new EngagementError("Parent conversation is archived", "PARENT_ARCHIVED");
  }
  const list = listEngagements(conv);
  const idx = list.findIndex((e) => e.id === engagementId);
  if (idx < 0) throw new EngagementError("Engagement not found", "NOT_FOUND");
  const eg = list[idx]!;

  const preservedCompany = eg.handoff.companyPreferences
    ?? conv.preferences?.byCompany?.[eg.companyId];
  const prevRev = eg.handoff.revision ?? 1;
  const handoff = buildHandoff({
    at,
    designRequirements: conv.designRequirements ?? "",
    sharedPreferences: conv.preferences?.shared,
    companyPreferences: preservedCompany,
    floorPlanId: eg.handoff.floorPlanId,
    language: conv.preferences?.shared?.language,
    revision: prevRev + 1,
    source: "pulled",
    doorStyleNames: opts?.doorStyleNames,
    boxMaterialNames: opts?.boxMaterialNames,
    requirementsDigest: opts?.requirementsDigest,
    briefFacts: opts?.briefFacts,
  });
  const note = conv.preferences?.shared?.language === "zh"
    ? `已采用主项目最新共享确认（修订 #${handoff.revision}；厂商专用小结未改动）。`
    : `Pulled latest shared confirmations from the main project (revision #${handoff.revision}; seller-specific summary unchanged).`;

  const next: CompanyEngagement = {
    ...eg,
    handoff,
    sharedWorking: {
      designRequirements: handoff.designRequirements,
      ...(handoff.sharedPreferences
        ? { preferences: { ...handoff.sharedPreferences } }
        : {}),
    },
    messages: [...eg.messages, {
      role: "system",
      speaker: "platform",
      content: note,
      at,
    }],
  };
  const companyEngagements = list.map((e, i) => (i === idx ? next : e));
  return {
    conversation: { ...conv, companyEngagements },
    engagement: next,
  };
}

export function sharedDiffersFromParent(
  conv: Conversation,
  eg: CompanyEngagement,
): boolean {
  const workingReq = eg.sharedWorking?.designRequirements ?? eg.handoff.designRequirements;
  const workingPrefs = eg.sharedWorking?.preferences ?? eg.handoff.sharedPreferences;
  if ((workingReq ?? "") !== (conv.designRequirements ?? "")) return true;
  return JSON.stringify(workingPrefs ?? {}) !== JSON.stringify(conv.preferences?.shared ?? {});
}

/** 客户/厂商共用的确认两段投影（不含主轨消息）。 */
export function confirmedPanels(
  conv: Conversation,
  eg: CompanyEngagement,
): {
  shared: {
    designRequirements: string;
    preferences: SharedPreferences;
    differsFromParent: boolean;
  };
  companySpecific: CompanyPreferences;
} {
  const liveCompany = conv.preferences?.byCompany?.[eg.companyId] ?? {};
  const frozen = eg.handoff.companyPreferences ?? {};
  return {
    shared: {
      designRequirements:
        eg.sharedWorking?.designRequirements ?? eg.handoff.designRequirements ?? "",
      preferences: {
        ...(eg.sharedWorking?.preferences ?? eg.handoff.sharedPreferences ?? {}),
      },
      differsFromParent: sharedDiffersFromParent(conv, eg),
    },
    // 展示优先实时 byCompany；缺项回落到开线冻结快照
    companySpecific: { ...frozen, ...liveCompany },
  };
}

/** 在账号下按 engagement id 查找（容错 URL 会话 id 与子轨错位）。 */
export function findEngagementOwnedByAccount(
  conversations: readonly Conversation[],
  accountId: string,
  engagementId: string,
): { conversation: Conversation; engagement: CompanyEngagement } | undefined {
  const eid = engagementId.trim();
  if (!eid) return undefined;
  for (const conv of conversations) {
    if (conv.customerAccountId !== accountId) continue;
    const eg = findEngagement(conv, eid);
    if (eg) return { conversation: conv, engagement: eg };
  }
  return undefined;
}

/** 厂商 inbox / 详情 DTO——刻意不含父 messages。 */
export function toVendorEngagementListItem(input: {
  conversation: Conversation;
  engagement: CompanyEngagement;
  parentFullTitle: string;
}): {
  id: string;
  conversationId: string;
  companyId: string;
  status: CompanyEngagementStatus;
  parentTitle: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  sharedSummary: string;
} {
  const eg = input.engagement;
  const last = eg.messages[eg.messages.length - 1];
  return {
    id: eg.id,
    conversationId: eg.conversationId,
    companyId: eg.companyId,
    status: eg.status,
    parentTitle: input.parentFullTitle,
    createdAt: eg.createdAt,
    updatedAt: last?.at ?? eg.createdAt,
    sharedSummary: eg.handoff.sharedSummary,
  };
}

export function toVendorEngagementDetail(input: {
  conversation: Conversation;
  engagement: CompanyEngagement;
  parentFullTitle: string;
  companyName: string;
}): {
  id: string;
  conversationId: string;
  companyId: string;
  companyName: string;
  status: CompanyEngagementStatus;
  parentTitle: string;
  handoff: CompanyEngagementHandoff;
  messages: EngagementMessage[];
  agentPaused?: boolean;
  confirmed: ReturnType<typeof confirmedPanels>;
} {
  const eg = input.engagement;
  return {
    id: eg.id,
    conversationId: eg.conversationId,
    companyId: eg.companyId,
    companyName: input.companyName,
    status: eg.status,
    parentTitle: input.parentFullTitle,
    handoff: eg.handoff,
    messages: eg.messages,
    ...(eg.agentPaused ? { agentPaused: true } : {}),
    confirmed: confirmedPanels(input.conversation, eg),
  };
}

/** 客户更新子轨共享工作副本（可选，供后续 UI 编辑）。 */
export function patchSharedWorking(
  conv: Conversation,
  engagementId: string,
  patch: { designRequirements?: string; preferences?: SharedPreferences },
): { conversation: Conversation; engagement: CompanyEngagement } {
  if (conv.status === "archived") {
    throw new EngagementError("Parent conversation is archived", "PARENT_ARCHIVED");
  }
  const list = listEngagements(conv);
  const idx = list.findIndex((e) => e.id === engagementId);
  if (idx < 0) throw new EngagementError("Engagement not found", "NOT_FOUND");
  const eg = list[idx]!;
  const next: CompanyEngagement = {
    ...eg,
    sharedWorking: {
      designRequirements:
        patch.designRequirements ?? eg.sharedWorking?.designRequirements
          ?? eg.handoff.designRequirements,
      preferences: {
        ...(eg.sharedWorking?.preferences ?? eg.handoff.sharedPreferences ?? {}),
        ...(patch.preferences ?? {}),
      },
    },
  };
  const companyEngagements = list.map((e, i) => (i === idx ? next : e));
  return { conversation: { ...conv, companyEngagements }, engagement: next };
}
