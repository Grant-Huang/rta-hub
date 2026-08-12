/**
 * 测试用用户 LLM —— FR-20 / 测试用户 Agent。
 *
 * 只拿：人设、测试意图（软目标）、私有世界事实、对话历史。
 * **不知道**系统检查表；不按写死剧本推进。
 * 系统/厂商必须通过引导提问收集信息；本 agent 在引导下即兴发挥。
 */
import type { CompletionClient } from "../agents/types.js";

/** 用户身份人设 —— 影响主动程度、术语、是否会 @ 厂商。 */
export type UserPersona = "beginner" | "familiar" | "trade_pro";

export interface CustomerFacts {
  /** 开场可能说的意向（含糊即可）。 */
  intent?: string;
  /** 厨房形状/口语描述。 */
  kitchenTalk?: string;
  /** 墙段事实（与场景 walls 对齐，但不直接当剧本念）。 */
  walls?: { label: string; length: number }[];
  ceilingHeight?: number;
  style?: string;
  budget?: string;
  province?: string;
  appliances?: string;
  plumbing?: string;
  windows?: string;
  /** 感兴趣的厂商名；仅在意图/引导合适时才可能 @。 */
  mentionCompany?: string;
  /** 其它私有备注（勿写测试点 id）。 */
  notes?: string;
}

/** 软目标：告诉 agent「想达成什么」，不是步骤脚本。 */
export interface TestMissionIntent {
  /** 给 agent 的自然语言意图说明。 */
  brief: string;
  /** 希望自然触及的软目标（由 harness 观察进度，不强迫逐步执行）。 */
  softGoals: string[];
}

export type UserUiAction =
  | "none"
  | "upload_floorplan"
  | "consent_design"
  | "approve_plan"
  | "request_quote"
  | "vague_revision";

export type UserAgentSource = "llm" | "deterministic";

/** 会话回合：customer=user，platform=assistant（与 HTTP 会话一致）。 */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface UserAgentTurnInput {
  client: CompletionClient | undefined;
  facts: CustomerFacts;
  persona: UserPersona;
  mission: TestMissionIntent;
  /**
   * 完整对话（客户 + 平台），按时间序。
   * 有则优先用于 LLM；缺省时回退到 assistantHistory（仅上一问）。
   */
  conversationHistory?: ConversationTurn[];
  /** 平台回复列表（含最新一问）；无 conversationHistory 时的兼容路径。 */
  assistantHistory?: string[];
  /** true = 会话第一句（客户主动开口）。 */
  opening?: boolean;
  language?: "en" | "zh";
  /** harness 注入的进度（非系统检查表原文）。 */
  progressHint?: string;
}

export interface UserAgentTurnResult {
  text: string;
  source: UserAgentSource;
  uiAction: UserUiAction;
}

const ACTION_RE = /\bACTION\s*:\s*(none|upload_floorplan|consent_design|approve_plan|request_quote|vague_revision)\b/i;

const PERSONA_LINES: Record<UserPersona, string> = {
  beginner: [
    "PERSONA: complete beginner homeowner.",
    "- You do not know cabinet jargon (RTA, SKU, lazy susan, toe kick).",
    "- Wait to be asked; give fuzzy everyday answers; you may confuse inches/feet.",
    "- Do not volunteer a full project brief. Do not @ a company unless the assistant clearly teaches you how and why.",
    "- If confused, say so and ask what they need from you.",
  ].join("\n"),
  familiar: [
    "PERSONA: somewhat experienced homeowner (renovated once / read blogs).",
    "- Answer clearly when asked; short natural sentences.",
    "- You may mention a seller with @ when product-specific questions come up and your intent includes that seller.",
    "- Still do not dump every private fact unprompted.",
  ].join("\n"),
  trade_pro: [
    "PERSONA: trade / builder / designer professional.",
    "- Use industry terms naturally (door style, RTA vs assembled, wall runs, clearances).",
    "- Be concise; answer missing items efficiently when asked; may volunteer key dims if the assistant is stalling.",
    "- Comfortable @-mentioning a seller for catalog questions.",
  ].join("\n"),
};

function factsBlock(facts: CustomerFacts): string {
  return [
    facts.intent && `Intent vibe: ${facts.intent}`,
    facts.kitchenTalk && `Kitchen: ${facts.kitchenTalk}`,
    facts.walls?.length && `Walls: ${facts.walls.map((w) => `${w.label} ${w.length}"`).join("; ")}`,
    facts.ceilingHeight != null && `Ceiling: ${facts.ceilingHeight}"`,
    facts.style && `Style preference: ${facts.style}`,
    facts.budget && `Budget: ${facts.budget}`,
    facts.province && `Province: ${facts.province}`,
    facts.appliances && `Appliances: ${facts.appliances}`,
    facts.plumbing && `Plumbing: ${facts.plumbing}`,
    facts.windows && `Windows: ${facts.windows}`,
    facts.mentionCompany && `Seller you might ask about: ${facts.mentionCompany}`,
    facts.notes && `Notes: ${facts.notes}`,
  ].filter(Boolean).join("\n");
}

const MAX_HISTORY_TURNS = 16;

function lastAssistantAsk(input: UserAgentTurnInput): string {
  const hist = input.conversationHistory;
  if (hist?.length) {
    for (let i = hist.length - 1; i >= 0; i--) {
      const t = hist[i]!;
      if (t.role === "assistant" && t.content.trim()) return t.content;
    }
  }
  const ah = input.assistantHistory;
  return ah?.[ah.length - 1] ?? "";
}

/**
 * 把会话映射成「客户模型」的 completion messages：
 * 会话里的 user（客户）→ assistant；assistant（平台）→ user。
 */
function buildLlmMessages(
  input: UserAgentTurnInput,
): { role: "user" | "assistant"; content: string }[] {
  if (input.opening) {
    return [{
      role: "user",
      content:
        "Start the conversation in one short message about wanting kitchen cabinets. Stay in persona. Do not dump all facts. ACTION:none unless you truly need UI now.",
    }];
  }

  const hist = input.conversationHistory;
  if (hist?.length) {
    const mapped = hist
      .filter((t) => t.content.trim())
      .slice(-MAX_HISTORY_TURNS)
      .map((t) => ({
        role: (t.role === "user" ? "assistant" : "user") as "user" | "assistant",
        content: t.content.slice(0, 2000),
      }));
    if (!mapped.length) {
      return [{ role: "user", content: replyNudge(input, lastAssistantAsk(input)) }];
    }
    // 必须以平台问句（API user）结尾，便于续写客户回复
    if (mapped[mapped.length - 1]!.role !== "user") {
      mapped.push({ role: "user", content: replyNudge(input, lastAssistantAsk(input)) });
    }
    return mapped;
  }

  const lastAsk = lastAssistantAsk(input);
  return [{ role: "user", content: replyNudge(input, lastAsk) }];
}

function replyNudge(input: UserAgentTurnInput, lastAsk: string): string {
  return [
    lastAsk ? `The assistant just said:\n"""${lastAsk.slice(0, 1200)}"""` : "",
    input.progressHint ? `App progress:\n${input.progressHint}` : "",
    "Write your next customer reply (short).",
    "Answer the assistant's LATEST question from PRIVATE WORLD.",
    "Do not dump unrelated facts (style/budget/etc.) when they asked for dimensions or layout sizes.",
    "If you already answered part of a question, supply the still-missing pieces they still ask for.",
    "Add ACTION:... only if you use the UI.",
  ].filter(Boolean).join("\n\n");
}

function buildSystem(input: UserAgentTurnInput): string {
  return [
    "You are a real customer chatting with a kitchen-cabinet platform in Canada.",
    PERSONA_LINES[input.persona],
    "",
    "TEST INTENT (soft goals — pursue naturally under the assistant's guidance; NOT a step script):",
    input.mission.brief,
    ...input.mission.softGoals.map((g) => `- ${g}`),
    "",
    "Rules:",
    "- Read the full conversation history. Stay consistent with what you already said.",
    "- Answer the assistant's LATEST question. Prefer completing missing pieces they still ask for.",
    "- Answer ONLY from PRIVATE WORLD facts below when you know them; if unsure, say you're not sure.",
    "- Uploading a floor-plan sketch does NOT put sizes into the system. "
      + "If they couldn't read the plan or ask for text / Q# sizes, type wall lengths, ceiling, "
      + "openings, and appliance widths from PRIVATE WORLD in chat.",
    "- Do NOT assume Confirmed already has your numbers — only what you type counts.",
    "- Do NOT volunteer unrelated private facts (e.g. style when they asked for wall lengths).",
    "- You do NOT know any internal checklist. Never mention test, scenario, FR-, or system internals.",
    "- Prefer short chat messages. Let the assistant lead; follow their questions.",
    "- When you want to use the product UI (not chat), end with exactly one line: ACTION:<name>",
    "  Allowed ACTION names: none | upload_floorplan | consent_design | approve_plan | request_quote | vague_revision",
    "- Use upload_floorplan when they ask for a floor plan / measurements upload and you are ready to provide one.",
    "- Use consent_design ONLY if PROGRESS shows readyToAskDesign=true or stage=readyToDraw, and they invited a design drawing.",
    "- If stage is still collecting, do NOT spam consent_design — answer their questions from PRIVATE WORLD instead (style, province, budget, appliance widths, sizes).",
    "- Use approve_plan only after PROGRESS shows planView=true.",
    "- Use request_quote only after planView/fourViews progress allows, when you want a formal quote/BOM.",
    "- Use vague_revision only if planView=true and you want a fuzzy aesthetic change.",
    "- Default ACTION:none. Reply with customer message text first; ACTION line last (optional). No role labels.",
    "",
    "PRIVATE WORLD (live these; never paste as a bullet list):",
    factsBlock(input.facts),
    input.progressHint ? `\nPROGRESS (from the app UI, not a script):\n${input.progressHint}` : "",
  ].filter(Boolean).join("\n");
}

function parseAction(raw: string): { text: string; uiAction: UserUiAction } {
  const m = raw.match(ACTION_RE);
  const uiAction = (m?.[1]?.toLowerCase() as UserUiAction | undefined) ?? "none";
  const text = raw.replace(ACTION_RE, "").replace(/\n{3,}/g, "\n\n").trim()
    .replace(/^["「]|["」]$/g, "");
  return { text, uiAction };
}

/**
 * 生成客户下一句（+ 可选 UI 动作）。
 */
export async function userAgentTurn(input: UserAgentTurnInput): Promise<UserAgentTurnResult> {
  if (input.client?.complete) {
    try {
      const raw = (await input.client.complete({
        system: buildSystem(input),
        messages: buildLlmMessages(input),
        temperature: input.persona === "beginner" ? 0.85 : 0.7,
        callSite: "orchestratorChat",
      })).trim();
      if (raw) {
        const parsed = parseAction(raw);
        if (parsed.text) {
          return { text: parsed.text, source: "llm", uiAction: parsed.uiAction };
        }
      }
    } catch {
      // fall through
    }
  }

  return { ...deterministicReply(input), source: "deterministic" };
}

/**
 * 无 LLM：按人设 + 助手上一问关键词从私有世界抠答案——仍不是自报全量。
 */
export function deterministicReply(input: UserAgentTurnInput): {
  text: string;
  uiAction: UserUiAction;
} {
  const f = input.facts;
  const zh = input.language === "zh";
  const ask = lastAssistantAsk(input);
  const askL = ask.toLowerCase();

  if (input.opening) {
    if (input.persona === "trade_pro") {
      return {
        text: f.intent
          ?? (zh
            ? "我们有个厨房翻新，需要 RTA 柜体方案，先对一下门板和墙段。"
            : "We have a kitchen remodel — need an RTA cabinet plan; want to align door style and wall runs."),
        uiAction: "none",
      };
    }
    if (input.persona === "beginner") {
      return {
        text: zh
          ? "你好…厨房柜子想换新的，但我不太懂该从哪开始。"
          : "Hi… we want new kitchen cabinets but I’m not sure where to start.",
        uiAction: "none",
      };
    }
    return {
      text: f.intent
        ?? (zh ? "想重做厨房橱柜，先问问大概怎么弄。" : "Looking to redo our kitchen cabinets — not sure where to start."),
      uiAction: "none",
    };
  }

  if (/shall i generate|需要我帮你生成设计|出一版|generate a design drawing/i.test(ask)) {
    return {
      text: zh ? "好，出一版看看吧" : "Yes, please generate a design",
      uiAction: "consent_design",
    };
  }

  // 识图失败 / 请用文字报尺寸 → 从私有世界打出可解析的墙长+层高（系统要靠聊天落库）
  const asksTypedGeometry = /couldn't read|no image content|answer in text|wall lengths|enter.*sizes|手输|文本.*墙|手动.*尺寸|q\s*\d+.*ceiling|send wall/i.test(askL)
    || (/wall|墙|ceiling|层高|q\s*\d+/i.test(askL) && /inch|英寸|["″]|length|多长|多少/i.test(askL));
  if (asksTypedGeometry && f.walls?.length) {
    const wallBit = f.walls.map((w) => `${w.label} ${w.length}"`).join(", ");
    const ceilBit = f.ceilingHeight != null ? `, ceiling ${f.ceilingHeight}"` : "";
    if (input.persona === "beginner") {
      return {
        text: zh
          ? `嗯…大概是 ${f.walls.map((w) => `${w.label} ${Math.round(w.length / 12)} 尺`).join("、")}`
            + (f.ceilingHeight != null ? `，层高好像 ${Math.round(f.ceilingHeight / 12)} 尺` : "")
          : `Um… maybe ${f.walls.map((w) => `${w.label} about ${Math.round(w.length / 12)} ft`).join(", ")}`
            + (f.ceilingHeight != null ? `, ceiling around ${Math.round(f.ceilingHeight / 12)} ft` : ""),
        uiAction: "none",
      };
    }
    return { text: `${wallBit}${ceilBit}`, uiAction: "none" };
  }

  if (/upload|户型|floor\s*plan|平面图|\+/i.test(askL) && /上传|upload|photo|图片|图/.test(askL)) {
    return {
      text: zh ? "我这边有张户型草图，先传上去。" : "I can upload a rough floor plan.",
      uiAction: "upload_floorplan",
    };
  }
  if (/upload|户型|floor\s*plan|平面图/.test(askL) && input.persona !== "beginner") {
    return {
      text: zh ? "我上传户型图吧。" : "I'll upload the floor plan.",
      uiAction: "upload_floorplan",
    };
  }
  if (/quote|报价|bom|物料/i.test(askL) && input.mission.softGoals.some((g) => /quote|报价/i.test(g))) {
    return {
      text: zh ? "可以的话给我一份报价和物料清单。" : "Please send a quote / BOM if you can.",
      uiAction: "request_quote",
    };
  }
  if (/approve|满意|四视图|full drawing|完整图纸/i.test(askL)) {
    return {
      text: zh ? "俯视图可以，继续出完整图纸吧。" : "Plan looks ok — please continue to full drawings.",
      uiAction: "approve_plan",
    };
  }

  // 尺寸/墙长优先于风格等，避免答非所问
  const asksDims = /尺寸|多大|size|wall|墙|多少尺|\bft\b|length|leg|跑尺|run|measure|dimension|inch|英寸|两腿|各边/.test(askL);
  const asksCeiling = /q\d+|层高|ceiling/.test(askL);
  if ((asksDims || asksCeiling) && (f.kitchenTalk || f.walls?.length || f.ceilingHeight != null)) {
    if (f.walls?.length && (asksDims || (asksCeiling && asksDims))) {
      const wallBit = f.walls.map((w) => `${w.label} ${w.length}"`).join(", ");
      const ceilBit = (asksCeiling || asksTypedGeometry) && f.ceilingHeight != null
        ? `, ceiling ${f.ceilingHeight}"`
        : (asksCeiling && f.ceilingHeight != null ? `, ceiling ${f.ceilingHeight}"` : "");
      if (input.persona === "beginner" && !asksCeiling) {
        return {
          text: f.kitchenTalk
            ?? (zh
              ? f.walls.map((w) => `${w.label} 大概 ${Math.round(w.length / 12)} 尺`).join("、")
              : f.walls.map((w) => `${w.label} ~${Math.round(w.length / 12)} ft`).join(", ")),
          uiAction: "none",
        };
      }
      if (input.persona === "beginner" && asksCeiling && f.ceilingHeight != null && !asksDims) {
        return {
          text: zh ? "层高…大概两米四？不太确定英寸怎么说。" : "Ceiling is… maybe eight feet? Not sure in inches.",
          uiAction: "none",
        };
      }
      // familiar / trade：给可解析英寸，便于系统 applyChatSiteAnswers 落库
      if (asksCeiling && f.ceilingHeight != null) {
        return { text: `${wallBit}, ceiling ${f.ceilingHeight}"`, uiAction: "none" };
      }
      if (asksDims) {
        return { text: wallBit + ceilBit, uiAction: "none" };
      }
    }
    if (asksCeiling && f.ceilingHeight != null) {
      if (input.persona === "beginner") {
        return {
          text: zh ? "层高…大概两米四？不太确定英寸怎么说。" : "Ceiling is… maybe eight feet? Not sure in inches.",
          uiAction: "none",
        };
      }
      return {
        text: zh ? `层高大概 ${f.ceilingHeight} 英寸` : `Ceiling is about ${f.ceilingHeight} inches`,
        uiAction: "none",
      };
    }
    if (asksDims && f.kitchenTalk) {
      return { text: f.kitchenTalk, uiAction: "none" };
    }
  }
  if (/上下水|plumbing|sink/.test(askL) && f.plumbing) {
    return { text: f.plumbing, uiAction: "none" };
  }
  if (/窗|window/.test(askL) && f.windows) {
    return { text: f.windows, uiAction: "none" };
  }
  if (/门洞|door opening/.test(askL)) {
    return { text: zh ? "没有额外门洞" : "No extra door openings", uiAction: "none" };
  }
  if (/风格|style|modern|farmhouse|门板|door style/.test(askL) && f.style) {
    return { text: f.style, uiAction: "none" };
  }
  if (/预算|budget/.test(askL) && f.budget) {
    return { text: f.budget, uiAction: "none" };
  }
  if (/省|province|ontario|安大略/.test(askL) && f.province) {
    return { text: f.province, uiAction: "none" };
  }
  if (/家电|appliance|fridge|冰箱/.test(askL)) {
    return {
      text: f.appliances
        ?? (zh
          ? "冰箱 36\"、灶具 30\"、洗碗机 24\""
          : "Fridge 36\", stove 30\", dishwasher 24\""),
      uiAction: "none",
    };
  }
  if (/布局|layout|l-?shape|一字|岛台/.test(askL) && f.kitchenTalk) {
    return { text: f.kitchenTalk, uiAction: "none" };
  }
  if (/@|公司|company|厂商|seller/.test(askL) && f.mentionCompany) {
    if (input.persona === "beginner") {
      return {
        text: zh
          ? `哦，那我试一下 @${f.mentionCompany} ，想问问转角柜有没有。`
          : `Ok, I'll try @${f.mentionCompany} — do you have corner bases?`,
        uiAction: "none",
      };
    }
    return { text: `@${f.mentionCompany}`, uiAction: "none" };
  }

  if (
    input.persona !== "beginner"
    && f.mentionCompany
    && input.mission.softGoals.some((g) => /@|厂商|seller|company/i.test(g))
    && /产品|型号|corner|lazy|转角|报价|sku/i.test(askL)
  ) {
    return {
      text: zh
        ? `@${f.mentionCompany} 有 36 寸转角柜或懒人转盘吗？`
        : `@${f.mentionCompany} do you have a 36" corner base or lazy susan?`,
      uiAction: "none",
    };
  }

  if (input.persona === "beginner") {
    return {
      text: zh ? "嗯…你能告诉我下一步该说什么吗？" : "Um… what should I tell you next?",
      uiAction: "none",
    };
  }
  return {
    text: zh ? "嗯，你觉得还需要我补充啥？" : "Hmm, what else do you need from me?",
    uiAction: "none",
  };
}

/** 从场景墙/偏好合成私有事实（不把完整 turns 剧本塞给系统）。 */
export function factsFromScenario(s: {
  turns?: string[];
  walls: { label: string; length: number }[];
  ceilingHeight: number;
  prefs?: { budgetBand?: string };
  appliances?: { kind: string; width?: number }[];
  customerFacts?: CustomerFacts;
  shape?: string;
}): CustomerFacts {
  if (s.customerFacts) return { ...s.customerFacts };
  const budgetMap: Record<string, string> = {
    economy: "Budget under CAD $10k",
    standard: "Budget CAD $10–20k",
    premium: "Budget over CAD $20k",
    unsure: "Budget not decided yet",
  };
  return {
    intent: s.turns?.[0] ?? "Want new kitchen cabinets",
    kitchenTalk: s.shape
      ? `${s.shape}, walls roughly ${s.walls.map((w) => `${w.label} ${Math.round(w.length / 12)} ft`).join(", ")}`
      : undefined,
    walls: s.walls.map((w) => ({ label: w.label, length: w.length })),
    ceilingHeight: s.ceilingHeight,
    style: "Modern",
    budget: s.prefs?.budgetBand ? budgetMap[s.prefs.budgetBand] : "Budget CAD $10–20k",
    province: "Ontario ON",
    appliances: s.appliances?.length
      ? s.appliances.map((a) => a.kind + (a.width ? ` ${a.width}"` : "")).join(", ")
      : undefined,
    plumbing: s.walls.some((w) => (w as { features?: { kind: string }[] }).features?.some((f) => f.kind === "plumbing"))
      ? `Plumbing on ${s.walls.find((w) => (w as { features?: { kind: string }[] }).features?.some((f) => f.kind === "plumbing"))?.label ?? "the main wall"}`
      : "Plumbing later",
    windows: s.walls.some((w) => (w as { features?: { kind: string }[] }).features?.some((f) => f.kind === "window"))
      ? "There is a window on one wall"
      : "No windows",
    mentionCompany: "枫岭橱柜",
  };
}

export function personaForCaseIndex(caseIndex: number): UserPersona {
  const order: UserPersona[] = ["beginner", "familiar", "trade_pro"];
  return order[((caseIndex % 3) + 3) % 3]!;
}
