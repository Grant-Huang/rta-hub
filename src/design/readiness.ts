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
import { chatConfirmedPlumbing, isDeferElectrical, isDeferGas, isDeferIsland } from "./chat-site-answers.js";
import { isConfirmAssumedAppliances } from "./chat-appliance-answers.js";
import { matchProvince, provinceByCode } from "./province-match.js";
import { requiredIntakeComplete } from "./intake-checklist.js";
import { SHAPE_SHORT_LABEL } from "../samples/templates.js";
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

/**
 * 分组头——只承载标题与聚合状态，不再重复罗列组内每一行的具体数字/位置：
 * 那些数字只在 `confirmedFacts`（按 `groupId` 分到同一组）里出现一次，
 * 面板按这份分组顺序（space → site → appliances → intent → seller，
 * 几何最基础排最前）渲染分组头 + 组内原子行，不再有第二份叙事复述。
 */
export interface DesignBriefSection {
  id: string;
  title: string;
  status: "locked" | "provisional" | "untouched" | "clarify";
}

/**
 * 已确认 Tab 里这一行能不能手动改、改的话要传什么——前端不用去解析 `key`
 * 字符串猜目标，直接读这个字段拼请求体（wall/ceiling/appliance/feature 走
 * `/resolve`，见 web/index.html 的 `saveFactEdit`；province 走
 * `/api/conversations/:id/preferences`，跟风格/预算共用的既有偏好接口）。
 * 没有这个字段 = 这一行不支持面板内编辑（风格/预算等走对话改）。
 */
export type ConfirmedFactEditTarget =
  | { kind: "wall"; wallRunId: string; currentLength: number }
  | { kind: "ceiling"; currentHeight: number }
  | { kind: "appliance"; applianceKind: ApplianceKind; currentWidth: number }
  | {
      kind: "feature"; wallRunId: string; featureId: string;
      currentOffset: number; currentWidth: number;
    }
  | { kind: "province"; currentCode: Province };

/**
 * 一键"确认"用的目标——跟 `editTarget` 是两回事：`editTarget` 是"改成别的
 * 值"（打开输入框重填），`confirmTarget` 是"就按这个已经在展示的值，一键
 * 确认"（不用客户重新输入）。只在 `status` 是 `assumed`（家电推定宽度）或
 * `needs_confirm` 且已有明确建议值（省份账号默认值）时才会带上。
 */
export type ConfirmedFactConfirmTarget =
  | { kind: "appliance"; applianceKind: ApplianceKind; width: number }
  | { kind: "province"; code: Province };

/** 已确认 Tab 用的明确事实行（尺寸/位置等，禁止模糊「已记录」）。 */
export interface ConfirmedFact {
  key: string;
  label: string;
  value: string;
  status: CheckStatus;
  /** 所属分组 id，对应 `sections[].id`——面板按分组渲染这一行。 */
  groupId: string;
  editTarget?: ConfirmedFactEditTarget;
  confirmTarget?: ConfirmedFactConfirmTarget;
}

export interface DesignReadiness {
  items: ReadinessItem[];
  /** 关键项是否都已 ok（或 deferred 且非 critical——critical 不允许 deferred 冒充 ok）。 */
  readyToAskDesign: boolean;
  /**
   * 必备信息（geometry/site/appliances）是否已收完，不含风格/预算/省份。
   * 为 false 时，风格/预算/省份不得进入候选问题池——见 `intake-checklist.ts`。
   */
  requiredIntakeComplete: boolean;
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
  kind: "plumbing" | "window" | "door" | "gas" | "electrical",
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
 * `critical: true` 有两层含义，这里要分开：
 *
 *   1. 挡住 `requiredIntakeComplete`——决定风格/预算/省份能不能问（见
 *      `intake-checklist.ts`）；
 *   2. 挡住 `readyToAskDesign`——决定能不能真的出一版排布。
 *
 * 上下水（`plumbing`）两层都挡：水槽柜必须落在真实上下水位置，排布离不开它。
 * 燃气/强电/岛台不一样：它们决定灶具/冰箱贴哪面墙、要不要留岛台过道，但
 * 排布可以先按常规位置出一版、客户答上来了再局部重排——不必和上下水一样
 * 卡住第一版。所以这三项只挡第 1 层（仍然是"问预算前必须问过的必备项"），
 * 不挡第 2 层。
 */
const DEFERRABLE_BEFORE_DESIGN: ReadonlySet<string> = new Set(["gas", "electrical", "island"]);

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
  // 省份走独立的建议/确认逻辑（见下方"省份"小节），不用这份 intake 判 missing。
  intake = intake.filter((f) => f !== "province");

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

  // —— 燃气接口（接灶具）——
  const hasGas = plan ? featureKind(plan, "gas").length > 0 : false;
  const deferredGas = isDeferGas(req);
  if (hasGas && plan) {
    items.push({
      id: "gas",
      category: "site",
      critical: true,
      status: "ok",
      brief: msg(lang,
        `Gas hookup:\n${describeFeatures(plan, "gas", lang)}`,
        `燃气接口：\n${describeFeatures(plan, "gas", lang)}`),
    });
  } else if (deferredGas) {
    items.push({
      id: "gas",
      category: "site",
      critical: true,
      status: "ok",
      brief: msg(lang,
        "Gas hookup: none — range will run on electric.",
        "燃气接口：没有——灶具走电。"),
    });
  } else {
    items.push({
      id: "gas",
      category: "site",
      critical: true,
      status: "missing",
      brief: msg(lang, "Gas hookup for the range not confirmed.", "接灶具的燃气接口尚未确认。"),
      askHint: msg(lang,
        "Is there a gas line for the range? Which wall, roughly where? Or say \"no gas / electric range\".",
        "有接灶具的燃气接口吗？在哪面墙、大概位置？没有的话可以说「没有燃气，用电」。"),
    });
  }

  // —— 强电接口（接冰箱/烤箱；没有燃气时也接灶具）——
  const hasElectrical = plan ? featureKind(plan, "electrical").length > 0 : false;
  if (hasElectrical && plan) {
    items.push({
      id: "electrical",
      category: "site",
      critical: true,
      status: "ok",
      brief: msg(lang,
        `Electrical hookup:\n${describeFeatures(plan, "electrical", lang)}`,
        `强电接口：\n${describeFeatures(plan, "electrical", lang)}`),
    });
  } else if (isDeferElectrical(req)) {
    items.push({
      id: "electrical",
      category: "site",
      critical: true,
      status: "deferred",
      brief: msg(lang,
        "Electrical hookup: deferred (you said to decide later).",
        "强电接口：已推迟（你说后定）。"),
    });
  } else {
    items.push({
      id: "electrical",
      category: "site",
      critical: true,
      status: "missing",
      brief: msg(lang, "Electrical hookup for fridge/oven not confirmed.", "冰箱/烤箱的强电接口尚未确认。"),
      askHint: deferredGas
        ? msg(lang,
          "Since there's no gas, where's the electrical hookup for the range (and fridge/oven)? Which wall, roughly where?",
          "既然没有燃气，灶具（以及冰箱/烤箱）的强电接口在哪面墙、大概位置？")
        : msg(lang,
          "Where's the electrical hookup for the fridge/oven (usually combined)? Which wall, roughly where?",
          "冰箱/烤箱（通常合并）的强电接口在哪面墙、大概位置？"),
    });
  }

  // —— 岛台空间——是否有位置做岛台，不是所有厨房都有——
  const islandRun = plan?.parsedGeometry.wallRuns.find((r) => isIsland(r));
  if (islandRun) {
    const islandPending = plan!.unresolvedItems.some((u) =>
      !u.resolved && u.target.kind === "wallRun" && u.target.id === islandRun.id);
    const sizeText = islandRun.depth != null
      ? `${islandRun.length}×${islandRun.depth}"`
      : `${islandRun.length}"`;
    items.push({
      id: "island",
      category: "geometry",
      critical: true,
      status: islandRun.length > 0
        ? (islandPending ? "needs_confirm" : "ok")
        : "missing",
      brief: islandRun.length > 0
        ? msg(lang, `Island: ${sizeText}.`, `岛台：${sizeText}。`)
        : msg(lang, "Island: size not confirmed yet.", "岛台：尺寸尚未确认。"),
      ...(islandRun.length > 0 ? {} : {
        askHint: msg(lang,
          "Roughly what size is the island (e.g. \"60x36\")?",
          "岛台大概多大（如「60x36」）？"),
      }),
    });
  } else if (isDeferIsland(req)) {
    items.push({
      id: "island",
      category: "geometry",
      critical: true,
      status: "ok",
      brief: msg(lang, "Island: no room for one.", "岛台：没有空间做岛台。"),
    });
  } else {
    items.push({
      id: "island",
      category: "geometry",
      critical: true,
      status: "missing",
      brief: msg(lang, "Island space not confirmed.", "岛台空间尚未确认。"),
      askHint: msg(lang,
        "Is there room for an island? If so, roughly what size (e.g. \"60x36\")? Or say \"no island\".",
        "有没有位置做岛台？如果有，大概多大（如「60x36」）？没有可以说「不做岛台」。"),
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
        // 冰箱是放不下的其中一台时，给客户一条不改尺寸、不加墙长也能出图的路：
        // 冰箱不一定非得在这面橱柜墙——储藏间/过道放得下的话，说一声就从这面墙的
        // 排布里去掉（见 chat-appliance-answers.ts 的 isFridgeElsewhere）。
        const fridgeNoRoom = fit.warnings.some((w) => w.kind === "refrigerator");
        items.push({
          id: "appliances_fit",
          category: "appliances",
          critical: true,
          status: "missing",
          brief: detail,
          askHint: msg(lang,
            "These appliances need more wall length than you have. Shrink appliance widths, drop an appliance, or give a longer wall" +
              (fridgeNoRoom
                ? " — or if the fridge can go elsewhere (not on this cabinet wall), just say so and we'll leave it out of this wall's layout"
                : "") +
              " — then we can design.",
            "这些家电需要的墙长超过了现有墙段。请改小家电宽度、减少台数，或报更长的墙" +
              (fridgeNoRoom
                ? "——如果冰箱可以不放在这面橱柜墙（比如放在储藏间/过道），直接告诉我们，我们就把它从这面墙的排布里去掉"
                : "") +
              "，否则无法出图。"),
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

  // —— 意图：风格 / 预算 ——
  // FR-15.2：禁止「已记在需求里」——必须写出系统理解到的具体描述。
  const doorStyleName = doorStyleNameFromPrefs(prefs);
  for (const field of ["style", "budget"] as const) {
    const missing = intake.includes(field);
    const fromPref = (field === "budget" && shared.budgetBand !== undefined)
      || (field === "style" && Boolean(doorStyleName));
    const ok = !missing || fromPref;
    const understood = ok
      ? (field === "style" && doorStyleName && missing
        ? msg(lang, `Style: ${doorStyleName}.`, `风格：${doorStyleName}。`)
        : describeIntentField(field, req, shared.budgetBand, lang))
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

  // —— 省份——账号上的省份只是**建议值**（注册必填，不代表客户在这次对话
  // 里确认过），必须客户明确确认/改口（聊天提到，或用已确认面板的下拉框
  // 改过）才算 ok；否则停在 needs_confirm，用建议值顶着继续，但仍要问一句。
  let provinceCurrentCode: Province | undefined;
  {
    const confirmedCode = shared.province;
    const chatHit = matchProvince(req);
    const confirmed = confirmedCode ? provinceByCode(confirmedCode) : chatHit;
    if (confirmed) {
      provinceCurrentCode = (confirmedCode ?? chatHit?.code) as Province | undefined;
      items.push({
        id: "province",
        category: "intent",
        critical: true,
        status: "ok",
        brief: msg(lang, `Province: ${confirmed.en} (${confirmed.code}).`, `省份：${confirmed.zh}（${confirmed.code}）。`),
      });
    } else if (input.accountProvince) {
      provinceCurrentCode = input.accountProvince;
      const suggested = provinceByCode(input.accountProvince);
      items.push({
        id: "province",
        category: "intent",
        critical: true,
        status: "needs_confirm",
        brief: suggested
          ? msg(lang,
            `Province: ${suggested.en} (${suggested.code}) — from your account, not yet confirmed.`,
            `省份：${suggested.zh}（${suggested.code}）——来自账号信息，尚未确认。`)
          : msg(lang, "Province: not yet confirmed.", "省份：尚未确认。"),
        askHint: suggested
          ? msg(lang,
            `Your account has ${suggested.en} (${suggested.code}) on file — is that right, or should I use a different province?`,
            `账号信息里的省份是${suggested.zh}（${suggested.code}）——对吗？不对的话告诉我正确的省份。`)
          : msg(lang, "Please confirm your province.", "请确认所在省份。"),
      });
    } else {
      items.push({
        id: "province",
        category: "intent",
        critical: true,
        status: "missing",
        brief: msg(lang, "Province: not yet.", "省份：尚未确认。"),
        askHint: msg(lang, "Please share your province.", "请补充所在省份。"),
      });
    }
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
    i.critical && !DEFERRABLE_BEFORE_DESIGN.has(i.id)
    && (i.status === "missing" || i.status === "needs_confirm"));
  // deferred / assumed（已接受推定）的关键项不阻断询问出图
  const readyToAskDesign = criticalBlocking.length === 0
    && items.some((i) => i.id === "walls_ceiling" && i.status === "ok");

  const sections = buildSections(items, lang);
  const confirmationText = buildConfirmationText(items, readyToAskDesign, lang);
  const confirmedFacts = buildConfirmedFacts(items, plan, lang, provinceCurrentCode);

  return {
    items, readyToAskDesign, requiredIntakeComplete: requiredIntakeComplete(items),
    openItems, sections, confirmationText, confirmedFacts,
  };
}

/**
 * 每个必备项 id → 所属分组 id。跟 `buildSections` 的 `pick(...)` 分组
 * 是同一份划分，两处都要改的话别漏了另一处。
 */
const ITEM_GROUP: Readonly<Record<string, string>> = {
  walls_ceiling: "space", island: "space",
  plumbing: "site", windows: "site", doors: "site", gas: "site", electrical: "site",
  appliances_kinds: "appliances", appliances_sizes: "appliances", appliances_fit: "appliances",
  style: "intent", budget: "intent", province: "intent",
  seller: "seller",
};

/** 占位行（缺失/待确认时）用的标签——不是完整分组标题，是这一条具体是什么。 */
const PLACEHOLDER_LABEL: Readonly<Record<string, { en: string; zh: string }>> = {
  walls_ceiling: { en: "Wall lengths & ceiling height", zh: "墙长与层高" },
  island: { en: "Island", zh: "岛台" },
  plumbing: { en: "Plumbing", zh: "上下水" },
  windows: { en: "Windows", zh: "窗" },
  doors: { en: "Doors", zh: "门" },
  gas: { en: "Gas hookup", zh: "燃气接口" },
  electrical: { en: "Electrical hookup", zh: "强电接口" },
  appliances_kinds: { en: "Appliances", zh: "家电" },
  style: { en: "Style", zh: "风格" },
  budget: { en: "Budget", zh: "预算" },
  province: { en: "Province", zh: "省份" },
  seller: { en: "Seller", zh: "厂商" },
};

/**
 * `appliances_sizes`/`appliances_fit` 是派生/复合项，不对应单独一段物理
 * 事实——家电存在就已经有逐台的 `appliance:` 行了（尺寸自然带出），家电
 * 不存在则 `appliances_kinds` 的占位行已经说明原因，不用再补一条重复的
 * "没有家电"。
 */
const SKIP_PLACEHOLDER: ReadonlySet<string> = new Set(["appliances_sizes", "appliances_fit"]);

/** 这个必备项是否已经有至少一行原子事实代表它——有的话就不用补占位行。 */
function hasFactFor(facts: readonly ConfirmedFact[], itemId: string, plan: FloorPlan | undefined): boolean {
  switch (itemId) {
    case "walls_ceiling": return facts.some((f) => f.key.startsWith("wall:") || f.key === "ceiling");
    case "island":
      return Boolean(plan?.parsedGeometry.wallRuns.some((r) => isIsland(r)))
        || facts.some((f) => f.key === "island:chat");
    case "plumbing": return facts.some((f) => f.key.startsWith("plumbing:"));
    case "windows": return facts.some((f) => f.key.startsWith("window:"));
    case "doors": return facts.some((f) => f.key.startsWith("door:"));
    case "gas": return facts.some((f) => f.key.startsWith("gas:"));
    case "electrical": return facts.some((f) => f.key.startsWith("electrical:"));
    case "appliances_kinds": return facts.some((f) => f.key.startsWith("appliance:"));
    case "style": return facts.some((f) => f.key === "style");
    case "budget": return facts.some((f) => f.key === "budget");
    case "province": return facts.some((f) => f.key === "province");
    case "seller": return facts.some((f) => f.key === "seller");
    default: return true;
  }
}

/** 把检查项拆成「标签 → 明确值」行，供已确认 Tab 逐条列出。 */
function buildConfirmedFacts(
  items: ReadinessItem[],
  plan: FloorPlan | undefined,
  lang: UiLanguage,
  provinceCurrentCode: Province | undefined,
): ConfirmedFact[] {
  const facts: ConfirmedFact[] = [];
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  if (plan) {
    if (plan.shapeTemplateId) {
      const shapeLabel = SHAPE_SHORT_LABEL[plan.shapeTemplateId];
      if (shapeLabel) {
        facts.push({
          key: "shape",
          label: msg(lang, "Kitchen shape", "户型"),
          value: lang === "zh" ? shapeLabel.zh : shapeLabel.en,
          status: "ok",
          groupId: "space",
        });
      }
    }
    const pending = (pred: (u: FloorPlan["unresolvedItems"][number]) => boolean) =>
      plan.unresolvedItems.some((u) => !u.resolved && pred(u));
    for (const r of plan.parsedGeometry.wallRuns) {
      const kind = isIsland(r)
        ? msg(lang, "Island", "岛台")
        : msg(lang, "Wall", "墙");
      const depth = r.depth != null
        ? msg(lang, `, depth ${r.depth}"`, `，进深 ${r.depth}"`)
        : "";
      const lengthPending = pending((u) =>
        u.target.kind === "wallRun" && u.target.id === r.id && u.field === "length");
      facts.push({
        key: `wall:${r.id}`,
        label: msg(lang, `${kind} ${r.label}`, `${kind} ${r.label}`),
        value: r.length > 0
          ? msg(lang, `${r.length}"${depth}`, `${r.length}"${depth}`)
          : msg(lang, "not set", "未定"),
        status: r.length <= 0 ? "missing" : lengthPending ? "needs_confirm" : "ok",
        groupId: "space",
        editTarget: { kind: "wall", wallRunId: r.id, currentLength: r.length },
      });
    }
    const ceil = plan.parsedGeometry.ceilingHeight;
    const ceilPending = pending((u) => u.field === "ceilingHeight");
    facts.push({
      key: "ceiling",
      label: msg(lang, "Ceiling height", "层高"),
      value: ceil != null ? `${ceil}"` : msg(lang, "not set", "未定"),
      status: ceil == null ? "missing" : ceilPending ? "needs_confirm" : "ok",
      groupId: "space",
      editTarget: { kind: "ceiling", currentHeight: ceil ?? 0 },
    });
    for (const kind of ["plumbing", "window", "door", "gas", "electrical"] as const) {
      for (const { run } of featureKind(plan, kind)) {
        for (const f of run.features.filter((x) => x.kind === kind)) {
          const kindLabel = kind === "plumbing"
            ? msg(lang, "Plumbing", "上下水")
            : kind === "window"
              ? msg(lang, "Window", "窗")
              : kind === "door"
                ? msg(lang, "Door", "门")
                : kind === "gas"
                  ? msg(lang, "Gas", "燃气")
                  : msg(lang, "Electrical", "强电");
          const featPending = pending((u) =>
            (u.target.kind === "feature" && u.target.id === f.id)
            || (u.target.kind === "wallRun" && u.target.id === run.id && u.field.startsWith(`feature.${kind}`)));
          facts.push({
            key: `${kind}:${run.id}:${f.offset}`,
            label: msg(lang, `${kindLabel} on ${run.label}`, `${run.label} · ${kindLabel}`),
            value: msg(lang,
              `offset ${f.offset}", width ${f.width}"`,
              `距起点 ${f.offset}"，宽 ${f.width}"`),
            status: featPending ? "needs_confirm" : "ok",
            groupId: "site",
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
        groupId: "appliances",
        editTarget: { kind: "appliance", applianceKind: a.kind, currentWidth: a.width },
        ...(a.provenance === "assumed"
          ? { confirmTarget: { kind: "appliance", applianceKind: a.kind, width: a.width } }
          : {}),
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
      groupId: ITEM_GROUP[id]!,
      ...(id === "province" && provinceCurrentCode
        ? {
            editTarget: { kind: "province", currentCode: provinceCurrentCode },
            ...(it.status === "needs_confirm"
              ? { confirmTarget: { kind: "province", code: provinceCurrentCode } }
              : {}),
          }
        : {}),
    });
  }

  // 对话已确认/推迟但没有落成一段墙特征时（比如"没有燃气"根本不会有 gas
  // feature），仍要列一行——否则客户明明答过，"已确认"面板里却完全看不到，
  // 显得像没问过。
  const CHAT_ONLY_FACT_ITEMS: {
    id: "plumbing" | "gas" | "electrical" | "island";
    labelEn: string; labelZh: string; stripRe: RegExp;
  }[] = [
    { id: "plumbing", labelEn: "Plumbing", labelZh: "上下水", stripRe: /^(Plumbing|上下水)\s*[：:]\s*/i },
    { id: "gas", labelEn: "Gas hookup", labelZh: "燃气接口", stripRe: /^(Gas hookup|燃气接口)\s*[：:]\s*/i },
    { id: "electrical", labelEn: "Electrical hookup", labelZh: "强电接口", stripRe: /^(Electrical hookup|强电接口)\s*[：:]\s*/i },
    { id: "island", labelEn: "Island", labelZh: "岛台", stripRe: /^(Island|岛台)\s*[：:]\s*/i },
  ];
  const hasIslandWall = Boolean(plan?.parsedGeometry.wallRuns.some((r) => isIsland(r)));
  for (const { id, labelEn, labelZh, stripRe } of CHAT_ONLY_FACT_ITEMS) {
    const it = byId[id];
    if (!it || (it.status !== "ok" && it.status !== "deferred")) continue;
    // island 走的是"墙"这条事实行（isIsland 的 wall run），不是自己的
    // key 前缀——已经有那段墙的话，这里就不用再补一行了。
    if (id === "island" ? hasIslandWall : facts.some((f) => f.key.startsWith(`${id}:`))) continue;
    facts.push({
      key: `${id}:chat`,
      label: msg(lang, labelEn, labelZh),
      value: it.brief.replace(stripRe, ""),
      status: it.status,
      groupId: ITEM_GROUP[id]!,
    });
  }

  // 每个必备项都要"永远有东西可看"：还没有任何原子行代表它的话，补一条
  // 占位行（用 askHint/brief 当 value），面板不用再靠单独一条"还需要"提示
  // 兜底——每一行自己的状态色 + 文案就是完整信息。
  for (const item of items) {
    if (item.status === "ok") continue;
    if (SKIP_PLACEHOLDER.has(item.id)) continue;
    if (hasFactFor(facts, item.id, plan)) continue;
    const label = PLACEHOLDER_LABEL[item.id];
    facts.push({
      key: `${item.id}:placeholder`,
      label: label ? msg(lang, label.en, label.zh) : item.id,
      value: item.askHint ?? item.brief,
      status: item.status,
      groupId: ITEM_GROUP[item.id] ?? "space",
    });
  }

  return facts;
}

/**
 * 分组头——只算聚合状态徽标（供 UI 渲染组标题旁的"已确认/待确认/未讨论"），
 * 不再生成具体数字的叙事文本：那些数字只在 `confirmedFacts`（按同一份
 * `ITEM_GROUP` 分组）里出现一次。
 */
function buildSections(items: ReadinessItem[], lang: UiLanguage): DesignBriefSection[] {
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const pick = (...ids: string[]) => ids.map((id) => byId[id]).filter(Boolean) as ReadinessItem[];

  const space = pick("walls_ceiling", "island");
  const site = pick("plumbing", "windows", "doors", "gas", "electrical");
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
    // （比如上下水已确认、只是窗户还没谈），徽标却说"还没聊"就自相矛盾了。
    // 所以徽标状态单独算，不能直接拿"组里最差的一项"当整组状态用：
    // 一项缺不代表整组没讨论过。
    const untouched = group.every((g) => g.status === "missing");
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
 * 从需求原文抽出客户可见的风格/预算描述。
 * 匹配标准选项时用标准术语；否则用摘录，绝不写「已记在需求里」。
 *
 * 省份不走这里——它的"建议值 vs 客户确认"逻辑在 `evaluateDesignReadiness`
 * 里单独处理（见"省份"小节），不是简单的"从需求文本摘一句"。
 */
export function describeIntentField(
  field: "style" | "budget",
  requirements: string,
  budgetBand: string | undefined,
  lang: UiLanguage,
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
