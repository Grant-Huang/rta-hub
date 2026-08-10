/**
 * 户型图发给客户前的AI审查 —— 确保图与已确认信息对齐。
 *
 * 与 DesignCritic（FR-21）的区别：
 *   - Critic 是运营侧事后评审，本模块是**客户交付前的质量闸门**
 *   - Critic 写 CritiqueReview，本模块直接返回「可发送 / 阻断」
 *   - 本模块检查点：墙名对齐、标注完整性、Q#与会话一致
 */
import type { FloorPlan, WallRun } from "../floorplan/types.js";
import type { SiteQuestion } from "../design/site-questions.js";
import type { Conversation } from "../domain/types.js";
import type { CompletionClient } from "../agents/types.js";
import type { SiteDiagramResult } from "../render/site-diagram.js";
import type { UiLanguage } from "../i18n/language.js";
import { DEFAULT_LANGUAGE, msg } from "../i18n/language.js";

export type SiteDiagramReviewSeverity = "blocking" | "warning" | "info";

export interface SiteDiagramReviewFinding {
  severity: SiteDiagramReviewSeverity;
  code: SiteDiagramReviewCode;
  /** 给运营/开发看的详细信息 */
  detail: string;
  /** 给客户看的提示（仅 warning 和 info） */
  customerMessage?: string;
}

export type SiteDiagramReviewCode =
  | "WALL_LABEL_MISMATCH"      // 图上墙名与会话不一致
  | "MISSING_DIMENSIONS"       // 缺少关键尺寸标注
  | "Q_NUMBER_MISMATCH"        // Q#与siteQuestions不一致
  | "FEATURE_NOT_MARKED"       // 窗/门/水电未标注
  | "CONFIRMED_VS_DIAGRAM"     // 已确认信息与图不符
  | "UNLABELED_WALLS"          // 有墙段无标签
  | "DIAGRAM_GENERATION_FAILED"; // 生成失败

export interface SiteDiagramReviewResult {
  /** 是否可以发给客户 */
  ok: boolean;
  findings: SiteDiagramReviewFinding[];
  /** 阻断项 */
  blockers: SiteDiagramReviewFinding[];
  /** 警告项（可发送，但需显示给客户） */
  warnings: SiteDiagramReviewFinding[];
}

export interface SiteDiagramReviewInput {
  diagram: SiteDiagramResult;
  floorPlan: FloorPlan;
  siteQuestions: readonly SiteQuestion[];
  conversation: Conversation;
  language?: UiLanguage;
  /** 可选AI审查客户端 */
  llm?: CompletionClient;
}

/**
 * 审查户型图是否可以发给客户。
 *
 * 分两层：
 *   1. 确定性检查（必须）
 *   2. AI语义审查（可选，无LLM时跳过）
 */
export async function reviewSiteDiagram(
  input: SiteDiagramReviewInput,
): Promise<SiteDiagramReviewResult> {
  const findings: SiteDiagramReviewFinding[] = [];
  const lang = input.language ?? DEFAULT_LANGUAGE;

  // ── 确定性检查 ──────────────────────────────────────────

  // 1. 墙标签完整性
  const wallRuns = input.floorPlan.parsedGeometry.wallRuns;
  const unlabeled = wallRuns.filter((r) => !r.label || r.label.trim() === "");
  if (unlabeled.length > 0) {
    findings.push({
      severity: "blocking",
      code: "UNLABELED_WALLS",
      detail: `${unlabeled.length} wall(s) have no label: cannot align with customer discussion`,
      customerMessage: msg(lang,
        "Some walls need labels before we can discuss them.",
        "部分墙段缺少标签，无法对齐讨论。"),
    });
  }

  // 2. 图上墙标签与siteQuestions对齐
  const questionWallIds = new Set(
    input.siteQuestions
      .filter((q) => q.wallRunId)
      .map((q) => q.wallRunId!),
  );
  const diagramWallLabels = new Set(input.diagram.wallLabels);
  
  for (const run of wallRuns) {
    if (questionWallIds.has(run.id) && !diagramWallLabels.has(run.label)) {
      findings.push({
        severity: "blocking",
        code: "WALL_LABEL_MISMATCH",
        detail: `Wall ${run.id} (${run.label}) appears in questions but not in diagram`,
        customerMessage: msg(lang,
          `Wall "${run.label}" mentioned in questions but not visible in diagram.`,
          `问题中提到的「${run.label}」墙在图上不可见。`),
      });
    }
  }

  // 3. Q#标注完整性
  const expectedQNumbers = input.siteQuestions.map((q) => `Q${q.q}`);
  const diagramQNumbers = input.diagram.questionMarks;
  
  for (const qNum of expectedQNumbers) {
    if (!diagramQNumbers.includes(qNum)) {
      findings.push({
        severity: "warning",
        code: "Q_NUMBER_MISMATCH",
        detail: `${qNum} in questions but not marked on diagram`,
        customerMessage: msg(lang,
          `Question ${qNum} will be asked but not marked on the diagram.`,
          `问题 ${qNum} 会在会话中提问，但图上未标注。`),
      });
    }
  }

  // 4. 关键尺寸检查
  const hasLengthDim = wallRuns.some((r) => r.length > 0);
  if (!hasLengthDim) {
    findings.push({
      severity: "blocking",
      code: "MISSING_DIMENSIONS",
      detail: "No wall lengths available — cannot generate meaningful diagram",
      customerMessage: msg(lang,
        "We need at least one wall length to draw the layout.",
        "需要至少一段墙长才能绘制布局图。"),
    });
  }

  // 5. 特征标注检查
  const hasFeatures = wallRuns.some((r) => r.features.length > 0);
  const hasQuestionsAboutFeatures = input.siteQuestions.some((q) =>
    q.kind === "plumbing" || q.kind === "window" || q.kind === "door");
  
  if (hasQuestionsAboutFeatures && !hasFeatures) {
    findings.push({
      severity: "info",
      code: "FEATURE_NOT_MARKED",
      detail: "Questions about features (window/door/plumbing) but none marked yet",
      customerMessage: msg(lang,
        "Features will be marked on the diagram once you answer the questions.",
        "回答问题后，窗口、门洞等特征会标注在图上。"),
    });
  }

  // 6. 已确认信息与图的对齐检查
  if (input.conversation.designRequirements) {
    const req = input.conversation.designRequirements.toLowerCase();
    // 检查是否提到了具体墙名但图上找不到
    for (const label of diagramWallLabels) {
      const mentioned = new RegExp(`\\b${label.toLowerCase()}\\b`, "i").test(req);
      if (mentioned) {
        // 好的 - 图与会话一致
      }
    }
    // 反向检查：会话提到的墙名在图上缺失
    for (const run of wallRuns) {
      if (!run.label) continue;
      const mentioned = new RegExp(
        `${run.label.toLowerCase()}\\s*(?:wall|墙)`,
        "i",
      ).test(req);
      if (mentioned && !diagramWallLabels.includes(run.label)) {
        findings.push({
          severity: "warning",
          code: "CONFIRMED_VS_DIAGRAM",
          detail: `Wall "${run.label}" mentioned in requirements but not in diagram labels`,
          customerMessage: msg(lang,
            `The "${run.label}" wall from our discussion should be visible in the diagram.`,
            `讨论中提到的「${run.label}」墙应该在图上可见。`),
        });
      }
    }
  }

  // ── AI语义审查（可选）──────────────────────────────────

  if (input.llm) {
    try {
      const aiFindings = await aiSemanticReview(input, lang);
      findings.push(...aiFindings);
    } catch (err) {
      // AI审查失败不应阻止图的发送，只记录
      findings.push({
        severity: "info",
        code: "DIAGRAM_GENERATION_FAILED",
        detail: `AI review failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── 汇总结果 ────────────────────────────────────────────

  const blockers = findings.filter((f) => f.severity === "blocking");
  const warnings = findings.filter((f) => f.severity === "warning");
  
  return {
    ok: blockers.length === 0,
    findings,
    blockers,
    warnings,
  };
}

/**
 * AI语义审查：检查图与会话内容的深层对齐。
 */
async function aiSemanticReview(
  input: SiteDiagramReviewInput,
  lang: UiLanguage,
): Promise<SiteDiagramReviewFinding[]> {
  const findings: SiteDiagramReviewFinding[] = [];
  
  if (!input.llm) return findings;

  // 构建审查prompt
  const wallLabels = input.diagram.wallLabels.join(", ");
  const qNumbers = input.diagram.questionMarks.join(", ");
  const recentMessages = input.conversation.messages
    .slice(-10)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const prompt = `You are reviewing a site diagram before showing it to the customer.

Diagram info:
- Wall labels: ${wallLabels}
- Q# markers: ${qNumbers}
- SVG length: ${input.diagram.svg.length} chars

Recent conversation:
${recentMessages}

Design requirements summary:
${input.conversation.designRequirements || "(none yet)"}

Check:
1. Are wall labels consistent with what the customer said?
2. Are Q# markers appropriate for unclear items?
3. Is anything the customer explicitly mentioned missing from the diagram?
4. Would showing this diagram now confuse the customer?

Respond in JSON:
{
  "findings": [
    {
      "severity": "blocking" | "warning" | "info",
      "issue": "brief description",
      "reason": "why this matters",
      "customerMessage": "what to tell the customer (if not blocking)"
    }
  ],
  "overallOk": true | false
}`;

  const response = await input.llm.complete({
    systemPrompt: "You are a quality reviewer for architectural diagrams.",
    userMessage: prompt,
    temperature: 0.3,
    maxTokens: 800,
  });

  try {
    const parsed = JSON.parse(response.content);
    
    for (const f of parsed.findings || []) {
      const code: SiteDiagramReviewCode = 
        f.severity === "blocking" ? "CONFIRMED_VS_DIAGRAM" :
        f.issue.toLowerCase().includes("label") ? "WALL_LABEL_MISMATCH" :
        "CONFIRMED_VS_DIAGRAM";
      
      findings.push({
        severity: f.severity || "info",
        code,
        detail: `AI: ${f.issue} — ${f.reason}`,
        customerMessage: f.customerMessage,
      });
    }
  } catch (err) {
    // JSON解析失败，记录但不阻断
    findings.push({
      severity: "info",
      code: "DIAGRAM_GENERATION_FAILED",
      detail: `AI review response parsing failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return findings;
}

/**
 * 确定性（无AI）审查 - 用于测试和无LLM环境。
 */
export function reviewSiteDiagramDeterministic(
  input: Omit<SiteDiagramReviewInput, "llm">,
): SiteDiagramReviewResult {
  return reviewSiteDiagram({ ...input, llm: undefined }) as any;
}
