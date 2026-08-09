/**
 * 知识层访问控制（L0 / L1 边界）—— FR-16 / FR-22；细则 docs/ACCESS_CONTROL.md。
 *
 * L0 = 平台知识卡 / handbook / overlays；L1 = 按 companyId 的规格与手册（不进本仓储）。
 *
 * 规则：
 *   - consumer / trade / company 运行时：只消费 published 且可注入的 L0 投影；
 *   - 卡实体正文 API：仅 platform_admin（需求侧不能经 API 读 L0 卡正文）；
 *   - draft / confirmed / deprecated：仅 platform_admin；
 *   - L1 不得以 PlatformKnowledgeCard 存在（validate 已拒）；本模块挡管理面。
 */
import type { Principal } from "../auth/principal.js";
import { AccessDeniedError, assertL0Manage, hasCapability } from "../auth/permissions.js";
import type { PlatformKnowledgeCard, PlatformOverlays, SettleTarget } from "./types.js";
import { buildOverlaysFromCards } from "./overlays.js";
import { publishedHandbookCards, renderHandbookForPrompt } from "./handbook.js";
import type { UiLanguage } from "../i18n/language.js";

/** 客户路径可消费的 settleTarget（未 publish 仍不可见）。 */
const RUNTIME_TARGETS: ReadonlySet<SettleTarget> = new Set([
  "handbook",
  "config.appliance",
  "config.layoutHeuristic",
  "config.dialogue",
]);

export function canManageKnowledge(principal: Principal): boolean {
  return hasCapability(principal, "knowledge.l0.manage");
}

export function assertCanManageKnowledge(principal: Principal): void {
  assertL0Manage(principal);
}

/**
 * API / 运营列表：admin 看全部；其他角色空列表（不抛，避免 enumeration 旁路）。
 */
export function listKnowledgeCardsFor(
  principal: Principal,
  cards: readonly PlatformKnowledgeCard[],
): PlatformKnowledgeCard[] {
  if (!canManageKnowledge(principal)) return [];
  return [...cards];
}

/**
 * 单卡读取：非 admin 一律视为不存在。
 */
export function getKnowledgeCardFor(
  principal: Principal,
  cards: readonly PlatformKnowledgeCard[],
  id: string,
): PlatformKnowledgeCard | undefined {
  if (!canManageKnowledge(principal)) return undefined;
  return cards.find((c) => c.id === id);
}

/**
 * 运行时注入用：仅 published + 白名单 settleTarget。
 * 不依赖 Principal.kind——调用方须已确认走客户/公司对话路径；
 * 若误把 admin 草稿塞进来，本过滤仍挡住未发布卡。
 */
export function cardsForRuntimeInjection(
  cards: readonly PlatformKnowledgeCard[],
): PlatformKnowledgeCard[] {
  return cards.filter(
    (c) => c.status === "published" && RUNTIME_TARGETS.has(c.settleTarget),
  );
}

export function overlaysForRuntime(
  cards: readonly PlatformKnowledgeCard[],
): PlatformOverlays {
  return buildOverlaysFromCards(cardsForRuntimeInjection(cards));
}

export function handbookPromptForRuntime(
  cards: readonly PlatformKnowledgeCard[],
  lang: UiLanguage = "en",
  opts?: { scopes?: readonly string[] },
): string {
  return renderHandbookForPrompt(cardsForRuntimeInjection(cards), lang, opts);
}

/** 训练会话：仅 admin。 */
export function assertCanAccessTrainer(principal: Principal): void {
  assertCanManageKnowledge(principal);
}

/**
 * 写卡守卫：非 admin 拒绝；且拒绝把明显 L1 目标伪装成可 publish（reject 卡本身也不该存）。
 */
export function assertCanWriteKnowledgeCard(
  principal: Principal,
  card: Pick<PlatformKnowledgeCard, "settleTarget" | "status">,
): void {
  assertCanManageKnowledge(principal);
  if (card.settleTarget === "reject") {
    throw new AccessDeniedError("Cannot store reject-target cards", "FORBIDDEN");
  }
}

/**
 * 供测试与审计：某主体能否经 API「看见」一张卡的正文。
 * consumer / trade / company 不读卡实体，只消费运行时 handbook/overlay 投影。
 * （可调：公开 FAQ 投影 API，见 ACCESS_CONTROL.md §3.1）
 */
export function canSeeKnowledgeCard(
  principal: Principal,
  _card: PlatformKnowledgeCard,
): boolean {
  return canManageKnowledge(principal);
}

/** 导出：运营专用。 */
export function exportableCards(
  principal: Principal,
  cards: readonly PlatformKnowledgeCard[],
): PlatformKnowledgeCard[] {
  return listKnowledgeCardsFor(principal, cards);
}

/** 便捷：published handbook 列表（与 handbook.ts 一致，但强制经 runtime 过滤）。 */
export function publishedRuntimeHandbook(
  cards: readonly PlatformKnowledgeCard[],
): PlatformKnowledgeCard[] {
  return publishedHandbookCards(cardsForRuntimeInjection(cards));
}
