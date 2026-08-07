/**
 * 公司入驻规格录入会话 —— FR-2、SCENARIOS 场景 A。
 *
 * 会话状态机：
 *   collecting → (导入/抽取) → reviewing → (清空待确认项) → ready → (发布) → published
 *
 * 硬性约束：
 *   - **待确认项不清空不允许发布**（FR-2 零静默失败）；
 *   - 发布产生**不可变**的 ProductSpecVersion（§3.6），已发布版本不可改；
 *   - 发布 ≠ 可产生 Quote，还需订阅生效（场景 A 第 8 点）。
 */
import type { ProductSpecVersion } from "../domain/types.js";
import type { SpecBundle } from "./bundle.js";
import {
  importSpecTemplates,
  type ImportOptions, type ImportResult, type ImportSources, type UnresolvedItem,
} from "./import.js";
import type { CompanyOverrides } from "../render/templates.js";
import { assertMutable, nextVersionNo, publishDraft, type PublishResult } from "./version.js";
import { capabilityQuestions, type ModuleCapabilities } from "./capabilities.js";

export type OnboardingStatus = "collecting" | "reviewing" | "ready" | "published";

export interface OnboardingSession {
  id: string;
  companyId: string;
  specVersionId: string;
  status: OnboardingStatus;
  unresolved: UnresolvedItem[];
  /** 运营手工修正的次数——FR-2 验收指标之一。 */
  manualCorrections: number;
  startedAt: string;
  updatedAt: string;
  /** 会话里对运营的追问，逐条对应一个待确认项。 */
  questions: OnboardingQuestion[];
}

export interface OnboardingQuestion {
  id: string;
  /** 关联的待确认项索引。 */
  unresolvedIndex: number;
  prompt: string;
  /** 系统给出的候选答案（若有）——但绝不自动采用。 */
  suggestions?: string[];
  answered: boolean;
}

export class OnboardingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "OnboardingError";
  }
}

let seq = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function startSession(companyId: string, at: string, existingVersions: readonly ProductSpecVersion[] = []): {
  session: OnboardingSession;
  draftVersion: ProductSpecVersion;
} {
  const specVersionId = newId("spec");
  const draftVersion: ProductSpecVersion = {
    id: specVersionId,
    companyId,
    versionNo: nextVersionNo(existingVersions, companyId),
    status: "draft",
    currency: "CAD",
    construction: "framed",
    overlay: "full",
    effectiveFrom: at,
  };
  return {
    session: {
      id: newId("ob"), companyId, specVersionId, status: "collecting",
      unresolved: [], manualCorrections: 0, startedAt: at, updatedAt: at, questions: [],
    },
    draftVersion,
  };
}

export interface IngestResult {
  session: OnboardingSession;
  bundle: SpecBundle;
  importResult: ImportResult;
}

/**
 * 导入模板，把待确认项转成会话里的追问。
 *
 * 系统会给候选建议，但**不会自动采用**——这就是「零静默失败」的落点。
 */
export function ingestTemplates(
  session: OnboardingSession,
  sources: ImportSources,
  at: string,
  faceOverridesOrOptions: CompanyOverrides | ImportOptions = {},
): IngestResult {
  if (session.status === "published") {
    throw new OnboardingError("该会话已发布，如需修改请开新草稿", "ALREADY_PUBLISHED");
  }
  const importResult = importSpecTemplates(
    session.specVersionId, session.companyId, sources, faceOverridesOrOptions);

  // 能力标签推不准的，也是待确认项（CATALOG_MODEL §2.2）。
  //
  // 排布算法读的是能力而不是型号码，所以一个把水槽柜误判成普通地柜的规格库，
  // 会让这家公司**每一版**方案的水槽都排错位置——而且不报错，只是一直错。
  // 与脸型匹配不上是同一个量级的问题，所以走同一条队列。
  const capItems: UnresolvedItem[] = capabilityQuestions(importResult.bundle.modules)
    .map((q) => ({
      sheet: "modules" as const,
      rowNumber: 0,
      field: "capabilities",
      reason: q.reason,
      raw: q.moduleCode,
    }));

  const unresolved = [...importResult.unresolved, ...capItems];
  const questions: OnboardingQuestion[] = unresolved.map((item, i) => ({
    id: newId("q"),
    unresolvedIndex: i,
    prompt: buildPrompt(item),
    answered: false,
  }));

  return {
    session: {
      ...session,
      status: unresolved.length === 0 ? "ready" : "reviewing",
      unresolved,
      questions,
      updatedAt: at,
    },
    bundle: importResult.bundle,
    importResult,
  };
}

function buildPrompt(item: UnresolvedItem): string {
  const where = `${item.sheet} 表第 ${item.rowNumber} 行的「${item.field}」`;
  switch (item.field) {
    case "faceTemplate":
      return `${where}：${item.reason}。这个型号在正视图上长什么样？（单门 / 双门 / 一抽一门 / 几个抽屉 / 水槽柜 / 转角…）`;
    case "type":
      return `${where}：${item.reason}。它属于地柜、吊柜、高柜、转角柜还是水槽柜？`;
    case "capabilities":
      return `型号「${item.raw ?? ""}」：${item.reason}。` +
        `它承载什么功能？（门板储物 / 抽屉柜 / 水槽柜 / 灶下柜 / 家电柜 / 转角 / 开放格）` +
        `——排布算法按这个决定它能放在哪，认错了每一版方案都会错。`;
    case "listPrice":
    case "tradePrice":
      return `${where}：${item.reason}。请提供该型号在这个价格组下的标价（只填数字，如 245.50）。`;
    default:
      return `${where}：${item.reason}。请补充。`;
  }
}

/**
 * 回答一条追问要给出的东西。
 *
 * **一条追问必须能被一个具体的值答掉**，否则它就不该出现在这条路径上。
 */
export interface QuestionAnswer {
  /** 脸型题：这个柜子正面长什么样。 */
  faceTemplateId?: string;
  /** 能力题：这个柜子承载什么功能。 */
  roles?: ModuleCapabilities["roles"];
}

export interface AnswerOutcome {
  session: OnboardingSession;
  /** 答案已经落到规格上的整包。**必须存回去**，否则等于没答。 */
  bundle: SpecBundle;
}

/**
 * 运营/商家回答一条追问。
 *
 * ## 为什么答案必须带值
 *
 * 这个函数原来只把 `answered` 翻成 `true`——**它把警报关掉了，但没有补数据**。
 * 结果是：商家点一下"我知道了"，队列清空，发布放行，而那个柜子在正视图上
 * 依然没有脸。零静默失败于是变成了零静默失败的**反面**：一个看起来被处理过、
 * 实际什么也没改的待确认项，比不提示更糟——因为没有人会再回头看它。
 *
 * 所以现在：答案带着值进来，落到规格上，再把那一条从队列里划掉。
 * 答不上来的题（价格写错了、型号漏了）**不走这条路**——那些要在表里改好后
 * 重新导入，函数会明确这么说，而不是给一个"算你答过了"的出口。
 */
export function answerQuestion(
  session: OnboardingSession,
  bundle: SpecBundle,
  questionId: string,
  answer: QuestionAnswer,
  at: string,
): AnswerOutcome {
  const q = session.questions.find((x) => x.id === questionId);
  if (!q) throw new OnboardingError(`没有这条追问：${questionId}`, "QUESTION_NOT_FOUND");
  const item = session.unresolved[q.unresolvedIndex];
  if (!item) throw new OnboardingError("这条追问对应的待确认项已经不在了", "ITEM_GONE");

  // 待确认项记的是型号码（`raw`），不是 id——商家看的是码
  const code = (item.raw ?? "").toUpperCase();
  const target = bundle.modules.find((m) => m.code === code);

  let modules = bundle.modules;
  if (item.field === "faceTemplate") {
    if (!answer.faceTemplateId) {
      throw new OnboardingError(
        "脸型题要给出一个脸型模板（如 F2_DOUBLE_DOOR）", "ANSWER_MISSING_VALUE");
    }
    if (!target) {
      throw new OnboardingError(`规格里找不到型号 ${code}`, "MODULE_NOT_FOUND");
    }
    modules = modules.map((m) =>
      m.code === code ? { ...m, faceTemplateId: answer.faceTemplateId! } : m);
  } else if (item.field === "capabilities") {
    if (!answer.roles?.length) {
      throw new OnboardingError(
        "能力题要给出至少一个角色（如 doorStorage / sinkBase）", "ANSWER_MISSING_VALUE");
    }
    if (!target) {
      throw new OnboardingError(`规格里找不到型号 ${code}`, "MODULE_NOT_FOUND");
    }
    modules = modules.map((m) =>
      m.code === code
        ? { ...m, capabilities: { ...(m.capabilities ?? {}), roles: answer.roles! } }
        : m);
  } else {
    // 没有"算你答过了"的出口
    throw new OnboardingError(
      `「${item.field}」这一条没法在会话里直接答——请在表里改好后重新导入。原因：${item.reason}`,
      "NOT_ANSWERABLE_INLINE",
    );
  }

  // 划掉这一条。索引会变，所以剩下的追问要重新对齐——不重算的话，
  // 下一条答案会落到错误的型号上
  const next = removeUnresolved(
    { ...session, manualCorrections: session.manualCorrections + 1 },
    q.unresolvedIndex, at);
  return { session: next, bundle: { ...bundle, modules } };
}

/**
 * 直接消解一个待确认项。
 *
 * 用在**运营已经在别处把数据补好了**的场合（比如在模板里改好重新导入之前，
 * 先把明知不适用的那几条划掉）。它不补数据，所以不是回答追问的正路——
 * 那条路是 `answerQuestion`，答案带着值。
 */
export function resolveUnresolved(session: OnboardingSession, index: number, at: string): OnboardingSession {
  return removeUnresolved(session, index, at, { countAsCorrection: true });
}

/**
 * 从队列里划掉第 `index` 条，并把剩下追问的索引重新对齐。
 *
 * **索引对齐这件事不能省**：`OnboardingQuestion.unresolvedIndex` 指向数组下标，
 * 删掉中间一条之后，它后面每一条的下标都变了。不重算的话，下一个答案会落到
 * 另一个型号身上——而那种错不会报错，只会让某个柜子悄悄换了脸。
 */
function removeUnresolved(
  session: OnboardingSession,
  index: number,
  at: string,
  opts: { countAsCorrection?: boolean } = {},
): OnboardingSession {
  const unresolved = session.unresolved.filter((_, i) => i !== index);
  const questions = session.questions
    .filter((q) => q.unresolvedIndex !== index)
    .map((q) => (q.unresolvedIndex > index
      ? { ...q, unresolvedIndex: q.unresolvedIndex - 1 } : q));
  return {
    ...session, unresolved, questions,
    manualCorrections: session.manualCorrections + (opts.countAsCorrection ? 1 : 0),
    status: unresolved.length === 0 ? "ready" : "reviewing",
    updatedAt: at,
  };
}

/**
 * 发布前的门禁。
 *
 * 三条都不通过就不允许发布——这是 FR-2「确认后才发布」与「零静默失败」的强制点。
 */
export function assertPublishable(session: OnboardingSession, bundle: SpecBundle): void {
  if (session.unresolved.length > 0) {
    throw new OnboardingError(
      `还有 ${session.unresolved.length} 个待确认项未处理，不能发布`,
      "UNRESOLVED_ITEMS",
    );
  }
  if (bundle.modules.length === 0) {
    throw new OnboardingError("规格里没有任何型号，不能发布", "EMPTY_SPEC");
  }
  const withoutPrice = bundle.modules.filter(
    (m) => !bundle.priceMatrix.some((e) => e.moduleId === m.id),
  );
  if (withoutPrice.length > 0) {
    throw new OnboardingError(
      `以下型号在价格矩阵里没有任何价格条目：${withoutPrice.map((m) => m.code).join(", ")}`,
      "MODULES_WITHOUT_PRICE",
    );
  }
  if (bundle.doorStyles.length === 0) {
    throw new OnboardingError("没有定义任何门板样式（门板决定价格组）", "NO_DOOR_STYLES");
  }
}

export interface PublishOutcome {
  session: OnboardingSession;
  result: PublishResult;
}

/** 发布草稿。产生不可变版本，原 published 转 archived。 */
export function publish(
  session: OnboardingSession,
  bundle: SpecBundle,
  versions: readonly ProductSpecVersion[],
  publishedBy: string,
  at: string,
): PublishOutcome {
  assertPublishable(session, bundle);
  const draft = versions.find((v) => v.id === session.specVersionId);
  if (!draft) throw new OnboardingError(`未找到草稿版本 ${session.specVersionId}`, "DRAFT_NOT_FOUND");
  assertMutable(draft);

  const result = publishDraft(versions, session.companyId, session.specVersionId, publishedBy, at);
  return {
    session: { ...session, status: "published", updatedAt: at },
    result,
  };
}
