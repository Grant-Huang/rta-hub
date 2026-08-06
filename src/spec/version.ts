/**
 * 规格版本管理 —— REQUIREMENTS 3.6 第 (1) 条。
 *
 * `ProductSpec` 不是一个可以就地改写的文档，而是一串**不可变版本**：
 *   - 发布后的版本不可修改（改动只能开新草稿）；
 *   - 同一公司同一时刻：published 最多 1 个、draft 最多 1 个；
 *   - 公司 Agent 与定价引擎只读 published 版本。
 *
 * 这同时解决了 3.4 节要求的「草稿/发布两态并存」——单个 status 字段做不到。
 */
import type { ProductSpecVersion, SpecVersionStatus } from "../domain/types.js";

export class SpecVersionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SpecVersionError";
  }
}

/** 同一公司下的版本集合必须满足的不变式。 */
export function assertInvariants(versions: readonly ProductSpecVersion[], companyId: string): void {
  const mine = versions.filter((v) => v.companyId === companyId);
  const published = mine.filter((v) => v.status === "published");
  const drafts = mine.filter((v) => v.status === "draft");
  if (published.length > 1) {
    throw new SpecVersionError(
      `公司 ${companyId} 存在 ${published.length} 个 published 版本，最多允许 1 个`,
      "MULTIPLE_PUBLISHED",
    );
  }
  if (drafts.length > 1) {
    throw new SpecVersionError(
      `公司 ${companyId} 存在 ${drafts.length} 个 draft 版本，最多允许 1 个`,
      "MULTIPLE_DRAFTS",
    );
  }
  const seen = new Set<number>();
  for (const v of mine) {
    if (seen.has(v.versionNo)) {
      throw new SpecVersionError(`公司 ${companyId} 的版本号 ${v.versionNo} 重复`, "DUPLICATE_VERSION_NO");
    }
    seen.add(v.versionNo);
  }
}

export function currentPublished(
  versions: readonly ProductSpecVersion[],
  companyId: string,
): ProductSpecVersion | undefined {
  return versions.find((v) => v.companyId === companyId && v.status === "published");
}

export function currentDraft(
  versions: readonly ProductSpecVersion[],
  companyId: string,
): ProductSpecVersion | undefined {
  return versions.find((v) => v.companyId === companyId && v.status === "draft");
}

export function nextVersionNo(versions: readonly ProductSpecVersion[], companyId: string): number {
  const mine = versions.filter((v) => v.companyId === companyId);
  return mine.reduce((max, v) => Math.max(max, v.versionNo), 0) + 1;
}

export interface PublishResult {
  /** 新发布的版本。 */
  published: ProductSpecVersion;
  /** 被归档的旧版本（若有）。 */
  archived?: ProductSpecVersion;
}

/**
 * 发布一个草稿版本。
 *
 * 语义：草稿 → published；原 published（若有）→ archived 并写上 effectiveTo。
 * 发布是**唯一**能改变 published 版本的动作。
 */
export function publishDraft(
  versions: readonly ProductSpecVersion[],
  companyId: string,
  draftId: string,
  publishedBy: string,
  at: string,
): PublishResult {
  assertInvariants(versions, companyId);

  const draft = versions.find(
    (v) => v.id === draftId && v.companyId === companyId && v.status === "draft",
  );
  if (!draft) {
    throw new SpecVersionError(`未找到公司 ${companyId} 的草稿版本 ${draftId}`, "DRAFT_NOT_FOUND");
  }

  const prev = currentPublished(versions, companyId);
  const published: ProductSpecVersion = {
    ...draft,
    status: "published",
    publishedAt: at,
    publishedBy,
    effectiveFrom: at,
  };
  const archived: ProductSpecVersion | undefined = prev
    ? { ...prev, status: "archived", effectiveTo: at }
    : undefined;

  return { published, archived };
}

/** 已发布/已归档的版本不可修改——这是可追溯性的基础。 */
export function assertMutable(version: ProductSpecVersion): void {
  if (version.status !== "draft") {
    throw new SpecVersionError(
      `版本 ${version.id} 状态为 ${version.status}，已发布或已归档的版本不可修改；请开新草稿`,
      "IMMUTABLE_VERSION",
    );
  }
}

/**
 * 公司的 status 是**派生值**，不作为可独立编辑的字段
 * （REQUIREMENTS 6.2：避免 status 与 billingPlan 两处真相不一致）。
 */
export function deriveCompanyStatus(input: {
  hasPublishedSpec: boolean;
  subscription: "none" | "trial" | "active";
  onboardingStarted: boolean;
  deactivated?: boolean;
}): SpecVersionStatus extends never ? never : "prospect" | "onboarding" | "active" | "inactive" {
  if (input.deactivated) return "inactive";
  const subscribed = input.subscription === "active" || input.subscription === "trial";
  if (input.hasPublishedSpec && subscribed) return "active";
  if (input.onboardingStarted || input.hasPublishedSpec) return "onboarding";
  return "prospect";
}
