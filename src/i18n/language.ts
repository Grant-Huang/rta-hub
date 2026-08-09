/**
 * 客户语言偏好。
 *
 * 默认英文。客户**整句用中文交流**或明确要求中文时切到中文；
 * 明确要求英文则切回。
 *
 * 图纸 SVG 标注可仍为英文（模块编码等），但交付说明（读图指南、人体工程、
 * 审核文案）必须跟会话语言，避免中文聊完突然大段英文。
 */
export type UiLanguage = "en" | "zh";

export const DEFAULT_LANGUAGE: UiLanguage = "en";

/** 从已存偏好取出语言；没有就用默认英文。 */
export function resolveLanguage(prefs: { language?: UiLanguage } | undefined): UiLanguage {
  return prefs?.language === "zh" ? "zh" : DEFAULT_LANGUAGE;
}

/**
 * 短尺寸/关键词堆（如 FR-15 封口「Fridge 36\", Ontario ON」）不应把已建立的中文会话切回英文。
 */
export function isLanguageNoiseDump(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length > 100) return false;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (cjk >= 4) return false;
  // 量纲、省、预算带、推定确认 —— 英文关键词堆
  return /(?:fridge|refrigerator|range|stove|dishwasher|oven|budget|ontario|\bon\b|assumed|widths?|province|cad\s*\$|\d+\s*")/i.test(t)
    && (t.match(/[A-Za-z]/g) ?? []).length >= 6;
}

/**
 * 是否把推断语言写进偏好。
 * - 明确切换：始终采纳
 * - 否则：忽略测量/封口类短句，避免中英混切
 */
export function shouldUpdateLanguageFromText(
  current: UiLanguage,
  inferred: UiLanguage | undefined,
  text: string,
  explicitSwitch: boolean,
): boolean {
  if (!inferred || inferred === current) return false;
  if (explicitSwitch) return true;
  if (isLanguageNoiseDump(text)) return false;
  return true;
}

/** 按语言取文案；默认英文。 */
export function msg(lang: UiLanguage | undefined, en: string, zh: string): string {
  return lang === "zh" ? zh : en;
}

/**
 * 客户这句话是不是在**明确切换语言**。
 */
export function detectLanguageSwitch(text: string): UiLanguage | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;

  if (
    /用中文|说中文|讲中文|改成中文|切换到中文|请用中文|能不能用中文|可以中文|中文回答|中文交流/.test(t)
    || /\b(in\s+chinese|speak\s+chinese|switch\s+to\s+chinese|reply\s+in\s+chinese)\b/.test(t)
  ) {
    return "zh";
  }

  if (
    /用英文|说英文|讲英文|改成英文|切换到英文|请用英文|英文回答|英文交流/.test(t)
    || /\b(in\s+english|speak\s+english|switch\s+to\s+english|talk\s+in\s+english|reply\s+in\s+english|can you (?:talk|speak|reply) in english)\b/.test(t)
  ) {
    return "en";
  }

  return undefined;
}

/**
 * 从客户话术**推断**当前应用语言（FR 语言跟随）。
 *
 * - 明确切换指令优先；
 * - 否则：汉字占「汉字+拉丁字母」比例 ≥ 40% → 中文；
 * - 拉丁字母为主 → 英文；
 * - 分不出（数字/符号）→ undefined（保持原偏好）。
 *
 * 夹几个中文词的英文句不会误切；整段中文对话会切到中文。
 */
export function inferLanguageFromText(text: string): UiLanguage | undefined {
  const switched = detectLanguageSwitch(text);
  if (switched) return switched;

  const t = text.trim();
  if (!t) return undefined;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const total = cjk + latin;
  if (total < 4) return undefined;
  if (cjk / total >= 0.4) return "zh";
  if (latin / total >= 0.6) return "en";
  return undefined;
}

/** 注入 LLM system prompt：回答必须跟客户语言。 */
export function languageRuleForLlm(lang: UiLanguage): string {
  return lang === "zh"
    ? "语言：客户正在用中文交流。之后每一轮回答与提问都用中文（产品编码 / SKU 除外）。"
    : "Language: the customer is communicating in English. Reply and ask questions in English from now on (except product codes / SKUs).";
}

/** 刚切换语言时，助手确认一句（不经过模型）。 */
export function languageSwitchAck(lang: UiLanguage): string {
  return lang === "zh"
    ? "好的，之后我用中文和你聊。"
    : "Got it — I'll continue in English.";
}
