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
import { importSpecTemplates, type ImportResult, type ImportSources, type UnresolvedItem } from "./import.js";
import type { CompanyOverrides } from "../render/templates.js";
import { assertMutable, nextVersionNo, publishDraft, type PublishResult } from "./version.js";

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
  faceOverrides: CompanyOverrides = {},
): IngestResult {
  if (session.status === "published") {
    throw new OnboardingError("该会话已发布，如需修改请开新草稿", "ALREADY_PUBLISHED");
  }
  const importResult = importSpecTemplates(session.specVersionId, session.companyId, sources, faceOverrides);

  const questions: OnboardingQuestion[] = importResult.unresolved.map((item, i) => ({
    id: newId("q"),
    unresolvedIndex: i,
    prompt: buildPrompt(item),
    answered: false,
  }));

  return {
    session: {
      ...session,
      status: importResult.unresolved.length === 0 ? "ready" : "reviewing",
      unresolved: importResult.unresolved,
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
    case "listPrice":
    case "tradePrice":
      return `${where}：${item.reason}。请提供该型号在这个价格组下的标价（只填数字，如 245.50）。`;
    default:
      return `${where}：${item.reason}。请补充。`;
  }
}

/** 运营回答一个追问，解决对应的待确认项。每次回答计入人工修正次数。 */
export function answerQuestion(
  session: OnboardingSession,
  questionId: string,
  at: string,
): OnboardingSession {
  const questions = session.questions.map((q) =>
    q.id === questionId ? { ...q, answered: true } : q);
  const remaining = questions.filter((q) => !q.answered).length;
  return {
    ...session,
    questions,
    manualCorrections: session.manualCorrections + 1,
    status: remaining === 0 ? "ready" : "reviewing",
    updatedAt: at,
  };
}

/** 直接消解一个待确认项（例如运营在模板里改好后重新导入）。 */
export function resolveUnresolved(session: OnboardingSession, index: number, at: string): OnboardingSession {
  const unresolved = session.unresolved.filter((_, i) => i !== index);
  const questions = session.questions.filter((q) => q.unresolvedIndex !== index);
  return {
    ...session, unresolved, questions,
    manualCorrections: session.manualCorrections + 1,
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
