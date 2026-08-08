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
import { interactionProfile, type TradeInteractionProfile } from "../trade/interaction.js";
import type { AgentContext, AgentReply, CompletionClient, DesignIntent } from "./types.js";
import { escalationDecision, tierForTurn, type EscalationDecision } from "./model-tiers.js";
import { askStyleRules } from "./quick-replies.js";
import { recordSkipped } from "./token-meter.js";
import { asksAboutRta, renderRtaComparison } from "../quote/rta-disclosure.js";
import {
  DEFAULT_LANGUAGE, languageRuleForLlm, msg, type UiLanguage,
} from "../i18n/language.js";

function orchestratorSystem(profile: TradeInteractionProfile, lang: UiLanguage): string {
  if (lang === "zh") {
    const lines = [
      "你是加拿大厨房橱柜平台的总控助手，帮客户理清装修需求。",
      "语气友好、像真人顾问：先回应客户刚说的，再自然地追问下一项；避免生硬清单口吻。",
      `每轮最多问 ${profile.maxQuestionsPerTurn} 个最关键的缺失信息。需要收集：`,
      "厨房尺寸与布局、风格、材质倾向、预算范围、期望工期、所在省份（省份必填，用于计算税费）。",
      "已有户型图且尺寸齐时，不必再问尺寸/布局；改为确认风格、预算、省份等。",
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
      askStyleRules(lang),
    ];
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
    `Ask at most ${profile.maxQuestionsPerTurn} of the most important missing items per turn. Collect:`,
    "kitchen size & layout, style, material leanings, budget range, timeline, and province (province is required for tax).",
    "If a floor plan is already uploaded with sizes confirmed, do not re-ask size/layout; focus on style, budget, province, etc.",
    "",
    "When the necessary intake fields are complete (or floor-plan sizes are confirmed):",
    "- **Proactively ask**: shall I generate a design based on what you've shared so far?",
    "- Do not claim you have started drawing until they clearly agree.",
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
    askStyleRules(lang),
  ];
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
    missing: readonly string[];
    floorPlanReady: boolean;
    readyToAskDesign: boolean;
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

  if (!client) {
    // 降级路径也记一笔：真实 token 是 0，但"本来会调一次、prompt 有多大"是可测的。
    // 不记的话，场景测试跑一百遍也回答不了「上线之后一个客户多少钱」。
    const content = fallbackPrompt(requirements, opts.profile, opts.repeatedAsk, lang, opts.intakeStatus);
    recordSkipped({
      callSite: "orchestratorChat",
      prompt: orchestratorSystem(opts.profile, lang) + renderForEstimate(ctx.history) + userText,
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
  const content = await client.complete({
    system: orchestratorSystem(opts.profile, lang) + (statusNote ? `\n\n${statusNote}` : ""),
    messages: [...ctx.history, { role: "user", content: userText }],
    temperature: 0.3,
    callSite: tierForTurn(decision) === "reasoning" ? "layoutRevision" : "orchestratorChat",
  });
  return {
    content: content.trim() || fallbackPrompt(requirements, opts.profile, opts.repeatedAsk, lang, opts.intakeStatus),
    requirements,
  };
}

/** 把 intake 状态写成模型可读的短注，避免幻觉「已齐 / 未齐」。 */
function intakeStatusNote(
  status: OrchestratorOptions["intakeStatus"],
  lang: UiLanguage,
): string {
  if (!status) return "";
  if (lang === "zh") {
    if (status.readyToAskDesign) {
      return "【状态】必要信息已齐，户型可用。请主动友好地问：是否要根据目前需求生成设计方案？未同意前不要说已经出图。";
    }
    const miss = status.missing.map((f) => fieldLabel(f, lang)).join("、") || "（无）";
    return `【状态】户型${status.floorPlanReady ? "已就绪" : "未就绪"}；仍缺：${miss}。请用友好口吻继续补齐，不要在信息未齐时提议出完整方案。`;
  }
  if (status.readyToAskDesign) {
    return "[Status] Intake is complete and the floor plan is ready. Proactively and warmly ask whether to generate a design from what they've shared. Do not claim a drawing exists until they agree.";
  }
  const miss = status.missing.map((f) => fieldLabel(f, lang)).join(", ") || "(none)";
  return `[Status] Floor plan ${status.floorPlanReady ? "ready" : "not ready"}; still missing: ${miss}. Keep collecting warmly; do not offer a full design until intake is complete.`;
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
    ["style", /风格|现代|传统|简约|极简|北欧|轻奢|工业风|日式|中式|田园|复古|shaker|modern|classic|nordic|farmhouse|transitional|traditional|欧式|美式/],
    ["budget", /预算|budget|万|\$|加币|cad|not decided/],
    ["province", /\b(on|bc|ab|qc|mb|sk|ns|nb|nl|pe|yt|nt|nu)\b|ontario|british columbia|alberta|quebec|安大略|不列颠|阿尔伯塔|魁北克|曼尼托巴|萨斯|新斯科舍|多伦多|温哥华|卡尔加里|蒙特利尔|渥太华/],
  ];
  return checks.filter(([, re]) => !re.test(text)).map(([name]) => name);
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
  const missing = intakeStatus?.missing
    ? [...intakeStatus.missing]
    : missingFields(requirements);
  const labels = (fields: string[]) => fields.map((f) => fieldLabel(f, lang));
  const ready = intakeStatus?.readyToAskDesign
    ?? (missing.length === 0 && (intakeStatus?.floorPlanReady ?? false));

  if (lang === "zh") {
    if (ready || (missing.length === 0 && intakeStatus?.floorPlanReady)) {
      return "目前整理到的需求已经比较完整了。**需要我根据这些信息给你出一版设计方案吗？**" +
        "你点头后我再开始画；想先补充也可以直接说。";
    }
    if (missing.length === 0 && !intakeStatus?.floorPlanReady) {
      return "文字需求已经比较齐了。接下来上传一张户型图，或在对话里把墙长和层高补上，" +
        "齐了之后我会问你要不要开始出设计。";
    }
    const ask = labels(missing.slice(0, profile.maxQuestionsPerTurn));
    const repeats = repeatedAsk === true ? 1 : Number(repeatedAsk) || 0;
    if (repeats >= 3) {
      return "记下了。你随时可以继续补充，或者直接上传户型图，我这边就能开始排。";
    }
    if (repeats === 2) {
      return "好的，我先按你说的记下来。剩下的几项下面点一下就行，" +
        "也可以直接上传户型图——从图里读出来的数比打字准。";
    }
    if (repeats === 1) {
      return `可能是我没问清楚。${ask.join("、")}这几项，下面直接选就行——` +
        `选项里带了价格影响，比打字省事。`;
    }
    if (!profile.explainJargon) {
      return `还需要：${ask.join("、")}。一次给全就行。`;
    }
    return `了解了。还想确认${ask.length > 1 ? "两件事" : "一件事"}：${ask.join("；")}？`;
  }

  if (ready || (missing.length === 0 && intakeStatus?.floorPlanReady)) {
    return "I have enough to work with. **Shall I generate a design based on what you've shared?** " +
      "I'll only start drawing after you say yes — or tell me if you want to add more first.";
  }
  if (missing.length === 0 && !intakeStatus?.floorPlanReady) {
    return "Your written requirements look complete. Next, upload a floor plan or enter wall lengths and ceiling height in chat — " +
      "once those are set, I'll ask whether to start a design.";
  }
  const ask = labels(missing.slice(0, profile.maxQuestionsPerTurn));
  const repeats = repeatedAsk === true ? 1 : Number(repeatedAsk) || 0;

  if (repeats >= 3) {
    return "Got it. Feel free to add more anytime, or upload a floor plan and I can start laying out.";
  }
  if (repeats === 2) {
    return "Okay, I'll note what you said. For the rest, tap an option below — " +
      "or upload a floor plan; sizes read from a drawing beat typing.";
  }
  if (repeats === 1) {
    return `I may not have asked clearly. For ${ask.join(", ")}, just pick below — ` +
      `options include price impact, which is easier than typing.`;
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
): string {
  const join = language === "zh" ? "、" : ", ";
  const modules = bundle.modules
    .map((m) => language === "zh"
      ? `${m.code}(${m.type} 宽:${m.widthOptions.join("/")} 高:${m.heightOptions.join("/")} 深:${m.depthOptions.join("/")})`
      : `${m.code}(${m.type} W:${m.widthOptions.join("/")} H:${m.heightOptions.join("/")} D:${m.depthOptions.join("/")})`)
    .join(join);
  const doors = bundle.doorStyles.map((d) => d.name).join(join);
  const hardware = bundle.hardwareOptions.map((h) => h.name).join(join);
  const accessories = bundle.accessoryOptions.map((a) => a.name).join(join);
  const none = msg(language, "(none)", "（无）");

  if (language === "zh") {
    return [
      `你是「${companyName}」的产品助手。只能基于下面这份本公司规格库回答问题。`,
      "",
      `可供型号：${modules || none}`,
      `门板样式：${doors || none}`,
      `五金选项：${hardware || none}`,
      `配件选项：${accessories || none}`,
      "",
      "硬性规则：",
      "1. 只回答上面列出的型号与选项。列表里没有的，直接说本公司不提供，**不要编，也不要提别家公司**。",
      "2. 尺寸只能取型号对应的候选值，不要给「接近的尺寸」。",
      "3. **绝对不要报价格。** 价格由系统按规格库计算，你说的任何金额都会被丢弃。",
      "4. 不确定就说不确定，让客户联系公司确认。",
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
    "",
    "Hard rules:",
    "1. Only answer about SKUs/options listed above. If it is not listed, say this seller does not offer it — **do not invent, and do not mention other sellers**.",
    "2. Sizes must be from that SKU's option lists — do not suggest “close” sizes.",
    "3. **Never quote prices.** The system prices from the catalog; any amount you invent is discarded.",
    "4. If unsure, say so and suggest contacting the seller.",
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
): Promise<AgentReply> {
  if (!client) {
    const content = deterministicSpecAnswer(companyName, bundle, userText, language);
    // 公司 Agent 的 prompt 里注入了整份规格清单——它通常是全系统**最大的一个
    // prompt**，成本分析里不能漏
    recordSkipped({
      callSite: "companySpecQa",
      prompt: buildCompanyAgentSystem(companyName, bundle, language)
        + renderForEstimate(ctx.history) + userText,
      reply: content,
    });
    return { content, companyId: bundle.companyId };
  }
  const content = await client.complete({
    system: buildCompanyAgentSystem(companyName, bundle, language),
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
