/**
 * 出图前评审叙事 —— FR-14 闸门未过时，不把半成品当可预览交付。
 *
 * DesignCritic（FR-21）是运营意见；本模块是客户侧「发现…正在调整…」叙事。
 */
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";
import type { AuditReport } from "./audit.js";

export const MAX_LAYOUT_FIX_ATTEMPTS = 2;

/** 客户可见的调整叙事（映射 SR-*）。 */
export function renderAdjustingNarrative(
  report: AuditReport,
  language: UiLanguage = DEFAULT_LANGUAGE,
  opts?: { attempt?: number; maxAttempts?: number },
): string {
  const lang = language;
  const attempt = opts?.attempt ?? 1;
  const max = opts?.maxAttempts ?? MAX_LAYOUT_FIX_ATTEMPTS;
  const rules = [...new Set(
    report.blockers.map((b) => b.rule).filter((r) => Boolean(r)),
  )] as string[];
  const rulePart = rules.length
    ? rules.join(msg(lang, ", ", "、"))
    : msg(lang, "pre-delivery checks", "交付前检查");
  const findings = report.blockers
    .slice(0, 3)
    .map((b) => b.message)
    .join(msg(lang, "; ", "；"));
  const head = msg(lang,
    `Found issues (${rulePart}) — adjusting the layout (attempt ${attempt}/${max}).`,
    `发现${rulePart}相关问题——正在调整排布（第 ${attempt}/${max} 次）。`);
  if (!findings) return head;
  return `${head} ${msg(lang, `Details: ${findings}`, `详情：${findings}`)}`;
}

/**
 * 未过闸门时是否把 SVG 等半成品交给客户路径。
 * false = 只给叙事 + audit，不给可预览交付图。
 */
export function customerMayPreviewDeliverable(report: AuditReport): boolean {
  return report.ok;
}
