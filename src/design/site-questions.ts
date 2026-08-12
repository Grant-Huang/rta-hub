/**
 * 现场特征题号（Q#）—— FR-19。
 *
 * 在墙对齐简图上标 Q1…，会话里按同一编号提问，避免「南墙 / Wall 1」对不上号。
 * 家电种类/推定宽度也走 Q#，与聊天写回（chat-appliance-answers）对齐，
 * 避免「聊过了但检查表仍待确认」。
 */
import type { FloorPlan, WallRun } from "../floorplan/types.js";
import { chatConfirmedPlumbing, isDeferPlumbing } from "./chat-site-answers.js";
import { assumedOnes, applianceLabel } from "../floorplan/appliances.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

export type SiteQuestionKind =
  | "ceiling"
  | "plumbing"
  | "window"
  | "door"
  | "wall_confirm"
  | "wall_length"
  | "appliance_kinds"
  | "appliance_width";

export interface SiteQuestion {
  /** 展示用编号，从 1 起（Q1）。 */
  q: number;
  id: string;
  kind: SiteQuestionKind;
  /** 关联墙段（层高题可无）。 */
  wallRunId?: string;
  wallLabel?: string;
  /** 会话题干（跟随 UI 语言）。 */
  prompt: string;
  /** 图上短标签（英文，§3.8）。 */
  mark: string;
}

export interface SiteQuestionSet {
  questions: SiteQuestion[];
  /** 解读是否已可用：至少一段墙长 > 0。 */
  geometryUsable: boolean;
  /** 是否仍需手动加墙（零墙段）。 */
  needsManualWalls: boolean;
}

function hasKind(run: WallRun, kind: string): boolean {
  return run.features.some((f) => f.kind === kind);
}

/**
 * 这类特征已经存在，但是不是客户确认的——户型模板预填的门/窗/上下水
 * 会带一条待确认项（FR-17.4），不能因为"已经有了"就当作已经问过。
 */
function pendingFeatureConfirm(plan: FloorPlan, kind: string): boolean {
  return plan.unresolvedItems.some((u) =>
    !u.resolved && u.target.kind === "feature"
    && plan.parsedGeometry.wallRuns.some((r) => r.features.some(
      (f) => f.id === u.target.id && f.kind === kind)));
}

/**
 * 根据户型与需求文案，生成带 Q# 的现场追问。
 *
 * `requirements` 用于识别客户已明文推迟（no windows / plumbing later）。
 */
export function buildSiteQuestions(
  plan: FloorPlan | undefined,
  requirements = "",
  lang: UiLanguage = DEFAULT_LANGUAGE,
): SiteQuestionSet {
  if (!plan) {
    return { questions: [], geometryUsable: false, needsManualWalls: true };
  }

  const runs = plan.parsedGeometry.wallRuns;
  const geometryUsable = runs.some((r) => r.length > 0);
  const needsManualWalls = runs.length === 0;
  const req = requirements;
  const deferPlumbing = isDeferPlumbing(req) || chatConfirmedPlumbing(req);
  const deferWindows = /no windows?|without windows?|没有窗|无窗|这几面墙没有窗|walls? have no windows?/i.test(req);
  const questions: SiteQuestion[] = [];
  let n = 1;

  const add = (
    partial: Omit<SiteQuestion, "q" | "prompt"> & { promptFor: (q: number) => string },
  ) => {
    const q = n++;
    questions.push({
      q,
      id: partial.id,
      kind: partial.kind,
      ...(partial.wallRunId ? { wallRunId: partial.wallRunId } : {}),
      ...(partial.wallLabel ? { wallLabel: partial.wallLabel } : {}),
      prompt: partial.promptFor(q),
      mark: partial.mark,
    });
  };

  if (
    plan.parsedGeometry.ceilingHeight == null
    || plan.unresolvedItems.some((u) => u.field === "ceilingHeight" && !u.resolved)
  ) {
    add({
      id: "sq_ceiling",
      kind: "ceiling",
      mark: "Ceiling?",
      promptFor: (q) => msg(lang,
        `Q${q}: What is the ceiling height in inches? (Reply e.g. "Q${q}: <inches>" or "ceiling <inches>")`,
        `Q${q}: 层高多少英寸？（可直接回「Q${q}: <英寸数>」或「层高 <英寸数>」）`),
    });
  }

  for (const run of runs) {
    const lowConf = plan.unresolvedItems.some(
      (u) => !u.resolved && u.target.kind === "wallRun" && u.target.id === run.id,
    );
    if (lowConf || run.length <= 0) {
      const label = run.label;
      const len = run.length;
      add({
        id: `sq_wall_${run.id}`,
        kind: len <= 0 ? "wall_length" : "wall_confirm",
        wallRunId: run.id,
        wallLabel: label,
        mark: len > 0 ? `${label}?` : `${label} len?`,
        promptFor: (q) => msg(lang,
          `Q${q}: Confirm wall "${label}" length` +
            (len > 0 ? ` (read ~${len}")` : "") + "?",
          `Q${q}: 请确认「${label}」墙长` +
            (len > 0 ? `（读到约 ${len}"）` : "") + "？"),
      });
    }
  }

  if (geometryUsable && !needsManualWalls) {
    const plumbingPending = pendingFeatureConfirm(plan, "plumbing");
    if ((!runs.some((r) => hasKind(r, "plumbing")) && !deferPlumbing) || plumbingPending) {
      add({
        id: "sq_plumbing",
        kind: "plumbing",
        wallRunId: runs[0]?.id,
        wallLabel: runs[0]?.label,
        mark: "Plumbing?",
        promptFor: (q) => msg(lang,
          plumbingPending
            ? `Q${q}: The sink plumbing shown is from the template, not measured yet — does it look about right, or tell me the real wall/offset?`
            : `Q${q}: Where is the sink plumbing (which wall name, roughly how far from a corner)? Or say "plumbing later".`,
          plumbingPending
            ? `Q${q}: 上下水位置是模板预填的，还没实际确认——大致对吗？不对的话告诉我实际墙名和距离。`
            : `Q${q}: 上下水在哪面墙（墙名）、距墙角大概多少？不确定可以说「下水稍后」。`),
      });
    }

    const windowPending = pendingFeatureConfirm(plan, "window");
    if ((!runs.some((r) => hasKind(r, "window")) && !deferWindows) || windowPending) {
      add({
        id: "sq_window",
        kind: "window",
        mark: "Window?",
        promptFor: (q) => msg(lang,
          windowPending
            ? `Q${q}: The window shown is from the template, not measured yet — does it look about right, or tell me the real wall/size?`
            : `Q${q}: Any windows on these walls? Name the wall + rough size, or say "no windows".`,
          windowPending
            ? `Q${q}: 窗户位置是模板预填的，还没实际确认——大致对吗？不对的话告诉我实际墙名和尺寸。`
            : `Q${q}: 这几面墙有窗吗？说出墙名和大概尺寸，或说「没有窗」。`),
      });
    }

    const doorPending = pendingFeatureConfirm(plan, "door");
    if ((!runs.some((r) => hasKind(r, "door")) && !/no doors?|没有门|无门洞/i.test(req)) || doorPending) {
      add({
        id: "sq_door",
        kind: "door",
        mark: "Door?",
        promptFor: (q) => msg(lang,
          doorPending
            ? `Q${q}: The door opening shown is from the template, not measured yet — does it look about right, or tell me the real wall/width?`
            : `Q${q}: Any door openings on these walls? Wall name + width, or say "no door openings".`,
          doorPending
            ? `Q${q}: 门洞位置是模板预填的，还没实际确认——大致对吗？不对的话告诉我实际墙名和宽度。`
            : `Q${q}: 有门洞吗？说出墙名与宽度，或说「没有门洞」。`),
      });
    }
  }

  // 家电：与墙特征一样用 Q# 对齐；尺寸不可后定——不因「家电后定」跳过出题
  const appliances = plan.appliances ?? [];
  // 只认 plan.appliances（与 readiness 同源）；聊天提及但未落库时仍出题，避免空转
  if (appliances.length === 0) {
    add({
      id: "sq_appliance_kinds",
      kind: "appliance_kinds",
      mark: "Appliances?",
      promptFor: (q) => msg(lang,
        `Q${q}: Which appliances will be in this kitchen? `
          + `Give each with width — e.g. \`<appliance> <inches>"\` `
          + `(sizes are required before design).`,
        `Q${q}: 这间厨房有哪些家电？`
          + `请带宽度，例如：\`<家电名称> <英寸数>寸\`（出图前必须明确尺寸）。`),
    });
  } else {
    for (const a of assumedOnes(appliances)) {
      const label = applianceLabel(a.kind, lang);
      add({
        id: `sq_appliance_w_${a.kind}`,
        kind: "appliance_width",
        mark: `${label}?`,
        promptFor: (q) => msg(lang,
          `Q${q}: ${label} width is assumed at ${a.width}". `
            + `Reply with the real width (e.g. "${label} ${a.width}"") `
            + `or say "assumed widths are fine" to confirm those numbers before design.`,
          `Q${q}: ${label}宽度暂按 ${a.width}" 推定。`
            + `请回复实际宽度（如「${label} ${a.width}"」），或说「推定可以」以在出图前确认该数值。`),
      });
    }
  }

  return { questions, geometryUsable, needsManualWalls };
}

/** 户型解读可用时，intake 不应再问尺寸/形状。 */
export function geometrySuppressesIntake(plan: FloorPlan | undefined): boolean {
  if (!plan) return false;
  return plan.parsedGeometry.wallRuns.some((r) => r.length > 0);
}
