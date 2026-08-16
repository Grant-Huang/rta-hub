/**
 * 厂商员工会话（Type2 · 部分 A）—— 对话式初始化。
 *
 * 厂商注册后没有单独的表单页面：门店地址、标准折扣、产品目录都是员工在这里
 * 跟后台 Agent 聊出来的。上传的价目表走 `spec/catalog-upload.ts` 那条路，
 * 落进已有的 `spec/onboarding.ts` 追问队列——这里只负责把队列里的追问转成
 * 聊天，把员工的自然语言答案转成 `answerQuestion` 需要的结构化值。
 *
 * 跟客户侧的确定性抽取（`extractGeometryFromChat`）是同一个做法：**LLM 只做
 * 抽取，落库前先经过现有的强校验**（`answerQuestion` 本身就是零静默失败的
 * 强制点，这里不重复也不能绕过它）。没配 LLM 时退化为要求员工按精确格式回答，
 * 不悄悄猜。
 */
import type { CabinetCompany, DiscountRule } from "../domain/types.js";
import { DEFAULT_LANGUAGE, type UiLanguage } from "../i18n/language.js";
import {
  answerQuestion, OnboardingError, type OnboardingQuestion, type OnboardingSession, type QuestionAnswer,
} from "../spec/onboarding.js";
import type { SpecBundle } from "../spec/bundle.js";
import type { CompletionClient } from "./types.js";

const KNOWN_ROLES = [
  "doorStorage", "drawerStorage", "sinkBase", "cooktopBase",
  "applianceHousing", "cornerAccess", "openDisplay", "trim",
] as const;
const FACE_TEMPLATE_RE = /^F(1[0-5]|[1-9])_[A-Z_]+$/;

export interface StaffAgentContext {
  client: CompletionClient | undefined;
  company: CabinetCompany;
  /** 当前正在跟进的入驻/复核会话；没有就是纯 profile 聊天。 */
  session?: OnboardingSession;
  bundle?: SpecBundle;
  language?: UiLanguage;
}

export interface StaffAgentPatch {
  companyUpdate?: Partial<Pick<CabinetCompany, "storeAddress" | "contactName" | "quoteEmail">>;
  /** `{ value }` 写入/替换标准折扣；`{ clear: true }` 取消。 */
  discountRule?: { value: number } | { clear: true };
  onboardingAnswer?: { session: OnboardingSession; bundle: SpecBundle };
}

export interface StaffAgentOutcome {
  reply: string;
  patch?: StaffAgentPatch;
}

function nextUnanswered(session: OnboardingSession): OnboardingQuestion | undefined {
  return session.questions.find((q) => !q.answered);
}

/** 队首追问渲染成一句聊天消息（含还剩几条）。 */
export function renderNextQuestionPrompt(session: OnboardingSession, language: UiLanguage): string {
  const q = nextUnanswered(session);
  if (!q) {
    return language === "zh"
      ? "所有待确认项都处理完了——可以发布这一版规格了。"
      : "All follow-ups are cleared — this draft is ready to publish.";
  }
  const remaining = session.questions.filter((x) => !x.answered).length;
  return language === "zh"
    ? `（还剩 ${remaining} 条待确认）${q.prompt}`
    : `(${remaining} follow-up${remaining === 1 ? "" : "s"} left) ${q.prompt}`;
}

/** LLM 把员工的自由文本答案抽成结构化值；没有 LLM 就走精确格式的确定性解析。 */
async function extractAnswer(
  client: CompletionClient | undefined,
  question: OnboardingQuestion,
  text: string,
): Promise<QuestionAnswer | undefined> {
  if (client?.completeJson) {
    const raw = await client.completeJson<{ faceTemplateId?: unknown; roles?: unknown }>({
      system: "You convert a warehouse staff member's free-text answer into a structured value. " +
        "Only use values that are explicitly implied by the text — never invent one.",
      messages: [{
        role: "user",
        content: `Question: ${question.prompt}\nStaff answer: ${text}\n` +
          `If this is a face-template answer, output {"faceTemplateId": "F<n>_<NAME>"} using one of: ` +
          "F1_SINGLE_DOOR, F2_DOUBLE_DOOR, F3_DRAWER_OVER_DOOR, F4_DRAWER_OVER_DOUBLE, F5_TWO_DRAWERS_OVER_DOUBLE, " +
          "F6_DRAWER_STACK, F7_FALSE_FRONT_DOUBLE, F8_APRON_SINK, F9_DIAGONAL_CORNER, F10_BLIND_CORNER, " +
          "F11_OPEN_SHELF, F12_WINE_GRID, F13_TALL_TWO_DOOR, F14_APPLIANCE, F15_PLAIN_PANEL.\n" +
          `If this is a capability answer, output {"roles": [...]} using only: ${KNOWN_ROLES.join(", ")}.\n` +
          "If the answer does not clearly map to either, output {}.",
      }],
      schemaHint: '{"faceTemplateId"?: string, "roles"?: string[]}',
      temperature: 0,
      callSite: "companyStaffOnboardingAnswer",
    });
    if (raw?.faceTemplateId && typeof raw.faceTemplateId === "string") {
      return { faceTemplateId: raw.faceTemplateId };
    }
    if (Array.isArray(raw?.roles) && raw.roles.length) {
      const roles = raw.roles.filter((r): r is typeof KNOWN_ROLES[number] =>
        typeof r === "string" && (KNOWN_ROLES as readonly string[]).includes(r));
      if (roles.length) return { roles };
    }
    return undefined;
  }

  // 无 LLM：只认精确格式，不猜——猜错一个能力标签会让排布算法每一版都错，
  // 这比"多问一句"贵得多
  const trimmed = text.trim();
  if (FACE_TEMPLATE_RE.test(trimmed.toUpperCase())) {
    return { faceTemplateId: trimmed.toUpperCase() };
  }
  const tokens = trimmed.split(/[,，、\s]+/).filter(Boolean);
  const roles = tokens.filter((t): t is typeof KNOWN_ROLES[number] =>
    (KNOWN_ROLES as readonly string[]).includes(t));
  if (roles.length && roles.length === tokens.length) return { roles };
  return undefined;
}

async function handleOnboardingAnswer(
  ctx: StaffAgentContext,
  session: OnboardingSession,
  bundle: SpecBundle,
  text: string,
  at: string,
  language: UiLanguage,
): Promise<StaffAgentOutcome> {
  const q = nextUnanswered(session);
  if (!q) return { reply: renderNextQuestionPrompt(session, language) };

  const answer = await extractAnswer(ctx.client, q, text);
  if (!answer) {
    const hint = language === "zh"
      ? "没听懂这个答案对应哪个值——" +
        "脸型题请给具体模板 id（如 F2_DOUBLE_DOOR），能力题请给角色词（如 sinkBase, doorStorage）。"
      : "Could not map that to a value — for face questions give a template id (e.g. F2_DOUBLE_DOOR); " +
        "for capability questions give role words (e.g. sinkBase, doorStorage).";
    return { reply: `${hint}\n\n${q.prompt}` };
  }

  try {
    const outcome = answerQuestion(session, bundle, q.id, answer, at);
    const ack = language === "zh" ? "记下了。" : "Got it.";
    return {
      reply: `${ack} ${renderNextQuestionPrompt(outcome.session, language)}`,
      patch: { onboardingAnswer: { session: outcome.session, bundle: outcome.bundle } },
    };
  } catch (e) {
    const detail = e instanceof OnboardingError ? e.message : (e instanceof Error ? e.message : String(e));
    return { reply: language === "zh" ? `这个答案没能用上：${detail}` : `Could not apply that answer: ${detail}` };
  }
}

interface ProfileIntent {
  intent: "setStoreAddress" | "setStandardDiscount" | "clearStandardDiscount" | "other";
  storeAddress?: string;
  discountPercent?: number;
}

const DISCOUNT_RE = /(\d+(?:\.\d+)?)\s*%/;
const DISCOUNT_KEYWORDS = /折扣|优惠|discount|off\b/i;
const ADDRESS_LEADIN_RE = /(?:门店地址|展厅地址|地址|store address|address)\s*[:：是]+\s*(.+)/i;
const CLEAR_DISCOUNT_RE = /没有(标准)?折扣|不打折|取消折扣|no (standard )?discount|remove discount/i;

async function extractProfileIntent(
  client: CompletionClient | undefined,
  text: string,
): Promise<ProfileIntent> {
  if (client?.completeJson) {
    const raw = await client.completeJson<{ intent?: unknown; storeAddress?: unknown; discountPercent?: unknown }>({
      system: "You extract one of a small set of intents from a cabinet-seller staff member's chat message. " +
        "Only extract a value the text clearly states — never infer or invent one.",
      messages: [{
        role: "user",
        content: `Message: ${text}\n` +
          'Output {"intent": "setStoreAddress"|"setStandardDiscount"|"clearStandardDiscount"|"other", ' +
          '"storeAddress"?: string, "discountPercent"?: number}. ' +
          '"setStandardDiscount" only applies to a single uniform percent-off-list-price discount for all ' +
          "consumers — if the message describes a category-specific or tiered discount, use \"other\" instead.",
      }],
      schemaHint: '{"intent": string, "storeAddress"?: string, "discountPercent"?: number}',
      temperature: 0,
      callSite: "companyStaffProfileIntent",
    });
    const intent = raw?.intent;
    if (intent === "setStoreAddress" && typeof raw?.storeAddress === "string" && raw.storeAddress.trim()) {
      return { intent, storeAddress: raw.storeAddress.trim() };
    }
    if (intent === "setStandardDiscount" && typeof raw?.discountPercent === "number" && raw.discountPercent > 0) {
      return { intent, discountPercent: raw.discountPercent };
    }
    if (intent === "clearStandardDiscount") return { intent };
    return { intent: "other" };
  }

  // 无 LLM：只认明确的引导句式，不猜——地址/折扣直接影响客户看到的邮件与报价
  if (CLEAR_DISCOUNT_RE.test(text)) return { intent: "clearStandardDiscount" };
  const addrMatch = ADDRESS_LEADIN_RE.exec(text);
  if (addrMatch?.[1]?.trim()) return { intent: "setStoreAddress", storeAddress: addrMatch[1].trim() };
  const pctMatch = DISCOUNT_RE.exec(text);
  if (pctMatch && DISCOUNT_KEYWORDS.test(text)) {
    const value = Number(pctMatch[1]);
    if (value > 0 && value < 100) return { intent: "setStandardDiscount", discountPercent: value };
  }
  return { intent: "other" };
}

/** 非"other"才返回结果——留给调用方决定"other"时是走入驻问答还是通用兜底话。 */
async function tryProfileIntent(
  ctx: StaffAgentContext,
  text: string,
  language: UiLanguage,
): Promise<StaffAgentOutcome | undefined> {
  const parsed = await extractProfileIntent(ctx.client, text);

  if (parsed.intent === "setStoreAddress" && parsed.storeAddress) {
    return {
      reply: language === "zh"
        ? `已记录门店地址：${parsed.storeAddress}。到店确认邮件会用这个地址——地址不对就再说一次。`
        : `Store address recorded: ${parsed.storeAddress}. Showroom-visit confirmations will use this — say it again to correct.`,
      patch: { companyUpdate: { storeAddress: parsed.storeAddress } },
    };
  }
  if (parsed.intent === "setStandardDiscount" && parsed.discountPercent) {
    return {
      reply: language === "zh"
        ? `已设置标准折扣：全部消费者统一 -${parsed.discountPercent}%（原价基础上）。` +
          "只支持这一档全店统一折扣，不支持按品类分档——按品类的折价只能在正式报价时由员工手动给。"
        : `Standard discount set: -${parsed.discountPercent}% off list, uniform for all consumers. ` +
          "Only one storewide rate is supported — category-specific discounts stay a manual, per-quote call for staff.",
      patch: { discountRule: { value: parsed.discountPercent } },
    };
  }
  if (parsed.intent === "clearStandardDiscount") {
    return {
      reply: language === "zh"
        ? "已取消标准折扣。Agent 无人工介入时只会报原价（MSRP）。"
        : "Standard discount cleared. The agent will now quote MSRP only when unattended.",
      patch: { discountRule: { clear: true } },
    };
  }
  return undefined;
}

function genericHelp(language: UiLanguage): StaffAgentOutcome {
  return {
    reply: language === "zh"
      ? "我能帮你登记门店地址（「门店地址是：…」）、设置全店统一的标准折扣（「标准折扣 15%」），" +
        "或者你可以直接把价目表文件发过来，我来解析导入。还需要点什么吗？"
      : 'I can record your store address ("store address: …"), set a storewide standard discount ' +
        '("standard discount 15%"), or take a catalog/price-list file for import. What would you like to do?',
  };
}

/**
 * 员工第一次打开这条常驻线程时看到的引导——主动列出发布一版规格前需要
 * 备齐的资产，以及上传文件时系统认哪些格式。不是"等员工问了才说"，
 * 因为大多数新入驻的厂商根本不知道要准备这些东西。
 *
 * 五金/配件加价项、运费规则**没有列进来**：这两类字段在类型和定价引擎里
 * 已经存在，但目前既不在文件导入的表格里，也不在这里能识别的聊天意图
 * 里——没有落地路径的东西不能写进引导语，写了就是承诺一个做不到的事。
 */
export function welcomeMessage(language: UiLanguage): string {
  if (language === "zh") {
    return "欢迎！在这里跟我聊几句，或者直接发文件，就能把产品规格和报价立起来。\n\n" +
      "发布一版规格前需要备齐：\n" +
      "1. 柜型清单——型号码、类型（地柜/吊柜/高柜/转角柜…）、可选宽高深尺寸\n" +
      "2. 价格组——门板花色分档\n" +
      "3. 门板样式——每种门板归属哪个价格组\n" +
      "4. 价格矩阵——每个型号在每个价格组下的标价\n" +
      "5. 箱体板材加价档（可选，如「全夹板 +20%」）\n\n" +
      "门店地址、全店统一的标准折扣，直接跟我说一句就行（如「门店地址是：…」「标准折扣 15%」）。\n\n" +
      "上传文件支持 .xlsx / .json（直接按表结构解析）；.pdf 也收，但要靠 AI 抽取，" +
      "抽出来的内容我会挑出来跟你逐条确认。Word/.txt 暂不支持——表格结构不可靠，麻烦转存成 Excel。\n\n" +
      "现在要发文件，还是先聊？";
  }
  return "Welcome! Chat with me here, or just send a file, to get your product specs and pricing live.\n\n" +
    "Before a spec version can be published, I need:\n" +
    "1. Module list — codes, types (base/wall/tall/corner…), available width/height/depth options\n" +
    "2. Price groups — the door-finish price tiers\n" +
    "3. Door styles — which price group each door style belongs to\n" +
    "4. Price matrix — the list price for each module in each price group\n" +
    "5. Box-material upcharge tiers (optional, e.g. \"plywood box +20%\")\n\n" +
    'Store address and a storewide standard discount can just be said in chat ' +
    '(e.g. "store address: …", "standard discount 15%").\n\n' +
    "For uploads: .xlsx and .json are parsed directly from their table structure; .pdf is also accepted " +
    "but goes through AI extraction, and I'll walk you through confirming anything it pulls out. " +
    "Word/.txt aren't supported — there's no reliable table structure to read, so please save as Excel instead.\n\n" +
    "Want to send a file now, or talk through it first?";
}

export interface OnboardingReminder {
  text: string;
  /**
   * 用来判断这条提醒是否已经出现在线程最后一条消息里。
   *
   * 追问场景不能直接拿 `text` 整句去比：`renderNextQuestionPrompt` 生成的句子
   * 会因为「记下了。」这类前缀、剩余条数变化而跟上一条不完全相同，逐字比对会
   * 把"同一条追问"误判成"新内容"，每次开页面都重复贴一遍。改成只比对追问本身
   * 的题干（`OnboardingQuestion.prompt`，两处生成都原样嵌入），前缀/计数怎么变
   * 都认得出是同一条。
   */
  dedupeKey: string;
}

/**
 * 每次打开这条线程都要重新判断：厂商入驻完成了吗（发布过至少一版规格）？
 * 没完成的话，还欠什么——不能指望厂商自己记得上次聊到哪、还差哪一项。
 *
 * 已发布过至少一版规格（`publishedSpecVersionId` 有值）就不再提醒——后续
 * 改价/加型号是维护动作，不是"入驻没走完"，不该被同一套提醒缠上。
 */
export function onboardingReminder(
  publishedSpecVersionId: string | undefined,
  session: OnboardingSession | undefined,
  language: UiLanguage,
): OnboardingReminder | undefined {
  if (publishedSpecVersionId) return undefined;

  if (!session) {
    const text = welcomeMessage(language);
    return { text, dedupeKey: text };
  }

  const pending = nextUnanswered(session);
  if (pending) {
    return { text: renderNextQuestionPrompt(session, language), dedupeKey: pending.prompt };
  }

  // 没有待答项了：借用 renderNextQuestionPrompt 的"已清空"分支而不是另写一句——
  // 回答最后一条追问时，聊天里已经用这句话确认过了；用词不一致会让去重比对
  // 失效（GET 又贴一遍看起来一样但字面不同的话），厂商会觉得系统在重复自己。
  const text = renderNextQuestionPrompt(session, language);
  return { text, dedupeKey: text };
}

/**
 * 意图路由。**先**看这句话是不是明确的地址/折扣设置——不管当前是不是正卡在入驻
 * 追问上，员工都应该能随时插一句"门店地址是…"而不被当成在回答上一条追问
 * （追问答案本身是精确 token，不会被误判成地址/折扣意图，见 extractProfileIntent
 * 的确定性正则要求的关键词/引导句式）。只有明确不是这两类意图时，才落到"当前
 * 是不是卡在追问上"这条分支。
 */
export async function companyStaffAgentReply(
  ctx: StaffAgentContext,
  text: string,
  at: string,
): Promise<StaffAgentOutcome> {
  const language = ctx.language ?? DEFAULT_LANGUAGE;
  const profileOutcome = await tryProfileIntent(ctx, text, language);
  if (profileOutcome) return profileOutcome;
  if (ctx.session && ctx.bundle && nextUnanswered(ctx.session)) {
    return handleOnboardingAnswer(ctx, ctx.session, ctx.bundle, text, at, language);
  }
  return genericHelp(language);
}

/** 供上传端点复用：把一条折扣意图落成 DiscountRule 补丁（新建或替换现有的那一条）。 */
export function applyStandardDiscountPatch(
  existing: readonly DiscountRule[],
  specVersionId: string,
  companyId: string,
  patch: { value: number } | { clear: true },
): DiscountRule[] {
  const withoutStandard = existing.filter((r) => !(r.audience === "consumer" && r.autoQuotable));
  if ("clear" in patch) return withoutStandard;
  const standard: DiscountRule = {
    id: `disc_standard_${companyId}`,
    specVersionId,
    companyId,
    audience: "consumer",
    kind: "percentOffList",
    value: patch.value,
    stackable: false,
    description: `Standard discount -${patch.value}%`,
    autoQuotable: true,
  };
  return [...withoutStandard, standard];
}
