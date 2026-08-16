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
 * 客户是在问"这是什么样"，不是在报出自己家的答案。
 *
 * 检测要放在"点名户型"识别之前——同一句话如果既提了户型词又带这类词
 * （"U型是什么样子"），是想看示例图，不能当成客户已经确认了 U 型。
 */
const WANTS_EXAMPLE = /不确定|不太确定|不知道|不太懂|看不懂|分不清|什么样|长什么样|举例|例子|参考图|看看图|看图|show me|not sure|don'?t know|what.{0,12}look like|(?:an\s+)?example/i;

export function wantsShapeExample(text: string): boolean {
  return WANTS_EXAMPLE.test(text);
}

/**
 * 这条待确认项是不是"图上真没读出来"，而不是"读到了、按 FR-15.5 例行要你确认一下"。
 *
 * `parse.ts` 的 `wallLengthFromVision` / `ceilingFromVision` / `ingestRawFeature`
 * 无论置信度多高都会挂一条待确认项——这是刻意设计（视觉结果不能自动当成
 * 已确认），但也意味着 `unresolvedItems.length` 本身不能当"这次扫描质量差"的
 * 信号：一间普通厨房光墙长+窗+门+上下水就轻松凑够 3 条，哪怕每个字段都读对了。
 * 真正"读不出来"的信号是：这条待确认项对应的字段在几何里**压根没有值**
 * （墙长仍是 0、层高仍是 undefined、特征没能落成 WallFeature）。
 */
function isGenuinelyUnreadable(plan: FloorPlan, item: FloorPlan["unresolvedItems"][number]): boolean {
  if (item.target.kind === "wallRun" && item.field === "length") {
    const run = plan.parsedGeometry.wallRuns.find((r) => r.id === item.target.id);
    return !run || run.length <= 0;
  }
  if (item.target.kind === "global" && item.field === "ceilingHeight") {
    return plan.parsedGeometry.ceilingHeight == null;
  }
  if (item.target.kind === "feature") return false; // 已经落成具体特征，只是例行确认
  if (item.target.kind === "wallRun") return true; // feature.kind / feature.<kind>.offset：没能落成特征
  return true; // 兜底（如全局 note）：不认识就按"没读出来"算，不静默放过
}

/**
 * 是否建议用户按示例补标注后重新上传。
 *
 * 零墙段 / 抽取失败 / 大量**真读不出来**的项 / 整体置信度很低 时为 true。
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
  const unreadable = pending.filter((u) => isGenuinelyUnreadable(plan, u));
  if (unreadable.length >= REUPLOAD_PENDING_MIN) return true;

  if (
    plan.parseConfidence > 0
    && plan.parseConfidence < 0.5
    && unreadable.length >= 2
  ) {
    return true;
  }

  const wallLenUnreadable = unreadable.filter(
    (u) => u.target.kind === "wallRun" && u.field === "length",
  );
  if (runs.length >= 2 && wallLenUnreadable.length >= runs.length) return true;

  return false;
}

/**
 * 开场欢迎语：先问户型是哪种形状，纯文字回答（Phase 2）。
 *
 * 不再一开场就摆出 5 张缩略图——客户仍然要打字/点文字选项说出户型
 * （"U型"这类），不是点图直接选中；拿不准哪个像可以直接说想看示例图，
 * 系统再按需展示（见 `web/index.html` 的意图识别）。
 */
export function floorplanFirstWelcome(lang: UiLanguage = DEFAULT_LANGUAGE): string {
  return msg(lang,
    "Hi — I'm your cabinet design assistant. Let's start with your kitchen's layout: "
      + "what shape is it — **one-wall, galley, L-shape, L-shape + island, or U-shape**? "
      + "Tell me in a word or two (tap a quick option below, or just type it).\n"
      + "Not sure which one matches? Just say so and I'll show you an example picture — "
      + "you'll still need to tell me which one it is afterward.\n"
      + "You can also upload a floor plan or hand sketch instead — tap +.\n\n"
      + "We'll turn what we get into an editable block diagram to discuss. Style, budget, and province can come next.\n"
      + "For a specific seller, @ the company name.",
    "你好，我是橱柜设计顾问。先说说你家厨房是哪种布局——"
      + "**一字型、走廊型、L型、L型+岛台，还是U型**？"
      + "打字告诉我就行（也可以点下面的快捷选项，或直接打字）。\n"
      + "拿不准哪个像自己家？直接说想看示例图，我发给你看——看完还是要告诉我是哪一种。\n"
      + "也可以改成上传户型图/手绘简图——点 + 上传。\n\n"
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
    /** 卡片列表里显示这个缩略图，不是原图——放大预览才用 url。 */
    thumbUrl: `/samples/${s.thumbFile}`,
    label: lang === "zh" ? s.labelZh : s.labelEn,
    hint: lang === "zh" ? s.hintZh : s.hintEn,
  }));
}
