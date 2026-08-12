/**
 * 户型采集门控 —— 开场优先问图、低置信建议重传。
 */
import type { FloorPlan } from "./types.js";
import type { ExtractionOutcome } from "./parse.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";
import { INTAKE_SAMPLES } from "../samples/catalog.js";

/** 未解决字段「很多」→ 请重传而不是逐项猜。 */
const REUPLOAD_PENDING_MIN = 3;

/**
 * 是否建议用户按示例补标注后重新上传。
 *
 * 零墙段 / 抽取失败 / 大量 unresolved / 整体置信度很低 时为 true。
 * 视觉未配置（notConfigured）不逼重传——应走手输。
 */
export function shouldSuggestReupload(
  plan: FloorPlan,
  extraction?: ExtractionOutcome,
): boolean {
  if (extraction?.status === "failed" || extraction?.status === "emptyResult") {
    return true;
  }
  const runs = plan.parsedGeometry.wallRuns;
  if (runs.length === 0) return true;

  const pending = plan.unresolvedItems.filter((u) => !u.resolved);
  if (pending.length >= REUPLOAD_PENDING_MIN) return true;

  if (
    plan.parseConfidence > 0
    && plan.parseConfidence < 0.5
    && pending.length >= 2
  ) {
    return true;
  }

  const wallLenPending = pending.filter(
    (u) => u.field === "length" || (u.target.kind === "wallRun" && u.field.includes("length")),
  );
  if (runs.length >= 2 && wallLenPending.length >= runs.length) return true;

  return false;
}

/** 开场欢迎语：先问户型图 / 手绘 / 设计草图。 */
export function floorplanFirstWelcome(lang: UiLanguage = DEFAULT_LANGUAGE): string {
  return msg(lang,
    "Hi — I'm your cabinet design assistant. Let's start with the kitchen site — two equally good ways to begin, pick whichever is faster for you:\n"
      + "1. **Upload a floor plan / hand sketch** — tap + (see the example below for what to mark: wall lengths + openings + ceiling). "
      + "If it matches one of the 5 common layouts, we'll spot that and only ask about what the sketch didn't show clearly.\n"
      + "2. **Or just pick the layout that looks like yours** — tap \"looks like mine\" on one of the 5 layout examples below "
      + "(one-wall / galley / L-shape / L-shape + island / U-shape). No sketching needed — we'll ask for that layout's specific wall lengths next.\n"
      + "Optional: already have a rough design idea (fridge / sink / cooktop)? Upload a sketch too — see the design example.\n\n"
      + "We'll turn what we get into an editable block diagram to discuss. Style, budget, and province can come next.\n"
      + "For a specific seller, @ the company name.",
    "你好，我是橱柜设计顾问。先从厨房现场开始——两种方式同样好用，哪个方便就用哪个：\n"
      + "1. **上传户型图/手绘简图** —— 点 + 上传（下面有示例，标注墙长、开口、层高）。"
      + "如果看起来像 5 种常见布局里的一种，系统会认出来，只追问草图上没读清楚的部分。\n"
      + "2. **或者直接选一个最像自己家的布局** —— 在下面 5 张布局示例上点「我家像这个」"
      + "（单壁型 / 走廊型 / L型 / L型+岛台 / U型）。不用手绘，选完直接问这个布局对应的具体墙长。\n"
      + "可选：已有初步布置想法（冰箱/水槽/灶台）？也可上传设计草图——见设计示例。\n\n"
      + "拿到信息后我会用统一的柜块拼接图复述现场，方便一起改尺寸和布局。风格、预算、省份稍后再聊。\n"
      + "点名某家公司用 @公司名。");
}

/** 重传提示文案。 */
export function reuploadPrompt(lang: UiLanguage = DEFAULT_LANGUAGE): string {
  return msg(lang,
    "Many sizes/features are still unclear. Please annotate clearer lengths and openings "
      + "(see the floor-plan example), then upload again with +. "
      + "Or answer the Q# on the block diagram one by one.",
    "图上仍有不少尺寸/开口我拿不准。请对照户型示例把墙长和开口标清楚后，再点 + 重新上传；"
      + "也可以按块图上的 Q# 逐项确认。");
}

/** 开场示例卡片（给前端画按钮）。 */
export function intakeSampleCards(lang: UiLanguage = DEFAULT_LANGUAGE) {
  return INTAKE_SAMPLES.map((s) => ({
    id: s.id,
    file: s.file,
    role: s.role,
    url: `/samples/${s.file}`,
    label: lang === "zh" ? s.labelZh : s.labelEn,
    hint: lang === "zh" ? s.hintZh : s.hintEn,
  }));
}
