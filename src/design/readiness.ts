/**
 * 设计就绪检查表与设计 brief —— FR-15 / REQUIREMENTS §3.7。
 *
 * 系统内部用这份表决定「还缺什么、能不能问要不要出设计」。
 * 客户看到的是叙事 brief + 会话里的白话确认，不是这张表本身。
 */
import type { Conversation, Province } from "../domain/types.js";
import type { FloorPlan, WallRun } from "../floorplan/types.js";
import { isIsland, isLayoutReady } from "../floorplan/types.js";
import { assumedOnes, applianceLabel, type ApplianceKind } from "../floorplan/appliances.js";
import { planAppliances } from "../layout/appliance-plan.js";
import { missingFields, fieldLabel } from "../agents/orchestrator.js";
import { geometrySuppressesIntake } from "./site-questions.js";
import { chatConfirmedPlumbing } from "./chat-site-answers.js";
import { isConfirmAssumedAppliances } from "./chat-appliance-answers.js";
import { matchProvince, provinceByCode } from "./province-match.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

export type CheckStatus = "ok" | "missing" | "needs_confirm" | "deferred" | "assumed";

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

/**
 * 已确认 Tab 里这一行能不能手动改、改的话要传什么——前端不用去解析 `key`
 * 字符串猜目标，直接读这个字段拼 `/resolve` 的请求体（见 web/index.html
 * 的 `submitConfirmedEdit`）。没有这个字段 = 这一行不支持面板内编辑
 * （风格/预算/省份等走对话改，不在这次编辑范围内）。
 */
export type ConfirmedFactEditTarget =
  | { kind: "wall"; wallRunId: string; currentLength: number }
  | { kind: "ceiling"; currentHeight: number }
  | { kind: "appliance"; applianceKind: ApplianceKind; currentWidth: number }
  | {
      kind: "feature"; wallRunId: string; featureId: string;
      currentOffset: number; currentWidth: number;
    };

/** 已确认 Tab 用的明确事实行（尺寸/位置等，禁止模糊「已记录」）。 */
export interface ConfirmedFact {
  key: string;
  label: string;
  value: string;
  status: CheckStatus;
  editTarget?: ConfirmedFactEditTarget;
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
  /** 已确认/待确认事实清单（给右栏明确列出）。 */
  confirmedFacts: ConfirmedFact[];
}

export interface ReadinessInput {
  conversation: Conversation;
  plan: FloorPlan | undefined;
  /** 当前选中的公司（有 published 规格时算 seller ok）。 */
  companyId?: string;
  companyName?: string;
  language?: UiLanguage;
  /**
   * 客户账号上已有的省份（注册时必填，定价用——见 domain/types.ts
   * `CustomerAccount.province`）。传了就不再靠聊天正则去猜客户有没有
   * "说过"省份：账号上已经有了，逼客户在聊天里再念一遍是无意义的重复收集。
   */
  accountProvince?: Province;
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
  kind: "plumbing" | "window" | "door",
  lang: UiLanguage,
): string {
  const hits = featureKind(plan, kind);
  if (hits.length === 0) return "";
  const parts = hits.map(({ run }) => {
    const feats = run.features.filter((f) => f.kind === kind);
    const detail = feats.map((f) =>
      lang === "zh"
        ? `距起点 ${f.offset}"、宽 ${f.width}"`
        : `offset ${f.offset}", width ${f.width}"`,
    ).join(lang === "zh" ? "；" : "; ");
    return lang === "zh" ? `${run.label}：${detail}` : `${run.label}: ${detail}`;
  });
  return parts.join(lang === "zh" ? "\n" : "\n");
}

function geometryLines(plan: FloorPlan, lang: UiLanguage): string[] {
  const lines: string[] = [];
  for (const r of plan.parsedGeometry.wallRuns) {
    const kind = isIsland(r)
      ? msg(lang, "island", "岛台")
      : msg(lang, "wall", "墙");
    const depth = r.depth != null
      ? msg(lang, `, depth ${r.depth}"`, `，进深 ${r.depth}"`)
      : "";
    if (r.length > 0) {
      lines.push(msg(lang,
        `${kind} "${r.label}": ${r.length}"${depth}`,
        `${kind}「${r.label}」：${r.length}"${depth}`));
    } else {
      lines.push(msg(lang,
        `${kind} "${r.label}": length not set`,
        `${kind}「${r.label}」：长度未定`));
    }
  }
  const ceil = plan.parsedGeometry.ceilingHeight;
  lines.push(ceil != null
    ? msg(lang, `Ceiling height: ${ceil}"`, `层高：${ceil}"`)
    : msg(lang, "Ceiling height: not set", "层高：未定"));
  return lines;
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
  // FR-17：解读可用后不再把尺寸/形状当 intake 缺口
  if (geometrySuppressesIntake(plan) || (plan && isLayoutReady(plan))) {
    intake = intake.filter((f) => f !== "kitchen size" && f !== "layout");
  }
  // 账号上已经有省份（注册必填）——不再要求客户在聊天里也说一遍才算数。
  if (input.accountProvince) {
    intake = intake.filter((f) => f !== "province");
  }

  const items: ReadinessItem[] = [];

  // —— 几何（已有墙长/层高要逐条写出，禁止只说「未齐」）——
  {
    const wallsReady = Boolean(
      plan
      && plan.parsedGeometry.wallRuns.length > 0
      && plan.parsedGeometry.wallRuns.every((r) => r.length > 0)
      && plan.unresolvedItems.every((u) => u.resolved),
    );
    const ceilReady = plan?.parsedGeometry.ceilingHeight != null;
    if (!plan || (!wallsReady && !(plan.parsedGeometry.wallRuns.some((r) => r.length > 0)))) {
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
    } else if (!wallsReady || !ceilReady) {
      const knownRuns = plan!.parsedGeometry.wallRuns.filter((r) => r.length > 0);
      const known = geometryLines(plan!, lang).join("\n");
      const isL = /l\s*-?\s*shape|l\s*型/i.test(req);
      const isU = /u\s*-?\s*shape|u\s*型/i.test(req);
      let askHint = !wallsReady
        ? msg(lang, "Enter each wall length in inches (e.g. `<wall name> <inches>\"`).", "请按墙报英寸长度（如 `<墙名> <英寸数>寸`）。")
        : msg(lang, "What is the ceiling height in inches?", "层高多少英寸？");
      if (!wallsReady && knownRuns.length === 1 && isL) {
        const w = knownRuns[0]!;
        askHint = msg(lang,
          `Got "${w.label}" at ${w.length}" (~${(w.length / 12).toFixed(0)} ft). What is the other L-leg length in inches or ft?`,
          `已记「${w.label}」${w.length}"（约 ${(w.length / 12).toFixed(0)} 尺）。L 型另一段多长（英寸或英尺）？`);
      } else if (!wallsReady && knownRuns.length >= 1 && knownRuns.length < 3 && isU) {
        askHint = msg(lang,
          `Got ${knownRuns.length} run(s). Please give the remaining U-leg length(s) in inches or ft.`,
          `已有 ${knownRuns.length} 段墙。请补齐 U 型其余段长度（英寸或英尺）。`);
      } else if (!wallsReady && knownRuns.length === 1 && !isL && !isU) {
        const w = knownRuns[0]!;
        askHint = msg(lang,
          `Got one run "${w.label}" at ${w.length}". Is it I-shape (one wall) or L/U? If L/U, give the other leg length; also need ceiling height.`,
          `已有一段「${w.label}」${w.length}"。是一字还是 L/U？若是 L/U 请报另一段长度；并请给层高。`);
      }
      items.push({
        id: "walls_ceiling",
        category: "geometry",
        critical: true,
        status: "missing",
        brief: known + (lang === "zh" ? "\n（尺寸未齐，还不能出图）" : "\n(Sizes incomplete — cannot draw yet)"),
        askHint,
      });
    } else {
      items.push({
        id: "walls_ceiling",
        category: "geometry",
        critical: true,
        status: "ok",
        brief: geometryLines(plan!, lang).join("\n"),
      });
    }
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
        `Plumbing:\n${describeFeatures(plan, "plumbing", lang)}`,
        `上下水：\n${describeFeatures(plan, "plumbing", lang)}`),
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
  } else if (chatConfirmedPlumbing(req)) {
    // 对话已确认墙位但尚未写入 feature（无户型 / 解析未命中墙 id）时，
    // 仍按「已确认」展示，避免 Design Basis 与聊天脱节。
    const snippet = req.split(/\n/).map((s) => s.trim()).find((s) =>
      /plumbing|sink|下水|水槽/i.test(s)) ?? req.slice(0, 80);
    items.push({
      id: "plumbing",
      category: "site",
      critical: true,
      status: "ok",
      brief: msg(lang,
        `Plumbing: you confirmed — ${snippet.slice(0, 100)}.`,
        `上下水：对话已确认——${snippet.slice(0, 100)}。`),
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
        `Windows:\n${describeFeatures(plan, "window", lang)}`,
        `窗：\n${describeFeatures(plan, "window", lang)}`),
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

  // —— 门洞（有则明确 offset/width）——
  const hasDoors = plan ? featureKind(plan, "door").length > 0 : false;
  if (hasDoors && plan) {
    items.push({
      id: "doors",
      category: "site",
      critical: false,
      status: "ok",
      brief: msg(lang,
        `Doors:\n${describeFeatures(plan, "door", lang)}`,
        `门：\n${describeFeatures(plan, "door", lang)}`),
    });
  }

  // —— 家电种类（不允许「后定」冒充就绪；尺寸未明不得进设计）——
  const appliances = plan?.appliances ?? [];
  if (appliances.length > 0) {
    const list = appliances.map((a) =>
      applianceLabel(a.kind, lang === "zh" ? "zh" : "en")).join(lang === "zh" ? "、" : ", ");
    items.push({
      id: "appliances_kinds",
      category: "appliances",
      critical: true,
      status: "ok",
      brief: msg(lang, `Appliances: ${list}.`, `家电：${list}。`),
    });
  } else {
    const triedDefer = DEFER_APPLIANCES.test(req);
    items.push({
      id: "appliances_kinds",
      category: "appliances",
      critical: true,
      status: "missing",
      brief: triedDefer
        ? msg(lang,
          "Appliances: still needed — sizes cannot be deferred before design.",
          "家电：仍需确认——出图前尺寸不可后定。")
        : msg(lang, "Which appliances will be in this kitchen?", "这间厨房会有哪些家电？"),
      // 举例格式用占位符，不写真实家电种类+数字——不然这句提示一旦被系统自己
      // 复述进对话历史，下一轮就会被 `parseAppliancesFromChat` 当成客户真报了
      // 一台家电（PR #26 同类根因：助手自己的举例被误认成客户数据）。
      askHint: msg(lang,
        "List each appliance with width in chat — e.g. `<appliance> <inches>\"`, one per appliance.",
        "请在对话里逐条列出每台家电及宽度，例如：`<家电> <英寸数>寸`。"),
    });
  }

  // —— 家电尺寸（关键：推定未确认 / 未采集 → 不能 readyToAskDesign）——
  if (appliances.length === 0) {
    items.push({
      id: "appliances_sizes",
      category: "appliances",
      critical: true,
      status: "missing",
      brief: msg(lang,
        "Appliance sizes: required before design (cannot defer).",
        "家电尺寸：出图前必须明确（不可后定）。"),
      askHint: msg(lang,
        "Give measured widths with each appliance (e.g. `<appliance> <inches>\"`).",
        "请随家电一并给出实测宽度（如 `<家电> <英寸数>寸`）。"),
    });
  } else {
    const assumed = assumedOnes(appliances);
    const assumedAccepted = isConfirmAssumedAppliances(req);
    const lines = appliances.map((a) => {
      const name = applianceLabel(a.kind, lang === "zh" ? "zh" : "en");
      const tag = a.provenance === "assumed"
        ? msg(lang, "assumed", "推定")
        : msg(lang, "confirmed", "已确认");
      return lang === "zh"
        ? `${name}：宽 ${a.width}"（${tag}）`
        : `${name}: width ${a.width}" (${tag})`;
    });
    items.push({
      id: "appliances_sizes",
      category: "appliances",
      critical: true,
      // 接受推定后仍标 assumed（不假装实测），但不再阻断出图
      status: assumed.length === 0
        ? "ok"
        : assumedAccepted
          ? "assumed"
          : "needs_confirm",
      brief: lines.join("\n"),
      ...(assumed.length > 0 && !assumedAccepted
        ? {
            askHint: msg(lang,
              "Reply with measured widths (e.g. fridge 36\"), or explicitly accept assumed numbers (\"assumed widths are fine\").",
              "请回复实测宽度（如冰箱 36\"），或明确接受推定数（「推定可以」）。"),
          }
        : {}),
    });
  }

  // —— 家电能否装进现有墙长（尽早报，禁止「收齐再拒绝」）——
  //
  // 只要有宽度（不管是客户给的还是推定的）就查，不等全部确认——「收齐再
  // 拒绝」正是这条要治的病。以前这里还要求 assumedOnes 为空或客户已接受
  // 推定，副作用是：只要列表里有**任何**未确认的推定值（哪怕只是灶具自动
  // 带上的推定烟机，跟放不放得下毫无关系），整个放不下的提示就被压下去，
  // 客户看到的只是"请确认尺寸"，看不到真正的"你的冰箱+灶具根本放不下"。
  {
    const wallsWithLen = plan?.parsedGeometry.wallRuns.filter((r) => r.length > 0) ?? [];
    if (appliances.length > 0 && wallsWithLen.length > 0 && plan) {
      const fit = planAppliances(plan.parsedGeometry, appliances, lang);
      if (fit.warnings.length > 0) {
        const detail = fit.warnings.map((w) => w.message).join("\n");
        items.push({
          id: "appliances_fit",
          category: "appliances",
          critical: true,
          status: "missing",
          brief: detail,
          askHint: msg(lang,
            "These appliances need more wall length than you have. Shrink appliance widths, drop an appliance, or give a longer wall — then we can design.",
            "这些家电需要的墙长超过了现有墙段。请改小家电宽度、减少台数，或报更长的墙——否则无法出图。"),
        });
      } else {
        items.push({
          id: "appliances_fit",
          category: "appliances",
          critical: true,
          status: "ok",
          brief: msg(lang,
            "Appliance widths fit the current wall runs.",
            "家电宽度与现有墙长匹配。"),
        });
      }
    }
  }

  // —— 意图：风格 / 预算 / 省份 ——
  // FR-15.2：禁止「已记在需求里」——必须写出系统理解到的具体描述。
  const doorStyleName = doorStyleNameFromPrefs(prefs);
  for (const field of ["style", "budget", "province"] as const) {
    const missing = intake.includes(field);
    const fromPref = (field === "budget" && shared.budgetBand !== undefined)
      || (field === "style" && Boolean(doorStyleName))
      || (field === "province" && Boolean(input.accountProvince));
    const ok = !missing || fromPref;
    const understood = ok
      ? (field === "style" && doorStyleName && missing
        ? msg(lang, `Style: ${doorStyleName}.`, `风格：${doorStyleName}。`)
        : describeIntentField(field, req, shared.budgetBand, lang, input.accountProvince))
      : "";
    items.push({
      id: field,
      category: "intent",
      critical: true,
      status: ok ? "ok" : "missing",
      brief: ok
        ? understood
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
  // deferred / assumed（已接受推定）的关键项不阻断询问出图
  const readyToAskDesign = criticalBlocking.length === 0
    && items.some((i) => i.id === "walls_ceiling" && i.status === "ok");

  const sections = buildSections(items, lang);
  const confirmationText = buildConfirmationText(items, readyToAskDesign, lang);
  const confirmedFacts = buildConfirmedFacts(items, plan, lang);

  return { items, readyToAskDesign, openItems, sections, confirmationText, confirmedFacts };
}

/** 把检查项拆成「标签 → 明确值」行，供已确认 Tab 逐条列出。 */
function buildConfirmedFacts(
  items: ReadinessItem[],
  plan: FloorPlan | undefined,
  lang: UiLanguage,
): ConfirmedFact[] {
  const facts: ConfirmedFact[] = [];
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  if (plan) {
    for (const r of plan.parsedGeometry.wallRuns) {
      const kind = isIsland(r)
        ? msg(lang, "Island", "岛台")
        : msg(lang, "Wall", "墙");
      const depth = r.depth != null
        ? msg(lang, `, depth ${r.depth}"`, `，进深 ${r.depth}"`)
        : "";
      facts.push({
        key: `wall:${r.id}`,
        label: msg(lang, `${kind} ${r.label}`, `${kind} ${r.label}`),
        value: r.length > 0
          ? msg(lang, `${r.length}"${depth}`, `${r.length}"${depth}`)
          : msg(lang, "not set", "未定"),
        status: r.length > 0 ? "ok" : "missing",
        editTarget: { kind: "wall", wallRunId: r.id, currentLength: r.length },
      });
    }
    const ceil = plan.parsedGeometry.ceilingHeight;
    facts.push({
      key: "ceiling",
      label: msg(lang, "Ceiling height", "层高"),
      value: ceil != null ? `${ceil}"` : msg(lang, "not set", "未定"),
      status: ceil != null ? "ok" : "missing",
      editTarget: { kind: "ceiling", currentHeight: ceil ?? 0 },
    });
    for (const kind of ["plumbing", "window", "door"] as const) {
      for (const { run } of featureKind(plan, kind)) {
        for (const f of run.features.filter((x) => x.kind === kind)) {
          const kindLabel = kind === "plumbing"
            ? msg(lang, "Plumbing", "上下水")
            : kind === "window"
              ? msg(lang, "Window", "窗")
              : msg(lang, "Door", "门");
          facts.push({
            key: `${kind}:${run.id}:${f.offset}`,
            label: msg(lang, `${kindLabel} on ${run.label}`, `${run.label} · ${kindLabel}`),
            value: msg(lang,
              `offset ${f.offset}", width ${f.width}"`,
              `距起点 ${f.offset}"，宽 ${f.width}"`),
            status: "ok",
            editTarget: {
              kind: "feature", wallRunId: run.id, featureId: f.id,
              currentOffset: f.offset, currentWidth: f.width,
            },
          });
        }
      }
    }
    for (const a of plan.appliances ?? []) {
      const name = applianceLabel(a.kind, lang === "zh" ? "zh" : "en");
      const tag = a.provenance === "assumed"
        ? msg(lang, "assumed", "推定")
        : msg(lang, "confirmed", "已确认");
      facts.push({
        key: `appliance:${a.kind}`,
        label: name,
        value: msg(lang, `width ${a.width}" (${tag})`, `宽 ${a.width}"（${tag}）`),
        status: a.provenance === "assumed" ? "assumed" : "ok",
        editTarget: { kind: "appliance", applianceKind: a.kind, currentWidth: a.width },
      });
    }
  }

  for (const id of ["style", "budget", "province", "seller"] as const) {
    const it = byId[id];
    if (!it || it.status === "missing") continue;
    const label = id === "style"
      ? msg(lang, "Style", "风格")
      : id === "budget"
        ? msg(lang, "Budget", "预算")
        : id === "province"
          ? msg(lang, "Province", "省份")
          : msg(lang, "Seller", "厂商");
    // brief 形如 "Budget: economy…" —— 去掉前缀留值
    const raw = it.brief.replace(/^(Style|Budget|Province|Seller|风格|预算|省份|厂商)\s*[：:]\s*/i, "").replace(/\.$/, "");
    facts.push({
      key: id,
      label,
      value: raw || it.brief,
      status: it.status,
    });
  }

  // 对话确认上下水但尚未写入 feature 时，仍列入事实
  const plumbingItem = byId.plumbing;
  if (
    plumbingItem
    && (plumbingItem.status === "ok" || plumbingItem.status === "deferred")
    && !facts.some((f) => f.key.startsWith("plumbing:"))
  ) {
    facts.push({
      key: "plumbing:chat",
      label: msg(lang, "Plumbing", "上下水"),
      value: plumbingItem.brief.replace(/^(Plumbing|上下水)\s*[：:]\s*/i, ""),
      status: plumbingItem.status,
    });
  }

  return facts;
}

function buildSections(items: ReadinessItem[], lang: UiLanguage): DesignBriefSection[] {
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const pick = (...ids: string[]) => ids.map((id) => byId[id]).filter(Boolean) as ReadinessItem[];

  const space = pick("walls_ceiling");
  const site = pick("plumbing", "windows", "doors");
  const appl = pick("appliances_kinds", "appliances_sizes", "appliances_fit");
  const intent = pick("style", "budget", "province");
  const seller = pick("seller");

  const section = (
    id: string,
    titleEn: string,
    titleZh: string,
    group: ReadinessItem[],
  ): DesignBriefSection => {
    // 整组只有「全部都没谈过」才算 untouched——组里哪怕只有一项已经 ok
    // （比如上下水已确认、只是窗户还没谈），body 里就会带出真实数据，
    // 徽标却说"还没聊"就自相矛盾了。所以徽标状态单独算，不能直接拿
    // "组里最差的一项" 当整组状态用：一项缺不代表整组没讨论过。
    const untouched = group.every((g) => g.status === "missing");
    const body = untouched
      ? msg(lang, "Not discussed yet.", "还没聊。")
      : group.map((g) => g.brief).join(lang === "zh" ? "\n" : "\n");
    const sectionStatus: DesignBriefSection["status"] = untouched
      ? "untouched"
      : group.some((g) => g.status === "missing" || g.status === "needs_confirm" || g.status === "assumed")
        ? "clarify"
        : group.some((g) => g.status === "deferred")
          ? "provisional"
          : "locked";
    return {
      id,
      title: msg(lang, titleEn, titleZh),
      body,
      status: sectionStatus,
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
    .filter((i) =>
      i.status === "ok" || i.status === "deferred"
      || i.status === "needs_confirm" || i.status === "assumed")
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

/**
 * 从需求原文抽出客户可见的风格/预算/省份描述。
 * 匹配标准选项时用标准术语；否则用摘录，绝不写「已记在需求里」。
 */
export function describeIntentField(
  field: "style" | "budget" | "province",
  requirements: string,
  budgetBand: string | undefined,
  lang: UiLanguage,
  accountProvince?: Province,
): string {
  const text = requirements;
  if (field === "budget") {
    if (budgetBand) {
      const label = BUDGET_BAND_LABEL[budgetBand]?.[lang]
        ?? budgetBand;
      return msg(lang, `Budget: ${label}.`, `预算：${label}。`);
    }
    const m = text.match(
      /预算[^。\n]{0,40}|budget[^.\n]{0,40}|CAD\s*\$?\s*[\d,.–-]+\s*k?/i,
    );
    const phrase = (m?.[0] ?? "").trim() || msg(lang, "stated in chat", "已在对话中说明");
    return msg(lang, `Budget: ${phrase}.`, `预算：${phrase}。`);
  }

  if (field === "province") {
    const hit = matchProvince(text) ?? (accountProvince ? provinceByCode(accountProvince) : undefined);
    if (hit) {
      return msg(lang,
        `Province: ${hit.en} (${hit.code}).`,
        `省份：${hit.zh}（${hit.code}）。`);
    }
    return msg(lang, "Province: stated in chat.", "省份：已在对话中说明。");
  }

  // style
  const style = matchStyle(text, lang);
  return msg(lang, `Style: ${style}.`, `风格：${style}。`);
}

const BUDGET_BAND_LABEL: Record<string, { en: string; zh: string }> = {
  economy: { en: "economy (under ~CAD $10k)", zh: "经济型（约 1 万加币以内）" },
  standard: { en: "standard (CAD $10–20k)", zh: "标准档（约 1–2 万加币）" },
  premium: { en: "premium (over CAD $20k)", zh: "高端（约 2 万加币以上）" },
  unsure: { en: "not decided yet", zh: "还没想好" },
};

const STYLE_TERMS: { re: RegExp; en: string; zh: string }[] = [
  { re: /现代简约|极简|minimal/i, en: "Modern / minimal", zh: "现代简约" },
  { re: /灰色.{0,8}(纹理|平板)|灰.{0,6}平板|grey?\s*(textured?\s*)?(slab|flat)/i, en: "Grey textured flat-panel", zh: "灰色纹理平板门" },
  { re: /哑光\s*白|matte\s*white|white\s*laminate/i, en: "Matte white laminate", zh: "哑光白层压板" },
  { re: /平板\s*门|flat\s*panel|\bslab\b|laminate|薄层压|门板/i, en: "Flat-panel / laminate", zh: "平板门 / 层压" },
  { re: /\bmodern\b|现代/i, en: "Modern", zh: "现代" },
  { re: /farmhouse|美式乡村|田园/i, en: "Farmhouse", zh: "美式乡村" },
  { re: /nordic|北欧|scandi/i, en: "Nordic", zh: "北欧" },
  { re: /transitional|轻奢/i, en: "Transitional", zh: "轻奢 / 过渡" },
  { re: /traditional|传统|欧式/i, en: "Traditional", zh: "传统" },
  { re: /shaker/i, en: "Shaker", zh: "Shaker" },
  { re: /工业风|industrial/i, en: "Industrial", zh: "工业风" },
  { re: /日式|japandi/i, en: "Japanese / Japandi", zh: "日式" },
];

function matchStyle(text: string, lang: UiLanguage): string {
  for (const t of STYLE_TERMS) {
    if (t.re.test(text)) return lang === "zh" ? t.zh : t.en;
  }
  // 摘一句含「风格/style/门板」的片段，避免模糊占位
  const m = text.match(/(?:风格|style|门板|door\s*style)[^。.\n]{0,40}/i);
  if (m) return m[0]!.trim();
  const line = text.split(/\n/).map((s) => s.trim()).find((s) =>
    /门|door|灰|白|gray|grey|matte|laminate|平板|slab/i.test(s));
  if (line) return line.slice(0, 64);
  const first = text.split(/\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return (first ?? msg(lang, "as described", "如所述")).slice(0, 48);
}

export { matchProvince };

function doorStyleNameFromPrefs(
  prefs: Conversation["preferences"],
): string | undefined {
  const by = prefs?.byCompany;
  if (!by) return undefined;
  for (const c of Object.values(by)) {
    // doorStyleId 本身常是可读 slug；若需求文案里已有同名则 matchStyle 会吃到
    if (c?.doorStyleId) return c.doorStyleId.replace(/[_-]+/g, " ");
  }
  return undefined;
}
