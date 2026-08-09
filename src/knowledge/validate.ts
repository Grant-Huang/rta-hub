/**
 * 知识卡校验 —— 禁 L1 泄漏、禁削弱硬约束（FR-22）。
 */
import type { PlatformKnowledgeCard, SettleTarget } from "./types.js";

export type ValidateIssue = {
  code:
    | "L1_LEAK"
    | "HARD_CONSTRAINT_OVERRIDE"
    | "MISSING_SETTLE_TARGET"
    | "REJECT_TARGET"
    | "REVIEW_NEEDS_DRAFT"
    | "CONFIG_NEEDS_STRUCTURED"
    | "EMPTY_BODY";
  message: string;
};

/** 厂商前缀 / 价目口吻 —— 不得进 L0。 */
const L1_PATTERNS: RegExp[] = [
  /\bB\d{2}\b/i,
  /\bDB\d{2}\b/i,
  /\b\dDB\d{2}\b/i,
  /\bNW-B\d+/i,
  /\$\s*\d/,
  /\bCAD\s*\d/i,
  /price\s*matrix/i,
  /价格矩阵|报价单上的型号|本公司\s*B\d/i,
  /coding\s*rules?/i,
  /柜型前缀/,
];

/** 试图放宽安全 / sellUnit / 定价硬规则。 */
const HARD_OVERRIDE_PATTERNS: RegExp[] = [
  /取消.{0,8}落台/,
  /不要.{0,8}落台区/,
  /no\s+cooktop\s+landing/i,
  /skip\s+cooktop\s+landing/i,
  /放宽.{0,8}净空/,
  /ignore\s+clearance/i,
  /disable\s+ergonomic/i,
  /关掉.{0,6}人体工程/,
  /允许超墙/,
  /跳过\s*sell\s*unit/i,
  /override\s+price\s+matrix/i,
  /改价格矩阵|伪造价格/,
];

function textBlob(card: Pick<PlatformKnowledgeCard, "title" | "body" | "structured">): string {
  const s = card.structured ? JSON.stringify(card.structured) : "";
  return `${card.title}\n${card.body.en}\n${card.body.zh ?? ""}\n${s}`;
}

export function validateKnowledgeCard(
  card: Pick<PlatformKnowledgeCard, "title" | "body" | "settleTarget" | "structured" | "status">,
): ValidateIssue[] {
  const issues: ValidateIssue[] = [];
  const blob = textBlob(card);

  if (!card.settleTarget) {
    issues.push({ code: "MISSING_SETTLE_TARGET", message: "settleTarget is required" });
  }
  if (card.settleTarget === "reject") {
    issues.push({ code: "REJECT_TARGET", message: "settleTarget reject must not be stored as a card" });
  }
  if (!card.body?.en?.trim()) {
    issues.push({ code: "EMPTY_BODY", message: "body.en is required" });
  }

  for (const re of L1_PATTERNS) {
    if (re.test(blob)) {
      issues.push({
        code: "L1_LEAK",
        message: `Looks like company-specific coding/pricing (matched ${re}). Keep this in L1, not platform trainer.`,
      });
      break;
    }
  }

  for (const re of HARD_OVERRIDE_PATTERNS) {
    if (re.test(blob)) {
      issues.push({
        code: "HARD_CONSTRAINT_OVERRIDE",
        message: `Attempts to weaken a hard constraint (matched ${re}). Rejected.`,
      });
      break;
    }
  }

  if (card.settleTarget === "review.rule") {
    const rr = card.structured?.reviewRule;
    if (!rr?.title?.trim() || !rr.criterion?.trim() || !rr.why?.trim()) {
      issues.push({
        code: "REVIEW_NEEDS_DRAFT",
        message: "review.rule cards need structured.reviewRule with title, criterion, why",
      });
    }
  }

  if (
    card.settleTarget === "config.appliance" ||
    card.settleTarget === "config.layoutHeuristic" ||
    card.settleTarget === "config.dialogue"
  ) {
    const st = card.structured;
    const ok =
      (card.settleTarget === "config.appliance" && st?.applianceDefaults) ||
      (card.settleTarget === "config.layoutHeuristic" &&
        (st?.layoutHeuristic || st?.applianceDefaults?.preferNoCooktopBase != null)) ||
      (card.settleTarget === "config.dialogue" && st?.dialogue);
    if (!ok) {
      issues.push({
        code: "CONFIG_NEEDS_STRUCTURED",
        message: `${card.settleTarget} requires matching structured fields`,
      });
    }
  }

  return issues;
}

/** 训练抽取阶段：文本是否应直接 reject（不建卡）。 */
export function shouldRejectTrainingText(text: string): ValidateIssue | undefined {
  const fake = {
    title: "probe",
    body: { en: text },
    settleTarget: "handbook" as SettleTarget,
    status: "draft" as const,
  };
  const issues = validateKnowledgeCard(fake);
  return issues.find((i) => i.code === "L1_LEAK" || i.code === "HARD_CONSTRAINT_OVERRIDE");
}
