/**
 * 现场特征题号（Q#）—— FR-19。
 *
 * 在墙对齐简图上标 Q1…，会话里按同一编号提问，避免「南墙 / Wall 1」对不上号。
 * 家电种类/推定宽度也走 Q#，与聊天写回（chat-appliance-answers）对齐，
 * 避免「聊过了但检查表仍待确认」。
 */
import type { FloorPlan, WallRun } from "../floorplan/types.js";
import { isIsland } from "../floorplan/types.js";
import { isWallLengthPending } from "../floorplan/parse.js";
import {
  chatConfirmedPlumbing, isDeferElectrical, isDeferGas, isDeferIsland, isDeferPlumbing,
} from "./chat-site-answers.js";
import { assumedOnes, applianceLabel } from "../floorplan/appliances.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

export type SiteQuestionKind =
  | "ceiling"
  | "plumbing"
  | "window"
  | "door"
  | "gas"
  | "electrical"
  | "island"
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
  const deferGas = isDeferGas(req);
  const deferElectrical = isDeferElectrical(req);
  const deferIsland = isDeferIsland(req);
  // 分批出题（不一次甩一屏），分三层优先级：
  //   1. `blockingCandidates`——层高完全未知、或某段墙长度是 0：这是排布
  //      连起点都没有的硬缺口，必须先问，别的问了也没用。
  //   2. `confirmCandidates`——已经有一个值（读到的/模板预填的），只是要
  //      客户扫一眼确认或改一改：墙长确认（`wall_confirm`）跟墙面特征
  //      （上下水/窗/门/燃气/强电/岛台）是同一类"看一眼、对不对"的动作，
  //      不管这个值是模板预填的还是识图读到的，捆成一批一起问，比拆开问
  //      更符合客户"扫一遍现场"的思维，也是本来就有的核对性质。
  //   3. `applianceCandidates`——家电种类/推定宽度，排最后，且现在都走
  //      applianceQuestions 交互卡（server.ts 的 /messages、/resolve 会把
  //      这里生成的家电文字题过滤掉），只有没有交互卡兜底的调用方（比如
  //      上传处理器）才会真的把这一批发给客户看。
  // 每批各自独立编号（Q1 起）；`buildSiteQuestions` 每轮重新计算，答完的
  // 项目下一轮自然从候选集里消失，不需要额外维护"问到第几轮"的状态。
  type Candidate = Omit<SiteQuestion, "q" | "prompt"> & { promptFor: (q: number) => string };
  const blockingCandidates: Candidate[] = [];
  const confirmCandidates: Candidate[] = [];
  const applianceCandidates: Candidate[] = [];

  if (
    plan.parsedGeometry.ceilingHeight == null
    || plan.unresolvedItems.some((u) => u.field === "ceilingHeight" && !u.resolved)
  ) {
    blockingCandidates.push({
      id: "sq_ceiling",
      kind: "ceiling",
      mark: "Ceiling?",
      promptFor: (q) => msg(lang,
        `Q${q}: What is the ceiling height in inches? (e.g. "ceiling 96")`,
        `Q${q}: 层高多少英寸？（如「层高 96」）`),
    });
  }

  for (const run of runs) {
    // 只看长度是否待确认——同一面墙上还没定的门/窗/上下水分类走各自的 Q#，
    // 不该让墙长这题被一起重新问一遍（见 parse.ts 的 isWallLengthPending 注释）。
    if (isWallLengthPending(plan, run.id) || run.length <= 0) {
      const label = run.label;
      const len = run.length;
      // 长度是 0：连基本数字都没有，属于硬缺口；已经有长度但待确认：跟
      // 墙面特征一样是"看一眼对不对"，归进 confirmCandidates。
      (len <= 0 ? blockingCandidates : confirmCandidates).push({
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
      confirmCandidates.push({
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
      confirmCandidates.push({
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
      confirmCandidates.push({
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

    const gasPending = pendingFeatureConfirm(plan, "gas");
    if ((!runs.some((r) => hasKind(r, "gas")) && !deferGas) || gasPending) {
      confirmCandidates.push({
        id: "sq_gas",
        kind: "gas",
        mark: "Gas?",
        promptFor: (q) => msg(lang,
          gasPending
            ? `Q${q}: The gas hookup shown is from the template, not measured yet — does it look about right, or tell me the real wall/position?`
            : `Q${q}: Is there a gas line for the range? Which wall, roughly where? Or say "no gas / electric range".`,
          gasPending
            ? `Q${q}: 燃气接口是模板预填的，还没实际确认——大致对吗？不对的话告诉我实际墙名和位置。`
            : `Q${q}: 有接灶具的燃气接口吗？在哪面墙、大概位置？没有的话可以说「没有燃气，用电」。`),
      });
    }

    const electricalPending = pendingFeatureConfirm(plan, "electrical");
    if ((!runs.some((r) => hasKind(r, "electrical")) && !deferElectrical) || electricalPending) {
      confirmCandidates.push({
        id: "sq_electrical",
        kind: "electrical",
        mark: "Electrical?",
        promptFor: (q) => msg(lang,
          electricalPending
            ? `Q${q}: The electrical hookup shown is from the template, not measured yet — does it look about right, or tell me the real wall/position?`
            : (deferGas
              ? `Q${q}: Since there's no gas, where's the electrical hookup for the range (and fridge/oven)? Which wall, roughly where?`
              : `Q${q}: Where's the electrical hookup for the fridge/oven (usually combined)? Which wall, roughly where?`),
          electricalPending
            ? `Q${q}: 强电接口是模板预填的，还没实际确认——大致对吗？不对的话告诉我实际墙名和位置。`
            : (deferGas
              ? `Q${q}: 既然没有燃气，灶具（以及冰箱/烤箱）的强电接口在哪面墙、大概位置？`
              : `Q${q}: 冰箱/烤箱（通常合并）的强电接口在哪面墙、大概位置？`)),
      });
    }

    if (!runs.some((r) => isIsland(r)) && !deferIsland) {
      confirmCandidates.push({
        id: "sq_island",
        kind: "island",
        mark: "Island?",
        promptFor: (q) => msg(lang,
          `Q${q}: Is there room for an island? If so, roughly what size (e.g. "60x36")? Or say "no island".`,
          `Q${q}: 有没有位置做岛台？如果有，大概多大（如「60x36」）？没有可以说「不做岛台」。`),
      });
    }
  }

  // 家电：与墙特征一样用 Q# 对齐；尺寸不可后定——不因「家电后定」跳过出题
  const appliances = plan.appliances ?? [];
  // 只认 plan.appliances（与 readiness 同源）；聊天提及但未落库时仍出题，避免空转
  if (appliances.length === 0) {
    applianceCandidates.push({
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
      applianceCandidates.push({
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

  const batch = blockingCandidates.length ? blockingCandidates
    : confirmCandidates.length ? confirmCandidates
      : applianceCandidates;
  let n = 1;
  const questions: SiteQuestion[] = batch.map((c) => {
    const q = n++;
    return {
      q,
      id: c.id,
      kind: c.kind,
      ...(c.wallRunId ? { wallRunId: c.wallRunId } : {}),
      ...(c.wallLabel ? { wallLabel: c.wallLabel } : {}),
      prompt: c.promptFor(q),
      mark: c.mark,
    };
  });

  return { questions, geometryUsable, needsManualWalls };
}

/** 户型解读可用时，intake 不应再问尺寸/形状。 */
export function geometrySuppressesIntake(plan: FloorPlan | undefined): boolean {
  if (!plan) return false;
  return plan.parsedGeometry.wallRuns.some((r) => r.length > 0);
}
