/**
 * 设计就绪检查表与设计 brief —— FR-15 / REQUIREMENTS §3.7。
 *
 * 系统内部用这份表决定「还缺什么、能不能问要不要出设计」。
 * 客户看到的是叙事 brief + 会话里的白话确认，不是这张表本身。
 */
import type { Conversation } from "../domain/types.js";
import type { FloorPlan, WallRun } from "../floorplan/types.js";
import { isLayoutReady } from "../floorplan/types.js";
import { assumedOnes } from "../floorplan/appliances.js";
import { missingFields, fieldLabel } from "../agents/orchestrator.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

export type CheckStatus = "ok" | "missing" | "needs_confirm" | "deferred";

export type CheckCategory = "geometry" | "site" | "appliances" | "intent" | "seller";

export interface ReadinessItem {
  id: string;
  category: CheckCategory;
  /** 是否挡住进入 readyToDraw。 */
  critical: boolean;
  status: CheckStatus;
  /** Tab1 / 出图前复述用的自然语言。 */
  brief: string;
  /** 会话里该追问什么（missing / needs_confirm 时）。 */
  askHint?: string;
}

export interface DesignBriefSection {
  id: string;
  title: string;
  body: string;
  status: "locked" | "provisional" | "untouched" | "clarify";
}

export interface DesignReadiness {
  items: ReadinessItem[];
  /** 关键项是否都已 ok（或 deferred 且非 critical——critical 不允许 deferred 冒充 ok）。 */
  readyToAskDesign: boolean;
  /** 仍缺或需确认的项（给编排/快捷回答）。 */
  openItems: ReadinessItem[];
  sections: DesignBriefSection[];
  /** 出图前给客户看的一整段文字确认。 */
  confirmationText: string;
}

export interface ReadinessInput {
  conversation: Conversation;
  plan: FloorPlan | undefined;
  /** 当前选中的公司（有 published 规格时算 seller ok）。 */
  companyId?: string;
  companyName?: string;
  language?: UiLanguage;
}

const DEFER_PLUMBING =
  /no plumbing|without plumbing|plumbing later|sink later|后装(下水|水管)|暂无上下水|没有上下水|下水稍后|水槽后定/i;
const DEFER_WINDOWS =
  /no windows?|without windows?|没有窗|无窗|这几面墙没有窗|walls? have no windows?/i;
const DEFER_APPLIANCES =
  /appliances? later|no appliances? yet|家电后定|家电稍后|暂时不谈家电/i;

function featureKind(plan: FloorPlan, kind: string): { run: WallRun; count: number }[] {
  const out: { run: WallRun; count: number }[] = [];
  for (const run of plan.parsedGeometry.wallRuns) {
    const n = run.features.filter((f) => f.kind === kind).length;
    if (n > 0) out.push({ run, count: n });
  }
  return out;
}

function describeFeatures(
  plan: FloorPlan,
  kind: "plumbing" | "window",
  lang: UiLanguage,
): string {
  const hits = featureKind(plan, kind);
  if (hits.length === 0) return "";
  const parts = hits.map(({ run, count }) => {
    const feats = run.features.filter((f) => f.kind === kind);
    const offsets = feats.map((f) => `${f.offset}"`).join(lang === "zh" ? "、" : ", ");
    return lang === "zh"
      ? `${run.label}上约 ${offsets} 处（${count} 处）`
      : `${run.label}: ~${offsets} (${count})`;
  });
  return parts.join(lang === "zh" ? "；" : "; ");
}

/**
 * 评估设计就绪检查表 + 生成 Tab1 brief 与出图前确认文案。
 */
export function evaluateDesignReadiness(input: ReadinessInput): DesignReadiness {
  const lang = input.language ?? DEFAULT_LANGUAGE;
  const plan = input.plan;
  const req = input.conversation.designRequirements ?? "";
  const prefs = input.conversation.preferences;
  const shared = prefs?.shared ?? {};

  let intake = missingFields(req);
  if (plan && isLayoutReady(plan)) {
    intake = intake.filter((f) => f !== "kitchen size" && f !== "layout");
  }

  const items: ReadinessItem[] = [];

  // —— 几何 ——
  if (!plan || !isLayoutReady(plan)) {
    items.push({
      id: "walls_ceiling",
      category: "geometry",
      critical: true,
      status: "missing",
      brief: msg(lang, "Wall lengths / ceiling height not complete yet.", "墙段长度或层高尚未补齐。"),
      askHint: msg(lang,
        "Upload a floor plan (+) or enter each wall length and ceiling height in chat.",
        "请上传户型图（+）或在对话里补齐各段墙长与层高。"),
    });
  } else {
    const walls = plan.parsedGeometry.wallRuns
      .map((r) => `${r.label} ${r.length}"`)
      .join(lang === "zh" ? "；" : "; ");
    const ceil = plan.parsedGeometry.ceilingHeight;
    items.push({
      id: "walls_ceiling",
      category: "geometry",
      critical: true,
      status: "ok",
      brief: msg(lang,
        `Walls: ${walls}. Ceiling: ${ceil}".`,
        `墙段：${walls}。层高：${ceil}"。`),
    });
  }

  // —— 上下水 ——
  const hasPlumbing = plan ? featureKind(plan, "plumbing").length > 0 : false;
  if (hasPlumbing && plan) {
    items.push({
      id: "plumbing",
      category: "site",
      critical: true,
      status: "ok",
      brief: msg(lang,
        `Plumbing: ${describeFeatures(plan, "plumbing", lang)}.`,
        `上下水：${describeFeatures(plan, "plumbing", lang)}。`),
    });
  } else if (DEFER_PLUMBING.test(req)) {
    items.push({
      id: "plumbing",
      category: "site",
      critical: true,
      status: "deferred",
      brief: msg(lang,
        "Plumbing: deferred (you said you'll decide later / none for now).",
        "上下水：已推迟（你说后定或暂无）。"),
    });
  } else {
    items.push({
      id: "plumbing",
      category: "site",
      critical: true,
      status: "missing",
      brief: msg(lang, "Plumbing location not confirmed.", "上下水位置尚未确认。"),
      askHint: msg(lang,
        "Where is the sink plumbing (which wall, roughly how far from a corner)? Or say \"plumbing later\" if unknown.",
        "上下水在哪面墙、距墙角大概多少？不确定可以说「下水稍后」。"),
    });
  }

  // —— 窗 ——
  const hasWindows = plan ? featureKind(plan, "window").length > 0 : false;
  if (hasWindows && plan) {
    items.push({
      id: "windows",
      category: "site",
      critical: false,
      status: "ok",
      brief: msg(lang,
        `Windows: ${describeFeatures(plan, "window", lang)}.`,
        `窗：${describeFeatures(plan, "window", lang)}。`),
    });
  } else if (DEFER_WINDOWS.test(req)) {
    items.push({
      id: "windows",
      category: "site",
      critical: false,
      status: "deferred",
      brief: msg(lang, "Windows: none / deferred as you said.", "窗：按你说的暂无或后定。"),
    });
  } else {
    items.push({
      id: "windows",
      category: "site",
      critical: false,
      status: "missing",
      brief: msg(lang, "Window locations not confirmed.", "窗户位置尚未确认。"),
      askHint: msg(lang,
        "Any windows on these walls? Rough position is fine — or say \"no windows\".",
        "这几面墙有窗吗？大概位置即可；没有可以说「没有窗」。"),
    });
  }

  // —— 家电种类 ——
  const appliances = plan?.appliances ?? [];
  if (appliances.length > 0) {
    const list = appliances.map((a) => a.kind).join(lang === "zh" ? "、" : ", ");
    items.push({
      id: "appliances_kinds",
      category: "appliances",
      critical: true,
      status: "ok",
      brief: msg(lang, `Appliances: ${list}.`, `家电：${list}。`),
    });
  } else if (DEFER_APPLIANCES.test(req)) {
    items.push({
      id: "appliances_kinds",
      category: "appliances",
      critical: true,
      status: "deferred",
      brief: msg(lang, "Appliances: deferred for now.", "家电：暂缓。"),
    });
  } else {
    items.push({
      id: "appliances_kinds",
      category: "appliances",
      critical: true,
      status: "missing",
      brief: msg(lang, "Which appliances will be in this kitchen?", "这间厨房会有哪些家电？"),
      askHint: msg(lang,
        "List appliances (fridge, range, dishwasher…) or say \"appliances later\".",
        "说说有哪些家电（冰箱、灶台、洗碗机…），或说「家电后定」。"),
    });
  }

  // —— 家电尺寸 ——
  if (appliances.length === 0) {
    items.push({
      id: "appliances_sizes",
      category: "appliances",
      critical: false,
      status: appliances.length === 0 && DEFER_APPLIANCES.test(req) ? "deferred" : "missing",
      brief: msg(lang, "Appliance sizes: n/a until kinds are known.", "家电尺寸：种类未定时暂无。"),
    });
  } else {
    const assumed = assumedOnes(appliances);
    const lines = appliances.map((a) => {
      const w = a.width;
      const tag = a.provenance === "assumed"
        ? msg(lang, "assumed", "推定")
        : msg(lang, "you confirmed", "已确认");
      return `${a.kind} ${w}" (${tag})`;
    });
    items.push({
      id: "appliances_sizes",
      category: "appliances",
      critical: false,
      status: assumed.length > 0 ? "needs_confirm" : "ok",
      brief: lines.join(lang === "zh" ? "；" : "; "),
      ...(assumed.length > 0
        ? {
            askHint: msg(lang,
              "Some appliance widths are assumed — please confirm or give measured widths.",
              "部分家电宽度是推定值——请确认或告知实测宽度。"),
          }
        : {}),
    });
  }

  // —— 意图：风格 / 预算 / 省份 ——
  for (const field of ["style", "budget", "province"] as const) {
    const missing = intake.includes(field);
    const fromPref = field === "budget" && shared.budgetBand !== undefined;
    const ok = !missing || fromPref;
    items.push({
      id: field,
      category: "intent",
      critical: true,
      status: ok ? "ok" : "missing",
      brief: ok
        ? (field === "budget" && shared.budgetBand
          ? msg(lang, `Budget band: ${shared.budgetBand}.`, `预算档：${shared.budgetBand}。`)
          : msg(lang,
            `${fieldLabel(field, lang)}: noted in your requirements.`,
            `${fieldLabel(field, lang)}：已记在需求里。`))
        : msg(lang,
          `${fieldLabel(field, lang)}: not yet.`,
          `${fieldLabel(field, lang)}：尚未确认。`),
      ...(ok ? {} : {
        askHint: msg(lang,
          `Please share your ${fieldLabel(field, "en")}.`,
          `请补充${fieldLabel(field, "zh")}。`),
      }),
    });
  }

  // —— 厂商 ——
  if (input.companyId) {
    items.push({
      id: "seller",
      category: "seller",
      critical: false,
      status: "ok",
      brief: msg(lang,
        `Seller: ${input.companyName ?? input.companyId}.`,
        `厂商：${input.companyName ?? input.companyId}。`),
    });
  } else {
    items.push({
      id: "seller",
      category: "seller",
      critical: false,
      status: "missing",
      brief: msg(lang, "No seller selected yet — @ a company when ready.", "尚未选定厂商——可用 @ 点名。"),
      askHint: msg(lang, "Type @ to pick a seller.", "输入 @ 选择厂商。"),
    });
  }

  const openItems = items.filter((i) => i.status === "missing" || i.status === "needs_confirm");
  const criticalBlocking = items.filter((i) =>
    i.critical && (i.status === "missing" || i.status === "needs_confirm"));
  // deferred critical counts as satisfied for asking design (customer chose to defer)
  const readyToAskDesign = criticalBlocking.length === 0
    && items.some((i) => i.id === "walls_ceiling" && i.status === "ok");

  const sections = buildSections(items, lang);
  const confirmationText = buildConfirmationText(items, readyToAskDesign, lang);

  return { items, readyToAskDesign, openItems, sections, confirmationText };
}

function statusToSection(
  status: CheckStatus,
): DesignBriefSection["status"] {
  switch (status) {
    case "ok": return "locked";
    case "deferred": return "provisional";
    case "needs_confirm": return "clarify";
    case "missing": return "untouched";
  }
}

function buildSections(items: ReadinessItem[], lang: UiLanguage): DesignBriefSection[] {
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const pick = (...ids: string[]) => ids.map((id) => byId[id]).filter(Boolean) as ReadinessItem[];

  const space = pick("walls_ceiling");
  const site = pick("plumbing", "windows");
  const appl = pick("appliances_kinds", "appliances_sizes");
  const intent = pick("style", "budget", "province");
  const seller = pick("seller");

  const section = (
    id: string,
    titleEn: string,
    titleZh: string,
    group: ReadinessItem[],
  ): DesignBriefSection => {
    const worst = group.some((g) => g.status === "missing")
      ? "missing"
      : group.some((g) => g.status === "needs_confirm")
        ? "needs_confirm"
        : group.every((g) => g.status === "ok" || g.status === "deferred")
          ? (group.some((g) => g.status === "deferred") ? "deferred" : "ok")
          : "missing";
    const untouched = group.every((g) => g.status === "missing");
    const body = untouched
      ? msg(lang, "Not discussed yet.", "还没聊。")
      : group.map((g) => g.brief).join(lang === "zh" ? "\n" : "\n");
    return {
      id,
      title: msg(lang, titleEn, titleZh),
      body,
      status: statusToSection(worst as CheckStatus),
    };
  };

  return [
    section("space", "Space & sizes", "空间与尺寸", space),
    section("site", "Wet wall & openings", "上下水与洞口", site),
    section("appliances", "Appliances", "家电", appl),
    section("intent", "Style, budget & province", "风格、预算与省份", intent),
    section("seller", "Seller", "厂商", seller),
  ];
}

function buildConfirmationText(
  items: ReadinessItem[],
  ready: boolean,
  lang: UiLanguage,
): string {
  if (!ready) {
    const asks = items
      .filter((i) => i.status === "missing" || i.status === "needs_confirm")
      .map((i) => i.askHint ?? i.brief)
      .slice(0, 4);
    return lang === "zh"
      ? `设计前还需要澄清：\n${asks.map((a) => `· ${a}`).join("\n")}`
      : `Before designing, we still need to clarify:\n${asks.map((a) => `· ${a}`).join("\n")}`;
  }

  const facts = items
    .filter((i) => i.status === "ok" || i.status === "deferred" || i.status === "needs_confirm")
    .map((i) => `· ${i.brief}`);
  if (lang === "zh") {
    return (
      "进入设计前，请确认我们按下面这些理解开工（推定项已标明）：\n" +
      facts.join("\n") +
      "\n\n**可以按这些生成设计吗？** 不对的地方直接改一句即可。"
    );
  }
  return (
    "Before we design, please confirm we'll proceed with the following (assumed items are labeled):\n" +
    facts.join("\n") +
    "\n\n**Shall I generate a design based on this?** If anything is wrong, just correct it in a sentence."
  );
}

/** 关键缺口的英文稳定键，供 quick-replies / 编排使用。 */
export function readinessOpenFields(readiness: DesignReadiness): string[] {
  return readiness.openItems.map((i) => i.id);
}
