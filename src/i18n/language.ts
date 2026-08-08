/**
 * 客户语言偏好。
 *
 * 默认英文。只有客户**明确要求**用中文时才切换，并记在会话偏好里；
 * 之后问答跟客户语言走。图纸上的字一律英文，不受此偏好影响。
 */
export type UiLanguage = "en" | "zh";

export const DEFAULT_LANGUAGE: UiLanguage = "en";

/** 从已存偏好取出语言；没有就用默认英文。 */
export function resolveLanguage(prefs: { language?: UiLanguage } | undefined): UiLanguage {
  return prefs?.language === "zh" ? "zh" : DEFAULT_LANGUAGE;
}

/** 按语言取文案；默认英文。 */
export function msg(lang: UiLanguage | undefined, en: string, zh: string): string {
  return lang === "zh" ? zh : en;
}

/**
 * 客户这句话是不是在**明确切换语言**。
 *
 * 只认明确请求——不能因为客户写了几个中文字就改语言（加拿大客户
 * 偶尔夹中文很正常），也不能因为一句话里有 English 就切回。
 */
export function detectLanguageSwitch(text: string): UiLanguage | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;

  // 明确要中文
  if (
    /用中文|说中文|讲中文|改成中文|切换到中文|请用中文|能不能用中文|可以中文|中文回答|中文交流/.test(t)
    || /\b(in\s+chinese|speak\s+chinese|switch\s+to\s+chinese|reply\s+in\s+chinese)\b/.test(t)
  ) {
    return "zh";
  }

  // 明确要英文
  if (
    /用英文|说英文|讲英文|改成英文|切换到英文|请用英文|英文回答|英文交流/.test(t)
    || /\b(in\s+english|speak\s+english|switch\s+to\s+english|talk\s+in\s+english|reply\s+in\s+english|can you (?:talk|speak|reply) in english)\b/.test(t)
  ) {
    return "en";
  }

  return undefined;
}

/** 注入 LLM system prompt：回答必须跟客户语言。 */
export function languageRuleForLlm(lang: UiLanguage): string {
  return lang === "zh"
    ? "语言：客户选择了中文。之后每一轮回答与提问都用中文。"
    : "Language: the customer prefers English. Reply and ask questions in English from now on.";
}

/** 刚切换语言时，助手确认一句（不经过模型）。 */
export function languageSwitchAck(lang: UiLanguage): string {
  return lang === "zh"
    ? "好的，之后我用中文和你聊。"
    : "Got it — I'll continue in English.";
}
