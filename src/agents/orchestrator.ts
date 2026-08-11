/**
 * 总控助手 + 公司 Agent —— FR-1、REQUIREMENTS 3.1。
 *
 * 工程上是**一套 prompt 模板按 companyId 参数化**，不是每家公司一个实例（§3.4）。
 *
 * 三条硬约束体现在代码里：
 *   1. 路由已经在 routing/mention.ts 里确定性完成，Agent 只负责「说什么」，
 *      不负责判断「这是哪家公司」；
 *   2. 公司 Agent 的上下文只注入该公司 published 规格，别家数据在物理上就到不了；
 *   3. Agent 产出的设计意图必须过 `stripPriceFields`——模型给的任何金额都被丢弃。
 */
import type { SpecBundle } from "../spec/bundle.js";
import { stripPriceFields } from "../spec/validation.js";
import { resolveModuleSellUnit } from "../spec/sku-semantics.js";
import type { CompanyCodingRules, CompanyEngagementHandoff } from "../domain/types.js";
import { interactionProfile, type TradeInteractionProfile } from "../trade/interaction.js";
import type { AgentContext, AgentReply, CompletionClient, DesignIntent } from "./types.js";
import { escalationDecision, tierForTurn, type EscalationDecision } from "./model-tiers.js";
import { askStyleRules } from "./quick-replies.js";
import { recordSkipped } from "./token-meter.js";
import { asksAboutRta, renderRtaComparison } from "../quote/rta-disclosure.js";
import {
  DEFAULT_LANGUAGE, languageRuleForLlm, msg, type UiLanguage,
} from "../i18n/language.js";
import {
  deterministicHandoffRestate,
  renderHandoffContextNote,
} from "../session/company-engagement.js";

/** 总控可注入的 L0 摘要——不含任何厂商前缀表。 */
function l0SellUnitSummary(lang: UiLanguage): string {
  if (lang === "zh") {
    return [
      "系统层售卖单元（与厂商无关）：",
      "- 码中明确 -BOX → 只卖柜体；明确 -DOOR → 只卖门板；",
      "- 无拆分后缀且同时有材质+花色标识 → 组合件；",
      "- 填缝/踢脚/收口等独立件不走 BOX/DOOR 拆分。",
      "具体柜型前缀（如 B12 是什么）必须 @ 某家公司后由该公司规则解释。",
    ].join("\n");
  }
  return [
    "Platform sell-unit rules (seller-agnostic):",
    "- Explicit -BOX → carcass only; explicit -DOOR → door/front only;",
    "- No split suffix but material + finish tokens → combo SKU;",
    "- Fillers / toe kicks / end panels are standalone — not BOX/DOOR splits.",
    "Cabinet prefix meanings (e.g. what B12 is) require @ a seller; do not invent another brand's coding.",
  ].join("\n");
}

function orchestratorSystem(
  profile: TradeInteractionProfile,
  lang: UiLanguage,
  extras?: { handbook?: string; maxQuestionsPerTurn?: number },
): string {
  const maxQ = extras?.maxQuestionsPerTurn ?? profile.maxQuestionsPerTurn;
  if (lang === "zh") {
    const lines = [
      "你是加拿大厨房橱柜平台的总控助手，帮客户理清装修需求。",
      "语气友好、像真人顾问：先回应客户刚说的，再自然地追问下一项；避免生硬清单口吻。",
      `每轮最多问 ${maxQ} 个最关键的缺失信息。需要收集：`,
      "优先顺序：先确认户型图/手绘简图（或设计想法草图），再问风格、材质、预算、工期、省份（省份必填，用于税费）。",
      "已有户型图且尺寸齐时，不必再问尺寸/布局；改为确认风格、预算、省份等。",
      "",
      "引导小白（多数客户不知道该先说什么）：",
      "- **开场先问有没有户型图**；没有则引导按示例手绘（墙长+开口+层高）上传；可选再问有无初步设计草图。",
      "- 上传后系统会给出「柜块拼接」讨论图：请客户对照图上尺寸/开口与 Q# 讨论；置信度很低时请其补标注后**重新上传**。",
      "- 每轮用一句话说明**为什么问这项**（例如：省份用来算税；墙长用来排布柜体）。",
      "- 给**简短示例答法**（如「安大略省 / 预算大概 1–2 万加币 / 现代一字门」），降低开口成本。",
      "- 客户含糊时，把它复述成可确认的选项，而不是原地重复原问题；**已确认的字段不要反复追问**（含家电种类/宽度）。",
      "- 户型图读失败或没有墙段时：请重传更清晰草图，或**立刻**改口请客户按墙报英寸长度与层高（可对照图上 Q#），不要空等识别。",
      "- 家电：请客户按 Q# 回答种类+宽度（例：冰箱 33\"、灶具 30\"）。**尺寸不可后定**——每台已列家电都须有明确宽度（实测，或客户清楚说「推定可以」接受推定数）后才能进入出图。**不要**在未确认时反复改口家电清单。",
      "- 推进报价前确认：层高、**已确认的家电宽度**、以及客户理解本平台为 **RTA 待组装**（非全定制、不含安装）。",
      "- 需要厂商细节时，**演示**如何 @公司名（例如：输入 @枫岭橱柜 再问转角柜），并说明点名后由该公司助手接答。",
      "- 信息将齐时，用一两句小结已收集项，再推进下一步，避免客户迷失。",
      "",
      "当上述必要信息都齐了（或客户已上传并确认户型尺寸）时：",
      "- **主动问一句**：是否要根据目前整理好的需求给出设计方案？",
      "- 未得到明确同意前，不要声称已经开始画图或出方案。",
      "",
      "边界：",
      "- 这个平台卖的是 **RTA 板式待组装橱柜**，不是全定制。",
      "  尺寸只有厂家的固定档、板件平装发货需要组装、不含上门安装。",
      "  客户把它当成定制来理解时**要当场纠正**——等到货到了再解释就是投诉了。",
      "- 你只掌握通用橱柜知识。**不要报出任何具体公司的价格或型号**。",
      "- 客户想问某家公司的具体产品时，提示他用 @公司名 点名，由那家公司的助手来答。",
      "- 需要给价格感觉时，只能说「行业典型区间」，且必须说明这不是任何公司的真实报价。",
      "",
      languageRuleForLlm(lang),
      "",
      l0SellUnitSummary(lang),
      "",
      askStyleRules(lang),
    ];
    if (extras?.handbook) {
      lines.push("", extras.handbook);
    }
    if (!profile.explainJargon) {
      lines.push(
        "",
        "本次对话的客户是专业建商/装修公司账号：",
        "- 可以直接使用行业术语（SKU、价格组、door style、RTA/assembled 等），不必解释基础概念。",
      );
    }
    if (profile.skipConfirmationPrompts) {
      lines.push("- 不要反复确认已经说过的信息，缺什么直接问什么。");
    }
    return lines.join("\n");
  }

  const lines = [
    "You are the intake assistant for a Canadian kitchen cabinet platform. Help the customer clarify their project.",
    "Be warm and conversational — acknowledge what they just said, then ask the next missing item naturally. Avoid stiff checklists.",
    `Ask at most ${maxQ} of the most important missing items per turn. Collect:`,
    "Priority: confirm floor plan / hand sketch (or optional design-idea sketch) first, then style, materials, budget, timeline, and province (required for tax).",
    "If a floor plan is already uploaded with sizes confirmed, do not re-ask size/layout; focus on style, budget, province, etc.",
    "",
    "Guide beginners (most customers do not know what to ask when):",
    "- **Open by asking for a floor plan**; if none, guide a hand sketch from the example (lengths + openings + ceiling) and upload; optionally ask for a design-idea sketch.",
    "- After upload, the system shows an editable **block run diagram** — discuss dims/openings and Q# on that figure; if confidence is low, ask them to annotate and **re-upload**.",
    "- Each turn, briefly say **why** you need the item (e.g. province → tax; wall lengths → layout).",
    "- Offer a **short example answer** (e.g. \"Ontario / about CAD $10–20k / modern shaker\") to lower friction.",
    "- If they are vague, restate as confirmable options; **do not re-ask fields already confirmed** (including appliance kinds/widths).",
    "- If floor-plan vision fails or there are no wall runs: ask for a clearer re-upload, or **immediately** ask for each wall length in inches and ceiling height (use diagram Q#), do not wait on recognition.",
    "- Appliances: ask via Q# for kinds+widths (e.g. fridge 33\", stove 30\"). **Do not defer sizes** — design cannot start until every listed appliance has an explicit width (measured, or customer clearly accepts assumed numbers with \"assumed widths are fine\"). Do not flip the appliance list after confirmation.",
    "- Before pushing toward a quote: confirm ceiling height, **confirmed appliance widths**, and that they understand this platform is **RTA** (flat-pack, assembly required, install not included).",
    "- For seller-specific product questions, **demonstrate** @CompanyName and explain that seller's agent will reply.",
    "- When nearly ready, summarize what you have in one or two sentences, then propose the next step.",
    "",
    "CRITICAL — design readiness (obey the [Status] / 【状态】 block appended to this system prompt):",
    "- ONLY when Status says intake is complete may you ask: shall I generate a design?",
    "- If Status says not ready or lists a still-missing item: ask that missing item (at most one).",
    "- NEVER claim \"everything is confirmed\" / \"I have everything I need\", or invite generating a design while Status says not ready.",
    "- NEVER switch to optional preferences (drawers, hardware, etc.) while critical intake is still missing.",
    "- If they ask to generate before Status says ready: acknowledge briefly, then ask the ONE still-missing item — do not pretend you can draw yet.",
    "",
    "Boundaries:",
    "- This platform sells **RTA (ready-to-assemble) cabinets**, not fully custom.",
    "  Sizes come in manufacturer fixed steps, they ship flat-packed and need assembly, install is not included.",
    "  If the customer treats this as custom, **correct that immediately** — explaining after delivery is a complaint.",
    "- You only have generic cabinet knowledge. **Never quote a specific company's price or SKU**.",
    "- When they want a specific seller, tell them to @ the company name so that company's agent can answer.",
    "- For ballpark pricing, only say \"typical industry ranges\" and make clear it is not any seller's real quote.",
    "",
    languageRuleForLlm(lang),
    "",
    l0SellUnitSummary(lang),
    "",
    askStyleRules(lang),
  ];
  if (extras?.handbook) {
    lines.push("", extras.handbook);
  }
  if (!profile.explainJargon) {
    lines.push(
      "",
      "This customer is a trade / builder account:",
      "- Industry terms (SKU, price group, door style, RTA/assembled) are fine; no need to explain basics.",
    );
  }
  if (profile.skipConfirmationPrompts) {
    lines.push("- Don't re-confirm information already given; ask only what's missing.");
  }
  return lines.join("\n");
}

/**
 * 交互差异只走 `profile` 一个入口。
 *
 * 之前这里直接看 `accountType`，与「贸易资质是否通过审核」是两套判断，
 * 容易出现「按 consumer 定价却按 trade 说话」的错位。现在两条链路都从
 * `effectiveAccountType` 派生（见 trade/verification.ts）。
 */
export interface OrchestratorOptions {
  profile: TradeInteractionProfile;
  /**
   * 本轮的升级判断（model-tiers.ts）。
   *
   * 不传就按轻量层走——绝大多数轮次都该走轻量层，那是这套分层存在的理由。
   */
  escalation?: EscalationDecision;
  /**
   * 已经连续问过同样的缺失字段几轮了（本轮不算）。
   *
   * 客户答了却没被识别出来时（"质感优先""门板选深色的" 匹配不上"风格"的关键词），
   * 再原样问一遍只会让人以为没被听见。这时候改口去用选择题——
   * 那本来就是为「客户答不上开放式问题」设计的（FR-1.1）。
   *
   * 但**改口也只改一次**。之前这里是个布尔值，一旦置真就每轮都回同一句
   * "可能是我没问清楚…"，模拟里连着三轮一字不差——这正是它本来要治的病。
   * 追问两次还没结果就该停下：选择题已经在下面了，客户会点的。
   */
  repeatedAsk?: number | boolean;
  /** 客户语言偏好。默认英文。 */
  language?: UiLanguage;
  /**
   * 本轮 intake 状态（由服务端根据需求摘要 + 户型算出）。
   * 注入给模型，避免它在信息已齐时还继续盘问，或信息未齐就声称可以出图。
   */
  intakeStatus?: {
    /** intake 字段键（style/budget…）或可读追问句 */
    missing: readonly string[];
    /** 检查表关键缺口的白话追问（勿把 walls_ceiling 等 id 直接塞给模型） */
    openAsks?: readonly string[];
    floorPlanReady: boolean;
    readyToAskDesign: boolean;
    /** 已确认项短摘要，禁止再问 */
    confirmedBriefs?: readonly string[];
    /**
     * **这一轮**刚从"未确认"变成"已确认"的具体数字（墙长/层高/家电宽度），
     * 由 `design/confirm-recap.ts` 算出。与 `confirmedBriefs`（全量、用于
     * "别再问"）不同——这个只报变化量，用于让回复先简短复述一句
     * "北墙168寸、层高96寸，记下了"，起弱确认作用（不是门禁，只是回声）。
     */
    justConfirmed?: readonly string[];
  };
  /** FR-22：已发布 handbook 正文（由服务端从 knowledge cards 渲染）。 */
  platformHandbook?: string;
  /** FR-22：对话策略 overlay（如 maxQuestionsPerTurn）。 */
  dialogueOverlay?: {
    maxQuestionsPerTurn?: number;
  };
}

/** 只有账号类型、没有 profile 时的便捷入口（测试与脚本用）。 */
export function optionsFor(accountType: "consumer" | "trade"): OrchestratorOptions {
  return { profile: interactionProfile(accountType) };
}

/**
 * 总控助手回复。
 *
 * 无 LLM 客户端时退化为**确定性的引导问答**——这不是降级凑数，
 * 而是保证核心链路（报价、闸门、计费）在没有 API key 的环境里也能端到端跑通。
 */
export async function orchestratorReply(
  client: CompletionClient | undefined,
  ctx: AgentContext,
  userText: string,
  opts: OrchestratorOptions,
): Promise<AgentReply> {
  const requirements = mergeRequirements(ctx.requirements, userText);
  const lang = opts.language ?? DEFAULT_LANGUAGE;
  const systemExtras = {
    ...(opts.platformHandbook ? { handbook: opts.platformHandbook } : {}),
    ...(opts.dialogueOverlay?.maxQuestionsPerTurn != null
      ? { maxQuestionsPerTurn: opts.dialogueOverlay.maxQuestionsPerTurn }
      : {}),
  };

  // 「RTA 和定制有什么区别」不交给模型答。
  //
  // 这是**产品边界**问题，答错的代价是客户按定制的预期下单、到货才发现是
  // 一箱板件。模型答这道题的典型失手是把差异说轻（"主要是需要自己组装"），
  // 而恰恰是被说轻的那几条——尺寸只有固定档、不含上门安装——事后最容易
  // 变成投诉。措辞固定在 `quote/rta-disclosure.ts`，与报价单末尾那段同源。
  if (asksAboutRta(userText)) {
    const content = renderRtaComparison(lang);
    if (!client) recordSkipped({ callSite: "orchestratorChat", prompt: userText, reply: content });
    return { content, requirements };
  }

  // 客户要出图但检查表未齐：禁止再走 LLM（易谎称已齐 / 改问偏好）
  if (
    opts.intakeStatus
    && !opts.intakeStatus.readyToAskDesign
    && userRequestsDesignGeneration(userText)
  ) {
    const content = fallbackPrompt(
      requirements, opts.profile, opts.repeatedAsk, lang, opts.intakeStatus,
    );
    if (!client) {
      recordSkipped({ callSite: "orchestratorChat", prompt: userText, reply: content });
    }
    return { content, requirements };
  }

  // 已齐且客户明确要出图 / 「等设计」寒暄：直接确认开工，禁止再问或陪聊
  if (
    opts.intakeStatus?.readyToAskDesign
    && (userRequestsDesignGeneration(userText) || isWaitingForDesignChitchat(userText))
  ) {
    const content = lang === "zh"
      ? "好的，开始根据已确认信息出设计…"
      : "Great — generating a layout from what we've confirmed…";
    if (!client) {
      recordSkipped({ callSite: "orchestratorChat", prompt: userText, reply: content });
    }
    return { content, requirements };
  }

  if (!client) {
    // 降级路径也记一笔：真实 token 是 0，但"本来会调一次、prompt 有多大"是可测的。
    // 不记的话，场景测试跑一百遍也回答不了「上线之后一个客户多少钱」。
    const content = fallbackPrompt(requirements, opts.profile, opts.repeatedAsk, lang, opts.intakeStatus);
    recordSkipped({
      callSite: "orchestratorChat",
      prompt: orchestratorSystem(opts.profile, lang, systemExtras) + renderForEstimate(ctx.history) + userText,
      reply: content,
    });
    return { content, requirements };
  }

  // 日常轮次走轻量模型；只有确定性触发（要出方案、多约束修改…）才上主力。
  // 判断逻辑在 model-tiers.ts，刻意不交给模型自己决定。
  const decision = opts.escalation ?? escalationDecision({
    userText, turnsWithoutProgress: 0,
  });
  const statusNote = intakeStatusNote(opts.intakeStatus, lang);
  const raw = await client.complete({
    system: orchestratorSystem(opts.profile, lang, systemExtras) + (statusNote ? `\n\n${statusNote}` : ""),
    messages: [...ctx.history, { role: "user", content: userText }],
    temperature: 0.3,
    callSite: tierForTurn(decision) === "reasoning" ? "layoutRevision" : "orchestratorChat",
  });
  const trimmed = raw.trim()
    || fallbackPrompt(requirements, opts.profile, opts.repeatedAsk ?? 0, lang, opts.intakeStatus);
  let content = guardPrematureDesignOffer(
    trimmed, requirements, opts.profile, opts.repeatedAsk ?? 0, lang, opts.intakeStatus,
  );
  // 资料已齐却空转「请稍候 / 团队制作中」→ 改成明确出图邀约（勿假装已在画）
  if (opts.intakeStatus?.readyToAskDesign && isPoliteDesignStall(content)) {
    content = lang === "zh"
      ? "必要信息已经齐了。**需要我现在根据已确认信息出设计吗？** 回复「请出图」或点下面的确认即可。"
      : "Everything needed is confirmed. **Shall I generate a design now?** Reply \"please generate\" or tap the confirm button.";
  }
  return { content, requirements };
}

/** 客户是否在请求出图 / 同意出图。 */
export function userRequestsDesignGeneration(text: string): boolean {
  return /(?:please\s+)?generat(?:e|ing)\s+(?:a\s+|the\s+)?design|go ahead and (?:generat|draw)|shall i generate|出(?:一版)?(?:设计|图)|生成设计|开始出图|好的?\s*出图|可以出图|请(?:开始)?(?:出图|生成)/i
    .test(text);
}

/**
 * 在系统已处于「等出图同意」时，短答复「yes/好的/同意」也算授权。
 * 勿在未邀约出图时单独使用，以免误触。
 */
export function isSoftDesignConsentYes(text: string): boolean {
  return /^(yes|yep|yeah|ok|okay|sure|please|go ahead|好的?|可以|同意|行|中)([\s!,.。！]*)$/i
    .test(text.trim());
}

/** 出图授权：强请求，或（仅当 awaitingConsent）短肯定 / 「等出图」寒暄。 */
export function isDesignConsentAffirmation(
  text: string,
  opts?: { awaitingConsent?: boolean },
): boolean {
  if (userRequestsDesignGeneration(text)) return true;
  if (opts?.awaitingConsent) {
    if (isSoftDesignConsentYes(text)) return true;
    if (isWaitingForDesignChitchat(text)) return true;
  }
  return false;
}

/** 「等设计 / 很期待」类寒暄——资料齐时应视为催出图，勿陪聊空转。 */
export function isWaitingForDesignChitchat(text: string): boolean {
  return /waiting\s+(for\s+)?(the\s+)?(design|overview|drawings?|layout)|looking\s+forward|excited\s+to\s+see|can'?t\s+wait|anticipat|please\s+(wait|hold)|hold\s+tight|design\s+team|in\s+the\s+works|等(着)?(出图|设计|方案|图纸|俯视)|期待|好了吗|出图了吗|催一下|什么时候能看/i
    .test(text);
}

/** LLM 是否在空转寒暄（假装制作中、无实质进展）。 */
export function isPoliteDesignStall(text: string): boolean {
  return /design\s+team|working\s+on\s+(it|your)|please\s+(wait|hold)|hold\s+tight|in\s+the\s+works|coming\s+together|制作中|请稍候|稍等一下|正在准备|团队正在/i
    .test(text);
}

/** 回复是否在未就绪时谎称可出图。 */
export function claimsPrematureDesignReady(text: string): boolean {
  return /everything i need.*(?:confirm|ready)|(?:all|everything).*(?:confirm(?:ed)?|ready).*(?:design|floor\s*plan)|shall i (?:go ahead and )?generate|ready to (?:generate|draw)|信息(?:已经)?(?:齐|齐全|完整)|可以开始(?:出图|设计)|需要我(?:帮你)?(?:生成|出).*(?:设计|图)/i
    .test(text);
}

/**
 * 未就绪时若模型仍邀请出图 / 声称已齐 → 改回确定性追问缺口。
 */
export function guardPrematureDesignOffer(
  content: string,
  requirements: string,
  profile: TradeInteractionProfile,
  repeatedAsk: number | boolean,
  lang: UiLanguage,
  intakeStatus?: OrchestratorOptions["intakeStatus"],
): string {
  if (!intakeStatus || intakeStatus.readyToAskDesign) return content;
  if (!claimsPrematureDesignReady(content) && !/shall i generate|需要我.*生成设计/i.test(content)) {
    return content;
  }
  return fallbackPrompt(requirements, profile, repeatedAsk, lang, intakeStatus);
}

/** 把 intake 状态写成模型可读的短注，避免幻觉「已齐 / 未齐」。 */
function intakeStatusNote(
  status: OrchestratorOptions["intakeStatus"],
  lang: UiLanguage,
): string {
  if (!status) return "";
  const open = (status.openAsks?.length ? status.openAsks : status.missing.map((f) => fieldLabel(f, lang)))
    .slice(0, 3);
  const confirmed = (status.confirmedBriefs ?? []).slice(0, 6);
  const justConfirmed = (status.justConfirmed ?? []).slice(0, 6);
  if (lang === "zh") {
    const recap = justConfirmed.length
      ? `本轮刚记下：${justConfirmed.join("、")}——先用一句话简短复述这几个数字（弱确认，不是提问），再继续。`
      : "";
    if (status.readyToAskDesign) {
      return `${recap ? `${recap} ` : ""}【状态】必要信息已齐，户型可用。请主动友好地问：是否要根据目前需求生成设计方案？未同意前不要说已经出图。`;
    }
    const miss = open.join("；") || "（无）";
    const done = confirmed.length ? `已确认勿再问：${confirmed.join("；")}。` : "";
    return `${recap ? `${recap} ` : ""}【状态】户型${status.floorPlanReady ? "已就绪" : "未就绪"}。${done}`
      + `本轮最多追问 1 项仍缺信息：${miss}。`
      + `若客户答非所问：先简短确认已记下的内容，再换一种问法或请其点快捷选项——禁止原样重复上一问。`
      + `不要贴户型草图；用纯文字提问。`
      + `未就绪时禁止：声称信息已齐、邀请出图、改问抽屉/五金等偏好。`
      + `信息未齐时不要提议出完整方案。`;
  }
  const recap = justConfirmed.length
    ? `Just recorded this turn: ${justConfirmed.join(", ")} — briefly restate these numbers first (a soft confirmation, not a question), then continue.`
    : "";
  if (status.readyToAskDesign) {
    return `${recap ? `${recap} ` : ""}[Status] Intake is complete and the floor plan is ready. Proactively and warmly ask whether to generate a design from what they've shared. Do not claim a drawing exists until they agree.`;
  }
  const miss = open.join("; ") || "(none)";
  const done = confirmed.length ? `Already confirmed (do NOT re-ask): ${confirmed.join("; ")}. ` : "";
  return `${recap ? `${recap} ` : ""}[Status] Floor plan ${status.floorPlanReady ? "ready" : "not ready"}. ${done}`
    + `Ask at most ONE still-missing item this turn: ${miss}. `
    + `If their reply is off-topic: briefly acknowledge what you have, then rephrase or point to quick options — never repeat the same question verbatim. `
    + `Text-only questions (no floor-plan sketches). `
    + `FORBIDDEN while not ready: saying everything is confirmed, inviting design generation, or asking optional preferences (drawers/hardware). `
    + `Do not offer a full design until this Status block says intake is complete.`;
}

/** 估算用：把历史拍平成会真的发出去的那串文字。 */
function renderForEstimate(history: readonly { role: string; content: string }[]): string {
  return history.map((m) => `${m.role}: ${m.content}`).join("\n");
}

/**
 * 还缺哪些关键字段——同时用于兜底话术与前端进度提示。
 *
 * 字段名用英文稳定键（与 `quick-replies.ts` 目录键一致）。展示给客户时
 * 再按语言翻译（见 `fieldLabel`）。
 */
export function missingFields(requirements: string): string[] {
  const text = requirements.toLowerCase();
  const checks: [string, RegExp][] = [
    ["kitchen size", /(\d+\s*(尺|米|m|ft|英尺|feet|'|″|inch|寸|sq\.?\s*ft))|尺寸|面积|平米|平方|one wall|two walls|kitchen\s*~/],
    ["layout", /布局|l\s*[- ]?shape|u\s*[- ]?shape|i\s*[- ]?shape|l\s*型|u\s*型|一字|岛台|island|galley|with island/],
    // 关键词表要认得**客户真会说的词**，尤其是快捷回答按钮上印的那几个
    // （`quick-replies.ts`）。认不出来的后果不是"少收一个字段"，而是客户点了
    // 按钮、系统下一轮又问同一个问题——比不给按钮更糟。
    // `test/quick-replies.test.ts` 对每个按钮做了穷举断言。
    ["style", /风格|现代|传统|简约|极简|北欧|轻奢|工业风|日式|中式|田园|复古|欧式|美式|平板|门板|哑光|纹理|灰色|白色|层压|shaker|modern|classic|nordic|farmhouse|transitional|traditional|slab|flat\s*panel|laminate|matte|textured?|grey|gray|door\s*style|cabinet\s*(?:door|style|finish)/i],
    ["budget", /预算|budget|万|\$|加币|cad|not decided/],
  ];
  const missing = checks.filter(([, re]) => !re.test(text)).map(([name]) => name);
  if (!hasProvinceMention(requirements)) missing.push("province");
  return missing;
}

/** 是否已提到加拿大省份（避免英文介词 on 假阳性）。 */
export function hasProvinceMention(requirements: string): boolean {
  const text = requirements;
  if (/ontario|british columbia|alberta|quebec|安大略|不列颠|阿尔伯塔|魁北克|曼尼托巴|萨斯|新斯科舍|多伦多|温哥华|卡尔加里|蒙特利尔|渥太华|\b(?:bc|ab|qc|mb|sk|ns|nb|nl|pe|yt|nt|nu)\s*省?\b|(?:^|[^a-zA-Z])on\s*省\b/i
    .test(text)) {
    return true;
  }
  // 大写两字母省码（含快捷回答里的 "Ontario ON"）
  return /(?:^|[^A-Za-z])(?:ON|BC|AB|QC|MB|SK|NS|NB|NL|PE|YT|NT|NU)(?:[^A-Za-z]|$)/.test(text);
}

/** 缺失字段的客户可见名称。 */
export function fieldLabel(field: string, lang: UiLanguage = DEFAULT_LANGUAGE): string {
  const zh: Record<string, string> = {
    "kitchen size": "厨房尺寸",
    layout: "布局",
    style: "风格",
    budget: "预算",
    province: "所在省份",
  };
  if (lang === "zh") return zh[field] ?? field;
  return field;
}

function fallbackPrompt(
  requirements: string,
  profile: TradeInteractionProfile,
  repeatedAsk: number | boolean = 0,
  lang: UiLanguage = DEFAULT_LANGUAGE,
  intakeStatus?: OrchestratorOptions["intakeStatus"],
): string {
  // 弱确认复述：只在这一轮真的有新东西被记下时才加这一句前缀——没有
  // `justConfirmed`（现有全部调用方都没传）时这句是空字符串，行为与之前
  // 完全一致，不会动到既有测试断言的原文案。
  const justConfirmed = intakeStatus?.justConfirmed ?? [];
  const recapPrefix = justConfirmed.length
    ? (lang === "zh"
      ? `记下了：${justConfirmed.join("、")}。`
      : `Got it — ${justConfirmed.join(", ")}. `)
    : "";
  return recapPrefix + fallbackPromptCore(requirements, profile, repeatedAsk, lang, intakeStatus);
}

function fallbackPromptCore(
  requirements: string,
  profile: TradeInteractionProfile,
  repeatedAsk: number | boolean = 0,
  lang: UiLanguage = DEFAULT_LANGUAGE,
  intakeStatus?: OrchestratorOptions["intakeStatus"],
): string {
  const missing = intakeStatus?.missing
    ? [...intakeStatus.missing]
    : missingFields(requirements);
  const labels = (fields: string[]) => fields.map((f) => fieldLabel(f, lang));
  const askPool = (intakeStatus?.openAsks?.length
    ? [...intakeStatus.openAsks]
    : labels(missing));
  const ask = askPool.slice(0, profile.maxQuestionsPerTurn);
  const ready = intakeStatus?.readyToAskDesign
    ?? (askPool.length === 0 && (intakeStatus?.floorPlanReady ?? false));
  const repeats = repeatedAsk === true ? 1 : Number(repeatedAsk) || 0;

  if (lang === "zh") {
    if (ready) {
      return "目前整理到的需求已经比较完整了。**需要我根据这些信息给你出一版设计方案吗？**" +
        "你点头后我再开始画；想先补充也可以直接说。";
    }
    if (askPool.length === 0 && !intakeStatus?.floorPlanReady) {
      return "文字需求已经比较齐了。接下来上传一张户型图，或在对话里把墙长和层高补上，" +
        "齐了之后我会问你要不要开始出设计。";
    }
    if (repeats >= 2) {
      return "我先不重复刚才那句了——下面点快捷选项，或按「墙名 英寸，层高 英寸」补尺寸；" +
        "若模型刚才超时，直接再发一句即可，不用重新确认已答过的项。";
    }
    if (repeats === 1) {
      return `可能是我没问清楚。请直接回答：${ask.join("；")}。` +
        `也可以点下面的选项，比打字省事。`;
    }
    if (!profile.explainJargon) {
      return `还需要：${ask.join("、")}。一次给全就行。`;
    }
    return `了解了。还想确认${ask.length > 1 ? "两件事" : "一件事"}：${ask.join("；")}？`;
  }

  if (ready) {
    return "I have enough to work with. **Shall I generate a design based on what you've shared?** " +
      "I'll only start drawing after you say yes — or tell me if you want to add more first.";
  }
  if (askPool.length === 0 && !intakeStatus?.floorPlanReady) {
    return "Your written requirements look complete. Next, upload a floor plan or enter wall lengths and ceiling height in chat — " +
      "once those are set, I'll ask whether to start a design.";
  }
  if (repeats >= 2) {
    return "I won't repeat the same question — tap a quick option below, or send wall lengths like "
      + "`<wall name> <inches>\", ceiling <inches>\"`. If the model timed out, just reply once more; no need to re-confirm answered items.";
  }
  if (repeats === 1) {
    return `I may not have asked clearly. Please answer: ${ask.join("; ")}. `
      + `Or tap an option below.`;
  }
  if (!profile.explainJargon) {
    return `Still need: ${ask.join(", ")}. You can send them all at once.`;
  }
  return `Got it. ${ask.length > 1 ? "A couple more things" : "One more thing"}: ${ask.join("; ")}?`;
}

/** 需求摘要的累积——不覆盖已有内容（旧实现的 `??` 会被空串清空）。 */
export function mergeRequirements(previous: string, addition: string): string {
  const add = addition.trim();
  if (!add) return previous;
  if (!previous) return add;
  if (previous.includes(add)) return previous;
  return `${previous}\n${add}`;
}

// ── 公司 Agent ────────────────────────────────────────────────────────────

/**
 * 构造公司 Agent 的 system prompt。
 *
 * 规格清单直接注入——这是"知识边界"的物理实现：上下文里没有别家公司的数据，
 * 模型想借用也无从借起。
 */
export function buildCompanyAgentSystem(
  companyName: string,
  bundle: SpecBundle,
  language: UiLanguage = DEFAULT_LANGUAGE,
  codingRules?: CompanyCodingRules,
): string {
  const join = language === "zh" ? "、" : ", ";
  const modules = bundle.modules
    .filter((m) => {
      const u = resolveModuleSellUnit(m, codingRules).sellUnit;
      // 注入时优先逻辑柜型；拆卖 BOX/DOOR 行单独列出会撑爆 prompt
      return u === "combo" || u === "standalone" || m.sellUnit === undefined;
    })
    .slice(0, 80)
    .map((m) => language === "zh"
      ? `${m.code}(${m.type} 宽:${m.widthOptions.join("/")} 高:${m.heightOptions.join("/")} 深:${m.depthOptions.join("/")})`
      : `${m.code}(${m.type} W:${m.widthOptions.join("/")} H:${m.heightOptions.join("/")} D:${m.depthOptions.join("/")})`)
    .join(join);
  const doors = bundle.doorStyles.map((d) => d.name).join(join);
  const hardware = bundle.hardwareOptions.map((h) => h.name).join(join);
  const accessories = bundle.accessoryOptions.map((a) => a.name).join(join);
  const none = msg(language, "(none)", "（无）");
  const rules = codingRules ?? undefined;
  const prefixBlock = rules?.prefixGuide?.length
    ? (language === "zh"
      ? ["", "本公司柜型前缀（只准用这里的解释，不要套别厂规则）：",
        ...rules.prefixGuide.map((g) => `- /${g.pattern}/ → ${g.meaning}`)]
      : ["", "This seller's coding prefixes (use ONLY these — never another seller's):",
        ...rules.prefixGuide.map((g) => `- /${g.pattern}/ → ${g.meaning}`)])
    : [];

  if (language === "zh") {
    return [
      `你是「${companyName}」的产品助手。只能基于下面这份本公司规格库回答问题。`,
      "",
      `可供型号：${modules || none}`,
      `门板样式：${doors || none}`,
      `五金选项：${hardware || none}`,
      `配件选项：${accessories || none}`,
      ...prefixBlock,
      "",
      "硬性规则：",
      "1. 只回答上面列出的型号与选项。列表里没有的，直接说本公司不提供，**不要编，也不要提别家公司**。",
      "2. 尺寸只能取型号对应的候选值，不要给「接近的尺寸」。",
      "3. **绝对不要报价格。** 价格由系统按规格库计算，你说的任何金额都会被丢弃。",
      "4. 不确定就说不确定，让客户联系公司确认。",
      "5. 解释型号码时只用本公司前缀规则，禁止套用其他厂商的 B12/DB12 含义。",
      "",
      "引导（答完产品问题后仍要帮小白往前走）：",
      "- **结合【当前户型几何】**：谈转角柜/懒人转盘/大宽度柜时，用实际墙长判断是否放得下（例如单墙约 84\" 时转角柜往往不合适，要直说）。",
      "- 用一句白话解释该型号是否适合客户已透露的厨房形状/墙长。",
      "- 主动提示下一步：缺尺寸→请上传户型或按 Q# 报墙长/层高；家电宽度未确认→请按图上 Q# 确认或说「推定可以」；需要正式价→出图后由系统报价（勿口报卖家价）。",
      "- 客户显然不懂术语时，先给一句话解释再给型号名；已问过的字段不要重复追问。",
      "",
      languageRuleForLlm(language),
    ].join("\n");
  }

  return [
    `You are the product assistant for "${companyName}". Answer only from this seller's catalog below.`,
    "",
    `SKUs: ${modules || none}`,
    `Door styles: ${doors || none}`,
    `Hardware: ${hardware || none}`,
    `Accessories: ${accessories || none}`,
    ...prefixBlock,
    "",
    "Hard rules:",
    "1. Only answer about SKUs/options listed above. If it is not listed, say this seller does not offer it — **do not invent, and do not mention other sellers**.",
    "2. Sizes must be from that SKU's option lists — do not suggest “close” sizes.",
    "3. **Never quote prices.** The system prices from the catalog; any amount you invent is discarded.",
    "4. If unsure, say so and suggest contacting the seller.",
    "5. When explaining SKU codes, use ONLY this seller's prefix guide — never another company's B12/DB12 meaning.",
    "",
    "Guidance (after answering the product question, keep beginners moving):",
    "- **Use [Kitchen geometry] when present**: for corner bases / lazy susans / wide units, judge fit against actual wall lengths (e.g. a ~84\" single run often cannot take a corner unit — say so).",
    "- In one plain sentence, relate the SKU to the customer's kitchen shape/wall lengths.",
    "- Next steps: missing sizes → upload a floor plan or answer wall/ceiling Q#; unconfirmed appliance widths → confirm via Q# or say \"assumed widths are fine\"; formal price → system quote after drawings (never invent seller prices).",
    "- Define jargon briefly for non-technical customers; do not re-ask fields already stated.",
    "",
    languageRuleForLlm(language),
  ].join("\n");
}

export async function companyAgentReply(
  client: CompletionClient | undefined,
  companyName: string,
  bundle: SpecBundle,
  ctx: AgentContext,
  userText: string,
  language: UiLanguage = DEFAULT_LANGUAGE,
  codingRules?: CompanyCodingRules,
): Promise<AgentReply> {
  const handoffNote = ctx.handoff
    ? `\n\n${renderHandoffContextNote(ctx.handoff, language)}`
    : (ctx.requirements?.trim()
      ? `\n\n${language === "zh"
        ? `【项目需求摘要】\n${ctx.requirements.trim()}\n已写明的项不要重问。`
        : `[Project requirements]\n${ctx.requirements.trim()}\nDo not re-ask fields already stated.`}`
      : "");
  const geoNote = ctx.geometryNote?.trim()
    ? `\n\n${ctx.geometryNote.trim()}`
    : "";
  const system = buildCompanyAgentSystem(companyName, bundle, language, codingRules)
    + handoffNote + geoNote;

  if (!client) {
    const content = deterministicSpecAnswer(companyName, bundle, userText, language);
    // 公司 Agent 的 prompt 里注入了整份规格清单——它通常是全系统**最大的一个
    // prompt**，成本分析里不能漏
    recordSkipped({
      callSite: "companySpecQa",
      prompt: system + renderForEstimate(ctx.history) + userText,
      reply: content,
    });
    return { content, companyId: bundle.companyId };
  }
  const content = await client.complete({
    system,
    messages: [...ctx.history, { role: "user", content: userText }],
    temperature: 0.2,
    // 查自家规格库属于事实问答，上下文已经把答案摆在眼前了，用轻量层足够
    callSite: "companySpecQa",
  });
  return {
    content: content.trim() || deterministicSpecAnswer(companyName, bundle, userText, language),
    companyId: bundle.companyId,
  };
}

/**
 * 开线 / pull 后：厂商 Agent 复述交接包并请用户确认。
 * 无 LLM 时走确定性模板（保证 doorStyle 等事实一定出现在气泡里）。
 */
export async function companyAgentRestateHandoff(
  client: CompletionClient | undefined,
  companyName: string,
  bundle: SpecBundle,
  handoff: CompanyEngagementHandoff,
  language: UiLanguage = DEFAULT_LANGUAGE,
  codingRules?: CompanyCodingRules,
  mode: "open" | "pull" = "open",
): Promise<AgentReply> {
  const fallback = deterministicHandoffRestate(companyName, handoff, language, mode);
  const handoffNote = renderHandoffContextNote(handoff, language);
  const system = buildCompanyAgentSystem(companyName, bundle, language, codingRules)
    + `\n\n${handoffNote}`;
  const userPrompt = language === "zh"
    ? (mode === "pull"
      ? "主项目共享确认刚同步到本协作。请用简短中文复述变更后的已确认项（尤其门板等厂专用项若仍有效须保留），并请客户确认。"
      : "协作刚开线。请用简短中文复述交接包中的已确认项（含门板等厂专用选型），并请客户确认是否正确。不要重问清单里已有的字段。")
    : (mode === "pull"
      ? "Shared confirmations were just pulled from the main project. Briefly restate the updated confirmed items (keep seller-specific picks if still valid) and ask the customer to confirm."
      : "This collaboration just opened. Briefly restate the handoff confirmations (including seller-specific door style if present) and ask the customer to confirm. Do not re-ask fields already listed.");

  if (!client) {
    recordSkipped({
      callSite: "companySpecQa",
      prompt: system + userPrompt,
      reply: fallback,
    });
    return { content: fallback, companyId: bundle.companyId };
  }

  try {
    const content = await client.complete({
      system,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.2,
      callSite: "companySpecQa",
    });
    const trimmed = content.trim();
    // 若模型漏掉已确认门板，回退确定性复述，避免再次出现「看不到 doorStyleId」
    const doorId = handoff.companyPreferences?.doorStyleId;
    const doorFact = handoff.confirmedFacts?.find((f) => f.key === "doorStyleId");
    const mustMention = doorId || doorFact?.display;
    if (mustMention && trimmed && !trimmed.includes(String(mustMention))
      && !(doorFact?.display && trimmed.includes(doorFact.display))
      && !(doorId && trimmed.includes(doorId))) {
      return { content: fallback, companyId: bundle.companyId };
    }
    return {
      content: trimmed || fallback,
      companyId: bundle.companyId,
    };
  } catch {
    return { content: fallback, companyId: bundle.companyId };
  }
}

/**
 * 无 LLM 时的确定性规格问答：从问题里抽出型号码/尺寸，直接查规格库。
 * 查不到就明确说没有——与有 LLM 时的边界规则一致。
 */
export function deterministicSpecAnswer(
  companyName: string,
  bundle: SpecBundle,
  question: string,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): string {
  const q = question.toUpperCase();
  const hits = bundle.modules.filter((m) => q.includes(m.code));
  if (hits.length > 0) {
    return hits.map((m) =>
      msg(lang,
        `${companyName} ${m.code}: ${m.type}, widths ${m.widthOptions.join("/")}", ` +
        `heights ${m.heightOptions.join("/")}", depths ${m.depthOptions.join("/")}", ` +
        `assembly ${m.assemblyOptions.join(" / ")}.`,
        `${companyName} 的 ${m.code}：${m.type}，宽 ${m.widthOptions.join("/")}"，` +
        `高 ${m.heightOptions.join("/")}"，深 ${m.depthOptions.join("/")}"，` +
        `可选 ${m.assemblyOptions.join(" / ")}。`),
    ).join("\n");
  }

  // 尺寸类提问：「有 36 寸的转角柜吗」
  const size = /(\d+(?:\.\d+)?)\s*(?:寸|英寸|"|inch)/i.exec(question);
  if (size) {
    const w = Number(size[1]);
    const matching = bundle.modules.filter((m) => m.widthOptions.includes(w));
    const widths = [...new Set(bundle.modules.flatMap((m) => m.widthOptions))]
      .sort((a, b) => a - b);
    if (matching.length) {
      return msg(lang,
        `${companyName} has ${w}"-wide SKUs: ${matching.map((m) => m.code).join(", ")}.`,
        `${companyName} 有 ${w}" 宽的型号：${matching.map((m) => m.code).join("、")}。`);
    }
    return msg(lang,
      `${companyName} has no ${w}"-wide SKU. Available widths: ${widths.join(", ")}".`,
      `${companyName} 目前没有 ${w}" 宽的型号。可选宽度是 ${widths.join("、")}"。`);
  }

  return msg(lang,
    `${companyName} currently offers: ${bundle.modules.map((m) => m.code).join(", ")}. ` +
    `Door styles: ${bundle.doorStyles.map((d) => d.name).join(", ")}. Which one are you asking about?`,
    `${companyName} 目前可供的型号有：${bundle.modules.map((m) => m.code).join("、")}。` +
    `门板样式：${bundle.doorStyles.map((d) => d.name).join("、")}。具体想问哪一个？`);
}

// ── 设计意图 ──────────────────────────────────────────────────────────────

const DESIGN_SCHEMA_HINT = `{
  "selections": [
    { "moduleId": "型号 id", "qty": 数量, "width": 数字, "height": 数字, "depth": 数字,
      "assembly": "RTA" | "assembled",
      "hardwareOptionIds": ["..."], "accessoryOptionIds": ["..."] }
  ],
  "doorStyleId": "门板 id",
  "notes": "一句话说明这版方案的思路"
}`;

/**
 * 让公司 Agent 产出设计意图。
 *
 * **返回值一定过 `stripPriceFields`**——即使模型在 selections 里塞了 unitPrice、
 * total 之类的字段，也到不了下游。这是 FR-8 第 1 条的执行点之一。
 */
export async function proposeDesign(
  client: CompletionClient | undefined,
  companyName: string,
  bundle: SpecBundle,
  requirements: string,
): Promise<DesignIntent> {
  if (!client?.completeJson) {
    return { selections: [], doorStyleId: bundle.doorStyles[0]?.id, notes: "No LLM connected — layout algorithm or manual design required" };
  }

  const raw = await client.completeJson<{ selections?: unknown; doorStyleId?: unknown; notes?: unknown }>({
    system: buildCompanyAgentSystem(companyName, bundle, DEFAULT_LANGUAGE) +
      "\n\nBased on the customer request, pick a set of cabinets from this seller's catalog." +
      "\n**Output selections only — no price fields.** Anything priced is discarded by the system.",
    messages: [{ role: "user", content: `Customer requirements:\n${requirements}` }],
    schemaHint: DESIGN_SCHEMA_HINT,
    temperature: 0.2,
    // 需求 → 设计意图是错了代价最大的一步，走主力层
    callSite: "designIntent",
  });

  if (!raw) {
    return { selections: [], doorStyleId: bundle.doorStyles[0]?.id, notes: "Model did not produce a valid design" };
  }

  // ★ 价格字段在这里被丢弃
  const { selections } = stripPriceFields(raw.selections);
  const doorStyleId = typeof raw.doorStyleId === "string" && bundle.doorStyles.some((d) => d.id === raw.doorStyleId)
    ? raw.doorStyleId
    : bundle.doorStyles[0]?.id;

  return {
    selections,
    ...(doorStyleId ? { doorStyleId } : {}),
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}
