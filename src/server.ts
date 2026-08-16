/**
 * RTA-Hub MVP-1 服务端。
 *
 * 与 v0.3 那版的关键差异（见 REQUIREMENTS 第 10 节）：
 *   - 删除「搜索列表 → 勾选 → 群发询价」这套客户端功能（与 CASL 冲突，FR-12）；
 *   - 全部状态按会话/租户隔离，落到平面文件持久化，不再有模块级全局单例；
 *   - 加了鉴权；
 *   - 发送闸门是服务端状态机，**不接受请求体里的 `confirm` 布尔字段**。
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context, Next } from "hono";

import { fromDollars, format } from "./domain/money.js";
import type {
  CabinetCompany, ChatMessage, CompanyEngagement, CompanyStaffMessage, CompanyStaffThread, Conversation,
  CritiqueStatus, CustomerAccount, ModuleType, Province, Quote, ServiceType,
} from "./domain/types.js";
import type { FloorPlan } from "./floorplan/types.js";
import type { GeneratedLayout } from "./layout/generate.js";
import { TenantScope } from "./tenancy/scoped-repo.js";
import { AccountScope } from "./tenancy/account-scope.js";
import { authorizeCompany, generateCompanyToken } from "./tenancy/company-auth.js";
import {
  adminPrincipal,
  companyPrincipal,
  isDemandSide,
  resolvePrincipal,
  AccessDeniedError,
  assertL1Read,
  assertL1Write,
  type Principal,
} from "./auth/index.js";
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookieHeader,
  clearAccountSessionCookieHeader,
  issueAccountSessionToken,
  resolveAccountSessionConfig,
  startupNoticeForAccountSession,
  verifyAccountSessionToken,
  type AccountSessionConfig,
} from "./auth/session.js";
import { requestLoginCode, verifyLoginCode } from "./auth/email-otp.js";
import {
  isTestAccountLogin, TEST_ACCOUNT_ID, verifyTestAccountPassword,
} from "./auth/password-login.js";
import {
  aggregateSignals, buildMentionSignal, clientFacingMessage, parseMentions, routeByText,
} from "./routing/mention.js";
import {
  buildSendDisclosure, confirm, createQuoteFromLlmOutput, recordSendResult,
  recordServiceConfirmation, recordServiceRequest,
} from "./app/quote-service.js";
import { openDispute, resolveDispute } from "./billing/lead-events.js";
import { quoteContentHash, verifySnapshot } from "./quote/state.js";
import { layoutFace, toSvg } from "./render/face-grammar.js";
import { buildFace, BASE_FACE_HEIGHT, matchFaceTemplate, type FaceTemplateId } from "./render/templates.js";
import {
  companyAgentReply, companyAgentRestateHandoff, fieldLabel, isDesignConsentAffirmation,
  mergeRequirements, missingFields, orchestratorReply,
} from "./agents/orchestrator.js";
import { newTrainerConversation, trainerTurn } from "./agents/trainer.js";
import {
  assertCanAccessTrainer,
  assertCanManageKnowledge,
  assertCanWriteKnowledgeCard,
  buildPromoteChecklist,
  confirmCard,
  deprecateCard,
  appendKnowledgeMetric,
  exportableCards,
  exportKnowledgeMarkdown,
  getKnowledgeCardFor,
  KnowledgeError,
  layoutOptsFromOverlays,
  listKnowledgeCardsFor,
  markSettledInCode,
  patchCard,
  platformKnowledgeRuntime,
  proposeDraftsFromAudit,
  publishCard,
  type PlatformKnowledgeCard,
  applyL1ItemToDraft,
  buildRegressionDashboard,
  confirmL1Item,
  dismissL1Item,
  L1LearnError,
  listL1ForCompany,
  mergeProposedDrafts,
  collectSessionCorrections,
  detectCorrectionFromText,
  proposeFromSessionCorrection,
  scanCompanyL1Signals,
  summarizeL1Queue,
} from "./knowledge/index.js";
import { currentDraft } from "./spec/version.js";
import {
  customerMayPreviewDeliverable, MAX_LAYOUT_FIX_ATTEMPTS, renderAdjustingNarrative,
} from "./delivery/adjusting.js";
import { applyRepairStrategy, repairStrategiesFor } from "./layout/audit-repair.js";
import { buildCabinetIndex } from "./layout/revision-intents.js";
import { quickRepliesFor } from "./agents/quick-replies.js";
import {
  buildEstimateDraft, buildIllustratedEstimate, catalogToPseudoModules, estimateCountsFromText, renderEstimateText,
} from "./estimate/generic.js";
import {
  buildQuoteEmail, buildServiceConfirmationEmail, buildServiceRequestEmail,
  deIdentifySignal, resolveSenderIdentity, sendEmail,
} from "./email/sender.js";
import { buildHtmlQuoteEmail } from "./email/html-quote.js";
import { buildComparison, renderComparisonHtml, renderComparisonText } from "./quote/comparison.js";
import {
  addFeature, addWallRun, createChatSourcedFloorPlan, createFloorPlanWithOutcome, extractionNote,
  interpretationSummary, pendingQuestions, resolveCeilingHeight, resolveItem,
  resolveWallLength, updateFeature,
} from "./floorplan/parse.js";
import {
  applyDesignInput, DesignInputError, exportDesignInput, validateDesignInputDocument,
} from "./floorplan/design-input.js";
import { isLayoutReady, isIsland, type WallFeature } from "./floorplan/types.js";
import { buildSiteQuestions, geometrySuppressesIntake } from "./design/site-questions.js";
import { applyChatSiteAnswers, applyExtractedWalls, chatMentionsGeometry } from "./design/chat-site-answers.js";
import {
  applyChatApplianceAnswers, applyExtractedAppliances, chatMentionsApplianceKinds, isConfirmAssumedAppliances,
} from "./design/chat-appliance-answers.js";
import { extractGeometryFromChat } from "./design/llm-extract.js";
import { justConfirmedNotes } from "./design/confirm-recap.js";
import type { BlockedEdit } from "./design/confirm-lock.js";
import { renderSiteDiagram } from "./render/site-diagram.js";
import { reviewSiteDiagram, type SiteDiagramReviewResult } from "./delivery/site-diagram-review.js";
import { isAllowedSampleFile } from "./samples/catalog.js";
import { floorplanTemplateById, matchKnownShape, SHAPE_WALL_EXPLANATION } from "./samples/templates.js";
import { matchesKnownTemplate, normalizeExtractionWithTemplate } from "./floorplan/template-match.js";
import {
  floorplanFirstWelcome, intakeSampleCards, reuploadPrompt, shouldSuggestReupload, wantsShapeExample,
} from "./floorplan/intake.js";
import { generateLayout, regenerateRun, toSelections } from "./layout/generate.js";
import { planAppliances } from "./layout/appliance-plan.js";
import { formatInches, renderFourViews } from "./render/views.js";
import {
  explainDesign, explainViews, renderRationaleHtml, renderRationaleText,
  renderViewGuideHtml, renderViewGuideText,
} from "./render/explain.js";
import { subscribe, SubscriptionError, unsubscribeByToken } from "./marketing/subscriptions.js";
import {
  deIdentifyBillingEvent, deIdentifyQuote, executeDeletionRequest, executeRetentionSweep,
  exportAccountData, planRetentionSweep,
} from "./privacy/retention.js";
import {
  retentionCronIntervalMs, startRetentionCron, type RetentionCronHandle,
} from "./privacy/retention-cron.js";
import {
  createAppContext, isCompanyActive, pricingContextFor, publishedBundle, renderStyleFor,
  type AppContext,
} from "./app/context.js";
import {
  buildDesignLayout, buildRevision, layoutKey, toGeneratedLayout, toStoredLayout,
} from "./layout/store.js";
import { listProjects, summarizePortfolio } from "./trade/projects.js";
import { interactionProfile } from "./trade/interaction.js";
import { escalationDecision, resolveModelTiers, tierReport } from "./agents/model-tiers.js";
import {
  canSeeTradePricing, effectiveAccountType, looksLikeGstNumber, reviewVerification,
  submitVerification, VerificationError, type TradeVerification,
} from "./trade/verification.js";
import { buildQuotePdf, quoteFilename } from "./pdf/quote-pdf.js";
import {
  approvePlan, backToPlan, deferDrawing, GENERIC_DESIGN_COMPANY_ID, grantDrawingConsent,
  isGenericDesignCompany, markQuoted, markReadyToDraw,
  newSession, recordPlanRevision, stagePrompt, StageError, allowedArtifacts,
  type DesignSession,
} from "./design/stages.js";
import { evaluateDesignReadiness } from "./design/readiness.js";
import { stripIntentFields } from "./design/intake-checklist.js";
import { renderPlanViews } from "./render/plan-view.js";
import { buildBom, bomToSelections } from "./layout/bom.js";
import { buildQuoteList, renderQuoteListHtml, renderQuoteListText } from "./quote/line-items.js";
import { compareFinishes, renderFinishComparison } from "./quote/finish-comparison.js";
import {
  answerQuestion, ingestTemplates, OnboardingError, publish,
  startSession, type OnboardingSession, type QuestionAnswer,
} from "./spec/onboarding.js";
import { blankTemplates, type ImportSources } from "./spec/import.js";
import { parseJsonCatalog, parseXlsxCatalog, type JsonCatalogPayload, type UploadParseResult } from "./spec/catalog-upload.js";
import { parsePdfCatalog, PdfCatalogExtractError } from "./spec/pdf-catalog-extract.js";
import {
  applyStandardDiscountPatch, companyStaffAgentReply, renderNextQuestionPrompt,
} from "./agents/company-staff-agent.js";
import type { CompanyOverrides } from "./render/templates.js";
import { rtaIntro, rtaQuoteNote } from "./quote/rta-disclosure.js";
import {
  DEFAULT_LANGUAGE, detectLanguageSwitch, inferLanguageFromText, languageSwitchAck, msg, resolveLanguage,
  shouldUpdateLanguageFromText,
  type UiLanguage,
} from "./i18n/language.js";
import { BOX_MATERIAL_LABEL_EN } from "./spec/carcass.js";
import { bomReadiness } from "./layout/bom.js";
import {
  applyPreferencesToSelections, buildApplianceQuestions, buildQuestionSet, drawerBiasFor,
  PreferenceError, resolvePreferences, unappliedPreferences, validatePreferences,
  type CustomerPreferences,
} from "./preferences/questions.js";
import {
  applianceFrom, normalizeAppliances, provenanceNote, violationCaveat,
  type ApplianceKind, type ApplianceSpec,
} from "./floorplan/appliances.js";
import { auditDeliverable, renderAuditText, type AuditReport } from "./delivery/audit.js";
import {
  appendOperatorCritiqueMessage, persistDeliveryAudit, runDesignCritique,
} from "./agents/design-critic.js";
import { createCriticLlmClient, createTestLlmClient } from "./agents/llm-client.js";
import {
  allTestPoints, createAppFetch, startAndRunTestSuite, suggestedPointIds,
} from "./testing/index.js";
import {
  critiquesForConversation, findConversationAcrossRuns, listAllSessionRuns,
  listConversationsAcrossRuns, reposForDataDir,
} from "./session/admin-access.js";
import { endSessionRun, touchSessionRunConversation } from "./session/runs.js";
import {
  conversationFullTitle,
  isConversationArchived,
  lifecycleStatus,
  truncateConversationTitle,
} from "./session/conversation-lifecycle.js";
import {
  activeEngagementForCompany,
  appendEngagementMessage,
  confirmedPanels,
  digestFromBriefSections,
  EngagementError,
  findEngagement,
  findEngagementOwnedByAccount,
  listEngagements,
  openEngagement,
  promoteSharedToParent,
  pullSharedFromParent,
  toVendorEngagementDetail,
  toVendorEngagementListItem,
} from "./session/company-engagement.js";
import { openRepositories } from "./store/repositories.js";
import { disputeWindowEndsAt, isWithinDisputeWindow } from "./billing/lead-events.js";
import {
  assertLaunchReady, launchGateReport, launchGateSummary, LaunchGatesNotMet,
} from "./app/launch-gates.js";
import {
  checkPassword, cookieHeader, issueToken, rateLimit, readCookie, resolveSiteGate,
  siteGate, siteGateDisabledExplicitly, SiteGateMisconfigured, startupNotice, unlockPage,
  type SiteGateConfig,
} from "./app/site-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEAD_FEE = fromDollars(process.env.LEAD_FEE_CAD || "45.00");
const now = (): string => new Date().toISOString();

type AppVars = { account: CustomerAccount; principal: Principal };
type Ctx = Context<{ Variables: AppVars }>;

let appCtx: AppContext;
let accountSessionCfg: AccountSessionConfig = { secret: "", ephemeral: true };

/** `c.req.param` 在 strict 下返回 string | undefined；路由已保证存在，统一收口。 */
function param(c: Ctx, name: string): string {
  return c.req.param(name) ?? "";
}

async function jsonBody<T extends object>(c: Ctx): Promise<Partial<T>> {
  try {
    const v = await c.req.json<T>();
    return (v && typeof v === "object" ? v : {}) as Partial<T>;
  } catch {
    return {};
  }
}

const app = new Hono<{ Variables: AppVars }>();

/**
 * 整站访问口令 —— **外层**闸门，挂在所有路由之前。
 *
 * 它把"谁能碰到这个系统"收敛到知道口令的人；但它不是登录态，口令后面的人
 * 仍然可以互相冒充账号。检查清单 E1 依然待办，见 `app/site-gate.ts` 的说明。
 */
let gate: SiteGateConfig = { secret: "", enabled: false };
app.use("*", (c, next) => siteGate(gate)(c, next));

/** 口令校验。限速按来源 IP，挡住字典爆破。 */
app.post("/__unlock", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const limit = rateLimit(ip);
  if (!limit.allowed) {
    return c.html(unlockPage(`Too many attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes.`), 429);
  }

  // 登录页是普通表单提交；同时接受 JSON，便于脚本化测试
  const ct = c.req.header("content-type") ?? "";
  const password = ct.includes("json")
    ? (await jsonBody<{ password: string }>(c as Ctx)).password
    : (await c.req.parseBody())["password"];

  if (!checkPassword(gate, password)) {
    return c.html(unlockPage("Incorrect password."), 401);
  }

  const secure = new URL(c.req.url).protocol === "https:";
  c.header("set-cookie", cookieHeader(issueToken(gate), secure));
  return c.redirect("/", 303);
});

/**
 * 鉴权：`X-Account-Id` → consumer/trade Principal（分身份域）。
 * 模型预留 session/JWT（AuthScheme）；见 docs/ACCESS_CONTROL.md §6。
 * 数据过滤走 AccountScope。
 *
 * 优先级：先看有没有登录态 cookie（`/api/auth/verify-code` 签发，E1 第一步），
 * 有且验证通过就以它为准；没有 cookie 才退回裸头 `X-Account-Id`（不校验，
 * 谁填哪个 id 就读哪个账号）——这条退路是刻意留的向后兼容，company/trade/
 * 脚本化测试都还靠它，不在这次改动范围内。也就是说：这一步只是新增了一条
 * 更可信的路径，没有关掉旧的裸头信任，见 `auth/principal.ts` 模块注释。
 */
async function requireAccount(c: Ctx, next: Next) {
  const sessionToken = readCookie(c.req.header("cookie"), ACCOUNT_SESSION_COOKIE);
  const sessionAccountId = verifyAccountSessionToken(accountSessionCfg, sessionToken);
  const principal = resolvePrincipal({
    scheme: sessionAccountId ? "session" : "header_mvp",
    sessionAccountId,
    accountIdHeader: c.req.header("x-account-id"),
    lookupAccount: (id) => appCtx.repos.accounts.byId(id),
    lookupCompany: () => undefined,
  });
  if (!isDemandSide(principal)) {
    return c.json({ error: "Unauthenticated: sign in or provide account id in X-Account-Id header" }, 401);
  }
  c.set("account", principal.account);
  c.set("principal", principal);
  await next();
}

/** 平台运营端点的最小保护。未配置 ADMIN_TOKEN 时一律拒绝，不留默认口令。 */
async function requireAdmin(c: Ctx, next: Next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || c.req.header("x-admin-token") !== expected) {
    return c.json({ error: "Unauthorized: valid X-Admin-Token required" }, 401);
  }
  c.set("principal", adminPrincipal());
  await next();
}

/**
 * 公司侧端点的鉴权。
 *
 * 关键：**先证明你是这家公司，再按你的身份过滤**。原来只有 `TenantScope` 过滤，
 * 而 companyId 来自 URL——那是拿调用方可控的输入做过滤，等于没有隔离。
 */
async function requireCompany(c: Ctx, next: Next) {
  const companyId = c.req.param("companyId") ?? "";
  const result = authorizeCompany({
    company: appCtx.repos.companies.byId(companyId),
    presented: c.req.header("x-company-token"),
    adminPresented: c.req.header("x-admin-token"),
    adminExpected: process.env.ADMIN_TOKEN,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  c.set("principal", companyPrincipal(companyId, result.via));
  await next();
}

function accountScopeOf(c: Ctx): AccountScope {
  return new AccountScope(c.get("account").id);
}

function ownedConversation(c: Ctx, id: string): Conversation | undefined {
  return accountScopeOf(c).byId(appCtx.repos.conversations.all(), id);
}

const CONVERSATION_ARCHIVED = {
  error: "Conversation is archived; restore it before continuing",
  code: "CONVERSATION_ARCHIVED",
} as const;

/** archived 会话禁止写；返回 Response 表示应直接 return。 */
function rejectIfArchived(c: Ctx, conv: Conversation): Response | null {
  if (!isConversationArchived(conv)) return null;
  return c.json(CONVERSATION_ARCHIVED, 409);
}

function rejectIfPlanConversationArchived(c: Ctx, plan: FloorPlan): Response | null {
  const conv = ownedConversation(c, plan.conversationId);
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  return rejectIfArchived(c, conv);
}

function ownedQuote(c: Ctx, id: string): Quote | undefined {
  return accountScopeOf(c).byId(appCtx.repos.quotes.all(), id);
}

// ── 户型图与方案的持久化访问（MVP-3：从内存 Map 迁到仓储）─────────────────

/** 某个会话当前在用的户型图。同一会话多张时取最近更新的——避免出图读到旧壳/错模板。 */
function planForConversation(conversationId: string): FloorPlan | undefined {
  const plans = appCtx.repos.floorPlans.filter((p) => p.conversationId === conversationId);
  if (plans.length === 0) return undefined;
  return plans.reduce((best, p) => (p.updatedAt >= best.updatedAt ? p : best));
}

/** 注入厂商 Agent：结合实际墙长谈转角柜等，避免空谈型号。 */
function geometryNoteForConversation(
  conversationId: string,
  lang: UiLanguage,
): string | undefined {
  const plan = planForConversation(conversationId);
  const runs = plan?.parsedGeometry.wallRuns.filter((r) => r.length > 0) ?? [];
  if (runs.length === 0) return undefined;
  const walls = runs.map((r) => `${r.label} ${r.length}"`).join(lang === "zh" ? "；" : "; ");
  const ceil = plan?.parsedGeometry.ceilingHeight;
  if (lang === "zh") {
    return `【当前户型几何】墙段：${walls}`
      + (ceil != null ? `；层高 ${ceil}"` : "")
      + "。谈转角柜/懒人转盘/大宽度柜时必须按这些尺寸判断是否放得下，不要脱离墙长空谈。";
  }
  return `[Kitchen geometry] Walls: ${walls}`
    + (ceil != null ? `; ceiling ${ceil}"` : "")
    + ". When discussing corner bases / lazy susans / wide units, judge fit against these lengths — do not advise in the abstract.";
}

function storedLayoutFor(floorPlanId: string, companyId: string): GeneratedLayout | undefined {
  const stored = appCtx.repos.storedLayouts.byId(layoutKey(floorPlanId, companyId));
  return stored ? toGeneratedLayout(stored) : undefined;
}

/**
 * 落盘一次排布结果。
 *
 * 三张表一起写，语义各不相同：
 *   - `StoredLayout`  当前工作态，同一 (户型, 公司) 只有一条，覆盖更新；
 *   - `DesignLayout`  方案标识，承载 specVersionId——报价引用的就是它；
 *   - `DesignRevision` 修订链，**只追加不覆盖**（§3.6），事后能回答
 *     「当时发出去的是哪一版」。
 */
async function persistLayout(input: {
  plan: FloorPlan;
  companyId: string;
  layout: GeneratedLayout;
  triggeredBy: "auto" | "customerRequest";
  changeSummary: string;
}): Promise<{ designLayoutId: string; revisionNo: number }> {
  const { plan, companyId, layout } = input;
  const at = now();
  const key = layoutKey(plan.id, companyId);
  const existing = appCtx.repos.storedLayouts.byId(key);

  const company = appCtx.repos.companies.byId(companyId);
  const specVersionId = company?.currentPublishedSpecVersionId ?? "";
  const designLayoutId = existing?.designLayoutId ?? `dl_${randomUUID().slice(0, 8)}`;
  const revisionNo = (existing?.currentRevisionNo ?? 0) + 1;

  await appCtx.repos.designLayouts.upsert(buildDesignLayout({
    id: designLayoutId,
    companyId,
    conversationId: plan.conversationId,
    specVersionId,
    floorPlanId: plan.id,
    revisionNo,
  }));
  await appCtx.repos.designRevisions.insert(buildRevision({
    designLayoutId, revisionNo, layout,
    triggeredBy: input.triggeredBy,
    changeSummary: input.changeSummary,
    at,
  }));
  await appCtx.repos.storedLayouts.upsert(toStoredLayout({
    floorPlanId: plan.id,
    companyId,
    conversationId: plan.conversationId,
    designLayoutId,
    revisionNo,
    layout,
    at,
    ...(existing ? { createdAt: existing.createdAt } : {}),
  }));

  return { designLayoutId, revisionNo };
}

/** 会话下已存排布（工作态），按更新时间新→旧。 */
function storedLayoutsForConversation(conversationId: string) {
  return appCtx.repos.storedLayouts
    .filter((l) => l.conversationId === conversationId)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * 打开会话时还原输出物用的快照。
 * 排布已在 `storedLayouts`；SVG 不单独落盘，这里按 placements 重渲染。
 */
function deliverablesForConversation(
  conversationId: string,
  preferredCompanyId?: string,
) {
  const plan = planForConversation(conversationId);
  if (!plan) return null;
  const session = appCtx.repos.designSessions.byId(conversationId);
  const all = storedLayoutsForConversation(conversationId);
  if (all.length === 0) return null;

  const want = (preferredCompanyId || session?.companyId || "").trim();
  const stored = (want ? all.find((l) => l.companyId === want) : undefined) ?? all[0]!;
  const layout = toGeneratedLayout(stored);
  const generic = isGenericDesignCompany(stored.companyId);
  const conv = appCtx.repos.conversations.byId(conversationId);
  const lang = resolveLanguage(conv?.preferences?.shared);
  const stage = session?.stage ?? "planReview";
  const planViews = renderPlanViews(plan.parsedGeometry, layout.placements);
  const canFour = !generic && allowedArtifacts(stage).fourViews;

  const base = {
    kind: canFour ? "fourViews" as const : "planView" as const,
    restored: true as const,
    generic,
    companyId: generic ? null : stored.companyId,
    designLayoutId: stored.designLayoutId,
    revisionNo: stored.currentRevisionNo,
    stage,
    planViews,
    moduleCounts: layout.moduleCounts,
    acceptable: layout.acceptable,
    ergonomics: layout.ergonomics,
    aesthetics: layout.aesthetics,
    warnings: layout.warnings,
  };

  if (!canFour || !conv) return base;

  const prefs = prefsFor(conv, stored.companyId);
  return {
    ...base,
    views: viewsFor(plan, layout, stored.companyId),
    explanation: explanationFor(plan, layout, stored.companyId, prefs, lang),
    cabinetIndex: buildCabinetIndex(layout.placements),
  };
}

function verificationFor(accountId: string): TradeVerification | undefined {
  return appCtx.repos.tradeVerifications.byId(accountId);
}

// ── 设计会话阶段（先问再画 → 全局俯视图评审 → 完整图纸）─────────────────

async function sessionFor(conversationId: string, companyId: string): Promise<DesignSession> {
  const existing = appCtx.repos.designSessions.byId(conversationId);
  // 换了公司就重开一段设计进程——排布是绑定公司规格库的（含 __generic__ ↔ 真厂）
  let session = existing && existing.companyId === companyId
    ? existing
    : newSession({ conversationId, companyId, at: now() });

  // 资料齐了就推进到「该问客户了」。
  // 通用哨兵不传公司 id 给就绪检查（seller 非关键，避免伪公司名污染 brief）。
  const readinessCompanyId = isGenericDesignCompany(companyId) ? undefined : companyId;
  if (session.stage === "collecting" && isReadyToDraw(conversationId, readinessCompanyId)) {
    session = markReadyToDraw(session, now());
  }
  return appCtx.repos.designSessions.upsert(session);
}

/**
 * 能不能开始问「要不要出图」。
 *
 * 以 FR-15 内部检查表为准：墙长齐 + 关键现场/意图项齐（不能猜上下水、家电等）。
 * 齐了只推进到 `readyToDraw`（文字确认 + 问一句），**不会**自动出图。
 */
function isReadyToDraw(conversationId: string, companyId?: string): boolean {
  return designReadinessFor(conversationId, companyId).readyToAskDesign;
}

/** FR-22：把已发布平台知识沉淀进排布选项。 */
function layoutKnowledgeOpts() {
  return layoutOptsFromOverlays(
    platformKnowledgeRuntime(appCtx.repos.knowledgeCards.all()).overlays,
  );
}

/** 账号注册时必填的省份（定价用）——设计 intake 不必再靠聊天正则重新确认一遍。 */
function accountProvinceFor(customerAccountId: string): Province | undefined {
  return appCtx.repos.accounts.byId(customerAccountId)?.province;
}

function designReadinessFor(conversationId: string, companyId?: string) {
  const conv = appCtx.repos.conversations.byId(conversationId);
  if (!conv) {
    return evaluateDesignReadiness({
      conversation: {
        id: conversationId, customerAccountId: "", messages: [],
        designRequirements: "", perCompanyThreads: [], createdAt: now(),
      },
      plan: undefined,
      language: DEFAULT_LANGUAGE,
    });
  }
  const plan = planForConversation(conversationId);
  const co = companyId ? appCtx.repos.companies.byId(companyId) : undefined;
  return evaluateDesignReadiness({
    conversation: conv,
    plan,
    ...(companyId ? { companyId } : {}),
    ...(co ? { companyName: co.name } : {}),
    language: resolveLanguage(conv.preferences?.shared),
    accountProvince: accountProvinceFor(conv.customerAccountId),
  });
}

/**
 * 设计前还缺哪些 intake 字段（编排/快捷回答用）。
 * 现场类缺口改走检查表 openItems。
 * FR-17：户型解读可用后不再要尺寸/形状快捷回答。
 */
function intakeMissing(conversationId: string): string[] {
  const conv = appCtx.repos.conversations.byId(conversationId);
  let missing = missingFields(conv?.designRequirements ?? "");
  const plan = planForConversation(conversationId);
  if (geometrySuppressesIntake(plan) || (plan && isLayoutReady(plan))) {
    missing = missing.filter((f) => f !== "kitchen size" && f !== "layout");
  }
  // 已选门板 = 风格已答（偏好与 intake 对齐，避免再弹风格 chip）
  const by = conv?.preferences?.byCompany;
  if (by && Object.values(by).some((c) => c?.doorStyleId)) {
    missing = missing.filter((f) => f !== "style");
  }
  return missing;
}

/** 本轮新答上的 intake 字段 → 会话反馈文案（FR-17.3）。 */
function answeredFieldFeedback(
  before: string,
  after: string,
  lang: UiLanguage,
): { field: string; note: string }[] {
  const was = new Set(missingFields(before));
  const now = new Set(missingFields(after));
  const gained = [...was].filter((f) => !now.has(f));
  return gained.map((field) => ({
    field,
    note: msg(lang,
      `Got it — ${fieldLabel(field, "en")}.`,
      `记下了——${fieldLabel(field, "zh")}。`),
  }));
}

/**
 * 打包 designBrief + 现场文字 Q#（默认不附图）。
 * 提问改纯文字：避免每轮把户型草图再贴一遍，造成「机械复述」。
 * 
 * **新增（用户需求）：发给客户前AI审查siteDiagram**
 */
async function briefingPayload(
  conversationId: string,
  companyId?: string,
  opts?: { includeSiteDiagram?: boolean },
) {
  const readiness = designReadinessFor(conversationId, companyId);
  const conv = appCtx.repos.conversations.byId(conversationId);
  const plan = planForConversation(conversationId);
  const lang = conv ? resolveLanguage(conv.preferences?.shared) : DEFAULT_LANGUAGE;
  const site = buildSiteQuestions(plan, conv?.designRequirements ?? "", lang);
  
  let diagram: ReturnType<typeof renderSiteDiagram> | undefined;
  let diagramReview: SiteDiagramReviewResult | undefined;
  
  if (opts?.includeSiteDiagram && plan && conv) {
    diagram = renderSiteDiagram(plan.parsedGeometry, site.questions);
    
    // **AI审查 - 发给客户前的质量闸门**
    try {
      diagramReview = await reviewSiteDiagram({
        diagram,
        floorPlan: plan,
        siteQuestions: site.questions,
        conversation: conv,
        language: lang,
        llm: appCtx.llm, // 使用配置的LLM客户端
      });
      
      // 如果审查不通过，不发送图，但保留警告信息供前端显示
      if (!diagramReview.ok) {
        diagram = undefined;
      }
    } catch (err) {
      // 审查失败时记录但不阻止（避免审查机制本身成为单点故障）
      console.warn(
        `[siteDiagram] Review failed for ${conversationId}:`,
        err instanceof Error ? err.message : String(err),
      );
      // 审查失败时允许发送图，但标记为未审查
      diagramReview = {
        ok: true,
        findings: [{
          severity: "info",
          code: "DIAGRAM_GENERATION_FAILED",
          detail: `Review process failed: ${err instanceof Error ? err.message : String(err)}`,
        }],
        blockers: [],
        warnings: [],
      };
    }
  }
  
  return {
    designBrief: {
      sections: readiness.sections,
      readyToAskDesign: readiness.readyToAskDesign,
      openItems: readiness.openItems.map((i) => ({
        id: i.id, status: i.status, brief: i.brief, askHint: i.askHint,
      })),
      confirmationText: readiness.confirmationText,
      confirmedFacts: readiness.confirmedFacts,
    },
    siteQuestions: site.questions,
    geometryUsable: site.geometryUsable,
    needsManualWalls: site.needsManualWalls,
    floorPlanId: plan?.id ?? null,
    floorPlanReady: plan ? isLayoutReady(plan) : false,
    ...(diagram ? { 
      siteDiagram: { 
        svg: diagram.svg, 
        wallLabels: diagram.wallLabels,
        // 附带审查结果供前端显示警告
        reviewPassed: diagramReview?.ok ?? true,
        reviewWarnings: diagramReview?.warnings.map((w) => w.customerMessage).filter(Boolean),
      } 
    } : {}),
    // 审查阻断时，提供阻断原因
    ...(diagramReview && !diagramReview.ok ? {
      siteDiagramBlocked: {
        reason: diagramReview.blockers.map((b) => b.customerMessage || b.detail).join("; "),
        blockers: diagramReview.blockers.map((b) => ({
          code: b.code,
          message: b.customerMessage || b.detail,
        })),
      },
    } : {}),
  };
}

/** 该公司的踢脚做法。缺省整体底座；`plasticLegs` 时物料清单里会出现地脚。 */
function toeKickSystemFor(companyId: string) {
  const company = appCtx.repos.companies.byId(companyId);
  const version = company?.currentPublishedSpecVersionId
    ? appCtx.repos.specVersions.byId(company.currentPublishedSpecVersionId)
    : undefined;
  return version?.toeKickSystem ?? "plywoodPanel";
}

/** 完整 BOM —— 柜体 + 填缝条 + 踢脚/地脚 + 收口板，缺料如实报出。 */
function bomFor(
  plan: FloorPlan,
  layout: GeneratedLayout,
  companyId: string,
  language: UiLanguage = DEFAULT_LANGUAGE,
) {
  const bundle = publishedBundle(appCtx, companyId);
  return buildBom({
    layout,
    wallRuns: plan.parsedGeometry.wallRuns,
    modules: bundle?.modules ?? [],
    toeKickSystem: toeKickSystemFor(companyId),
    language,
  });
}

/**
 * 家电相关的两句话：推定值说明，以及硬约束否决时的注脚。
 *
 * 两者分开，因为用途不同：前者任何时候都该说（客户要知道图是按什么尺寸画的），
 * 后者**只在方案被否决时**才有意义——「你的厨房排不下」和
 * 「按我们猜的尺寸排不下」对客户是完全不同的两句话。
 */
function applianceNotes(plan: FloorPlan, acceptable: boolean, language = DEFAULT_LANGUAGE): {
  applianceProvenance?: string;
  ergonomicsCaveat?: string;
} {
  const list = plan.appliances ?? [];
  if (list.length === 0) return {};
  const note = provenanceNote(list, language);
  const caveat = acceptable ? undefined : violationCaveat(list, language);
  return {
    ...(note ? { applianceProvenance: note } : {}),
    ...(caveat ? { ergonomicsCaveat: caveat } : {}),
  };
}

/**
 * 把要交给客户的文字拼成一段，供交付前审核核对「该说的话真的说了」。
 *
 * 只检查数据字段是不够的：`provenance: "assumed"` 存在数据里，
 * 但客户读到的是文字——两者可能脱节，而脱节的那一次正是出事的那一次。
 */
function customerText(
  explanation: { viewGuideText?: string; perRun?: { text: string }[] } | undefined,
  notes: { applianceProvenance?: string; ergonomicsCaveat?: string },
  extra: string[] = [],
): string {
  return [
    explanation?.viewGuideText ?? "",
    ...(explanation?.perRun ?? []).map((p) => p.text),
    notes.applianceProvenance ?? "",
    notes.ergonomicsCaveat ?? "",
    ...extra,
  ].join("\n");
}

/** 合成某会话在某公司下的偏好（跨公司项 + 该公司项）。 */
function prefsFor(conv: Conversation, companyId: string): CustomerPreferences {
  return resolvePreferences(
    conv.preferences?.shared,
    conv.preferences?.byCompany?.[companyId],
  );
}

/**
 * 把一轮俯视图修改落到偏好上。
 *
 * 和 `/preferences` 走**同一套校验**——修改排布时能改的东西，不该比第一次
 * 回答选择题时能选的东西更宽松；否则会出现"问卷里没有的取值从这个口子进来"。
 *
 * 返回真正改到的键名，让上层能如实告诉客户哪几条被采纳了。
 */
async function applyRevision(
  conversationId: string,
  companyId: string,
  changes: Partial<CustomerPreferences>,
): Promise<{ keys: string[]; error?: string }> {
  const conv = appCtx.repos.conversations.byId(conversationId);
  if (!conv) return { keys: [], error: "Conversation not found" };
  const bundle = publishedBundle(appCtx, companyId);

  let split;
  try {
    split = validatePreferences(changes, bundle);
  } catch (e) {
    if (e instanceof PreferenceError) return { keys: [], error: e.message };
    throw e;
  }
  const keys = [...Object.keys(split.shared), ...Object.keys(split.company)];
  if (keys.length === 0) return { keys };

  const prev = conv.preferences ?? {};
  const byCompany = { ...(prev.byCompany ?? {}) };
  if (Object.keys(split.company).length > 0) {
    byCompany[companyId] = { ...(byCompany[companyId] ?? {}), ...split.company };
  }
  const nextShared = { ...(prev.shared ?? {}), ...split.shared };
  if (split.shared.layoutHints) {
    nextShared.layoutHints = {
      ...(prev.shared?.layoutHints ?? {}),
      ...split.shared.layoutHints,
    };
  }

  // 岛台加长写回户型几何——审核与排布读同一份长度，避免「排了 96"、审核按 84"」
  const boost = split.shared.layoutHints?.enlargeIslandInches;
  if (boost && boost > 0) {
    const plan = planForConversation(conversationId);
    if (plan) {
      let next = plan;
      for (const run of plan.parsedGeometry.wallRuns) {
        if (!isIsland(run)) continue;
        next = resolveWallLength(next, run.id, run.length + boost, now());
      }
      if (next !== plan) await appCtx.repos.floorPlans.upsert(next);
    }
    // 已落到几何，避免 generate 再加一次
    if (nextShared.layoutHints) {
      const { enlargeIslandInches: _drop, ...rest } = nextShared.layoutHints;
      nextShared.layoutHints = rest;
      if (!keys.includes("layoutHints")) keys.push("layoutHints");
      if (!keys.includes("enlargeIslandInches")) keys.push("enlargeIslandInches");
    }
  }

  await appCtx.repos.conversations.update(conv.id, {
    preferences: { shared: nextShared, byCompany },
  });
  return { keys };
}

/** 地柜层总长度——预算区间的锚点。没有户型图时返回 undefined，不硬编一个数。 */
function baseRunInches(conversationId: string): number | undefined {
  const plan = planForConversation(conversationId);
  if (!plan) return undefined;
  const total = plan.parsedGeometry.wallRuns.reduce((sum, r) => sum + r.length, 0);
  return total > 0 ? total : undefined;
}

// ── 基础 ──────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true }));

/** 开场示例图（户型极简 / 设计草图）——白名单文件。 */
app.get("/samples/:name", (c) => {
  const name = param(c, "name");
  if (!isAllowedSampleFile(name)) return c.json({ error: "Sample not found" }, 404);
  const file = path.join(__dirname, "samples", name);
  if (!existsSync(file)) return c.json({ error: "Sample not found" }, 404);
  const lower = name.toLowerCase();
  const mime = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg"
    : lower.endsWith(".svg") ? "image/svg+xml"
      : "image/png";
  c.header("cache-control", "public, max-age=3600");
  return c.body(readFileSync(file), 200, { "content-type": mime });
});

// ── 账号登录（E1 第一步：邮箱验证码，见 auth/session.ts + auth/email-otp.ts）──

/** 发登录验证码。不区分邮箱是否已注册——第一次验证成功即建号，见 /verify-code。 */
app.post("/api/auth/request-code", async (c) => {
  const body = await jsonBody<{ email: string }>(c);
  const email = (body.email || "").trim();
  if (!email || !email.includes("@")) {
    return c.json({ error: "Valid email required" }, 400);
  }
  const result = requestLoginCode(email);
  if (!result.ok) {
    return c.json(
      { error: "Too many attempts, try again later", retryAfterSec: result.retryAfterSec },
      429,
    );
  }
  const sender = resolveSenderIdentity();
  const sendResult = await sendEmail({
    kind: "auth_code",
    to: email,
    subject: `Your RTA-Hub sign-in code: ${result.code}`,
    text: `Your sign-in code is ${result.code}. It expires in 10 minutes.\n`
      + `If you didn't request this, you can ignore this email.\n\n— ${sender.name}`,
  }, { sender });
  // 未配置 SMTP 时是 dry-run，没有真的发信——本地/联调环境把码带在响应里，
  // 不然开发者永远拿不到验证码。生产环境必须配 SMTP，否则等于没有登录入口。
  return c.json({
    ok: true,
    ...(sendResult.dryRun
      ? { devCode: result.code, note: "SMTP not configured: dry-run, code returned for local testing only" }
      : {}),
  });
});

/** 校验验证码；通过则签发账号会话 cookie（找不到该邮箱的账号就新建一个）。 */
app.post("/api/auth/verify-code", async (c) => {
  const body = await jsonBody<{ email: string; code: string }>(c);
  const email = (body.email || "").trim();
  const code = (body.code || "").trim();
  if (!email || !code) return c.json({ error: "Email and code required" }, 400);

  const verify = verifyLoginCode(email, code);
  if (!verify.ok) {
    const status = verify.reason === "rate_limited" ? 429 : 401;
    return c.json({ error: "Invalid or expired code", reason: verify.reason }, status);
  }

  const normalized = email.toLowerCase();
  let account = appCtx.repos.accounts.find((a) => a.email.toLowerCase() === normalized);
  if (!account) {
    account = await appCtx.repos.accounts.insert({
      id: `ca_${randomUUID().slice(0, 8)}`,
      accountType: "consumer",
      email,
      displayName: email.split("@")[0] || email,
      // 定价必需字段，注册时还不知道——给个默认值，后续在 /me 里改；
      // 报价用的省份走会话内确认的那份，不是这里（两者是分开的字段）。
      province: "ON",
      consentRecords: [{ termsVersion: appCtx.termsVersion, consentedAt: now(), channel: "email_login" }],
    });
  }

  const token = issueAccountSessionToken(accountSessionCfg, account.id);
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("set-cookie", accountSessionCookieHeader(token, secure));
  return c.json({
    ok: true,
    account: { id: account.id, email: account.email, displayName: account.displayName },
  });
});

/**
 * 测试账号口令登录：用户名 `test` / 邮箱 `test@rta-hub.local`，默认口令 Grant123。
 * 签发与验证码登录同一套会话 cookie。
 */
app.post("/api/auth/login", async (c) => {
  const body = await jsonBody<{ login?: string; email?: string; password?: string }>(c);
  const login = (body.login || body.email || "").trim();
  const password = body.password ?? "";
  if (!login || !password) {
    return c.json({ error: "Login and password required" }, 400);
  }
  if (!isTestAccountLogin(login) || !verifyTestAccountPassword(password)) {
    return c.json({ error: "Invalid login or password" }, 401);
  }
  const account = appCtx.repos.accounts.byId(TEST_ACCOUNT_ID);
  if (!account) {
    return c.json({ error: "Test account is not seeded" }, 500);
  }
  const token = issueAccountSessionToken(accountSessionCfg, account.id);
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("set-cookie", accountSessionCookieHeader(token, secure));
  return c.json({
    ok: true,
    account: { id: account.id, email: account.email, displayName: account.displayName },
  });
});

app.post("/api/auth/logout", (c) => {
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("set-cookie", clearAccountSessionCookieHeader(secure));
  return c.json({ ok: true });
});

/** 前端开场用来判断"这个浏览器已经登录了吗"。没有/过期一律返回 account: null，不报错。 */
app.get("/api/auth/me", (c) => {
  const token = readCookie(c.req.header("cookie"), ACCOUNT_SESSION_COOKIE);
  const accountId = verifyAccountSessionToken(accountSessionCfg, token);
  const account = accountId ? appCtx.repos.accounts.byId(accountId) : undefined;
  if (!account) return c.json({ account: null });
  return c.json({
    account: {
      id: account.id, email: account.email, displayName: account.displayName,
      accountType: account.accountType,
    },
  });
});

app.get("/", (c) => c.html(readFileSync(path.join(__dirname, "../web/index.html"), "utf-8")));
app.get("/me", (c) => {
  const file = path.join(__dirname, "../web/me.html");
  if (!existsSync(file)) {
    return c.html(
      "<!doctype html><meta charset=utf-8><title>Me</title><p>Loading…</p>",
      404,
    );
  }
  return c.html(readFileSync(file, "utf-8"));
});

/** 厂商工作台入口（从 /me 链入；页内用 Company/Admin Token）。 */
app.get("/company/:companyId", (c) => {
  const file = path.join(__dirname, "../web/company.html");
  if (!existsSync(file)) {
    return c.html(
      "<!doctype html><meta charset=utf-8><title>Company</title><p>Company console not found.</p>",
      404,
    );
  }
  return c.html(readFileSync(file, "utf-8"));
});
app.get("/admin", (c) =>
  c.html(readFileSync(path.join(__dirname, "../web/admin-review.html"), "utf-8")));
app.get("/admin/trainer", (c) => {
  const file = path.join(__dirname, "../web/admin-trainer.html");
  if (!existsSync(file)) {
    return c.html(
      "<!doctype html><meta charset=utf-8><title>Trainer</title>"
      + "<p>Platform Trainer UI is not available yet. DesignCritic review: <a href=/admin>/admin</a>. "
      + "See docs/SYSTEM_TRAINER_AGENT.md.</p>"
      + "<p lang=zh-CN>系统训练助手 UI 尚未落地。DesignCritic 评审见 <a href=/admin>/admin</a>。"
      + "设计见 docs/SYSTEM_TRAINER_AGENT.md。</p>",
      404,
    );
  }
  return c.html(readFileSync(file, "utf-8"));
});
app.get("/admin/l1-learn", (c) =>
  c.html(readFileSync(path.join(__dirname, "../web/admin-l1-learn.html"), "utf-8")));
app.get("/admin/regression", (c) =>
  c.html(readFileSync(path.join(__dirname, "../web/admin-regression.html"), "utf-8")));
app.get("/admin/test-user", (c) =>
  c.html(readFileSync(path.join(__dirname, "../web/admin-test-user.html"), "utf-8")));
app.get("/ui-i18n.js", (c) => {
  c.header("content-type", "application/javascript; charset=utf-8");
  return c.body(readFileSync(path.join(__dirname, "../web/ui-i18n.js"), "utf-8"));
});

/** @openai/apps-sdk-ui 图标桥接产物（web-ui `npm run build` → web/vendor/apps-sdk-ui）。 */
app.get("/vendor/apps-sdk-ui/*", (c) => {
  const rel = c.req.path.replace(/^\/vendor\/apps-sdk-ui\//, "");
  if (!rel || rel.includes("..")) return c.text("Not found", 404);
  const file = path.join(__dirname, "../web/vendor/apps-sdk-ui", rel);
  if (!existsSync(file)) return c.text("Not found — run npm run build:ui", 404);
  const ext = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
  };
  c.header("content-type", types[ext] || "application/octet-stream");
  c.header("cache-control", "public, max-age=3600");
  return c.body(readFileSync(file));
});

// ── 公司目录（只暴露客户可见信息，不暴露订阅/计费状态）────────────────────

app.get("/api/companies", (c) =>
  c.json({
    companies: appCtx.repos.companies.filter(isCompanyActive).map((co) => ({
      id: co.id, name: co.name, aliases: co.aliases, serviceAreas: co.serviceAreas,
    })),
  }));

app.get("/api/companies/:id/spec", (c) => {
  const co = appCtx.repos.companies.byId(param(c, "id"));
  if (!co || !isCompanyActive(co)) return c.json({ error: "Company not found or unavailable" }, 404);
  const bundle = publishedBundle(appCtx, co.id);
  if (!bundle) return c.json({ error: "Company has no published catalog" }, 404);
  return c.json({
    company: { id: co.id, name: co.name },
    doorStyles: bundle.doorStyles.map((d) => ({ id: d.id, name: d.name, priceGroupId: d.priceGroupId })),
    boxMaterials: (bundle.boxMaterialOptions ?? []).map((m) => ({
      id: m.id, name: m.name, code: m.code,
    })),
    modules: bundle.modules.map((m) => ({
      id: m.id, code: m.code, type: m.type,
      widthOptions: m.widthOptions, heightOptions: m.heightOptions, depthOptions: m.depthOptions,
      faceTemplateId: m.faceTemplateId,
    })),
    hardwareOptions: bundle.hardwareOptions.map((h) => ({ id: h.id, name: h.name })),
    accessoryOptions: bundle.accessoryOptions.map((a) => ({ id: a.id, name: a.name })),
  });
});

// ── 对话：确定性 @ 路由 + Agent 应答 ──────────────────────────────────────

app.post("/api/conversations", requireAccount, async (c) => {
  const body = await jsonBody<{ tags?: string[] }>(c);
  const conv: Conversation = {
    id: `cv_${randomUUID().slice(0, 8)}`,
    customerAccountId: c.get("account").id,
    messages: [], designRequirements: "", perCompanyThreads: [],
    createdAt: now(),
    status: "active",
    origin: appCtx.origin,
    runId: appCtx.runId,
    ...(body.tags?.length ? { tags: body.tags } : {}),
  };
  await appCtx.repos.conversations.insert(conv);
  await touchSessionRunConversation(appCtx.repos, appCtx.runId, conv.id);
  return c.json({ conversation: conv }, 201);
});

/** Critic 优先用独立 reasoning/VL；未配时回落生产 llm。 */
function criticLlmOrFallback() {
  return createCriticLlmClient() ?? appCtx.llm;
}

/** 里程碑后跑 DesignCritic（同步 MVP；失败不挡客户响应）。 */
async function maybeRunCritique(
  conversationId: string,
  trigger: Parameters<typeof runDesignCritique>[0]["trigger"],
): Promise<void> {
  try {
    const openCritiqueCount = appCtx.repos.critiqueReviews
      .filter((r) => r.status === "open").length;
    await runDesignCritique({
      repos: appCtx.repos,
      conversationId,
      trigger,
      llm: criticLlmOrFallback(),
      runStats: {
        conversationCount: appCtx.repos.conversations.all().length,
        openCritiqueCount,
      },
    });
  } catch (e) {
    console.warn(`[design-critic] ${trigger} failed:`, e instanceof Error ? e.message : e);
  }
}

async function recordAuditAndCritique(opts: {
  conversationId: string;
  deliverable: "planView" | "fourViews" | "quoteList";
  audit: AuditReport;
  trigger: Parameters<typeof runDesignCritique>[0]["trigger"];
  designLayoutId?: string;
  quoteId?: string;
}): Promise<void> {
  await persistDeliveryAudit(appCtx.repos, {
    conversationId: opts.conversationId,
    deliverable: opts.deliverable,
    ok: opts.audit.ok,
    findings: opts.audit.findings.map((f) => ({
      code: f.code,
      severity: f.severity,
      message: f.message,
      ...(f.rule ? { rule: f.rule } : {}),
    })),
    checked: opts.audit.checked,
    at: now(),
    ...(opts.designLayoutId ? { designLayoutId: opts.designLayoutId } : {}),
    ...(opts.quoteId ? { quoteId: opts.quoteId } : {}),
  });
  if (!opts.audit.ok) {
    appendKnowledgeMetric(appCtx.dataDir, {
      type: "audit_blocking",
      conversationId: opts.conversationId,
      count: opts.audit.blockers.length,
      detail: opts.deliverable,
    });
    // P1：自动提议 draft 候选卡，绝不 publish
    const drafts = proposeDraftsFromAudit({
      audit: opts.audit,
      conversationId: opts.conversationId,
    });
    for (const d of drafts) {
      const existing = appCtx.repos.knowledgeCards.byId(d.id);
      if (!existing) {
        await appCtx.repos.knowledgeCards.insert(d);
        appendKnowledgeMetric(appCtx.dataDir, {
          type: "draft_proposed",
          conversationId: opts.conversationId,
          detail: d.title,
        });
      }
    }
  }
  // 无论闸门是否放行都跑 Critic——失败项正是运营最该看见的
  await maybeRunCritique(opts.conversationId, opts.trigger);
}

app.post("/api/conversations/:id/messages", requireAccount, async (c) => {
  const account = c.get("account");
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;

  const body = await jsonBody<{ text: string }>(c);
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ error: "text is required" }, 400);

  const at = now();
  const messages: ChatMessage[] = [...conv.messages, { role: "user", content: text, at }];
  const routing = { companies: appCtx.repos.companies.all(), isActive: isCompanyActive };

  // 语言：明确切换优先；否则按客户话术主体语言跟随（中文对话→中文回复）。
  // 短英文尺寸/封口句不翻转已建立的中文会话。交付说明跟会话语言。
  let language: UiLanguage = resolveLanguage(conv.preferences?.shared);
  const switched = detectLanguageSwitch(text);
  const inferred = switched ?? inferLanguageFromText(text);
  let prefsPatch = conv.preferences;
  if (shouldUpdateLanguageFromText(language, inferred, text, Boolean(switched))) {
    language = inferred!;
    const prev = conv.preferences ?? {};
    prefsPatch = {
      ...prev,
      shared: { ...(prev.shared ?? {}), language },
    };
  }

  const routed: { companyId: string; companyName: string }[] = [];
  const notices: string[] = [];
  const replies: ChatMessage[] = [];
  const perCompanyThreads = conv.perCompanyThreads.map((t) => ({ ...t, messages: [...t.messages] }));
  // 客户明确要求看户型示例图时才有值（Phase 2）——不再一开场就常驻展示。
  let showcaseSamples: ReturnType<typeof intakeSampleCards> | undefined;

  // 仅「明确切换」时回一句确认；整段中文自然跟随时不打断
  if (switched) {
    replies.push({ role: "assistant", content: languageSwitchAck(language), at });
  }

  const mentions = parseMentions(text);
  for (const raw of mentions) {
    const outcome = routeByText(routing, raw);
    if (outcome.kind === "routed") {
      const bundle = publishedBundle(appCtx, outcome.company.id);
      if (!bundle) continue;
      routed.push({ companyId: outcome.company.id, companyName: outcome.company.name });

      let thread = perCompanyThreads.find((t) => t.companyId === outcome.company.id);
      if (!thread) {
        thread = { companyId: outcome.company.id, messages: [] };
        perCompanyThreads.push(thread);
      }
      const history = thread.messages.map(toHistory);
      thread.messages.push({ role: "user", content: text, companyId: outcome.company.id, at });

      // 公司 Agent：上下文里只有这家公司的 published 规格 + CodingRules
      const specVer = appCtx.repos.specVersions.byId(bundle.id);
      try {
        const reply = await companyAgentReply(appCtx.llm, outcome.company.name, bundle,
          {
            conversationId: conv.id,
            requirements: conv.designRequirements,
            history,
            geometryNote: geometryNoteForConversation(conv.id, language),
          }, text, language,
          specVer?.codingRules);
        const assistantMsg: ChatMessage = { role: "assistant", content: reply.content, companyId: outcome.company.id, at };
        thread.messages.push(assistantMsg);
        replies.push(assistantMsg);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const fail = language === "zh"
          ? `（${outcome.company.name}）刚才连接超时：${detail.slice(0, 80)}。请再试一次。`
          : `(${outcome.company.name}) timed out: ${detail.slice(0, 80)}. Please try again.`;
        const assistantMsg: ChatMessage = { role: "assistant", content: fail, companyId: outcome.company.id, at };
        thread.messages.push(assistantMsg);
        replies.push(assistantMsg);
      }
    } else {
      notices.push(clientFacingMessage(outcome, language));
      await appCtx.repos.mentionSignals.insert(buildMentionSignal(outcome, {
        conversationId: conv.id, customerAccountId: account.id,
        prospects: appCtx.repos.prospects.all(), at,
      }));
    }
  }

  let designRequirements = conv.designRequirements;

  // 本轮"刚记下"的具体数字（弱确认复述用）——在下面的块里算出来，
  // 块结束后传给 orchestratorReply 的 intakeStatus。
  let justConfirmedThisTurn: string[] = [];

  // 对话确认 Q# / 现场特征 / 家电 → 写入 FloorPlan
  // （无图时也要建壳；助手复述里的墙长/「推定可以」也要从历史回填，否则 Confirmed 空）
  {
    const priorReq = conv.designRequirements ?? "";
    const historyBlob = conv.messages
      .slice(-24)
      .map((m) => m.content)
      .filter((s) => Boolean(s?.trim()))
      .join("\n");
    const combined = [priorReq, historyBlob, text].filter((s) => s.trim()).join("\n");
    // 只给"会真正写入 FloorPlan 的正则解析"看客户自己说过的话——`combined`/
    // `historyBlob` 不分角色，助手上一轮举的例子（"比如：主墙15'…"/"比如冰箱
    // 33寸、灶具30寸"）混进去会被正则当成客户刚报的数据，写成"已确认"；等
    // 客户真的照着回答，反而被当成在改一个从没确认过的值（确认锁误触发）。
    // LLM 抽取路径（下面 extractGeometryFromChat）早就用按角色区分的 turns
    // 避开了这个坑，这里给两条会写数据的正则路径（`applyChatSiteAnswers`、
    // `applyChatApplianceAnswers`）补上同样的隔离。`needShell`/`buildSiteQuestions`
    // 不写数据，且前者依赖"从历史（含助手复述）回填"的既有行为，不动它们。
    const customerOnlyCombined = [
      priorReq,
      conv.messages
        .slice(-24)
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .filter((s) => Boolean(s?.trim()))
        .join("\n"),
      text,
    ].filter((s) => s.trim()).join("\n");
    let planChat = planForConversation(conv.id);
    // 开场第一问是"你家是哪种布局"，纯文字回答（Phase 2）。客户拿不准时可以
    // 直接说想看示例图（"不确定"/"什么样"/"show me" 一类）——检测优先于下面
    // 的"点名户型"识别：同一句话如果既提了户型词又带"什么样/举例"这类词，
    // 是在问"这是什么样"，不是在报出自己家的答案，不能当成确认。
    if (!planChat && wantsShapeExample(text)) {
      const namedShapeId = matchKnownShape(text);
      const toShow = namedShapeId
        ? intakeSampleCards(language).filter((s) => s.id === namedShapeId)
        : intakeSampleCards(language).filter((s) => s.role === "floorplan");
      showcaseSamples = toShow;
      replies.push({
        role: "assistant",
        content: msg(language,
          "Here's what that looks like — take a look, then tell me which shape matches your kitchen.",
          "示例图在下面——看完告诉我哪一种像你家的户型。"),
        at,
      });
    } else if (!planChat) {
      // 开场第一问是"你家是哪种布局"，纯文字回答（Phase 2）：客户直接打字点名
      // 已知户型（"U型"/"走廊型"…）时，套用该户型的标准墙壳——跟点按钮选模板走
      // 同一份逻辑（`applyFloorplanTemplate`），只是入口从点击换成了打字。
      // 只在**还没有户型**时识别，不然客户后面聊天里随口提一句"我朋友家是U型的"
      // 也会被当成要重置几何。
      const shapeId = matchKnownShape(text);
      if (shapeId) {
        const applied = await applyFloorplanTemplate(conv, shapeId, language, at);
        if (applied) {
          planChat = applied.plan;
          replies.push({ role: "assistant", content: applied.interpretation, at });
        }
      }
    }
    const needShell = !planChat && (
      chatMentionsGeometry(combined)
      || chatMentionsApplianceKinds(combined)
      || isConfirmAssumedAppliances(combined)
    );
    if (needShell) {
      planChat = createChatSourcedFloorPlan(conv.id, at);
      await appCtx.repos.floorPlans.upsert(planChat);
    }
    // 本轮开始前的快照——用来算"这一轮到底新记下了什么"（弱确认复述），
    // 不是全量已确认清单（那个用 confirmedBriefs，下面已经在用）。
    const planBeforeThisTurn = planChat;
    // 本轮被"确认锁"拦下的修改尝试——不管是 LLM 抽取还是正则解析触发的，
    // 都汇总到这一份列表里，用于下面推一句委婉拒绝+引导去已确认面板改。
    const blockedEditsThisTurn: BlockedEdit[] = [];
    if (planChat) {
      // LLM 结构化解析先"抢答"墙长/层高/家电——喂给它的是按角色打行标的
      // 干净记录（CUSTOMER/ASSISTANT），不是下面 combined 那种把历史文本整段
      // 拼起来的东西，这正是为了不让助手自己的举例/警告文案被当成数据
      // （见 llm-extract.ts 头部注释的根因说明）。没配 LLM、或抽取失败/
      // 返回不合法时，extractGeometryFromChat 原样返回 undefined，照旧退回
      // 下面的正则解析——两条路径共用同一把"确认锁"（confirm-lock.ts），
      // 已确认的字段谁都不能覆盖。
      if (appCtx.llm) {
        const turns = [...conv.messages.slice(-24).map(toHistory), { role: "user" as const, content: text }];
        const extracted = await extractGeometryFromChat(appCtx.llm, turns);
        if (extracted) {
          if (extracted.wallRuns.length > 0 || extracted.ceilingHeightInches !== undefined) {
            planChat = applyExtractedWalls(
              planChat, extracted.wallRuns, extracted.ceilingHeightInches, at, blockedEditsThisTurn,
            );
            await appCtx.repos.floorPlans.upsert(planChat);
          }
          if (extracted.appliances.length > 0 || extracted.confirmAssumedAppliances) {
            planChat = applyExtractedAppliances(
              planChat, extracted.appliances, extracted.confirmAssumedAppliances, blockedEditsThisTurn,
            );
            await appCtx.repos.floorPlans.upsert(planChat);
          }
        }
      }

      const siteQs = buildSiteQuestions(planChat, combined, language).questions;
      const siteApply = applyChatSiteAnswers(planChat, customerOnlyCombined, at, siteQs);
      if (siteApply) {
        await appCtx.repos.floorPlans.upsert(siteApply.plan);
        planChat = siteApply.plan;
        blockedEditsThisTurn.push(...siteApply.blockedEdits);
      }
      // 用累计文本：历史里客户说过的「assumed widths are fine」也能在本轮落库；
      // 用 customerOnlyCombined 而不是 combined——原因同上一句 applyChatSiteAnswers：
      // 助手自己举的家电宽度例子（"比如冰箱33寸、灶具30寸"）不能被当成客户确认过。
      const appApply = applyChatApplianceAnswers(planChat, customerOnlyCombined);
      if (appApply) {
        await appCtx.repos.floorPlans.upsert(appApply.plan);
        planChat = appApply.plan;
        blockedEditsThisTurn.push(...appApply.blockedEdits);
      }
      // 客户想在对话里改一个已经确认过的数字——委婉拒绝，引导去"已确认"
      // 面板手动改，不静默套用、也不假装没看见这次修改尝试。
      if (blockedEditsThisTurn.length > 0) {
        const lines = blockedEditsThisTurn.map((b) => language === "zh"
          ? `${b.label}：已确认为 ${b.current}"，暂时没法在对话里直接改成 ${b.attempted}"`
          : `${b.label}: already confirmed at ${b.current}", can't change it to ${b.attempted}" here`);
        replies.push({
          role: "assistant",
          content: (language === "zh"
            ? "这几项已经确认过了，对话里没法直接改：\n"
            : "These are already confirmed and can't be changed in chat:\n")
            + lines.join("\n")
            + (language === "zh"
              ? "\n如果确实要改，请到右边「已确认」面板里手动修改。"
              : "\nIf you really need to change it, please edit it directly in the Confirmed panel on the right."),
          at,
        });
      }
      // 墙长 + 家电一旦齐：立刻报空间不足（禁止「收齐再拒绝」）
      if (planChat) {
        const fitAsk = evaluateDesignReadiness({
          conversation: { ...conv, designRequirements: priorReq },
          plan: planChat,
          language,
          accountProvince: account.province,
        }).items.find((i) => i.id === "appliances_fit" && i.status === "missing");
        if (fitAsk) {
          const already = [...conv.messages, ...replies]
            .slice(-6)
            .some((m) => m.role === "assistant" && /放不下|too tight|need more wall|墙长超过|空间不够|Space check/i.test(m.content));
          if (!already) {
            const head = language === "zh"
              ? "⚠ 空间不够：根据你刚报的墙长和家电宽度，"
              : "⚠ Space check: with the wall lengths and appliance widths you just gave, ";
            replies.push({
              role: "assistant",
              content: `${head}${fitAsk.brief}\n${fitAsk.askHint ?? ""}`.trim(),
              at,
            });
          }
        }
      }
    }
    justConfirmedThisTurn = justConfirmedNotes(planBeforeThisTurn, planChat, language);
  }

  // FR-22.2：可识别的会话纠错 → 该公司 L1 draft（禁写 L0 / published 价）
  await maybeEnqueueSessionCorrection(conv, text);

  if (mentions.length === 0) {
    // 交互口吻按**生效**账号类型走：资质没过审的 trade 账号按 consumer 定价，
    // 说话方式也应该一致，否则会出现"按零售价报价却全程行话"的错位
    const effective = effectiveAccountType(account, verificationFor(account.id));

    // 纯切换语言的短句：只回确认，不再跑一轮需求问答（否则会叠两句助手回复）。
    // 本轮已即时报「空间不够」时也不再叠一轮收集话术。
    const switchOnly = Boolean(switched) && isLanguageSwitchOnly(text);
    const fitReplyThisTurn = replies.some((r) =>
      /空间不够|Space check|appliances_fit|墙长超过|need more wall/i.test(r.content));
    if (!switchOnly && !fitReplyThisTurn) {
      // 日常轮次走轻量模型，只有确定性触发才上主力（model-tiers.ts）。
      // 「连续几轮没进展」是兜底：轻量模型可能在原地打转，客户已经说了三轮
      // 却一个字段都没被收集到。
      const escalation = escalationDecision({
        userText: text,
        turnsWithoutProgress: turnsWithoutProgress(conv),
        justParsedFloorPlan: false,
      });
  // Pass intake status into LLM for friendlier collection
      const nextReqs = designRequirementsAfter(conv, text);
      const readinessPre = (() => {
        // provisional: merge next reqs into a shallow copy for status
        const shadow = { ...conv, designRequirements: nextReqs };
        const plan = planForConversation(conv.id);
        return evaluateDesignReadiness({
          conversation: shadow,
          plan,
          language,
          accountProvince: account.province,
        });
      })();
      const intakeMissRaw = intakeMissing(conv.id).length
        ? missingFields(nextReqs).filter((f) => {
            const plan = planForConversation(conv.id);
            if (plan && isLayoutReady(plan) && (f === "kitchen size" || f === "layout")) return false;
            return true;
          })
        : [];
      // 必备信息（户型/上下水/窗门/家电）没收完时，style/budget/province 不进候选池——
      // 不是排后面问，是不出现（见 design/intake-checklist.ts）。
      const intakeMiss = readinessPre.requiredIntakeComplete
        ? intakeMissRaw
        : stripIntentFields(intakeMissRaw);
      // prefer checklist open critical asks when geometry exists
      const planReady = readinessPre.items.some((i) => i.id === "walls_ceiling" && i.status === "ok");
      const openAsks = readinessPre.openItems
        .filter((i) => i.critical && (i.status === "missing" || i.status === "needs_confirm"))
        .filter((i) => readinessPre.requiredIntakeComplete || i.category !== "intent")
        .sort((a, b) => {
          if (a.id === "appliances_fit") return -1;
          if (b.id === "appliances_fit") return 1;
          return 0;
        })
        .map((i) => i.askHint || i.brief)
        .slice(0, 3);
      const repeatedAsk = askedSameFieldsBefore(conv, nextReqs, openAsks);
      const confirmedBriefs = [
        ...readinessPre.confirmedFacts
          .filter((f) => f.status === "ok" || f.status === "needs_confirm" || f.status === "deferred")
          .map((f) => `${f.label}: ${f.value}`),
        ...readinessPre.items
          .filter((i) => i.status === "ok" || i.status === "deferred" || i.status === "needs_confirm")
          .map((i) => i.brief),
      ].filter((s, idx, arr) => s.trim() && arr.indexOf(s) === idx)
        .slice(0, 10);
      const pk = platformKnowledgeRuntime(appCtx.repos.knowledgeCards.all());
      const handbook = pk.handbook(language);
      try {
        const reply = await orchestratorReply(appCtx.llm,
          { conversationId: conv.id, requirements: conv.designRequirements, history: conv.messages.map(toHistory) },
          text, {
            profile: interactionProfile(effective),
            escalation,
            repeatedAsk,
            language,
            ...(resolveSenderIdentity().email
              ? { supportContact: resolveSenderIdentity().email }
              : {}),
            ...(handbook ? { platformHandbook: handbook } : {}),
            ...(pk.overlays.dialogue
              ? { dialogueOverlay: pk.overlays.dialogue }
              : {}),
            intakeStatus: {
              missing: intakeMiss,
              openAsks: openAsks.length ? openAsks : intakeMiss.map((f) => fieldLabel(f, language)),
              confirmedBriefs,
              floorPlanReady: planReady,
              readyToAskDesign: readinessPre.readyToAskDesign,
              requiredIntakeComplete: readinessPre.requiredIntakeComplete,
              ...(justConfirmedThisTurn.length ? { justConfirmed: justConfirmedThisTurn } : {}),
            },
          });
        designRequirements = reply.requirements ?? designRequirements;
        replies.push({ role: "assistant", content: reply.content, at });
      } catch (err) {
        // LLM 超时/失败：明确重试文案，禁止「再确认一遍」同一问题
        designRequirements = nextReqs;
        const detail = err instanceof Error ? err.message : String(err);
        // 用合并后的需求重算缺口——超时前客户刚说的风格等必须算已答
        const afterFail = evaluateDesignReadiness({
          conversation: { ...conv, designRequirements: nextReqs },
          plan: planForConversation(conv.id),
          language,
          accountProvince: account.province,
        });
        const nextHint = afterFail.readyToAskDesign
          ? undefined
          : (afterFail.openItems
            .filter((i) => i.critical && (i.status === "missing" || i.status === "needs_confirm"))
            .filter((i) => afterFail.requiredIntakeComplete || i.category !== "intent")
            .map((i) => i.askHint || i.brief)[0]
            ?? openAsks[0]
            ?? (intakeMiss[0] ? fieldLabel(intakeMiss[0], language) : undefined));
        const fallback = language === "zh"
          ? `⚠️ 模型刚才调用失败（${detail.slice(0, 80)}）。你刚说的内容已记下，不会丢。`
            + (afterFail.readyToAskDesign
              ? "必要信息已齐——请再发一句「请出图」或点确认出图，即可继续。"
              : `请直接再发一句，或点下面的快捷选项——不必重新确认已答过的项`
                + (nextHint ? `。若要继续，优先补：${nextHint}` : "。"))
          : `⚠️ Model call failed (${detail.slice(0, 80)}). I've saved what you said.`
            + (afterFail.readyToAskDesign
              ? " Intake looks complete — reply \"please generate the design\" or tap the confirm button to continue."
              : ` Please send one short reply or tap a quick option — do not re-confirm answered items`
                + (nextHint ? `. Next needed: ${nextHint}` : "."));
        replies.push({ role: "assistant", content: fallback, at });
      }
    }
  } else {
    designRequirements = mergeRequirements(designRequirements, text);
    if (notices.length > 0 && replies.length === 0) {
      replies.push({ role: "assistant", content: notices[0]!, at });
    }
  }

  const updated = await appCtx.repos.conversations.update(conv.id, {
    messages: [...messages, ...replies], perCompanyThreads, designRequirements,
    ...(prefsPatch !== conv.preferences ? { preferences: prefsPatch } : {}),
  });

  // 随回复带上本轮的选择题。
  //
  // 「预算大概多少」这类问题不该用开放式问法——客户不知道一套橱柜该是多少钱，
  // 开放式提问等于让他先去做一遍市场调研。有公司上下文时给出真实门板/五金选项，
  // 没有时至少能给按尺寸锚定的预算区间。
  // FR-18：只有客户主动 @ / 路由到的公司才算已选——禁止默认第一家。
  const questionCompanyId = routed[0]?.companyId ?? "";
  const qBundle = questionCompanyId ? publishedBundle(appCtx, questionCompanyId) : undefined;
  const inches = baseRunInches(conv.id);
  const questions = buildQuestionSet({
    ...(qBundle ? { bundle: qBundle } : {}),
    ...(inches !== undefined
      ? { budget: {
          baseRunInches: inches,
          catalog: appCtx.catalog,
          sourceVerified: appCtx.catalogSourceVerified,
        } }
      : {}),
    answered: prefsFor(updated, questionCompanyId),
    maxPerTurn: interactionProfile(
      effectiveAccountType(account, verificationFor(account.id)),
    ).maxQuestionsPerTurn,
    language,
  });

  // 缺失字段配一组**可点的快捷回答**（`agents/quick-replies.ts`）。
  //
  // 「您偏好的厨房风格是什么？」后面跟一串括号里的例子,客户读完还是不知道
  // 答案该有多长。给可点选项；勿每轮命令式催「回一个词」。
  // FR-17：户型解读可用后去掉 kitchen size / layout。
  const missing = intakeMissing(updated.id);
  const briefing = await briefingPayload(updated.id, questionCompanyId || undefined);
  const readiness = designReadinessFor(updated.id, questionCompanyId || undefined);
  let quickFieldList = missing.length
    ? [...missing]
    : readiness.openItems.filter((i) => i.critical).map((i) => {
        if (i.id === "style" || i.id === "budget" || i.id === "province") return i.id;
        return "";
      }).filter(Boolean);
  if (briefing.geometryUsable) {
    quickFieldList = quickFieldList.filter((f) => f !== "kitchen size" && f !== "layout");
  }
  // 必备信息没收完时，风格/预算/省份的快捷回答 chip 也不该冒出来——
  // 不然按钮和助手嘴上说的（"必备信息没收完不问这些"）对不上。
  if (!readiness.requiredIntakeComplete) {
    quickFieldList = stripIntentFields(quickFieldList);
  }
  const quickReplies = mentions.length === 0
    ? quickRepliesFor(
        quickFieldList,
        interactionProfile(
          effectiveAccountType(account, verificationFor(account.id)),
        ).maxQuestionsPerTurn,
        language,
      )
    : [];

  // 资料齐了：推进阶段并带回「要不要出设计」+ 文字确认复述
  // 未选厂商时仍可 readyToAskDesign（seller 非关键）；阶段机需要公司时用显式 id。
  let designPrompt = null as ReturnType<typeof stagePrompt> | null;
  let designSession = null as Awaited<ReturnType<typeof sessionFor>> | null;
  let designConsentGranted = false;
  const designCompanyId = questionCompanyId || GENERIC_DESIGN_COMPANY_ID;

  if (readiness.readyToAskDesign) {
    designSession = await sessionFor(updated.id, designCompanyId);
    const awaitingConsent = designSession.stage === "readyToDraw";
    const alreadyPlan = designSession.stage === "planReview"
      || designSession.stage === "fullDrawings"
      || designSession.stage === "quoted";

    if (
      awaitingConsent
      && isDesignConsentAffirmation(text, { awaitingConsent: true })
    ) {
      // 聊天里明确同意出图 → 立刻授权，禁止再弹「请点同意」
      try {
        designSession = grantDrawingConsent(designSession, at, text.slice(0, 160));
        designSession = await appCtx.repos.designSessions.upsert(designSession);
        designConsentGranted = true;
        designPrompt = null;
        const startMsg = language === "zh"
          ? "好的，开始根据已确认信息出设计…"
          : "Great — generating a layout from what we've confirmed…";
        replies.length = 0;
        replies.push({ role: "assistant", content: startMsg, at });
        await appCtx.repos.conversations.update(updated.id, {
          messages: [...messages, ...replies],
        });
      } catch {
        // 阶段冲突时仍回退到出图确认卡
        designConsentGranted = false;
      }
    } else if (alreadyPlan && isDesignConsentAffirmation(text, { awaitingConsent: true })) {
      // 已授权过：勿再问同意，让前端刷新/继续出图
      designConsentGranted = true;
      designPrompt = null;
    } else if (awaitingConsent) {
      const base = stagePrompt(designSession, {
        language,
        missingFields: readiness.openItems.map((i) => i.brief),
      });
      designPrompt = {
        ...base,
        message: `${readiness.confirmationText}\n\n${base.message}`,
      };
    }
  } else if (questionCompanyId && isReadyToDraw(updated.id, questionCompanyId)) {
    // 理论上与 readiness.readyToAskDesign 同真；保留旧分支兼容
    designSession = await sessionFor(updated.id, questionCompanyId);
    if (designSession.stage === "readyToDraw") {
      const base = stagePrompt(designSession, {
        language,
        missingFields: readiness.openItems.map((i) => i.brief),
      });
      designPrompt = {
        ...base,
        message: `${readiness.confirmationText}\n\n${base.message}`,
      };
    }
  }

  // 已答字段的反馈（FR-17.3）——避免前端再甩同一组 chip
  const answeredFeedback = answeredFieldFeedback(
    conv.designRequirements ?? "",
    updated.designRequirements ?? "",
    language,
  );

  const planAfter = planForConversation(updated.id);
  const applianceQuestions = planAfter
    ? buildApplianceQuestions({
        known: planAfter.appliances ?? [],
        kindsAnswered: (planAfter.appliances?.length ?? 0) > 0,
        maxPerTurn: 1,
        language,
      })
    : [];

  // FR-23：首次 @ 到尚无 active 协作分支的公司时，提示客户确认开线（不自动开）
  const engagementOffer = routed.find((r) => !activeEngagementForCompany(updated, r.companyId));

  return c.json({
    replies,
    reply: replies[0] ?? null,
    routedTo: routed,
    notices,
    requirements: updated.designRequirements,
    missingFields: missing,
    quickReplies,
    answeredFeedback,
    questions,
    questionCompanyId: questionCompanyId || null,
    language,
    ...briefing,
    ...(showcaseSamples ? { intakeSamples: showcaseSamples } : {}),
    ...(applianceQuestions.length ? { applianceQuestions } : {}),
    ...(designPrompt ? { designPrompt, designSession } : {}),
    ...(designConsentGranted ? { designConsentGranted: true, designSession } : {}),
    ...(engagementOffer
      ? {
          engagementOffer: {
            companyId: engagementOffer.companyId,
            companyName: engagementOffer.companyName,
          },
        }
      : {}),
  });
});

/**
 * 本账号的历史会话列表 —— 左栏用。
 *
 * 只回**列表要用的那几个字段**，不回完整会话：一个账号可能有几十段对话，
 * 每段几十条消息，全量回一次左栏就要拉几百 KB，而它只显示一行标题。
 *
 * 标题取客户说的第一句话——「我们家厨房要整个翻新」比「会话 cv_3f2a」
 * 有用得多，而且不用额外让客户起名字。
 */
app.get("/api/conversations", requireAccount, (c) => {
  const accountId = c.get("account").id;
  const quotes = appCtx.repos.quotes.all();
  const list = appCtx.repos.conversations.all()
    .filter((v) => v.customerAccountId === accountId)
    .map((v) => {
      const last = v.messages[v.messages.length - 1];
      const mine = quotes.filter((q) => q.conversationId === v.id);
      const fullTitle = conversationFullTitle(v.messages);
      const engagements = listEngagements(v)
        .filter((e) => e.status === "active")
        .map((e) => ({
          id: e.id,
          companyId: e.companyId,
          customerTitle: e.customerTitle,
          status: e.status,
        }));
      return {
        id: v.id,
        title: truncateConversationTitle(fullTitle),
        fullTitle,
        status: lifecycleStatus(v),
        ...(v.archivedAt ? { archivedAt: v.archivedAt } : {}),
        messageCount: v.messages.length,
        quoteCount: mine.length,
        companies: v.perCompanyThreads.map((t) => t.companyId),
        engagements,
        updatedAt: last?.at ?? v.createdAt,
        createdAt: v.createdAt,
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return c.json({ conversations: list });
});

app.post("/api/conversations/:id/archive", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  if (lifecycleStatus(conv) === "archived") {
    return c.json({ conversation: { ...conv, status: "archived" as const } });
  }
  const at = now();
  const updated = await appCtx.repos.conversations.update(conv.id, {
    status: "archived",
    archivedAt: at,
  });
  return c.json({ conversation: updated });
});

// ── FR-23 厂商协作子线程（客户侧）──────────────────────────────────────────

function engagementHttpError(e: unknown): { status: 400 | 404 | 409; body: { error: string; code: string } } {
  if (e instanceof EngagementError) {
    const status = e.code === "NOT_FOUND" ? 404
      : e.code === "EMPTY_TEXT" || e.code === "COMPANY_MISMATCH" ? 400
        : 409;
    return { status, body: { error: e.message, code: e.code } };
  }
  throw e;
}

/** 子轨 Confirmed = 主轨 Design Basis brief + 厂专用选型（结构对齐便于双向同步）。 */
function engagementConfirmedPayload(conv: Conversation, eg: CompanyEngagement) {
  const workingReq = eg.sharedWorking?.designRequirements ?? eg.handoff.designRequirements ?? "";
  const workingPrefs = eg.sharedWorking?.preferences ?? eg.handoff.sharedPreferences;
  const shadow: Conversation = {
    ...conv,
    designRequirements: workingReq,
    preferences: {
      shared: { ...(workingPrefs ?? {}) },
      byCompany: conv.preferences?.byCompany,
    },
  };
  const company = appCtx.repos.companies.byId(eg.companyId);
  const lang = resolveLanguage(workingPrefs ?? conv.preferences?.shared);
  const readiness = evaluateDesignReadiness({
    conversation: shadow,
    plan: planForConversation(conv.id),
    companyId: eg.companyId,
    ...(company ? { companyName: company.name } : {}),
    language: lang,
    accountProvince: accountProvinceFor(conv.customerAccountId),
  });
  const panels = confirmedPanels(conv, eg);
  const doorId = panels.companySpecific.doorStyleId;
  const bundle = publishedBundle(appCtx, eg.companyId);
  const doorName = doorId
    ? (bundle?.doorStyles.find((d) => d.id === doorId)?.name ?? doorId)
    : undefined;
  return {
    ...panels,
    designBrief: {
      sections: readiness.sections,
      readyToAskDesign: readiness.readyToAskDesign,
      openItems: readiness.openItems.map((i) => ({
        id: i.id, status: i.status, brief: i.brief, askHint: i.askHint,
      })),
      confirmationText: readiness.confirmationText,
      confirmedFacts: readiness.confirmedFacts,
    },
    ...(doorId ? {
      doorStyleId: doorId,
      doorStyleName: doorName,
    } : {}),
    handoffRevision: eg.handoff.revision ?? 1,
    requirementsDigest: eg.handoff.requirementsDigest
      ?? digestFromBriefSections(readiness.sections, readiness.confirmedFacts, lang).requirementsDigest,
    pricedProductList: pricedProductListFor(conv.id, eg.companyId),
  };
}

/**
 * 厂商会话下方的产品清单——只展示，不触发生成。报价生成入口还是主会话的
 * POST /api/quotes；这里按会话+厂商找该厂商最新一份已出的报价，没有就是
 * undefined，前端提示"还没有报价"。
 */
function pricedProductListFor(conversationId: string, companyId: string) {
  const quotes = appCtx.repos.quotes
    .filter((q) => q.conversationId === conversationId && q.companyId === companyId);
  if (!quotes.length) return undefined;
  const latest = quotes.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  return {
    quoteId: latest.id,
    currency: latest.currency,
    lineItems: latest.lineItems,
    subtotal: latest.subtotal,
    taxes: latest.taxes,
    total: latest.total,
    createdAt: latest.createdAt,
  };
}

function briefHandoffBits(conversationId: string, companyId: string, language: UiLanguage) {
  const readiness = designReadinessFor(conversationId, companyId);
  return digestFromBriefSections(readiness.sections, readiness.confirmedFacts, language);
}

/** 按 URL 会话 + eid 取子轨；若会话 id 错位，在同账号下按 eid 找回。 */
function resolveOwnedEngagement(c: Ctx, conversationId: string, engagementId: string): {
  conversation: Conversation;
  engagement: NonNullable<ReturnType<typeof findEngagement>>;
} | { error: Response } {
  const eid = engagementId.trim();
  if (!eid) {
    return { error: c.json({ error: "Engagement not found", code: "NOT_FOUND" }, 404) };
  }
  const accountId = c.get("account").id;
  let conv = ownedConversation(c, conversationId);
  let eg = conv ? findEngagement(conv, eid) : undefined;
  if (!eg) {
    const found = findEngagementOwnedByAccount(
      appCtx.repos.conversations.all(), accountId, eid,
    );
    if (found) {
      conv = found.conversation;
      eg = found.engagement;
    }
  }
  if (!conv || !eg) {
    return { error: c.json({ error: "Engagement not found", code: "NOT_FOUND" }, 404) };
  }
  return { conversation: conv, engagement: eg };
}

app.post("/api/conversations/:id/engagements", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;
  const body = await jsonBody<{ companyId: string }>(c);
  const companyId = (body.companyId ?? "").trim();
  const company = companyId ? appCtx.repos.companies.byId(companyId) : undefined;
  if (!company || !isCompanyActive(company)) {
    return c.json({ error: "Company not found or unavailable" }, 404);
  }
  const plan = planForConversation(conv.id);
  const bundle = publishedBundle(appCtx, company.id);
  const doorStyleNames = Object.fromEntries(
    (bundle?.doorStyles ?? []).map((d) => [d.id, d.name]),
  );
  const boxMaterialNames = Object.fromEntries(
    (bundle?.boxMaterialOptions ?? []).map((m) => [m.id, m.name]),
  );
  const language = resolveLanguage(conv.preferences?.shared);
  const { requirementsDigest, briefFacts } = briefHandoffBits(conv.id, company.id, language);
  try {
    let { conversation: next, engagement, created } = openEngagement({
      conversation: conv,
      companyId: company.id,
      companyName: company.name,
      at: now(),
      floorPlanId: plan?.id,
      doorStyleNames,
      boxMaterialNames,
      requirementsDigest,
      briefFacts,
    });
    // 首次开线：厂商 Agent 复述交接包（系统助手已写入开线说明）
    if (created && bundle) {
      const specVer = appCtx.repos.specVersions.byId(bundle.id);
      const restate = await companyAgentRestateHandoff(
        appCtx.llm, company.name, bundle, engagement.handoff, language,
        specVer?.codingRules, "open",
      );
      ({ conversation: next, engagement } = appendEngagementMessage(
        next, engagement.id,
        {
          role: "assistant",
          speaker: "company_agent",
          content: restate.content,
          at: now(),
        },
      ));
    }
    await appCtx.repos.conversations.upsert(next);
    return c.json({
      engagement,
      created,
      confirmed: engagementConfirmedPayload(next, engagement),
    }, created ? 201 : 200);
  } catch (e) {
    const err = engagementHttpError(e);
    return c.json(err.body, err.status);
  }
});

app.get("/api/conversations/:id/engagements", requireAccount, (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  return c.json({
    engagements: listEngagements(conv).map((e) => ({
      id: e.id,
      companyId: e.companyId,
      customerTitle: e.customerTitle,
      status: e.status,
      createdAt: e.createdAt,
      messageCount: e.messages.length,
    })),
  });
});

app.get("/api/conversations/:id/engagements/:eid", requireAccount, (c) => {
  const resolved = resolveOwnedEngagement(c, param(c, "id"), param(c, "eid"));
  if ("error" in resolved) return resolved.error;
  const { conversation: conv, engagement: eg } = resolved;
  const company = appCtx.repos.companies.byId(eg.companyId);
  return c.json({
    engagement: eg,
    companyName: company?.name ?? eg.companyId,
    confirmed: engagementConfirmedPayload(conv, eg),
    parentStatus: lifecycleStatus(conv),
    conversationId: conv.id,
  });
});

app.post("/api/conversations/:id/engagements/:eid/messages", requireAccount, async (c) => {
  const resolved = resolveOwnedEngagement(c, param(c, "id"), param(c, "eid"));
  if ("error" in resolved) return resolved.error;
  const { conversation: conv, engagement: eg0 } = resolved;
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;
  const body = await jsonBody<{ text: string }>(c);
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ error: "text is required", code: "EMPTY_TEXT" }, 400);
  const at = now();
  const beforeCount = eg0.messages.length;
  try {
    let { conversation: next, engagement } = appendEngagementMessage(
      conv, eg0.id, { role: "user", speaker: "user", content: text, at },
    );
    const company = appCtx.repos.companies.byId(engagement.companyId);
    const bundle = company ? publishedBundle(appCtx, company.id) : undefined;
    const language = resolveLanguage(next.preferences?.shared);
    if (company && bundle && !engagement.agentPaused) {
      const specVer = appCtx.repos.specVersions.byId(bundle.id);
      const history = engagement.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      try {
        const reply = await companyAgentReply(
          appCtx.llm, company.name, bundle,
          {
            conversationId: next.id,
            requirements: engagement.handoff.requirementsDigest
              ?? engagement.sharedWorking?.designRequirements
              ?? engagement.handoff.designRequirements
              ?? next.designRequirements,
            history,
            handoff: engagement.handoff,
            geometryNote: geometryNoteForConversation(next.id, language),
          },
          text, language, specVer?.codingRules,
        );
        ({ conversation: next, engagement } = appendEngagementMessage(
          next, engagement.id,
          {
            role: "assistant",
            speaker: "company_agent",
            content: reply.content,
            at,
          },
        ));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        ({ conversation: next, engagement } = appendEngagementMessage(
          next, engagement.id,
          {
            role: "assistant",
            speaker: "company_agent",
            content: language === "zh"
              ? `（协作）连接超时：${detail.slice(0, 80)}`
              : `(collaboration) timed out: ${detail.slice(0, 80)}`,
            at,
          },
        ));
      }
    }
    await appCtx.repos.conversations.upsert(next);
    return c.json({
      engagement,
      confirmed: engagementConfirmedPayload(next, engagement),
      // 按本次调用新增的消息数取切片，不按时间戳匹配——同一毫秒内两条消息
      // 时间戳相同是真实可能发生的（内存态测试尤其容易撞上），`at` 匹配会
      // 把更早那条也算进本轮回复，见 test/company-engagement.test.ts 的间歇性失败。
      replies: engagement.messages.slice(beforeCount + 1).filter((m) => m.role !== "user"),
      conversationId: next.id,
    });
  } catch (e) {
    const err = engagementHttpError(e);
    return c.json(err.body, err.status);
  }
});

app.post("/api/conversations/:id/engagements/:eid/promote", requireAccount, async (c) => {
  const resolved = resolveOwnedEngagement(c, param(c, "id"), param(c, "eid"));
  if ("error" in resolved) return resolved.error;
  const { conversation: conv, engagement: eg0 } = resolved;
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;
  try {
    const { conversation: next, engagement, systemSummary, changedKeys } =
      promoteSharedToParent(conv, eg0.id, now());
    await appCtx.repos.conversations.upsert(next);
    return c.json({
      engagement,
      confirmed: engagementConfirmedPayload(next, engagement),
      systemSummary,
      changedKeys,
      conversation: { id: next.id, designRequirements: next.designRequirements, preferences: next.preferences },
    });
  } catch (e) {
    const err = engagementHttpError(e);
    return c.json(err.body, err.status);
  }
});

app.post("/api/conversations/:id/engagements/:eid/pull", requireAccount, async (c) => {
  const resolved = resolveOwnedEngagement(c, param(c, "id"), param(c, "eid"));
  if ("error" in resolved) return resolved.error;
  const { conversation: conv, engagement: eg0 } = resolved;
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;
  try {
    const company = appCtx.repos.companies.byId(eg0.companyId);
    const bundle = company ? publishedBundle(appCtx, company.id) : undefined;
    const doorStyleNames = Object.fromEntries(
      (bundle?.doorStyles ?? []).map((d) => [d.id, d.name]),
    );
    const boxMaterialNames = Object.fromEntries(
      (bundle?.boxMaterialOptions ?? []).map((m) => [m.id, m.name]),
    );
    const language = resolveLanguage(conv.preferences?.shared);
    const { requirementsDigest, briefFacts } = briefHandoffBits(
      conv.id, eg0.companyId, language,
    );
    let { conversation: next, engagement } = pullSharedFromParent(
      conv, eg0.id, now(), {
        doorStyleNames, boxMaterialNames, requirementsDigest, briefFacts,
      },
    );
    if (company && bundle && !engagement.agentPaused) {
      const specVer = appCtx.repos.specVersions.byId(bundle.id);
      const restate = await companyAgentRestateHandoff(
        appCtx.llm, company.name, bundle, engagement.handoff, language,
        specVer?.codingRules, "pull",
      );
      ({ conversation: next, engagement } = appendEngagementMessage(
        next, engagement.id,
        {
          role: "assistant",
          speaker: "company_agent",
          content: restate.content,
          at: now(),
        },
      ));
    }
    await appCtx.repos.conversations.upsert(next);
    return c.json({
      engagement,
      confirmed: engagementConfirmedPayload(next, engagement),
      conversationId: next.id,
    });
  } catch (e) {
    const err = engagementHttpError(e);
    return c.json(err.body, err.status);
  }
});

app.post("/api/conversations/:id/unarchive", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  if (lifecycleStatus(conv) === "active") {
    const { archivedAt: _drop, ...rest } = conv;
    return c.json({ conversation: { ...rest, status: "active" as const } });
  }
  const { archivedAt: _drop, ...rest } = conv;
  const updated: Conversation = { ...rest, status: "active" };
  await appCtx.repos.conversations.upsert(updated);
  return c.json({ conversation: updated });
});

app.get("/api/conversations/:id", requireAccount, (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const language = resolveLanguage(conv.preferences?.shared);
  const companyId = c.req.query("companyId") || undefined;
  const readiness = designReadinessFor(conv.id, companyId);
  const plan = planForConversation(conv.id);
  return c.json({
    conversation: { ...conv, status: lifecycleStatus(conv) },
    language,
    rtaIntro: rtaIntro(language),
    welcome: floorplanFirstWelcome(language),
    intakeSamples: intakeSampleCards(language),
    // 切会话时前端必须恢复户型 id，否则同意出图会因 floorPlanId=null 卡死
    floorPlanId: plan?.id ?? null,
    floorPlanReady: plan ? isLayoutReady(plan) : false,
    // 已出过的设计图：从 storedLayouts 重渲染，避免刷新后输出物 Tab 空白
    deliverables: deliverablesForConversation(conv.id, companyId),
    designBrief: {
      sections: readiness.sections,
      readyToAskDesign: readiness.readyToAskDesign,
      openItems: readiness.openItems.map((i) => ({
        id: i.id, status: i.status, brief: i.brief, askHint: i.askHint,
      })),
      confirmationText: readiness.confirmationText,
      confirmedFacts: readiness.confirmedFacts,
    },
  });
});

// ── 价格与偏好的选择式提问（FR-1）─────────────────────────────────────────

/**
 * 本轮要问客户的选择题。
 *
 * 为什么不让 LLM 直接问：选项必须来自这家公司**真实的**规格库，价格影响必须是
 * **算出来的**。模型会编出这家公司没有的门板，也会随口说"大概贵两成"——
 * 这两件事都会让客户按错误信息做决定（FR-8 的同一条理由）。
 */
app.get("/api/conversations/:id/questions", requireAccount, (c) => {
  const account = c.get("account");
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);

  const companyId = c.req.query("companyId") ?? "";
  const bundle = companyId ? publishedBundle(appCtx, companyId) : undefined;
  if (companyId && !bundle) return c.json({ error: "Company has no published catalog" }, 409);

  const inches = baseRunInches(conv.id);
  const plan = planForConversation(conv.id);
  const stored = plan && companyId
    ? appCtx.repos.storedLayouts.byId(layoutKey(plan.id, companyId))
    : undefined;
  const cabinetCount = stored
    ? stored.moduleCounts.reduce((n, m) => n + m.qty, 0)
    : undefined;

  const effective = effectiveAccountType(account, verificationFor(account.id));
  const prefLang = resolveLanguage(conv.preferences?.shared);
  const questions = buildQuestionSet({
    ...(bundle ? { bundle } : {}),
    ...(inches !== undefined
      ? { budget: {
          baseRunInches: inches,
          catalog: appCtx.catalog,
          sourceVerified: appCtx.catalogSourceVerified,
        } }
      : {}),
    answered: prefsFor(conv, companyId),
    maxPerTurn: interactionProfile(effective).maxQuestionsPerTurn,
    ...(cabinetCount !== undefined ? { estimatedCabinetCount: cabinetCount } : {}),
    language: prefLang,
  });

  return c.json({
    questions,
    answered: prefsFor(conv, companyId),
    // 没有户型图时预算题问不出来（区间需要尺寸锚定），如实说明而不是给个瞎猜的区间
    ...(inches === undefined
      ? { note: msg(resolveLanguage(conv.preferences?.shared),
          "Upload a floor plan and fill in the sizes first — then we can give a grounded budget range.",
          "上传户型图并补齐尺寸后，我们才能给出有依据的预算区间。") }
      : {}),
  });
});

/** 记录客户的选择。跨公司项与该公司项分开存（见 Conversation.preferences）。 */
app.post("/api/conversations/:id/preferences", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;

  const body = await jsonBody<CustomerPreferences & { companyId: string }>(c);
  const companyId = body.companyId ?? "";
  const bundle = companyId ? publishedBundle(appCtx, companyId) : undefined;

  let split;
  try {
    split = validatePreferences(body, bundle);
  } catch (e) {
    if (e instanceof PreferenceError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const prev = conv.preferences ?? {};
  const byCompany = { ...(prev.byCompany ?? {}) };
  if (companyId && Object.keys(split.company).length > 0) {
    byCompany[companyId] = { ...(byCompany[companyId] ?? {}), ...split.company };
  }

  // 门板选择同时写入需求摘要，避免 intake「风格」与偏好卡各走各的、下一轮又追问风格
  let designRequirements = conv.designRequirements;
  let savedLabel: string | undefined;
  if (split.company.doorStyleId && bundle) {
    const door = bundle.doorStyles.find((d) => d.id === split.company.doorStyleId);
    if (door) {
      savedLabel = door.name;
      designRequirements = mergeRequirements(designRequirements, door.name);
    }
  }

  const updated = await appCtx.repos.conversations.update(conv.id, {
    preferences: {
      shared: { ...(prev.shared ?? {}), ...split.shared },
      byCompany,
    },
    ...(designRequirements !== conv.designRequirements ? { designRequirements } : {}),
  });

  return c.json({
    preferences: prefsFor(updated, companyId),
    requirements: updated.designRequirements,
    ...(savedLabel ? { savedLabel, savedKind: "doorStyle" as const } : {}),
    // 储物偏好会改变排布，已生成的方案需要重排才会生效——不要让客户以为改完就生效了
    layoutAffected: split.shared.storage !== undefined,
  });
});

// ── 冷启动通用预估（FR-10）────────────────────────────────────────────────

app.post("/api/conversations/:id/estimate", requireAccount, async (c) => {
  const account = c.get("account");
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;

  // 有户型图就出**含四视图**的版本（MVP-2，场景 B 第 4 点）；否则退回纯文本版
  // 必须读会话「当前」户型（最近更新），避免同会话多张时出图/估价串到旧壳
  const plan = planForConversation(conv.id);

  if (plan && isLayoutReady(plan)) {
    const lang = resolveLanguage(conv.preferences?.shared);
    const illustrated = buildIllustratedEstimate(appCtx.catalog, plan.parsedGeometry, {
      conversationId: conv.id, province: account.province, at: now(),
    }, { taxRules: appCtx.taxRules, sourceVerified: appCtx.catalogSourceVerified, language: lang });
    await appCtx.repos.estimates.insert(illustrated.draft);
    return c.json({
      estimate: illustrated.draft,
      text: renderEstimateText(illustrated.draft, lang),
      views: illustrated.viewsByRun,
      viewsDisclaimer: illustrated.viewsDisclaimer,
    }, 201);
  }

  const lang = resolveLanguage(conv.preferences?.shared);
  const draft = buildEstimateDraft(appCtx.catalog, {
    conversationId: conv.id,
    moduleCounts: estimateCountsFromText(conv.designRequirements),
    province: account.province,
    at: now(),
  }, { taxRules: appCtx.taxRules, sourceVerified: appCtx.catalogSourceVerified, language: lang });

  await appCtx.repos.estimates.insert(draft);
  // EstimateDraft 没有 companyId —— 结构上不可能进入发送闸门（FR-8 第 4 条）
  return c.json({ estimate: draft, text: renderEstimateText(draft, lang) }, 201);
});

// ── 报价 ──────────────────────────────────────────────────────────────────

app.post("/api/quotes", requireAccount, async (c) => {
  const account = c.get("account");
  const body = await jsonBody<{
    companyId: string; conversationId: string; doorStyleId: string;
    boxMaterialId: string; selections: unknown; designLayoutId: string;
  }>(c);

  const company = body.companyId ? appCtx.repos.companies.byId(body.companyId) : undefined;
  if (!company || !isCompanyActive(company)) return c.json({ error: "Company not found or unavailable" }, 404);
  const conv = ownedConversation(c, body.conversationId ?? "");
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const archivedQuote = rejectIfArchived(c, conv);
  if (archivedQuote) return archivedQuote;
  // 客户在选择题里选过门板/箱体就直接用，不必再传一遍
  const prefs = prefsFor(conv, company.id);
  const doorStyleId = body.doorStyleId || prefs.doorStyleId;
  // 箱体板材没选就传空——定价那边按商家的默认档算，并把用的是哪一档记进快照
  const boxMaterialId = body.boxMaterialId || prefs.boxMaterialId;
  if (!doorStyleId) return c.json({ error: "Door style is required (sets the price group)" }, 400);

  const pricing = pricingContextFor(appCtx, company.id);
  if (!pricing) return c.json({ error: "Company has no published catalog" }, 409);

  // 方案违反人体工程硬约束时不允许出报价——那不是"便宜一点"的取舍，
  // 是灶台旁没处放热锅、洗碗机离水槽太远这类不该发给客户的方案（FR-4）
  const activePlan = planForConversation(conv.id);
  const stored = activePlan
    ? appCtx.repos.storedLayouts.byId(layoutKey(activePlan.id, company.id))
    : undefined;
  if (stored && !stored.acceptable) {
    return c.json({
      error: "Current layout failed ergonomic checks — adjust it first",
      ergonomics: stored.ergonomics.filter((v) => v.severity === "blocking"),
    }, 409);
  }

  // 贸易价的两道门槛（资质核实 + 订阅）在**定价链路**上生效，不只是界面隐藏：
  // 没过门槛的 trade 账号按 consumer 定价（开放问题 7）
  const gate = canSeeTradePricing(account, verificationFor(account.id));
  const accountType = effectiveAccountType(account, verificationFor(account.id));

  const result = createQuoteFromLlmOutput(new TenantScope(company.id), pricing, body.selections, {
    quoteId: `q_${randomUUID().slice(0, 8)}`,
    // 有方案就引用方案的真实修订号，报价才追得回"当时用的是哪一版"（§3.6）
    designLayoutId: body.designLayoutId ?? stored?.designLayoutId ?? `dl_${randomUUID().slice(0, 8)}`,
    designRevisionNo: stored?.currentRevisionNo ?? 1,
    conversationId: conv.id,
    customerAccountId: account.id,
    accountType,
    province: account.province,
    doorStyleId,
    ...(boxMaterialId ? { boxMaterialId } : {}),
    at: now(),
  });

  for (const e of result.events) await appCtx.repos.auditEvents.insert(e);
  if (!result.ok) return c.json({ error: "Quote validation failed; generation refused", issues: result.issues }, 422);

  await appCtx.repos.quotes.insert(result.quote);

  // 逐项清单：柜体与其门板一组、附件单列、分类汇总。
  // 只给一个总价，客户既判断不了贵在哪，也没法跟别家比（quote/line-items.ts）
  const quoteLang = convLanguage(conv);
  const bom = activePlan && stored
    ? bomFor(activePlan, toGeneratedLayout(stored), company.id, quoteLang) : undefined;
  const list = buildQuoteList({
    quote: result.quote,
    modules: pricing.modules,
    doorStyles: pricing.doorStyles,
    ...(pricing.boxMaterialOptions ? { boxMaterials: pricing.boxMaterialOptions } : {}),
    ...(bom ? { bomLines: bom.lines } : {}),
    language: quoteLang,
  });

  // ── 换花色比价（FR-6.3）──
  //
  // 同一套方案换其他门板花色的重算价。**逐行重算**——整条定价链路重跑一遍，
  // 只换 doorStyleId，折扣运费税一并重算。给总价乘一个系数得出的数没有任何
  // 一行支持它，而客户会拿它去跟别家比、去签合同。
  const finishes = compareFinishes({
    ctx: pricing,
    // 用**这份报价实际算出来的行**反推选择：与其重新拼一遍 selections，
    // 不如从结果回读——重新拼的那一份迟早与真实报价对不上，
    // 而"比价表上的数与客户真选了之后拿到的报价不一致"是最难解释的一种错。
    selections: result.quote.lineItems.map((l) => ({
      moduleId: l.moduleId, qty: l.qty, assembly: l.assembly,
      width: l.width, height: l.height, depth: l.depth,
      hardwareOptionIds: l.modifiers.filter((m) => m.kind === "hardware").map((m) => m.refId),
      accessoryOptionIds: l.modifiers.filter((m) => m.kind === "accessory").map((m) => m.refId),
    })),
    currentDoorStyleId: doorStyleId,
    // 比价必须按**这份报价实际用的箱体档**重算。按默认档算出来的差价，
    // 客户真去换花色时拿不到——那正是这个模块最忌讳的那种不一致。
    ...(result.quote.boxMaterialId ? { boxMaterialId: result.quote.boxMaterialId } : {}),
    accountType,
    province: account.province,
    at: now(),
    language: quoteLang,
  });

  const session = appCtx.repos.designSessions.byId(conv.id);

  // ── 交付前审核（FR-14）──
  //
  // 报价是客户**据以做决定**的东西：拿去跟别家比、拿去下单。所以这一步查得最严，
  // 而且把快照复算也算进来——一份复算对不上的报价，看起来和对得上的一模一样。
  // 推定的家电尺寸要**跟着报价一起走**，不能只写在图纸说明里：报价单是客户
  // 拿去下单的那一份，而"烤箱位按 30" 推定"正是决定柜子装不装得进去的那句话。
  // 用的是与图纸说明同一句措辞（`provenanceNote`），两处不各写一版。
  // `RTA_QUOTE_NOTE` 是签字之前的最后一次提醒：这份价对的是**板件平装、
  // 需要组装、不含安装**的 RTA，不是全定制。客户会拿这张单子去跟定制的
  // 报价比——那两个数不可比，而不可比这件事必须写在单子上，不能只在开场
  // 说过一次。
  const listText = [
    renderQuoteListText(list, quoteLang),
    renderFinishComparison(finishes, format, quoteLang),
    activePlan?.appliances?.length ? provenanceNote(activePlan.appliances, quoteLang) : undefined,
    rtaQuoteNote(quoteLang),
  ].filter(Boolean).join("\n\n");
  const audit = auditDeliverable({
    deliverable: "quoteList",
    stage: session?.stage ?? "quoted",
    ...(stored ? { layout: toGeneratedLayout(stored) } : {}),
    ...(activePlan ? { wallRuns: activePlan.parsedGeometry.wallRuns } : {}),
    modules: pricing.modules,
    ...(bom ? { bom } : {}),
    quote: result.quote,
    quoteList: list,
    ...(activePlan?.appliances?.length ? { appliances: activePlan.appliances } : {}),
    snapshot: verifySnapshot(result.quote, pricing, now()),
    customerFacingText: listText,
    // 有多档才要求写明按的是哪一档；只有一档时没有可比的另一档，写了只是噪音
    ...(pricing.boxMaterialOptions
      ? { boxMaterialCount: pricing.boxMaterialOptions.length } : {}),
    language: quoteLang,
  });
  if (!audit.ok) {
    await recordAuditAndCritique({
      conversationId: conv.id,
      deliverable: "quoteList",
      audit,
      trigger: "quote",
      quoteId: result.quote.id,
    });
    // 拦下来，并**说清楚拦的是什么**——「报价校验未通过」对客户毫无用处
    return c.json({
      error: "This quote failed pre-delivery checks and cannot be released yet",
      audit, auditText: renderAuditText(audit, quoteLang),
    }, 409);
  }

  if (session && session.companyId === company.id && session.stage === "fullDrawings") {
    await appCtx.repos.designSessions.upsert(markQuoted(session, now()));
  }

  await recordAuditAndCritique({
    conversationId: conv.id,
    deliverable: "quoteList",
    audit,
    trigger: "quote",
    quoteId: result.quote.id,
  });

  return c.json({
    quote: result.quote,
    formattedTotal: format(result.quote.total),
    quoteList: list,
    quoteListText: listText,
    quoteListHtml: renderQuoteListHtml(list, quoteLang),
    finishComparison: finishes,
    audit, auditText: renderAuditText(audit, quoteLang),
    // trade 账号被降级定价时如实说明原因，不静默按零售价出单
    ...(account.accountType === "trade" && !gate.allowed
      ? { tradePricing: { applied: false, reason: gate.reason, nextStep: gate.nextStep } }
      : {}),
  }, 201);
});

app.get("/api/quotes/:id", requireAccount, (c) => {
  const q = ownedQuote(c, param(c, "id"));
  return q ? c.json({ quote: q, formattedTotal: format(q.total) }) : c.json({ error: "Quote not found" }, 404);
});

/** 发送前的二次披露（FR-13 第 2 条）——客户必须先看到这个清单。 */
app.get("/api/quotes/:id/disclosure", requireAccount, (c) => {
  const account = c.get("account");
  const q = ownedQuote(c, param(c, "id"));
  if (!q) return c.json({ error: "Quote not found" }, 404);
  const company = appCtx.repos.companies.byId(q.companyId);
  const conv = appCtx.repos.conversations.byId(q.conversationId);
  return c.json(buildSendDisclosure(q, company?.name ?? q.companyId, {
    displayName: account.displayName, email: account.email,
  }, resolveLanguage(conv?.preferences?.shared)));
});

/** 客户确认 —— 独立的服务端状态迁移，留痕。 */
app.post("/api/quotes/:id/confirm", requireAccount, async (c) => {
  const q = ownedQuote(c, param(c, "id"));
  if (!q) return c.json({ error: "Quote not found" }, 404);
  try {
    const r = confirm(q, now());
    await appCtx.repos.quotes.update(r.quote.id, r.quote);
    for (const e of r.events) await appCtx.repos.auditEvents.insert(e);
    return c.json({ quote: r.quote });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

/**
 * 发送。
 *
 * **这里没有读取任何 `confirm` 字段**——报价必须已经处于 `confirmed` 状态，
 * 否则状态机直接拒绝。这是 FR-8 第 3 条的闸门。
 */
app.post("/api/quotes/:id/send", requireAccount, async (c) => {
  const account = c.get("account");
  const q = ownedQuote(c, param(c, "id"));
  if (!q) return c.json({ error: "Quote not found" }, 404);
  if (q.status !== "confirmed") {
    return c.json({ error: `Quote status is ${q.status}; customer must confirm before send` }, 409);
  }

  const company = appCtx.repos.companies.byId(q.companyId);
  const sender = resolveSenderIdentity();

  // 有方案就发 HTML 版（CID 内嵌四视图 + 表格 + 纯文本兜底 + 附件兜底，FR-7）
  const plan = planForConversation(q.conversationId);
  const layout = plan ? storedLayoutFor(plan.id, q.companyId) : undefined;
  const bundle = publishedBundle(appCtx, q.companyId);
  const pdf = plan && layout ? renderQuotePdf(q, plan, layout, account) : undefined;

  const outbound = plan && layout && bundle
    ? (() => {
        const html = buildHtmlQuoteEmail({
          quote: q,
          companyName: company?.name ?? q.companyId,
          customerName: account.displayName,
          customerEmail: account.email,
          viewsByRun: viewsFor(plan, layout, q.companyId),
          senderName: sender.name,
          ...(sender.contact ? { senderContact: sender.contact } : {}),
        });
        return {
          kind: "lead" as const, to: company?.quoteEmail ?? "",
          subject: html.subject, text: html.text, html: html.html,
          // 正式报价单 PDF 作为**纯附件**（无 cid），与内嵌视图并列：
          // 收件人转发给采购时，附件才是那份能存档、能打印的东西（FR-7）
          attachments: [
            ...html.attachments,
            ...(pdf
              ? [{
                  filename: quoteFilename(q),
                  contentType: "application/pdf",
                  content: pdf.pdf.toString("base64"),
                  encoding: "base64" as const,
                }]
              : []),
          ],
        };
      })()
    : (() => {
        const plainEmail = buildQuoteEmail({
          companyName: company?.name ?? q.companyId,
          customerName: account.displayName,
          customerEmail: account.email,
          province: q.province,
          quoteText: renderQuoteText(q),
          quoteId: q.id,
        }, sender);
        return { ...plainEmail, to: company?.quoteEmail ?? "" };
      })();

  const sendResult = await sendEmail(outbound, {
    sender,
    ...(appCtx.mailTransport ? { transport: appCtx.mailTransport } : {}),
  });
  const at = now();
  const outcome = recordSendResult(
    q, appCtx.repos.billingEvents.all(),
    sendResult.delivered
      ? { delivered: true }
      : { delivered: false, error: "error" in sendResult ? sendResult.error : "Unknown error" },
    LEAD_FEE, at,
  );

  await appCtx.repos.quotes.update(outcome.quote.id, outcome.quote);
  for (const e of outcome.events) await appCtx.repos.auditEvents.insert(e);
  if (outcome.billingEvent) await appCtx.repos.billingEvents.insert(outcome.billingEvent);

  return c.json({
    quote: outcome.quote,
    dryRun: sendResult.dryRun,
    // **发失败要说清为什么。** 原来只把状态改成 failed 就返回了，理由只留在审计
    // 事件里——客户点了发送，界面上什么也没说；运营要翻审计流水才知道是
    // CASL 校验没过还是 SMTP 连不上。两者要做的事完全不同。
    ...(sendResult.delivered ? {} : {
      sendError: "error" in sendResult ? sendResult.error : "Unknown error",
    }),
    billingSuppressed: outcome.billingSuppressed,
    billingEventId: outcome.billingEvent?.id,
    attachedPdf: Boolean(pdf),
    // 字符替换等提示不吞掉——公司名里有中文时收件人要知道 PDF 上写的是什么
    ...(pdf?.warnings.length ? { pdfWarnings: pdf.warnings } : {}),
  });
});

/**
 * 下载正式报价单 PDF。
 *
 * 与邮件里的附件是**同一份**（同一个 `buildQuotePdf` 调用路径），
 * 避免出现「客户看到的」和「公司收到的」不一致。
 */
app.get("/api/quotes/:id/pdf", requireAccount, (c) => {
  const account = c.get("account");
  const q = ownedQuote(c, param(c, "id"));
  if (!q) return c.json({ error: "Quote not found" }, 404);

  const plan = planForConversation(q.conversationId);
  const layout = plan ? storedLayoutFor(plan.id, q.companyId) : undefined;
  if (!plan || !layout) return c.json({ error: "This quote has no linked layout; cannot build a drawing quote PDF" }, 409);

  const result = renderQuotePdf(q, plan, layout, account);
  return c.body(new Uint8Array(result.pdf), 200, {
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${quoteFilename(q)}"`,
    ...(result.warnings.length ? { "x-pdf-warnings": String(result.warnings.length) } : {}),
  });
});

/**
 * 厂商会话 Type1 落地——客户请求到店/上门。
 *
 * 只促成一次邮件：把联系方式和已发出的报价一起递给厂商 `quoteEmail`，
 * 不排班、不做地理覆盖校验，双方线下联系。只能对已经 `sent` 的报价发起——
 * 发出前厂商压根没收到这个客户的线索，谈"到店/上门"没有意义。
 */
app.post("/api/quotes/:id/service-request", requireAccount, async (c) => {
  const account = c.get("account");
  const q = ownedQuote(c, param(c, "id"));
  if (!q) return c.json({ error: "Quote not found" }, 404);
  if (q.status !== "sent") {
    return c.json({ error: `Quote status is ${q.status}; the quote must be sent to the seller first` }, 409);
  }
  if (q.serviceRequest) {
    return c.json({ error: "A service request already exists for this quote", serviceRequest: q.serviceRequest }, 409);
  }

  const body = await jsonBody<{ serviceType: ServiceType; phone: string; email: string; note: string }>(c);
  if (body.serviceType !== "showroom_visit" && body.serviceType !== "onsite_visit") {
    return c.json({ error: "serviceType must be showroom_visit or onsite_visit" }, 400);
  }
  const phone = body.phone?.trim();
  const email = body.email?.trim();
  if (!phone && !email) {
    return c.json({ error: "Provide at least a phone or an email so the seller can reach you" }, 400);
  }
  const customerContact = { ...(phone ? { phone } : {}), ...(email ? { email } : {}) };

  const company = appCtx.repos.companies.byId(q.companyId);
  const sender = resolveSenderIdentity();
  const plan = planForConversation(q.conversationId);
  const layout = plan ? storedLayoutFor(plan.id, q.companyId) : undefined;
  const pdf = plan && layout ? renderQuotePdf(q, plan, layout, account) : undefined;

  const outbound = buildServiceRequestEmail({
    companyName: company?.name ?? q.companyId,
    customerName: account.displayName,
    customerAccountEmail: account.email,
    serviceType: body.serviceType,
    customerContact,
    ...(body.note?.trim() ? { note: body.note.trim() } : {}),
    quoteId: q.id,
    quoteText: renderQuoteText(q),
  }, sender);
  outbound.to = company?.quoteEmail ?? "";
  if (pdf) {
    outbound.attachments = [{
      filename: quoteFilename(q),
      contentType: "application/pdf",
      content: pdf.pdf.toString("base64"),
      encoding: "base64",
    }];
  }

  const sendResult = await sendEmail(outbound, {
    sender,
    ...(appCtx.mailTransport ? { transport: appCtx.mailTransport } : {}),
  });
  const at = now();
  let outcome;
  try {
    outcome = recordServiceRequest(
      q,
      { serviceType: body.serviceType, customerContact, ...(body.note?.trim() ? { note: body.note.trim() } : {}) },
      sendResult.delivered
        ? { delivered: true }
        : { delivered: false, error: "error" in sendResult ? sendResult.error : "Unknown error" },
      at,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
  await appCtx.repos.quotes.update(outcome.quote.id, outcome.quote);
  for (const e of outcome.events) await appCtx.repos.auditEvents.insert(e);

  return c.json({
    quote: outcome.quote,
    dryRun: sendResult.dryRun,
    ...(sendResult.delivered ? {} : { sendError: "error" in sendResult ? sendResult.error : "Unknown error" }),
  });
});

/**
 * 厂商员工确认到店/上门请求——发第二封邮件给客户。
 *
 * 鉴权走 `requireCompany`：先证明是这家公司，再操作它自己的报价单。
 */
app.post("/api/company/:companyId/quotes/:id/confirm-service", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  const q = appCtx.repos.quotes.byId(param(c, "id"));
  if (!q || q.companyId !== companyId) return c.json({ error: "Quote not found" }, 404);
  if (!q.serviceRequest) return c.json({ error: "This quote has no service request to confirm" }, 409);
  if (q.serviceRequest.confirmedAt) {
    return c.json({ error: "Already confirmed", serviceRequest: q.serviceRequest }, 409);
  }

  const company = appCtx.repos.companies.byId(companyId);
  const account = appCtx.repos.accounts.byId(q.customerAccountId);
  const to = q.serviceRequest.customerContact.email ?? account?.email;
  if (!to) {
    return c.json({ error: "Customer left no email; confirm by phone directly and note it offline" }, 409);
  }

  const sender = resolveSenderIdentity();
  const plan = planForConversation(q.conversationId);
  const layout = plan ? storedLayoutFor(plan.id, companyId) : undefined;
  const pdf = plan && layout && account ? renderQuotePdf(q, plan, layout, account) : undefined;

  const outbound = buildServiceConfirmationEmail({
    companyName: company?.name ?? companyId,
    customerName: account?.displayName ?? "there",
    serviceType: q.serviceRequest.serviceType,
    ...(company?.storeAddress ? { storeAddress: company.storeAddress } : {}),
    quoteId: q.id,
  }, sender);
  outbound.to = to;
  if (pdf) {
    outbound.attachments = [{
      filename: quoteFilename(q),
      contentType: "application/pdf",
      content: pdf.pdf.toString("base64"),
      encoding: "base64",
    }];
  }

  const sendResult = await sendEmail(outbound, {
    sender,
    ...(appCtx.mailTransport ? { transport: appCtx.mailTransport } : {}),
  });
  const at = now();
  let outcome;
  try {
    outcome = recordServiceConfirmation(
      q,
      sendResult.delivered
        ? { delivered: true }
        : { delivered: false, error: "error" in sendResult ? sendResult.error : "Unknown error" },
      at,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
  await appCtx.repos.quotes.update(outcome.quote.id, outcome.quote);
  for (const e of outcome.events) await appCtx.repos.auditEvents.insert(e);

  return c.json({
    quote: outcome.quote,
    dryRun: sendResult.dryRun,
    ...(sendResult.delivered ? {} : { sendError: "error" in sendResult ? sendResult.error : "Unknown error" }),
  });
});

app.get("/api/quotes/:id/audit", requireAccount, (c) => {
  const q = ownedQuote(c, param(c, "id"));
  if (!q) return c.json({ error: "Quote not found" }, 404);
  return c.json({ events: appCtx.repos.auditEvents.filter((e) => e.quoteId === q.id) });
});

// ── 户型图（FR-3）─────────────────────────────────────────────────────────

app.post("/api/conversations/:id/floorplan", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;
  const body = await jsonBody<{
    fileName?: string; mimeType?: string; sizeBytes?: number; image?: string;
    text?: string;
    files?: { fileName: string; mimeType: string; sizeBytes: number; image: string }[];
  }>(c);

  type FloorFile = { fileName: string; mimeType: string; sizeBytes: number; image?: string };
  const files: FloorFile[] = Array.isArray(body.files)
    ? body.files.map((f) => ({
      fileName: f.fileName ?? "floorplan",
      mimeType: f.mimeType ?? "image/png",
      sizeBytes: f.sizeBytes ?? 0,
      image: f.image,
    }))
    : [{
      fileName: body.fileName ?? "floorplan",
      mimeType: body.mimeType ?? "image/png",
      sizeBytes: body.sizeBytes ?? 0,
      image: body.image,
    }];

  // 兼容：旧客户端无 files 字段时仍走单文件；显式传空 files 则 400
  if (Array.isArray(body.files) && body.files.length === 0) {
    return c.json({ error: "At least one file is required" }, 400);
  }
  if (files.length === 0) {
    return c.json({ error: "At least one file is required" }, 400);
  }

  for (const f of files) {
    const mime = (f.mimeType ?? "").toLowerCase();
    if (!mime.startsWith("image/") && mime !== "application/pdf") {
      return c.json({ error: `Unsupported mime type: ${f.mimeType}` }, 400);
    }
  }

  const fpLang = resolveLanguage(conv.preferences?.shared);
  const at = now();
  const interpretations: string[] = [];
  let plan = undefined as Awaited<ReturnType<typeof createFloorPlanWithOutcome>>["plan"] | undefined;
  let extraction = undefined as Awaited<ReturnType<typeof createFloorPlanWithOutcome>>["extraction"] | undefined;

  for (const file of files) {
    const outcome = await createFloorPlanWithOutcome(
      {
        conversationId: conv.id,
        file: {
          name: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        },
        at,
        language: fpLang,
      },
      file.image,
      appCtx.vision,
      // 草图先判断像不像 5 种标准布局之一（FLOORPLAN_TEMPLATES）；猜中且够可信，
      // 就按该布局的墙段框架去标注图上已读到的尺寸、只追问框架里缺的那几段——
      // 而不是把草图当完全自由的墙段列表从零问起。猜不中/没猜/置信度不够时
      // 返回 undefined，parse.ts 原样退回既有的自由抽取路径。
      (raw, lang) => {
        const template = matchesKnownTemplate(raw);
        return template ? normalizeExtractionWithTemplate(raw!, template, lang) : undefined;
      },
    );
    plan = outcome.plan;
    extraction = outcome.extraction;
    await appCtx.repos.floorPlans.upsert(plan);
    interpretations.push(interpretationSummary(plan, extraction, fpLang));
  }

  // 一会话一户型：保留最后一份；家电从旧图合并过来（重传不应丢掉已确认家电）
  const keepId = plan!.id;
  const previousPlans = appCtx.repos.floorPlans.filter(
    (p) => p.conversationId === conv.id && p.id !== keepId,
  );
  const carriedAppliances = normalizeAppliances(
    previousPlans.flatMap((p) => p.appliances ?? []),
  );
  if (carriedAppliances.length > 0 && !(plan!.appliances?.length)) {
    plan = { ...plan!, appliances: carriedAppliances, updatedAt: at };
    await appCtx.repos.floorPlans.upsert(plan);
  }
  // 重传同样不应丢掉已确认的墙长/层高——新图没读出来时才补旧图的（新图读出来的
  // 数据以新图为准，不做合并，避免新旧墙段混在一起对不上号）。
  if (!plan!.parsedGeometry.wallRuns.some((r) => r.length > 0)) {
    const carriedWallRuns = previousPlans.flatMap((p) => p.parsedGeometry.wallRuns);
    if (carriedWallRuns.some((r) => r.length > 0)) {
      plan = {
        ...plan!,
        parsedGeometry: { ...plan!.parsedGeometry, wallRuns: carriedWallRuns },
        updatedAt: at,
      };
      await appCtx.repos.floorPlans.upsert(plan);
    }
  }
  if (plan!.parsedGeometry.ceilingHeight == null) {
    const carriedCeiling = previousPlans
      .map((p) => p.parsedGeometry.ceilingHeight)
      .find((h) => h != null);
    if (carriedCeiling != null) {
      plan = {
        ...plan!,
        parsedGeometry: { ...plan!.parsedGeometry, ceilingHeight: carriedCeiling },
        updatedAt: at,
      };
      await appCtx.repos.floorPlans.upsert(plan);
    }
  }
  for (const old of previousPlans) {
    await appCtx.repos.floorPlans.remove(old.id);
  }

  // FR-17：解读 + 纯文字 Q#（不附图提问，避免每轮重贴草图）
  const interpretation = interpretations.join("\n");
  const briefing = await briefingPayload(conv.id, undefined, { includeSiteDiagram: false });
  const sitePrompts = briefing.siteQuestions.slice(0, 4).map((q) => q.prompt);
  const assistantBits = [interpretation, ...sitePrompts];
  const suggestReupload = shouldSuggestReupload(plan!, extraction);
  // 识别失败 / 零墙段：1–2 轮内强制手输墙长/层高，推进 readyToDraw
  const needsManual = briefing.needsManualWalls
    || !plan!.parsedGeometry.wallRuns.some((r) => r.length > 0)
    || (extraction && extraction.status !== "ok" && extraction.status !== "notConfigured");
  if (suggestReupload) {
    assistantBits.push(reuploadPrompt(fpLang));
  }
  if (needsManual) {
    assistantBits.push(msg(fpLang,
      "Answer in text only — send wall lengths and ceiling in one message "
        + "(e.g. `<wall name> <inches>\", <wall name> <inches>\", ceiling <inches>\"`). "
        + "Then confirm each appliance with its width so we can ask whether to draw.",
      "请只用文字回答——一条消息补齐墙长和层高"
        + "（例如：`<墙名> <英寸数>寸，<墙名> <英寸数>寸，层高 <英寸数>寸`）。"
        + "随后确认家电（或说「家电后定」），即可问你要不要出图。"));
  } else if (sitePrompts.length) {
    assistantBits.push(msg(fpLang,
      "Please answer the numbered questions above in chat (text only).",
      "请在对话里用文字回答上面的编号问题即可。"));
  }
  const names = files.map((f) => f.fileName).join(fpLang === "zh" ? "、" : ", ");
  const anyImage = files.some((f) => !!f.image);
  const textPart = typeof body.text === "string" ? body.text.trim() : "";
  const uploadLine = msg(fpLang,
    `[Floor plan uploaded: ${names}]` + (anyImage ? "\n[images attached]" : ""),
    `[已上传户型图：${names}]` + (anyImage ? "\n[附图]" : ""));
  const echoMsg: ChatMessage = {
    role: "user",
    content: textPart ? `${textPart}\n${uploadLine}` : uploadLine,
    at,
  };
  const interpretMsg: ChatMessage = {
    role: "assistant",
    content: assistantBits.filter(Boolean).join("\n"),
    at,
  };
  await appCtx.repos.conversations.update(conv.id, {
    messages: [...conv.messages, echoMsg, interpretMsg],
  });

  return c.json({
    floorPlan: plan,
    ready: isLayoutReady(plan!),
    // 完整性优先：拿不准的地方逐条追问，不静默跳过（FR-3）
    questions: pendingQuestions(plan!),
    // 视觉抽取走没走、为什么没读出东西——四种情况看起来一样，要做的事完全不同
    extraction,
    interpretation,
    suggestReupload,
    intakeSamples: intakeSampleCards(fpLang),
    // FR-17.2：解读可用时前端勿再展示加墙/尺寸/形状 quick replies
    suppressGeometryIntake: briefing.geometryUsable,
    ...(extractionNote(extraction!, fpLang) ? { extractionNote: extractionNote(extraction!, fpLang) } : {}),
    ...briefing,
    replies: [interpretMsg],
  }, 201);
});

/**
 * 套用户型模板：建墙壳（标准数值，全部标记待确认）+ 生成解读复述（含墙名讲解）。
 *
 * 预填**不是**客户确认——每段墙、每处门窗都留一条待确认项，走跟手绘/上传一样的
 * Q# 核对（FR-15.5）。两个入口共用：`/floorplan-template`（客户点按钮，Phase 2
 * 之前的路径，仍保留给"其他"分支用）；主聊天入口客户直接打字点名户型
 * （见 `matchKnownShape` 调用处）。
 */
async function applyFloorplanTemplate(
  conv: Conversation,
  templateId: string,
  lang: UiLanguage,
  at: string,
): Promise<{ plan: FloorPlan; interpretation: string } | undefined> {
  const template = floorplanTemplateById(templateId);
  if (!template) return undefined;

  const previousPlans = appCtx.repos.floorPlans.filter((p) => p.conversationId === conv.id);
  const carriedAppliances = normalizeAppliances(previousPlans.flatMap((p) => p.appliances ?? []));
  for (const old of previousPlans) await appCtx.repos.floorPlans.remove(old.id);

  let plan = createChatSourcedFloorPlan(conv.id, at);
  const wallIds: string[] = [];
  for (const w of template.walls) {
    plan = addWallRun(plan, {
      label: w.label,
      length: w.length,
      ...(w.kind ? { kind: w.kind } : {}),
      ...(w.depth !== undefined ? { depth: w.depth } : {}),
      ...(w.startsAtCorner !== undefined ? { startsAtCorner: w.startsAtCorner } : {}),
    }, at);
    wallIds.push(plan.parsedGeometry.wallRuns[plan.parsedGeometry.wallRuns.length - 1]!.id);
  }
  for (const f of template.features) {
    plan = addFeature(plan, wallIds[f.wall]!, { kind: f.kind, offset: f.offset, width: f.width }, at);
  }
  plan = resolveCeilingHeight(plan, template.ceilingHeight, at);
  if (carriedAppliances.length > 0) plan = { ...plan, appliances: carriedAppliances };

  // 模板预填不是客户量的——每段墙长、每处门窗都留一条待确认项（FR-17.4 / FR-15.5）
  const confirmItems: FloorPlan["unresolvedItems"] = [];
  for (const r of plan.parsedGeometry.wallRuns) {
    confirmItems.push({
      id: `tpl_${randomUUID().slice(0, 8)}`,
      target: { kind: "wallRun", id: r.id },
      field: "length",
      reason: msg(lang,
        `Confirm "${r.label}" is about ${r.length}" (from the ${template.id} template).`,
        `请确认「${r.label}」大约是 ${r.length}"（来自 ${template.id} 模板）。`),
      suggestion: r.length,
      resolved: false,
    });
    for (const f of r.features) {
      confirmItems.push({
        id: `tpl_${randomUUID().slice(0, 8)}`,
        target: { kind: "feature", id: f.id },
        field: f.kind,
        reason: msg(lang,
          `Confirm the ${f.kind} on "${r.label}" (from the template) — offset ${f.offset}", width ${f.width}".`,
          `请确认「${r.label}」上的${f.kind}（模板预填）——距起点 ${f.offset}"，宽 ${f.width}"。`),
        suggestion: f.offset,
        resolved: false,
      });
    }
  }
  plan = {
    ...plan,
    unresolvedItems: [...plan.unresolvedItems, ...confirmItems],
    shapeTemplateId: template.id,
    updatedAt: at,
  };
  await appCtx.repos.floorPlans.upsert(plan);

  const templateNote = lang === "zh" ? template.noteZh : template.noteEn;
  const wallExplain = SHAPE_WALL_EXPLANATION[template.id];
  const explainLine = wallExplain ? (lang === "zh" ? wallExplain.zh : wallExplain.en) : "";
  const interpretation = [
    msg(lang,
      `Applied the "${templateId}" template as a starting point: ${templateNote} `
        + "These are standard numbers, not measured — please confirm below.",
      `已按「${templateId}」模板预填作为起点：${templateNote} `
        + "这些是标准数值，不是量出来的——请在下面逐项确认。"),
    explainLine,
  ].filter(Boolean).join("\n");

  return { plan, interpretation };
}

/**
 * 户型模板快选（FR-17.4）：客户选"我家像哪个"，跳过从零手绘。
 *
 * 预填**不是**客户确认——每段墙、每处门窗都留一条待确认项，走跟手绘/上传
 * 一样的 Q# 核对（FR-15.5）。选「其他」（`templateId: "other"`）等同于没选
 * 模板：维持零墙段，走既有的手动补墙追问。
 */
app.post("/api/conversations/:id/floorplan-template", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;
  const body = await jsonBody<{ templateId?: string }>(c);
  const templateId = body.templateId ?? "";
  const fpLang = resolveLanguage(conv.preferences?.shared);
  const at = now();

  // 一会话一户型：跟上传口径一致
  const previousPlans = appCtx.repos.floorPlans.filter((p) => p.conversationId === conv.id);
  const carriedAppliances = normalizeAppliances(previousPlans.flatMap((p) => p.appliances ?? []));

  if (templateId === "other" || templateId === "") {
    // 客户说都不像——维持零墙段，走既有的手动补墙追问（FR-17.2 例外条款）
    let plan = previousPlans[0];
    if (!plan) {
      plan = createChatSourcedFloorPlan(conv.id, at);
      if (carriedAppliances.length > 0) plan = { ...plan, appliances: carriedAppliances };
      await appCtx.repos.floorPlans.upsert(plan);
    }
    const briefing = await briefingPayload(conv.id, undefined, { includeSiteDiagram: false });
    const noneMsg: ChatMessage = {
      role: "assistant",
      content: msg(fpLang,
        "No problem — let's go wall by wall instead. How many walls does the kitchen have, "
          + "and roughly how long is each one?",
        "没关系，那我们一段墙一段墙来——厨房大概几面墙，每段大概多长？"),
      at,
    };
    await appCtx.repos.conversations.update(conv.id, { messages: [...conv.messages, noneMsg] });
    return c.json({
      floorPlan: plan,
      ready: isLayoutReady(plan),
      questions: pendingQuestions(plan),
      intakeSamples: intakeSampleCards(fpLang),
      ...briefing,
      replies: [noneMsg],
    });
  }

  const applied = await applyFloorplanTemplate(conv, templateId, fpLang, at);
  if (!applied) return c.json({ error: `Unknown template: ${templateId}` }, 400);
  let plan = applied.plan;

  const briefing = await briefingPayload(conv.id, undefined, { includeSiteDiagram: false });
  const sitePrompts = briefing.siteQuestions.slice(0, 4).map((q) => q.prompt);
  const interpretation = [applied.interpretation, ...sitePrompts].filter(Boolean).join("\n");
  const echoMsg: ChatMessage = {
    role: "user",
    content: msg(fpLang, `[Picked floor-plan template: ${templateId}]`, `[选择户型模板：${templateId}]`),
    at,
  };
  const interpretMsg: ChatMessage = { role: "assistant", content: interpretation, at };
  await appCtx.repos.conversations.update(conv.id, {
    messages: [...conv.messages, echoMsg, interpretMsg],
  });

  return c.json({
    floorPlan: plan,
    ready: isLayoutReady(plan),
    // 完整性优先：拿不准的地方逐条追问，不静默跳过（FR-3）
    questions: pendingQuestions(plan),
    interpretation,
    intakeSamples: intakeSampleCards(fpLang),
    // FR-17.2：解读可用时前端勿再展示加墙/尺寸/形状 quick replies
    suppressGeometryIntake: briefing.geometryUsable,
    ...briefing,
    replies: [interpretMsg],
  }, 201);
});

app.get("/api/floorplans/:id", requireAccount, (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "Floor plan not found" }, 404);
  return c.json({ floorPlan: plan, ready: isLayoutReady(plan), questions: pendingQuestions(plan) });
});

/**
 * 导入一份标准化设计输入 JSON（FR-24）——供体外系统（更强的 VL 模型读图、
 * CAD/设计软件导出、另一套系统迁移）直接套用，跳过本系统的逐项收集。
 *
 * 与户型模板（FR-17.4）同一门禁：只有 `provenance: "customer"` 的项才不
 * 生成待确认项；其余（含未声明 provenance 的）仍要走 Q# 确认，不能因为
 * 数据来自"更强的模型"就自动当成已确认。
 */
app.post("/api/conversations/:id/design-input", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;

  const raw = await jsonBody<Record<string, unknown>>(c);
  let doc;
  try {
    doc = validateDesignInputDocument(raw);
  } catch (e) {
    if (e instanceof DesignInputError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const at = now();
  // 一会话一户型：跟上传/模板选择口径一致
  const previousPlans = appCtx.repos.floorPlans.filter((p) => p.conversationId === conv.id);
  const carriedAppliances = normalizeAppliances(previousPlans.flatMap((p) => p.appliances ?? []));
  for (const old of previousPlans) await appCtx.repos.floorPlans.remove(old.id);

  const { plan, pendingConfirmCount } = applyDesignInput(conv.id, doc, at, carriedAppliances);
  await appCtx.repos.floorPlans.upsert(plan);

  const fpLang = resolveLanguage(conv.preferences?.shared);
  const briefing = await briefingPayload(conv.id, undefined, { includeSiteDiagram: false });
  const sitePrompts = briefing.siteQuestions.slice(0, 4).map((q) => q.prompt);
  const interpretation = [
    pendingConfirmCount > 0
      ? msg(fpLang,
        `Imported design data as a starting point — ${pendingConfirmCount} item(s) are not yet `
          + "confirmed and still need your OK. Please confirm below.",
        `已导入设计数据作为起点——其中 ${pendingConfirmCount} 项尚未确认，仍需你过一遍。请在下面逐项确认。`)
      : msg(fpLang,
        "Imported design data — everything came in already confirmed.",
        "已导入设计数据——所有项都已标记为确认过的。"),
    ...sitePrompts,
  ].filter(Boolean).join("\n");
  const echoMsg: ChatMessage = {
    role: "user",
    content: msg(fpLang, "[Imported design input]", "[导入设计输入]"),
    at,
  };
  const interpretMsg: ChatMessage = { role: "assistant", content: interpretation, at };
  await appCtx.repos.conversations.update(conv.id, {
    messages: [...conv.messages, echoMsg, interpretMsg],
  });

  return c.json({
    floorPlan: plan,
    ready: isLayoutReady(plan),
    questions: pendingQuestions(plan),
    interpretation,
    intakeSamples: intakeSampleCards(fpLang),
    suppressGeometryIntake: briefing.geometryUsable,
    ...briefing,
    replies: [interpretMsg],
  }, 201);
});

/**
 * 导出当前已确认的设计输入为同一套 schema（FR-24）——供客户换会话/换设备
 * 带走已确认的结果，或供另一套系统直接消费。
 */
app.get("/api/conversations/:id/design-input", requireAccount, (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const plan = planForConversation(conv.id);
  if (!plan) return c.json({ error: "No floor plan yet" }, 404);
  return c.json({ designInput: exportDesignInput(plan) });
});

/** 客户回答追问 / 手动补齐尺寸。 */
app.post("/api/floorplans/:id/resolve", requireAccount, async (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "Floor plan not found" }, 404);
  const archivedPlan = rejectIfPlanConversationArchived(c, plan);
  if (archivedPlan) return archivedPlan;
  const body = await jsonBody<{
    itemId: string; wallRunId: string; length: number; ceilingHeight: number;
    /**
     * 加一段墙。**默认与上一段相接**——人报自己家厨房时报的是一圈连着的墙。
     * 岛台传 `kind: "island"`（外加 `depth`），它不接任何墙。
     */
    addRun: {
      label: string; length: number;
      startsAtCorner?: boolean; endsAtCorner?: boolean;
      kind?: "wall" | "island"; depth?: number;
    };
    addFeature: { wallRunId: string; kind: WallFeature["kind"]; offset: number; width: number };
    /** 改一个已存在特征的位置/宽度（已确认面板用，不是新加一个）。 */
    editFeature: { wallRunId: string; featureId: string; offset?: number; width?: number };
    /**
     * 这个厨房里的家电（FR-3.2）。
     *
     * 不给 `width` 就走常见尺寸并标 `provenance: "assumed"`——「我不确定」是
     * 合法答案，但推定值要留痕，下游的解释与硬约束提示都读它。
     */
    appliances: {
      kind: ApplianceKind; width?: number;
      clearanceEachSide?: number; preferredZone?: ApplianceSpec["preferredZone"];
      /** 冰箱高度（英寸）——决定上方能不能装吊柜；其余家电类型忽略这个字段。 */
      height?: number;
    }[];
  }>(c);

  const resolveLang = resolveLanguage(
    appCtx.repos.conversations.byId(plan.conversationId)?.preferences?.shared);
  let next = plan;
  try {
    if (body.addRun) next = addWallRun(next, body.addRun, now());
    if (body.wallRunId && typeof body.length === "number") {
      next = resolveWallLength(next, body.wallRunId, body.length, now());
    }
    if (typeof body.ceilingHeight === "number") next = resolveCeilingHeight(next, body.ceilingHeight, now());
    // 窗户、上下水、家电位。**没有这个入口，没有视觉模型时就永远排不出水槽柜**——
    // 排布引擎靠 run.features 决定水槽放哪、哪段墙不放吊柜。
    if (body.addFeature) {
      const f = body.addFeature;
      const run = next.parsedGeometry.wallRuns.find((r) => r.id === f.wallRunId);
      if (!run) return c.json({ error: `Wall run ${f.wallRunId} not found` }, 400);
      if (typeof f.offset !== "number" || typeof f.width !== "number" || f.width <= 0) {
        return c.json({ error: "Feature needs offset and a positive width (inches)" }, 400);
      }
      if (f.offset < 0 || f.offset + f.width > run.length) {
        return c.json({
          error: `${f.kind} at ${formatInches(f.offset)}–${formatInches(f.offset + f.width)} ` +
            `is outside ${run.label} (${formatInches(run.length)})`,
        }, 400);
      }
      next = addFeature(next, f.wallRunId, {
        kind: f.kind, offset: f.offset, width: f.width,
      }, now());
    }
    if (body.editFeature) {
      const e = body.editFeature;
      const run = next.parsedGeometry.wallRuns.find((r) => r.id === e.wallRunId);
      if (!run) return c.json({ error: `Wall run ${e.wallRunId} not found` }, 400);
      const feature = run.features.find((f) => f.id === e.featureId);
      if (!feature) return c.json({ error: `Feature ${e.featureId} not found on ${run.label}` }, 400);
      const offset = e.offset ?? feature.offset;
      const width = e.width ?? feature.width;
      if (offset < 0 || offset + width > run.length) {
        return c.json({
          error: `${feature.kind} at ${formatInches(offset)}–${formatInches(offset + width)} ` +
            `is outside ${run.label} (${formatInches(run.length)})`,
        }, 400);
      }
      next = updateFeature(next, e.wallRunId, e.featureId, { offset: e.offset, width: e.width }, now());
    }
    if (body.appliances) {
      if (!Array.isArray(body.appliances)) {
        return c.json({ error: "appliances must be an array" }, 400);
      }
      next = {
        ...next,
        appliances: normalizeAppliances([
          ...(next.appliances ?? []),
          ...body.appliances.map((a) => applianceFrom({ ...a, language: resolveLang })),
        ]),
        updatedAt: now(),
      };
    }
    if (body.itemId) next = resolveItem(next, body.itemId, now());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  await appCtx.repos.floorPlans.upsert(next);
  const resolveBriefing = await briefingPayload(next.conversationId);
  const fitWarnings = (() => {
    const apps = next.appliances ?? [];
    if (!apps.length || !next.parsedGeometry.wallRuns.some((r) => r.length > 0)) return [];
    return planAppliances(next.parsedGeometry, apps, resolveLang).warnings;
  })();
  return c.json({
    floorPlan: next, ready: isLayoutReady(next), questions: pendingQuestions(next),
    ...resolveBriefing,
    ...(fitWarnings.length
      ? {
          applianceFitOk: false,
          applianceFitWarnings: fitWarnings.map((w) => w.message),
        }
      : { applianceFitOk: true }),
    // 有推定尺寸就如实说出来，并把还能问的问题一并给出——
    // 「我们假设了什么」不该只活在文案里
    ...(next.appliances?.length
      ? (() => {
          const note = provenanceNote(next.appliances, resolveLang);
          return {
            appliances: next.appliances,
            ...(note ? { provenanceNote: note } : {}),
            applianceQuestions: buildApplianceQuestions({
              known: next.appliances, kindsAnswered: true, maxPerTurn: 2,
              language: resolveLang,
            }),
          };
        })()
      : {
          applianceQuestions: buildApplianceQuestions({
            known: [], kindsAnswered: false, maxPerTurn: 1, language: resolveLang,
          }),
        }),
  });
});

// ── 设计会话：先问再画（FR-4.2）───────────────────────────────────────────

/**
 * 当前该做什么。
 *
 * 资料齐了会推进到 `readyToDraw` 并给出**「需要我帮你生成设计图吗？」**——
 * 系统不替客户决定什么时候开始看方案。
 */
app.get("/api/conversations/:id/design", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  // FR-18：未选厂商时走通用哨兵，不再 400
  const rawCompanyId = (c.req.query("companyId") ?? "").trim();
  const companyId = rawCompanyId || GENERIC_DESIGN_COMPANY_ID;
  const generic = isGenericDesignCompany(companyId);
  const readinessCompanyId = generic ? undefined : companyId;

  const session = await sessionFor(conv.id, companyId);
  const plan = planForConversation(conv.id);
  const readiness = designReadinessFor(conv.id, readinessCompanyId);
  const missing = intakeMissing(conv.id);
  const briefing = await briefingPayload(conv.id, readinessCompanyId);

  const stored = plan
    ? appCtx.repos.storedLayouts.byId(layoutKey(plan.id, companyId))
    : undefined;

  const basePrompt = stagePrompt(session, {
    language: convLanguage(conv),
    missingFields: readiness.openItems.map((i) => i.brief),
    ...(stored ? { planAcceptable: stored.acceptable } : {}),
  });
  const prompt = session.stage === "readyToDraw"
    ? { ...basePrompt, message: `${readiness.confirmationText}\n\n${basePrompt.message}` }
    : basePrompt;

  return c.json({
    session,
    prompt,
    allowed: allowedArtifacts(session.stage),
    missingFields: missing,
    generic,
    companyId: generic ? null : companyId,
    ...briefing,
  });
});

/**
 * 客户对「要不要出图」的回答，以及后续的阶段推进。
 *
 * 这些是**客户的动作**，不是系统自己往前走——这正是这套阶段机存在的理由。
 */
app.post("/api/conversations/:id/design/advance", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const archived = rejectIfArchived(c, conv);
  if (archived) return archived;
  const body = await jsonBody<{
    companyId: string;
    action: "consent" | "defer" | "approvePlan" | "backToPlan" | "revise";
    note: string;
    /** revise 专用：这一轮要改的偏好项（与 /preferences 同一套取值）。 */
    changes: Partial<CustomerPreferences>;
  }>(c);
  // FR-18：未选厂商时走通用设计哨兵；@ 厂商后用真实 companyId 重开进程
  const companyId = (body.companyId ?? "").trim() || GENERIC_DESIGN_COMPANY_ID;
  const generic = isGenericDesignCompany(companyId);

  if (generic && (body.action === "revise" || body.action === "approvePlan")) {
    return c.json({
      error: msg(convLanguage(conv),
        "This is a generic preview. @ a seller first to revise or unlock full company drawings.",
        "这是通用示意。请先 @ 一家厂商，再改排布或出该公司完整图纸。"),
      code: "GENERIC_NEEDS_COMPANY",
      needCompany: true,
    }, 409);
  }

  let session = await sessionFor(conv.id, companyId);
  const at = now();
  try {
    switch (body.action) {
      case "consent": session = grantDrawingConsent(session, at, body.note); break;
      case "defer": session = deferDrawing(session, at); break;
      case "approvePlan": session = approvePlan(session, at); break;
      case "backToPlan": session = backToPlan(session, at); break;
      case "revise": {
        // 一轮修改要真的改到输入上，否则下一版会画出一模一样的图（stages.ts）
        const applied = await applyRevision(conv.id, companyId, body.changes ?? {});
        if (applied.error) return c.json({ error: applied.error }, 400);
        session = recordPlanRevision(session, at, {
          ...(body.note ? { note: body.note } : {}),
          applied: applied.keys,
          ...(applied.keys.length === 0
            ? { unapplied: msg(convLanguage(conv),
              "Nothing in this round could be applied to the layout — same as the previous version.",
              "这一轮没有可落到排布上的具体改动，方案与上一版相同。") }
            : {}),
        });
        if (body.note) await maybeEnqueueSessionCorrection(conv, body.note);
        break;
      }
      default: return c.json({ error: `Unknown action ${String(body.action)}` }, 400);
    }
  } catch (e) {
    if (e instanceof StageError) return c.json({ error: e.message, stage: session.stage }, 409);
    throw e;
  }

  const saved = await appCtx.repos.designSessions.upsert(session);
  const plan = planForConversation(conv.id);
  const stored = plan && !generic
    ? appCtx.repos.storedLayouts.byId(layoutKey(plan.id, companyId))
    : undefined;
  await maybeRunCritique(conv.id, "stageAdvance");
  const lang = convLanguage(conv);
  const prompt = stagePrompt(saved, {
    language: lang,
    missingFields: missingFields(conv.designRequirements),
    ...(stored ? { planAcceptable: stored.acceptable } : {}),
  });
  // 通用同意出图：提示这是示意，并引导稍后 @ 厂商
  const genericPrompt = generic && body.action === "consent"
    ? {
      ...prompt,
      message: msg(lang,
        "Here's a generic layout preview from industry size steps — not any seller's real SKUs. "
          + "@ a company when you want a layout from their published catalog.",
        "这是按行业通用尺寸档位生成的示意排布，**不对应任何厂商真实型号**。"
          + "想按某厂规格出方案时，请 @ 该公司。"),
    }
    : prompt;

  return c.json({
    session: saved,
    prompt: genericPrompt,
    allowed: allowedArtifacts(saved.stage),
    generic,
    companyId: generic ? null : companyId,
    // 这一轮到底改到了什么——客户提的和系统改的分开报，不含糊
    ...(body.action === "revise"
      ? { revision: saved.revisionRequests?.[saved.revisionRequests.length - 1] }
      : {}),
  });
});

/**
 * 未选厂商时的全局俯视示意（FR-18）——伪模块 + GenericCatalog。
 * 结构上无真实 companyId，不能进报价发送闸门；@ 厂商后改走 /plan-view。
 */
app.post("/api/floorplans/:id/generic-plan-view", requireAccount, async (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "Floor plan not found" }, 404);
  const archivedPlanView = rejectIfPlanConversationArchived(c, plan);
  if (archivedPlanView) return archivedPlanView;
  if (!isLayoutReady(plan)) {
    return c.json({ error: "Floor plan is still incomplete", questions: pendingQuestions(plan) }, 409);
  }

  const session = await sessionFor(plan.conversationId, GENERIC_DESIGN_COMPANY_ID);
  const conv = appCtx.repos.conversations.byId(plan.conversationId);
  const planLang = resolveLanguage(conv?.preferences?.shared);
  if (!allowedArtifacts(session.stage).planView) {
    return c.json({
      error: msg(planLang,
        "Not ready to draw yet — please confirm “Shall I generate a design drawing?” first.",
        "还没到出图阶段——请先确认「需要我帮你生成设计图吗？」"),
      stage: session.stage,
      prompt: stagePrompt(session, { language: planLang, missingFields: [] }),
    }, 409);
  }

  const pseudoModules = catalogToPseudoModules(appCtx.catalog);
  const shared = (conv?.preferences?.shared ?? {}) as CustomerPreferences;
  const layoutOpts = {
    ...(plan.parsedGeometry.ceilingHeight !== undefined
      ? { ceilingHeight: plan.parsedGeometry.ceilingHeight } : {}),
    drawerBias: drawerBiasFor(shared),
    language: planLang,
    ...(shared.layoutHints ? { layoutHints: shared.layoutHints } : {}),
    ...(plan.appliances?.length ? { appliances: plan.appliances } : {}),
    ...layoutKnowledgeOpts(),
  };
  const layout = generateLayout(plan.parsedGeometry, pseudoModules, layoutOpts);

  const account = c.get("account");
  const moduleCounts: Partial<Record<ModuleType, number>> = {};
  for (const m of layout.moduleCounts) {
    const mod = pseudoModules.find((p) => p.id === m.moduleId);
    if (!mod) continue;
    moduleCounts[mod.type] = (moduleCounts[mod.type] ?? 0) + m.qty;
  }
  const draft = buildEstimateDraft(appCtx.catalog, {
    conversationId: plan.conversationId,
    moduleCounts,
    province: account.province,
    at: now(),
  }, {
    taxRules: appCtx.taxRules,
    sourceVerified: appCtx.catalogSourceVerified,
    language: planLang,
  });
  await appCtx.repos.estimates.insert(draft);

  const viewsDisclaimer = msg(planLang,
    "Views are drawn from common industry size steps — **not any seller's real SKUs**. "
      + "After you @ a company, the system re-layouts with that company's published catalog.",
    "示意图按行业通用尺寸档位绘制，**不对应任何具体公司的真实型号**。"
      + "选定公司后，系统会用该公司规格库里真实存在的型号重新排布并出图。");

  const { designLayoutId, revisionNo } = await persistLayout({
    plan,
    companyId: GENERIC_DESIGN_COMPANY_ID,
    layout,
    triggeredBy: "auto",
    changeSummary: msg(planLang,
      "Generic preview layout (industry size steps — not a seller catalog)",
      "通用示意排布（行业尺寸档位，非厂商目录）"),
  });

  return c.json({
    designLayoutId,
    revisionNo,
    stage: session.stage,
    generic: true,
    deliverableReady: true,
    planViews: renderPlanViews(plan.parsedGeometry, layout.placements),
    moduleCounts: layout.moduleCounts,
    acceptable: layout.acceptable,
    warnings: layout.warnings,
    estimate: draft,
    estimateText: renderEstimateText(draft, planLang),
    viewsDisclaimer,
    prompt: stagePrompt(session, {
      language: planLang,
      planAcceptable: layout.acceptable,
    }),
  }, 201);
});

/**
 * 全局俯视图 —— 客户第一个看到的图，多轮修改都在它上面进行。
 *
 * 单段墙的俯视图回答不了「L 型两条边怎么接」「U 型中间还剩多宽」，
 * 而这恰恰是客户第一眼要判断的（见 render/plan-view.ts）。
 */
app.post("/api/floorplans/:id/plan-view", requireAccount, async (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "Floor plan not found" }, 404);
  const archivedPlanView = rejectIfPlanConversationArchived(c, plan);
  if (archivedPlanView) return archivedPlanView;
  if (!isLayoutReady(plan)) {
    return c.json({ error: "Floor plan is still incomplete", questions: pendingQuestions(plan) }, 409);
  }
  const body = await jsonBody<{ companyId: string }>(c);
  const company = body.companyId ? appCtx.repos.companies.byId(body.companyId) : undefined;
  if (!company || !isCompanyActive(company)) return c.json({ error: "Company not found or unavailable" }, 404);
  const bundle = publishedBundle(appCtx, company.id);
  if (!bundle) return c.json({ error: "Company has no published catalog" }, 409);

  const session = await sessionFor(plan.conversationId, company.id);
  const convEarly = appCtx.repos.conversations.byId(plan.conversationId);
  if (!allowedArtifacts(session.stage).planView) {
    return c.json({
      error: msg(resolveLanguage(convEarly?.preferences?.shared),
        "Not ready to draw yet — please confirm “Shall I generate a design drawing?” first.",
        "还没到出图阶段——请先确认「需要我帮你生成设计图吗？」"),
      stage: session.stage,
      prompt: stagePrompt(session, {
        language: resolveLanguage(convEarly?.preferences?.shared),
        missingFields: [],
      }),
    }, 409);
  }

  const conv = convEarly;
  const prefs = conv ? prefsFor(conv, company.id) : {};
  const planLang = resolveLanguage(conv?.preferences?.shared);
  const layoutOpts = {
    ...(plan.parsedGeometry.ceilingHeight !== undefined
      ? { ceilingHeight: plan.parsedGeometry.ceilingHeight } : {}),
    drawerBias: drawerBiasFor(prefs),
    language: planLang,
    ...(prefs.layoutHints ? { layoutHints: prefs.layoutHints } : {}),
    // 客户报过的家电按实际尺寸留空；没报过就用兜底（标为推定值，FR-3.2）
    ...(plan.appliances?.length ? { appliances: plan.appliances } : {}),
    ...layoutKnowledgeOpts(),
  };

  // FR-14：按阻断 SR 定向修复（转角/灶台/过道等）+ 有限次重试；仍失败则叙事、不泄半成品
  let geometryForLayout = plan.parsedGeometry;
  let layout = generateLayout(geometryForLayout, bundle.modules, layoutOpts);
  let explanation = explanationFor(plan, layout, company.id, prefs, planLang);
  let planNotes = applianceNotes(plan, layout.acceptable, planLang);
  let audit = auditDeliverable({
    deliverable: "planView", stage: session.stage,
    layout, wallRuns: geometryForLayout.wallRuns,
    ...(plan.appliances?.length ? { appliances: plan.appliances } : {}),
    customerFacingText: customerText(explanation, planNotes),
    language: planLang,
  });
  let fixAttempts = 0;
  const strategies = repairStrategiesFor(audit);
  while (!audit.ok && fixAttempts < MAX_LAYOUT_FIX_ATTEMPTS && fixAttempts < strategies.length) {
    const strategy = strategies[fixAttempts]!;
    fixAttempts += 1;
    const applied = applyRepairStrategy(layoutOpts, geometryForLayout, strategy);
    if (applied.geometry) geometryForLayout = applied.geometry;
    layout = generateLayout(geometryForLayout, bundle.modules, applied.opts);
    explanation = explanationFor(plan, layout, company.id, prefs, planLang);
    planNotes = applianceNotes(plan, layout.acceptable, planLang);
    audit = auditDeliverable({
      deliverable: "planView", stage: session.stage,
      layout, wallRuns: geometryForLayout.wallRuns,
      ...(plan.appliances?.length ? { appliances: plan.appliances } : {}),
      customerFacingText: customerText(explanation, planNotes),
      language: planLang,
    });
  }
  // 定向缩短岛台且最终过闸 → 落库几何，避免下一轮又变回过窄过道
  if (audit.ok && geometryForLayout !== plan.parsedGeometry) {
    await appCtx.repos.floorPlans.upsert({
      ...plan,
      parsedGeometry: geometryForLayout,
      updatedAt: now(),
    });
  }

  const lastRevision = session.revisionRequests?.[session.revisionRequests.length - 1];
  const { designLayoutId, revisionNo } = await persistLayout({
    plan, companyId: company.id, layout,
    triggeredBy: session.planRevisions > 0 ? "customerRequest" : "auto",
    // 版本说明要写清「因为客户说了什么才改的」，而不是只留一个轮次编号——
    // 一年后回看这条记录，"第 3 轮调整" 什么也没说明（§3.6 的版本可追溯）
    changeSummary: (() => {
      const lang = planLang;
      if (!lastRevision) {
        return msg(lang, "Initial overall plan layout", "首版全局排布");
      }
      const note = lastRevision.note ?? msg(lang, "customer requested changes", "客户要求调整");
      const applied = lastRevision.applied.length
        ? msg(lang, ` (changed: ${lastRevision.applied.join(", ")})`, `（改动：${lastRevision.applied.join("、")}）`)
        : msg(lang, " (nothing applicable to the layout)", "（无可落到排布上的改动）");
      return msg(lang,
        `Revision ${session.planRevisions + 1}: ${note}${applied}`,
        `第 ${session.planRevisions + 1} 版：${note}${applied}`);
    })(),
  });

  await recordAuditAndCritique({
    conversationId: plan.conversationId,
    deliverable: "planView",
    audit,
    trigger: "planView",
    designLayoutId,
  });

  const deliverableReady = customerMayPreviewDeliverable(audit);
  const cabinetIndex = buildCabinetIndex(layout.placements);
  const adjustingNarrative = !deliverableReady
    ? renderAdjustingNarrative(audit, planLang, {
      attempt: Math.max(1, fixAttempts),
      maxAttempts: MAX_LAYOUT_FIX_ATTEMPTS,
    })
    : undefined;

  return c.json({
    designLayoutId, revisionNo,
    stage: session.stage,
    deliverableReady,
    ...(adjustingNarrative ? { adjusting: true, narrative: adjustingNarrative } : {}),
    // 闸门未过：不把半成品 SVG 当「可预览交付」
    ...(deliverableReady
      ? { planViews: renderPlanViews(plan.parsedGeometry, layout.placements) }
      : { planViews: { base: "", wall: "", note: adjustingNarrative } }),
    moduleCounts: layout.moduleCounts,
    cabinetIndex,
    audit, auditText: renderAuditText(audit, planLang),
    ergonomics: layout.ergonomics,
    // 推定的家电尺寸会影响硬约束结论——**由推定值导致的否决必须说明它是推定的**，
    // 否则客户会以为自己的厨房真的排不下（FR-3.2）
    ...planNotes,
    aesthetics: layout.aesthetics,
    acceptable: layout.acceptable,
    warnings: layout.warnings,
    explanation,
    prompt: stagePrompt(session, {
      language: planLang,
      planAcceptable: layout.acceptable,
    }),
    /** 这一版是应哪次修改而出的——客户能对上自己刚说的话。 */
    ...(lastRevision ? { revision: lastRevision } : {}),
  }, 201);
});

// ── 方案生成与四视图（FR-4 / FR-5）────────────────────────────────────────

app.post("/api/floorplans/:id/layout", requireAccount, async (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "Floor plan not found" }, 404);
  const archivedLayout = rejectIfPlanConversationArchived(c, plan);
  if (archivedLayout) return archivedLayout;
  if (!isLayoutReady(plan)) {
    return c.json({
      error: "Floor plan is still incomplete — resolve pending items first",
      questions: pendingQuestions(plan),
    }, 409);
  }
  const body = await jsonBody<{ companyId: string }>(c);
  const company = body.companyId ? appCtx.repos.companies.byId(body.companyId) : undefined;
  if (!company || !isCompanyActive(company)) return c.json({ error: "Company not found or unavailable" }, 404);
  const bundle = publishedBundle(appCtx, company.id);
  if (!bundle) return c.json({ error: "Company has no published catalog" }, 409);

  // 完整四视图要等客户在全局俯视图上点过头——一上来给四张图，
  // 客户不知道该看哪张、该对哪张提意见（design/stages.ts）
  const session = await sessionFor(plan.conversationId, company.id);
  const convEarly = appCtx.repos.conversations.byId(plan.conversationId);
  if (!allowedArtifacts(session.stage).fourViews) {
    return c.json({
      error: (() => {
        const lang = resolveLanguage(convEarly?.preferences?.shared);
        return session.stage === "planReview"
          ? msg(lang,
              "Confirm the overall plan layout first, then we can produce the full four views",
              "请先在全局俯视图上确认排布，再出完整四视图")
          : msg(lang,
              "Not ready to draw yet — please confirm “Shall I generate a design drawing?” first.",
              "还没到出图阶段——请先确认「需要我帮你生成设计图吗？」");
      })(),
      stage: session.stage,
      prompt: stagePrompt(session, {
        language: resolveLanguage(convEarly?.preferences?.shared),
        missingFields: [],
      }),
    }, 409);
  }

  // 储物偏好进的是**排布算法**，不是记下来给人看：选"尽量多做抽屉"会改变装箱
  // 候选的偏好项，进而改变实际排出来的柜型（preferences/questions.ts 的 storage 题）
  const conv = convEarly;
  const prefs = conv ? prefsFor(conv, company.id) : {};
  const layout = generateLayout(plan.parsedGeometry, bundle.modules, {
    ...(plan.parsedGeometry.ceilingHeight !== undefined
      ? { ceilingHeight: plan.parsedGeometry.ceilingHeight } : {}),
    drawerBias: drawerBiasFor(prefs),
    language: resolveLanguage(conv?.preferences?.shared),
    ...(prefs.layoutHints ? { layoutHints: prefs.layoutHints } : {}),
    // 客户报过的家电按实际尺寸留空；没报过就用兜底（标为推定值，FR-3.2）
    ...(plan.appliances?.length ? { appliances: plan.appliances } : {}),
    ...layoutKnowledgeOpts(),
  });
  const { designLayoutId, revisionNo } = await persistLayout({
    plan, companyId: company.id, layout,
    triggeredBy: "auto",
    changeSummary: msg(resolveLanguage(conv?.preferences?.shared), "Auto-generated initial layout from floor plan", "按户型自动生成初版方案"),
  });

  // 交付前审核（FR-14）。四视图这一步已经有完整 BOM 与偏好落实结果，
  // 所以查得比俯视图那一步更全
  const layoutLang = resolveLanguage(conv?.preferences?.shared);
  const bom = bomFor(plan, layout, company.id, layoutLang);
  const selections = applyPreferencesToSelections(bomToSelections(bom), prefs, bundle);
  const unapplied = unappliedPreferences(bomToSelections(bom), prefs, bundle, layoutLang);
  const explanation = explanationFor(
    plan, layout, company.id, prefs, layoutLang);
  const notes = applianceNotes(plan, layout.acceptable, layoutLang);
  const audit = auditDeliverable({
    deliverable: "fourViews", stage: session.stage,
    layout, wallRuns: plan.parsedGeometry.wallRuns,
    modules: bundle.modules, bom,
    ...(plan.appliances?.length ? { appliances: plan.appliances } : {}),
    unappliedPreferences: unapplied,
    customerFacingText: customerText(explanation, notes),
    language: layoutLang,
  });

  await recordAuditAndCritique({
    conversationId: plan.conversationId,
    deliverable: "fourViews",
    audit,
    trigger: "fourViews",
    designLayoutId,
  });

  const deliverableReady = customerMayPreviewDeliverable(audit);
  const adjustingNarrative = !deliverableReady
    ? renderAdjustingNarrative(audit, layoutLang)
    : undefined;

  return c.json({
    layoutKey: layoutKey(plan.id, company.id),
    designLayoutId,
    revisionNo,
    deliverableReady,
    ...(adjustingNarrative ? { adjusting: true, narrative: adjustingNarrative } : {}),
    warnings: layout.warnings,
    moduleCounts: layout.moduleCounts,
    cabinetIndex: buildCabinetIndex(layout.placements),
    audit, auditText: renderAuditText(audit, layoutLang),
    // 人体工程硬约束与美观评分（FR-4）
    ergonomics: layout.ergonomics,
    ...notes,
    aesthetics: layout.aesthetics,
    acceptable: layout.acceptable,
    // 直接可喂给 /api/quotes（结构里没有任何价格字段，FR-8）。
    // 五金/配件按 appliesTo* 过滤后才加上——加到装不了的柜体上会被定价校验整单拒绝
    // 完整 BOM：柜体 + 填缝条 + 踢脚/地脚 + 收口板。
    // 只报柜体的话，客户拿到的是一份缺料的价格（见 layout/bom.ts）
    selections,
    bomMissing: bom.missing,
    // 偏好没能完全落实时如实说明——静默地部分落实最坏（客户拆箱才发现吊柜是平板的）
    unappliedPreferences: unapplied,
    // 闸门未过：不把半成品图当可预览交付（选型数据仍保留供内部迭代）
    planViews: deliverableReady
      ? renderPlanViews(plan.parsedGeometry, layout.placements)
      : { base: "", wall: "", note: adjustingNarrative },
    views: deliverableReady ? viewsFor(plan, layout, company.id) : [],
    // 图纸配解释：这是什么图、为什么这么排（全部来自算出来的结果）
    explanation,
    appliedPreferences: prefs,
  }, 201);
});

/** 局部重算：只重排指定墙段，其余原样保留（场景 D 第 4 点）。 */
app.post("/api/floorplans/:id/layout/regenerate", requireAccount, async (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "Floor plan not found" }, 404);
  const archivedRegen = rejectIfPlanConversationArchived(c, plan);
  if (archivedRegen) return archivedRegen;
  const body = await jsonBody<{ companyId: string; wallRunId: string }>(c);
  const companyId = body.companyId ?? "";
  const current = storedLayoutFor(plan.id, companyId);
  if (!current) return c.json({ error: "No layout has been generated yet" }, 404);
  const bundle = companyId ? publishedBundle(appCtx, companyId) : undefined;
  if (!bundle) return c.json({ error: "Company has no published catalog" }, 409);

  const conv = appCtx.repos.conversations.byId(plan.conversationId);
  const prefs = conv ? prefsFor(conv, companyId) : {};
  const next = regenerateRun(current, plan.parsedGeometry, bundle.modules, body.wallRunId ?? "", {
    ...(plan.parsedGeometry.ceilingHeight !== undefined
      ? { ceilingHeight: plan.parsedGeometry.ceilingHeight } : {}),
    drawerBias: drawerBiasFor(prefs),
    language: resolveLanguage(conv?.preferences?.shared),
    // 客户报过的家电按实际尺寸留空；没报过就用兜底（标为推定值，FR-3.2）
    ...(plan.appliances?.length ? { appliances: plan.appliances } : {}),
  });
  const { designLayoutId, revisionNo } = await persistLayout({
    plan, companyId, layout: next,
    triggeredBy: "customerRequest",
    changeSummary: msg(resolveLanguage(conv?.preferences?.shared),
      `Customer requested re-layout of run ${body.wallRunId ?? ""}`,
      `客户要求重排 ${body.wallRunId ?? ""} 段`),
  });
  return c.json({
    layoutKey: layoutKey(plan.id, companyId),
    designLayoutId,
    revisionNo,
    warnings: next.warnings,
    moduleCounts: next.moduleCounts,
    ergonomics: next.ergonomics,
    aesthetics: next.aesthetics,
    acceptable: next.acceptable,
    selections: applyPreferencesToSelections(toSelections(next), prefs, bundle),
    unappliedPreferences: unappliedPreferences(toSelections(next), prefs, bundle, resolveLanguage(conv?.preferences?.shared)),
    views: viewsFor(plan, next, companyId),
    explanation: explanationFor(
      plan, next, companyId, prefs, resolveLanguage(conv?.preferences?.shared)),
    appliedPreferences: prefs,
  });
});

// ── 多公司比价（FR-6）─────────────────────────────────────────────────────

app.get("/api/conversations/:id/comparison", requireAccount, (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const cmpLang = resolveLanguage(conv.preferences?.shared);
  const cmp = buildComparison(
    conv.id,
    appCtx.repos.quotes.filter((q) => q.conversationId === conv.id),
    (id) => appCtx.repos.companies.byId(id)?.name,
    now(),
    cmpLang,
  );
  return c.json({
    comparison: cmp,
    text: renderComparisonText(cmp, cmpLang),
    html: renderComparisonHtml(cmp, cmpLang),
  });
});

// ── 视图渲染（脸型文法）───────────────────────────────────────────────────

app.get("/api/render/face", (c) => {
  const code = c.req.query("code");
  const width = Number(c.req.query("width") ?? 30);
  const height = Number(c.req.query("height") ?? BASE_FACE_HEIGHT);
  let templateId = c.req.query("template") as FaceTemplateId | undefined;
  let params = {};

  if (code) {
    const match = matchFaceTemplate(code);
    if (!match) return c.json({ error: `SKU ${code} did not match a face template — needs manual mapping` }, 422);
    templateId = match.templateId;
    params = match.params;
  }
  if (!templateId) return c.json({ error: "code or template is required" }, 400);

  try {
    const layout = layoutFace(buildFace(templateId, params), width, height, {
      overlay: "full", construction: "framed", faceFrameWidth: 1.5,
    });
    return c.body(toSvg(layout, { title: code ?? templateId }), 200, {
      "content-type": "image/svg+xml; charset=utf-8",
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

// ── 邮件列表（FR-12）──────────────────────────────────────────────────────

app.post("/api/subscribe", async (c) => {
  const body = await jsonBody<{
    email: string; companyName: string; consent: boolean; lang?: string;
  }>(c);
  const ua = c.req.header("user-agent");
  const ip = c.req.header("x-forwarded-for");
  const lang = (body.lang === "zh" || c.req.query("lang") === "zh" ? "zh" : "en") as "en" | "zh";
  try {
    const sub = subscribe({
      email: body.email ?? "",
      companyName: body.companyName ?? "",
      consentGiven: body.consent === true,
      termsVersion: appCtx.termsVersion,
      ...(ua ? { userAgent: ua } : {}),
      ...(ip ? { ipAddress: ip } : {}),
      at: now(),
      language: lang,
    });
    await appCtx.repos.subscriptions.insert(sub);
    // 匹配市场库，形成「投放 → 订阅 → 入驻」的转化漏斗（场景 I 第 7 点）
    const prospect = appCtx.repos.prospects.find((p) => p.email.toLowerCase() === sub.email);
    if (prospect) await appCtx.repos.prospects.update(prospect.id, { status: "subscribed", lastUpdated: now() });
    return c.json({ ok: true, unsubscribeToken: sub.unsubscribeToken }, 201);
  } catch (e) {
    if (e instanceof SubscriptionError) return c.json({ error: e.message, code: e.code }, 400);
    return c.json({
      error: msg(lang, "Email is already on the mailing list", "该邮箱已在邮件列表中"),
    }, 409);
  }
});

/** CASL：退订必须真的生效。GET 便于邮件里直接点击。 */
app.get("/unsubscribe", async (c) => {
  const lang = (c.req.query("lang") === "zh" ? "zh" : "en") as "en" | "zh";
  try {
    const updated = unsubscribeByToken(
      appCtx.repos.subscriptions.all(), c.req.query("token") ?? "", now(), lang);
    await appCtx.repos.subscriptions.update(updated.id, updated);
    return c.html(
      "<p lang=en>You have been unsubscribed. You will not receive further emails from us.</p>"
      + "<p lang=zh-CN>你已退订。我们不会再向你发送此类邮件。</p>");
  } catch {
    return c.html(
      "<p lang=en>This unsubscribe link is invalid or has expired.</p>"
      + "<p lang=zh-CN>退订链接无效或已失效。</p>",
      400);
  }
});

// ── 公司侧：规格录入与发布（FR-2 / SCENARIOS 场景 A）──────────────────────
//
// 这一整套状态机在 `spec/onboarding.ts` 里早就写好了，但**一直没有出口**：
// 只有种子文件在进程内调它。也就是说，一家真实商家没有任何办法把自己的价目表
// 录进来——供给侧这一半从外面看是不存在的。下面是那个出口。
//
// 鉴权走 `requireCompany`：先证明你是这家公司，再按你的身份操作。规格是一家
// 商家最核心的资产，拿 URL 里的 companyId 当身份等于没有隔离。

/** 空白模板。商家照着填，比让他猜我们要什么格式强。 */
app.get("/api/company/:companyId/spec/templates", requireCompany, (c) =>
  c.json({
    templates: blankTemplates(),
    note: "Row 1 of each sheet is the header; row 2+ are examples — replace with your catalog. " +
      "boxMaterials is optional — sellers with a single box material can omit that sheet.",
  }));

/** 开一段录入会话，同时产生一个 draft 版本。已有未发布的草稿就接着那一段。 */
app.post("/api/company/:companyId/spec/sessions", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  const versions = appCtx.repos.specVersions.all().filter((v) => v.companyId === companyId);

  // 已经有一段没发布的会话就接着用。每次点"开始录入"都开一段新草稿的话，
  // 商家会攒下一堆半截会话，而且分不清哪一段是他昨天填到一半的那个。
  const existing = appCtx.repos.onboardingSessions.all()
    .find((s) => s.companyId === companyId && s.status !== "published");
  if (existing) return c.json({ session: existing, resumed: true }, 200);

  const { session, draftVersion } = startSession(companyId, now(), versions);
  await appCtx.repos.specVersions.insert(draftVersion);
  await appCtx.repos.onboardingSessions.insert(session);
  return c.json({ session, draftVersion, resumed: false }, 201);
});

app.get("/api/company/:companyId/spec/sessions/:sessionId", requireCompany, (c) => {
  const session = ownedSession(c);
  return session ? c.json({ session, ...sessionView(session) }) : c.json({ error: "Onboarding session not found" }, 404);
});

/**
 * 导入模板。
 *
 * **可以反复导**：商家在自己的表里改好一行再传一次，是最自然的修法。
 * 每次导入都重算待确认队列——不这么做的话，商家改好了表，队列里还留着
 * 上一次的旧问题，他会以为自己没改对。
 */
app.post("/api/company/:companyId/spec/sessions/:sessionId/import", requireCompany, async (c) => {
  const session = ownedSession(c);
  if (!session) return c.json({ error: "Onboarding session not found" }, 404);
  const body = await jsonBody<{ sources: ImportSources; faceOverrides: CompanyOverrides }>(c);
  if (!body.sources?.modules) {
    return c.json({ error: "modules sheet is required (SKUs, types, size steps)" }, 400);
  }

  // 上一版已经确认过的型号带进来：商家改一次价，不该被要求把"NS-B12 是单门"
  // 再答一遍。那是型号的固有属性，不是这一版的属性——而答二十遍之后，
  // 人会开始随手点，那套队列存在的全部意义就没了。
  const company = appCtx.repos.companies.byId(param(c, "companyId"));
  const previous = company?.currentPublishedSpecVersionId
    ? appCtx.repos.specBundles.byId(company.currentPublishedSpecVersionId)
    : undefined;

  try {
    const r = ingestTemplates(session, body.sources, now(), {
      faceOverrides: body.faceOverrides ?? {},
      ...(previous ? { knownModules: previous.modules } : {}),
    });
    await appCtx.repos.onboardingSessions.update(session.id, r.session);
    // 草稿整包也存下来：商家分几次填时，上一次导进去的东西不能丢
    await appCtx.repos.specBundles.upsert(r.bundle);
    return c.json({
      session: r.session,
      ...sessionView(r.session),
      // 进来几条、卡住几条，两个数都要给。只报一句"导入成功"，
      // 商家不会知道他 200 个型号里有 30 个根本没进来
      stats: r.importResult.stats,
      inheritedFromPrevious: r.importResult.stats.inheritedFromPrevious,
      rejectedModuleRows: r.importResult.stats.moduleRows - r.importResult.stats.modulesImported,
      rejectedPriceRows:
        r.importResult.stats.priceMatrixRows - r.importResult.stats.priceMatrixImported,
    }, 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

/**
 * 回答一条追问。
 *
 * **没有"跳过"这个动作。** 每一条要么能在这里用一个具体的值答掉（脸型、能力），
 * 要么就是"表里写错了"——那种改好表重新导入，队列会自己重算，那一条自然消失。
 * 不存在第三种情况需要一个"先划掉再说"的按钮，而留一个这样的按钮，
 * 等于整套队列是可选的：商家点二十下就能带着一堆空数据发布。
 */
app.post("/api/company/:companyId/spec/sessions/:sessionId/answer", requireCompany, async (c) => {
  const session = ownedSession(c);
  if (!session) return c.json({ error: "Onboarding session not found" }, 404);
  const body = await jsonBody<{
    questionId: string; unresolvedIndex: number; answer: QuestionAnswer;
  }>(c);

  let next = session;
  if (body.questionId) {
    // 答案要**带着值**进来，落到规格上。只把警报关掉而不补数据，等于没答——
    // 那个柜子会带着一张空脸一路走到正视图上
    const bundle = appCtx.repos.specBundles.byId(session.specVersionId);
    if (!bundle) return c.json({ error: "This session has not imported any catalog yet" }, 409);
    try {
      const outcome = answerQuestion(session, bundle, body.questionId, body.answer ?? {}, now());
      next = outcome.session;
      await appCtx.repos.specBundles.upsert(outcome.bundle);
    } catch (e) {
      return c.json({
        error: e instanceof Error ? e.message : String(e),
        code: e instanceof OnboardingError ? e.code : "ANSWER_FAILED",
      }, e instanceof OnboardingError && e.code === "QUESTION_NOT_FOUND" ? 404 : 400);
    }
  } else {
    return c.json({
      error: "Specify which follow-up you are answering (questionId) and the answer. " +
        "Rows that were wrong in the sheet are not fixed here — correct the sheet and re-import; the queue recalculates.",
    }, 400);
  }
  await appCtx.repos.onboardingSessions.update(session.id, next);
  return c.json({ session: next, ...sessionView(next) });
});

/**
 * 发布。
 *
 * 三道门禁在 `assertPublishable` 里：待确认项没清空、没有型号、有型号查不到价、
 * 没有门板样式——任何一条不过都不放行。**这是 FR-2「零静默失败」的强制点**，
 * 不是提示。
 */
app.post("/api/company/:companyId/spec/sessions/:sessionId/publish", requireCompany, async (c) => {
  const session = ownedSession(c);
  if (!session) return c.json({ error: "Onboarding session not found" }, 404);
  const companyId = param(c, "companyId");
  const bundle = appCtx.repos.specBundles.byId(session.specVersionId);
  if (!bundle) return c.json({ error: "This session has not imported any catalog yet" }, 409);

  const body = await jsonBody<{ publishedBy: string }>(c);
  const versions = appCtx.repos.specVersions.all().filter((v) => v.companyId === companyId);

  let outcome;
  try {
    outcome = publish(session, bundle, versions, body.publishedBy ?? "company", now());
  } catch (e) {
    // 拦下来要说清楚**拦的是哪一条**：「发布失败」对商家毫无用处
    return c.json({
      error: e instanceof Error ? e.message : String(e),
      code: e instanceof OnboardingError ? e.code : "PUBLISH_FAILED",
      ...sessionView(session),
    }, 409);
  }

  await appCtx.repos.specVersions.update(outcome.result.published.id, outcome.result.published);
  if (outcome.result.archived) {
    await appCtx.repos.specVersions.update(outcome.result.archived.id, outcome.result.archived);
  }
  await appCtx.repos.onboardingSessions.update(session.id, outcome.session);

  // 公司指向新版本。**已发出的报价不受影响**——它们冻结了自己的快照（§3.6）
  const company = appCtx.repos.companies.byId(companyId);
  if (company) {
    await appCtx.repos.companies.update(companyId, {
      ...company, currentPublishedSpecVersionId: outcome.result.published.id,
    });
  }

  const active = company ? isCompanyActive({
    ...company, currentPublishedSpecVersionId: outcome.result.published.id,
  }) : false;

  // 「这家商家现在到底能不能出报价」只有**一个**答案，两道门槛都算进去：
  //   ① 订阅生效了吗（场景 A 第 8 点）
  //   ② 这套规格拼得出一份完整的物料清单吗（SR-M1）
  //
  // 第二条以前只在客户下单那一刻才查，而那时候看到错的是客户、能修的是商家。
  // 商家等到的是"一条线索都没有"，中间没有任何一句话告诉他为什么。
  const readiness = bomReadiness(bundle.modules, outcome.result.published.toeKickSystem);
  const blockers: string[] = [];
  if (!active) {
    blockers.push(
      "Personalization subscription is not active — customers can still @ you for product Q&A, " +
      "but they get a generic EstimateDraft, not a formal quote bound to your catalog.",
    );
  }
  if (!readiness.ready) {
    blockers.push(
      `Catalog is missing items every quote will fail delivery audit on: ${readiness.missing.join(", ")}. ` +
      "These are not cabinets — they are finishing parts a complete kitchen needs (e.g. toe kick). " +
      "Add them to the price list and open a new draft.",
    );
  }

  return c.json({
    session: outcome.session,
    published: outcome.result.published,
    ...(outcome.result.archived ? { archived: outcome.result.archived } : {}),
    canQuote: blockers.length === 0,
    ...(blockers.length ? { blockers } : {}),
    specCompleteness: readiness,
  }, 201);
});

// ── 厂商员工会话（Type2 A）——对话式初始化 ──────────────────────────────────
//
// 不是上面表单 API 的替代——是同一套底层状态机的另一个入口。员工在这里聊出来
// 的答案，落地方式跟表单提交完全一样（同一个 ingestTemplates/answerQuestion）。
// 这里只是把"数据怎么递进来"从"填表"换成"聊天 + 发文件"。厂商注册后没有
// 单独的表单页面——门店地址、标准折扣、产品目录都是从这条入口进来的。

function staffThreadFor(companyId: string): CompanyStaffThread {
  return appCtx.repos.companyStaffThreads.byId(companyId)
    ?? { id: companyId, companyId, messages: [], updatedAt: now() };
}

app.get("/api/company/:companyId/staff-chat", requireCompany, (c) => {
  return c.json({ thread: staffThreadFor(param(c, "companyId")) });
});

/** 员工发一句话；后台 Agent 答复，并把能落地的意图（地址/折扣/追问答案）直接写库。 */
app.post("/api/company/:companyId/staff-chat/messages", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  const company = appCtx.repos.companies.byId(companyId);
  if (!company) return c.json({ error: "Company not found" }, 404);
  const body = await jsonBody<{ text: string }>(c);
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text is required" }, 400);

  const thread = staffThreadFor(companyId);
  const at = now();
  const language = inferLanguageFromText(text) ?? DEFAULT_LANGUAGE;

  const session = thread.activeOnboardingSessionId
    ? appCtx.repos.onboardingSessions.byId(thread.activeOnboardingSessionId)
    : undefined;
  const bundle = session ? appCtx.repos.specBundles.byId(session.specVersionId) : undefined;

  const outcome = await companyStaffAgentReply(
    { client: appCtx.llm, company, session, bundle, language }, text, at,
  );

  let updatedCompany = company;
  if (outcome.patch?.companyUpdate) {
    updatedCompany = { ...company, ...outcome.patch.companyUpdate };
    await appCtx.repos.companies.update(companyId, outcome.patch.companyUpdate);
  }
  if (outcome.patch?.discountRule) {
    const specVersionId = company.currentPublishedSpecVersionId ?? session?.specVersionId;
    const existingBundle = specVersionId ? appCtx.repos.specBundles.byId(specVersionId) : undefined;
    if (!specVersionId || !existingBundle) {
      return c.json({
        error: "This company has no draft or published spec yet — import a catalog before setting a discount",
      }, 409);
    }
    const discountRules = applyStandardDiscountPatch(
      existingBundle.discountRules, specVersionId, companyId, outcome.patch.discountRule,
    );
    await appCtx.repos.specBundles.upsert({ ...existingBundle, discountRules });
  }
  let nextSession = session;
  if (outcome.patch?.onboardingAnswer) {
    nextSession = outcome.patch.onboardingAnswer.session;
    await appCtx.repos.onboardingSessions.update(nextSession.id, nextSession);
    await appCtx.repos.specBundles.upsert(outcome.patch.onboardingAnswer.bundle);
  }

  const staffMsg: CompanyStaffMessage = { role: "staff", content: text, at };
  const assistantMsg: CompanyStaffMessage = {
    role: "assistant",
    content: outcome.reply,
    at: now(),
    ...(outcome.patch ? {
      action: {
        kind: outcome.patch.companyUpdate ? "profileUpdated" as const
          : outcome.patch.discountRule ? "discountUpdated" as const
          : "questionsAnswered" as const,
      },
    } : {}),
  };
  const nextThread: CompanyStaffThread = {
    ...thread,
    messages: [...thread.messages, staffMsg, assistantMsg],
    updatedAt: assistantMsg.at,
    ...(nextSession ? { activeOnboardingSessionId: nextSession.id } : {}),
  };
  await appCtx.repos.companyStaffThreads.upsert(nextThread);

  return c.json({ thread: nextThread, company: updatedCompany });
});

/**
 * 批量目录/价目表上传——Excel(.xlsx)/JSON 一等公民，PDF 走 LLM 抽取兜底。
 * Word/.txt 不支持：没有可依赖的表格结构，宁可让商家转存成 Excel。
 *
 * 接 multipart（字段名 `file`）或直接 JSON body（四/五张表的对象数组）。
 */
app.post("/api/company/:companyId/staff-chat/catalog", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  const company = appCtx.repos.companies.byId(companyId);
  if (!company) return c.json({ error: "Company not found" }, 404);

  let parsed: UploadParseResult;
  let filename = "upload.json";
  try {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "No file field found in the upload (expected \"file\")" }, 400);
      filename = file.name || filename;
      const buffer = Buffer.from(await file.arrayBuffer());
      if (/\.xlsx?$/i.test(filename)) {
        parsed = parseXlsxCatalog(buffer);
      } else if (/\.pdf$/i.test(filename)) {
        parsed = await parsePdfCatalog(buffer, appCtx.llm);
      } else if (/\.json$/i.test(filename)) {
        parsed = parseJsonCatalog(JSON.parse(buffer.toString("utf-8")) as JsonCatalogPayload);
      } else {
        return c.json({
          error: `Unsupported file type for "${filename}" — please upload .xlsx, .json, or .pdf. ` +
            "Word/.txt are not supported: there is no reliable table structure to parse from them.",
        }, 400);
      }
    } else {
      parsed = parseJsonCatalog(await jsonBody<JsonCatalogPayload>(c));
    }
  } catch (e) {
    if (e instanceof PdfCatalogExtractError) return c.json({ error: e.message, code: e.code }, 422);
    return c.json({ error: `Could not read this file: ${e instanceof Error ? e.message : String(e)}` }, 400);
  }

  if (parsed.missingRequiredSheets.length) {
    return c.json({
      error: `Missing required tables: ${parsed.missingRequiredSheets.join(", ")}`,
      unmatchedSheets: parsed.unmatchedSheets,
    }, 422);
  }

  const thread = staffThreadFor(companyId);
  let session = thread.activeOnboardingSessionId
    ? appCtx.repos.onboardingSessions.byId(thread.activeOnboardingSessionId)
    : appCtx.repos.onboardingSessions.all().find((s) => s.companyId === companyId && s.status !== "published");

  if (!session) {
    const versions = appCtx.repos.specVersions.all().filter((v) => v.companyId === companyId);
    const started = startSession(companyId, now(), versions);
    session = started.session;
    await appCtx.repos.specVersions.insert(started.draftVersion);
    await appCtx.repos.onboardingSessions.insert(session);
  }

  const previous = company.currentPublishedSpecVersionId
    ? appCtx.repos.specBundles.byId(company.currentPublishedSpecVersionId)
    : undefined;

  let ingestResult;
  try {
    ingestResult = ingestTemplates(session, parsed.sources, now(), {
      ...(previous ? { knownModules: previous.modules } : {}),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
  await appCtx.repos.onboardingSessions.update(ingestResult.session.id, ingestResult.session);
  await appCtx.repos.specBundles.upsert(ingestResult.bundle);

  const summary = `Parsed "${filename}": ${ingestResult.importResult.stats.modulesImported} SKUs, ` +
    `${ingestResult.importResult.stats.priceMatrixImported} price rows, ` +
    `${ingestResult.session.unresolved.length} item(s) need review.` +
    (parsed.unmatchedSheets.length ? ` (unrecognized tabs/keys: ${parsed.unmatchedSheets.join(", ")})` : "");
  const systemMsg: CompanyStaffMessage = {
    role: "system", content: summary, at: now(), action: { kind: "catalogImported" },
  };
  const assistantMsg: CompanyStaffMessage = {
    role: "assistant", content: renderNextQuestionPrompt(ingestResult.session, DEFAULT_LANGUAGE), at: now(),
  };
  const nextThread: CompanyStaffThread = {
    ...thread,
    messages: [...thread.messages, systemMsg, assistantMsg],
    activeOnboardingSessionId: ingestResult.session.id,
    updatedAt: assistantMsg.at,
  };
  await appCtx.repos.companyStaffThreads.upsert(nextThread);

  return c.json({
    thread: nextThread,
    session: ingestResult.session,
    stats: ingestResult.importResult.stats,
    unmatchedSheets: parsed.unmatchedSheets,
  }, 201);
});

/** 会话的对外视图：还剩几条、下一条问什么。 */
function sessionView(session: OnboardingSession) {
  const pending = session.questions.filter((q) => !q.answered);
  return {
    status: session.status,
    unresolvedCount: session.unresolved.length,
    pendingQuestions: pending,
    manualCorrections: session.manualCorrections,
    canPublish: session.unresolved.length === 0 && session.status !== "collecting",
  };
}

function ownedSession(c: Ctx): OnboardingSession | undefined {
  const s = appCtx.repos.onboardingSessions.byId(param(c, "sessionId"));
  // 令牌证明了你是哪一家，会话必须**也**属于那一家——否则 A 家拿自己的令牌
  // 就能改 B 家的规格草稿
  return s && s.companyId === param(c, "companyId") ? s : undefined;
}

// ── 公司侧：计费透明度与争议（FR-7 / 8.1）─────────────────────────────────

app.get("/api/company/:companyId/billing", requireCompany, (c) => {
  const scope = new TenantScope(param(c, "companyId"));
  return c.json({ events: scope.filter(appCtx.repos.billingEvents.all()) });
});

app.post("/api/company/:companyId/billing/:eventId/dispute", requireCompany, async (c) => {
  const scope = new TenantScope(param(c, "companyId"));
  const event = scope.find(appCtx.repos.billingEvents.all(), (e) => e.id === param(c, "eventId"));
  if (!event) return c.json({ error: "Billing event not found" }, 404);
  const body = await jsonBody<{ reason: string; evidence: string; openedBy: string }>(c);
  try {
    const updated = openDispute(event, {
      openedBy: body.openedBy ?? "company",
      reason: (body.reason as never) ?? "other",
      evidence: body.evidence ?? "",
      at: now(),
    });
    await appCtx.repos.billingEvents.update(updated.id, updated);
    return c.json({ event: updated });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

// ── FR-23 厂商协作 inbox（投影；永不返回父 messages）──────────────────────

app.get("/api/company/:companyId/engagements", requireCompany, (c) => {
  const companyId = param(c, "companyId");
  const items = appCtx.repos.conversations.all().flatMap((conv) =>
    listEngagements(conv)
      .filter((e) => e.companyId === companyId && e.status === "active")
      .map((e) => toVendorEngagementListItem({
        conversation: conv,
        engagement: e,
        parentFullTitle: conversationFullTitle(conv.messages),
      })));
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return c.json({ engagements: items });
});

app.get("/api/company/:companyId/engagements/:eid", requireCompany, (c) => {
  const companyId = param(c, "companyId");
  const company = appCtx.repos.companies.byId(companyId);
  const eid = param(c, "eid");
  for (const conv of appCtx.repos.conversations.all()) {
    const eg = findEngagement(conv, eid);
    if (!eg) continue;
    if (eg.companyId !== companyId) {
      return c.json({ error: "Engagement not found" }, 404);
    }
    return c.json({
      engagement: toVendorEngagementDetail({
        conversation: conv,
        engagement: eg,
        parentFullTitle: conversationFullTitle(conv.messages),
        companyName: company?.name ?? companyId,
      }),
      // 显式不返回 conversation.messages
    });
  }
  return c.json({ error: "Engagement not found" }, 404);
});

app.post("/api/company/:companyId/engagements/:eid/messages", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  const eid = param(c, "eid");
  const body = await jsonBody<{ text: string; pauseAgent?: boolean }>(c);
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ error: "text is required", code: "EMPTY_TEXT" }, 400);

  for (const conv of appCtx.repos.conversations.all()) {
    const eg = findEngagement(conv, eid);
    if (!eg) continue;
    if (eg.companyId !== companyId) {
      return c.json({ error: "Engagement not found" }, 404);
    }
    try {
      const { conversation: next, engagement } = appendEngagementMessage(
        conv, eid,
        {
          role: "company_human",
          speaker: "company_human",
          content: text,
          at: now(),
        },
        { pauseAgent: body.pauseAgent },
      );
      await appCtx.repos.conversations.upsert(next);
      const company = appCtx.repos.companies.byId(companyId);
      return c.json({
        engagement: toVendorEngagementDetail({
          conversation: next,
          engagement,
          parentFullTitle: conversationFullTitle(next.messages),
          companyName: company?.name ?? companyId,
        }),
      });
    } catch (e) {
      const err = engagementHttpError(e);
      return c.json(err.body, err.status);
    }
  }
  return c.json({ error: "Engagement not found" }, 404);
});

// ── 平台运营 ──────────────────────────────────────────────────────────────

/** FR-21：跨来源 SessionRun 列表（含 simulate / test 索引发现）。 */
app.get("/api/admin/session-runs", requireAdmin, (c) =>
  c.json({ runs: listAllSessionRuns(appCtx), currentRunId: appCtx.runId, dataDir: appCtx.dataDir }));

/** FR-21：跨账号只读会话列表。 */
app.get("/api/admin/conversations", requireAdmin, (c) => {
  const origin = c.req.query("origin") || undefined;
  const runId = c.req.query("runId") || undefined;
  const rows = listConversationsAcrossRuns(appCtx, {
    ...(origin ? { origin } : {}),
    ...(runId ? { runId } : {}),
  });
  return c.json({
    conversations: rows.map((r) => ({
      id: r.conversation.id,
      customerAccountId: r.conversation.customerAccountId,
      createdAt: r.conversation.createdAt,
      messageCount: r.conversation.messages.length,
      origin: r.origin,
      runId: r.runId,
      tags: r.conversation.tags ?? [],
      dataDir: r.dataDir,
      preview: r.conversation.messages.find((m) => m.role === "user")?.content?.slice(0, 80) ?? "",
    })),
  });
});

/** FR-21：只读完整会话 + 关联元数据（不改客户数据）。 */
app.get("/api/admin/conversations/:id", requireAdmin, (c) => {
  const hit = findConversationAcrossRuns(appCtx, param(c, "id"));
  if (!hit) return c.json({ error: "Conversation not found" }, 404);
  const { conversation: conv, repos } = hit;
  const session = repos.designSessions.byId(conv.id);
  const plans = repos.floorPlans.filter((p) => p.conversationId === conv.id);
  const quotes = repos.quotes.filter((q) => q.conversationId === conv.id)
    .map((q) => ({ id: q.id, companyId: q.companyId, total: q.total, status: q.status }));
  const critiques = critiquesForConversation(repos, conv.id);
  return c.json({
    conversation: conv,
    designSession: session ?? null,
    floorPlanIds: plans.map((p) => p.id),
    quotes,
    critiques,
    run: hit.run ?? null,
  });
});

app.get("/api/admin/conversations/:id/critiques", requireAdmin, (c) => {
  const hit = findConversationAcrossRuns(appCtx, param(c, "id"));
  if (!hit) return c.json({ error: "Conversation not found" }, 404);
  return c.json({ critiques: critiquesForConversation(hit.repos, hit.conversation.id) });
});

app.post("/api/admin/conversations/:id/critiques", requireAdmin, async (c) => {
  const hit = findConversationAcrossRuns(appCtx, param(c, "id"));
  if (!hit) return c.json({ error: "Conversation not found" }, 404);
  const review = await runDesignCritique({
    repos: hit.repos,
    conversationId: hit.conversation.id,
    trigger: "manual",
    llm: criticLlmOrFallback(),
  });
  if (!review) return c.json({ error: "Critique failed" }, 500);
  return c.json({ critique: review }, 201);
});

function findCritiqueRepos(critiqueId: string, hintConversationId?: string) {
  const local = appCtx.repos.critiqueReviews.byId(critiqueId);
  if (local) return { repos: appCtx.repos, review: local };
  if (hintConversationId) {
    const hit = findConversationAcrossRuns(appCtx, hintConversationId);
    if (hit) {
      const review = hit.repos.critiqueReviews.byId(critiqueId);
      if (review) return { repos: hit.repos, review };
    }
  }
  for (const run of listAllSessionRuns(appCtx)) {
    if (!run.dataDir || run.dataDir === appCtx.dataDir) continue;
    try {
      const repos = reposForDataDir(appCtx, run.dataDir);
      const review = repos.critiqueReviews.byId(critiqueId);
      if (review) return { repos, review };
    } catch { /* skip */ }
  }
  return undefined;
}

app.post("/api/admin/critiques/:id/messages", requireAdmin, async (c) => {
  const body = await jsonBody<{ text: string; conversationId?: string }>(c);
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ error: "text is required" }, 400);
  const hit = findCritiqueRepos(param(c, "id"), body.conversationId);
  if (!hit) return c.json({ error: "Critique not found" }, 404);
  const updated = await appendOperatorCritiqueMessage(
    hit.repos, hit.review.id, text, criticLlmOrFallback(),
  );
  return c.json({ critique: updated });
});

app.patch("/api/admin/critiques/:id", requireAdmin, async (c) => {
  const body = await jsonBody<{ status: CritiqueStatus; conversationId?: string }>(c);
  if (!body.status || !["open", "acked", "promoted_to_trainer"].includes(body.status)) {
    return c.json({ error: "status must be open|acked|promoted_to_trainer" }, 400);
  }
  const hit = findCritiqueRepos(param(c, "id"), body.conversationId);
  if (!hit) return c.json({ error: "Critique not found" }, 404);
  const updated = await hit.repos.critiqueReviews.update(hit.review.id, {
    ...hit.review, status: body.status,
  });
  return c.json({ critique: updated });
});

/** simulate / 测试显式结束一轮 SessionRun，并触发 sessionEnd 评审。 */
// ── 测试用户 Agent（src/testing，可切割）──────────────────────────────────

app.get("/api/admin/test-user/points", requireAdmin, (c) =>
  c.json({
    status: "success",
    data: {
      points: allTestPoints(),
      suggestedIds: suggestedPointIds(),
    },
  }));

app.get("/api/admin/test-user/runs", requireAdmin, (c) =>
  c.json({
    status: "success",
    data: {
      runs: appCtx.repos.testUserRuns.all()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 40),
    },
  }));

app.get("/api/admin/test-user/runs/:id", requireAdmin, (c) => {
  const run = appCtx.repos.testUserRuns.byId(param(c, "id"));
  if (!run) return c.json({ status: "error", message: "Test run not found" }, 404);
  const critiques = run.cases
    .map((x) => (x.critiqueId ? appCtx.repos.critiqueReviews.byId(x.critiqueId) : undefined))
    .filter(Boolean);
  return c.json({ status: "success", data: { run, critiques } });
});

app.post("/api/admin/test-user/runs", requireAdmin, async (c) => {
  const body = await jsonBody<{
    count?: number;
    pointIds?: string[];
    runCritic?: boolean;
    accountId?: string;
  }>(c);
  const call = createAppFetch(app);
  try {
    // 临时把 origin/runId 切到 test，使新建会话带 test- 元数据；结束后恢复
    const prevOrigin = appCtx.origin;
    const prevRunId = appCtx.runId;
    const suiteRunId = `test_admin_${Date.now().toString(36)}`;
    appCtx.origin = "test";
    appCtx.runId = suiteRunId;
    let run;
    try {
      run = await startAndRunTestSuite(
        {
          call,
          repos: appCtx.repos,
          dataDir: appCtx.dataDir,
          sessionRunId: suiteRunId,
          userLlm: createTestLlmClient(),
          criticLlm: criticLlmOrFallback(),
          adminToken: process.env.ADMIN_TOKEN,
        },
        {
          ...(body.count != null ? { count: body.count } : {}),
          ...(body.pointIds ? { pointIds: body.pointIds } : {}),
          ...(body.runCritic != null ? { runCritic: body.runCritic } : {}),
          ...(body.accountId ? { accountId: body.accountId } : {}),
        },
      );
    } finally {
      appCtx.origin = prevOrigin;
      appCtx.runId = prevRunId;
    }
    return c.json({ status: "success", data: { run } }, 201);
  } catch (e) {
    return c.json({
      status: "error",
      message: e instanceof Error ? e.message : String(e),
    }, 500);
  }
});

app.post("/api/admin/session-runs/:id/end", requireAdmin, async (c) => {
  const body = await jsonBody<{
    exitCode?: number; scenarioSource?: string; note?: string; critiqueConversationIds?: string[];
  }>(c);
  const runId = param(c, "id");
  let repos = appCtx.repos;
  let run = repos.sessionRuns.byId(runId);
  if (!run) {
    const discovered = listAllSessionRuns(appCtx).find((r) => r.id === runId);
    if (discovered?.dataDir) {
      repos = openRepositories(discovered.dataDir);
      run = repos.sessionRuns.byId(runId);
    }
  }
  if (!run) return c.json({ error: "Session run not found" }, 404);
  const ended = await endSessionRun(repos, runId, {
    endedAt: now(),
    ...(body.exitCode !== undefined ? { exitCode: body.exitCode } : {}),
    ...(body.scenarioSource ? { scenarioSource: body.scenarioSource } : {}),
    ...(body.note ? { note: body.note } : {}),
  });
  const ids = body.critiqueConversationIds?.length
    ? body.critiqueConversationIds
    : (ended?.conversationIds ?? []);
  for (const cid of ids) {
    await runDesignCritique({
      repos, conversationId: cid, trigger: "sessionEnd", llm: criticLlmOrFallback(),
    });
  }
  return c.json({ run: ended });
});

// ── 平台知识训练（FR-22）—— 强制 principal + knowledge 过滤 ────────────────

app.post("/api/admin/trainer/conversations", requireAdmin, async (c) => {
  assertCanAccessTrainer(c.get("principal"));
  const conv = newTrainerConversation("admin");
  await appCtx.repos.trainerConversations.insert(conv);
  return c.json({ status: "success", data: { conversation: conv } }, 201);
});

app.get("/api/admin/trainer/conversations/:id", requireAdmin, (c) => {
  assertCanAccessTrainer(c.get("principal"));
  const conv = appCtx.repos.trainerConversations.byId(param(c, "id"));
  if (!conv) return c.json({ status: "error", message: "Trainer conversation not found" }, 404);
  const cards = listKnowledgeCardsFor(
    c.get("principal"),
    conv.cardIds
      .map((id) => appCtx.repos.knowledgeCards.byId(id))
      .filter((x): x is PlatformKnowledgeCard => Boolean(x)),
  );
  return c.json({ status: "success", data: { conversation: conv, cards } });
});

app.post("/api/admin/trainer/conversations/:id/messages", requireAdmin, async (c) => {
  assertCanAccessTrainer(c.get("principal"));
  const conv = appCtx.repos.trainerConversations.byId(param(c, "id"));
  if (!conv) return c.json({ status: "error", message: "Trainer conversation not found" }, 404);
  const body = await jsonBody<{ text: string }>(c);
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ status: "error", message: "text required" }, 400);

  try {
    const turn = await trainerTurn({
      conversation: conv,
      userText: text,
      taughtBy: "admin",
      client: appCtx.llm,
      saveCards: async (cards) => {
        for (const card of cards) {
          assertCanWriteKnowledgeCard(c.get("principal"), card);
          await appCtx.repos.knowledgeCards.insert(card);
        }
      },
    });
    await appCtx.repos.trainerConversations.update(turn.conversation.id, turn.conversation);
    return c.json({
      status: "success",
      data: {
        conversation: turn.conversation,
        assistantMessage: turn.assistantMessage,
        proposedCards: turn.proposedCards,
        rejected: turn.rejected,
      },
    });
  } catch (e) {
    const message = e instanceof KnowledgeError ? e.message : String(e);
    const code = e instanceof KnowledgeError ? e.code : "TRAINER_ERROR";
    return c.json({ status: "error", message, code }, 400);
  }
});

app.get("/api/admin/knowledge", requireAdmin, (c) => {
  assertCanManageKnowledge(c.get("principal"));
  const status = c.req.query("status");
  const target = c.req.query("settleTarget");
  let cards = listKnowledgeCardsFor(c.get("principal"), appCtx.repos.knowledgeCards.all());
  if (status) cards = cards.filter((x) => x.status === status);
  if (target) cards = cards.filter((x) => x.settleTarget === target);
  return c.json({ status: "success", data: { cards } });
});

app.get("/api/admin/knowledge/overlays", requireAdmin, (c) => {
  assertCanManageKnowledge(c.get("principal"));
  const overlays = platformKnowledgeRuntime(appCtx.repos.knowledgeCards.all()).overlays;
  return c.json({ status: "success", data: { overlays } });
});

app.get("/api/admin/knowledge/export", requireAdmin, (c) => {
  assertCanManageKnowledge(c.get("principal"));
  const md = exportKnowledgeMarkdown(
    exportableCards(c.get("principal"), appCtx.repos.knowledgeCards.all()),
  );
  return c.text(md);
});

app.get("/api/admin/knowledge/:id", requireAdmin, (c) => {
  const card = getKnowledgeCardFor(
    c.get("principal"),
    appCtx.repos.knowledgeCards.all(),
    param(c, "id"),
  );
  if (!card) return c.json({ status: "error", message: "Not found" }, 404);
  return c.json({ status: "success", data: { card } });
});
app.patch("/api/admin/knowledge/:id", requireAdmin, async (c) => {
  assertCanManageKnowledge(c.get("principal"));
  const card = getKnowledgeCardFor(
    c.get("principal"),
    appCtx.repos.knowledgeCards.all(),
    param(c, "id"),
  );
  if (!card) return c.json({ status: "error", message: "Not found" }, 404);
  const body = await jsonBody<{
    title?: string;
    body?: { en: string; zh?: string };
    settleTarget?: PlatformKnowledgeCard["settleTarget"];
    kind?: PlatformKnowledgeCard["kind"];
    scope?: PlatformKnowledgeCard["scope"];
    structured?: PlatformKnowledgeCard["structured"];
    confirm?: boolean;
  }>(c);
  try {
    let next = card;
    if (body.title || body.body || body.settleTarget || body.kind || body.scope || body.structured) {
      next = patchCard(next, {
        ...(body.title != null ? { title: body.title } : {}),
        ...(body.body != null ? { body: body.body } : {}),
        ...(body.settleTarget != null ? { settleTarget: body.settleTarget } : {}),
        ...(body.kind != null ? { kind: body.kind } : {}),
        ...(body.scope != null ? { scope: body.scope } : {}),
        ...(body.structured != null ? { structured: body.structured } : {}),
      });
    }
    assertCanWriteKnowledgeCard(c.get("principal"), next);
    if (body.confirm) next = confirmCard(next);
    await appCtx.repos.knowledgeCards.update(next.id, next);
    return c.json({ status: "success", data: { card: next } });
  } catch (e) {
    const message = e instanceof KnowledgeError ? e.message : String(e);
    return c.json({ status: "error", message }, 400);
  }
});

app.post("/api/admin/knowledge/:id/publish", requireAdmin, async (c) => {
  assertCanManageKnowledge(c.get("principal"));
  const card = getKnowledgeCardFor(
    c.get("principal"),
    appCtx.repos.knowledgeCards.all(),
    param(c, "id"),
  );
  if (!card) return c.json({ status: "error", message: "Not found" }, 404);
  try {
    const next = publishCard(card, "admin");
    await appCtx.repos.knowledgeCards.update(next.id, next);
    return c.json({ status: "success", data: { card: next } });
  } catch (e) {
    const message = e instanceof KnowledgeError ? e.message : String(e);
    return c.json({ status: "error", message }, 400);
  }
});

app.post("/api/admin/knowledge/:id/deprecate", requireAdmin, async (c) => {
  assertCanManageKnowledge(c.get("principal"));
  const card = getKnowledgeCardFor(
    c.get("principal"),
    appCtx.repos.knowledgeCards.all(),
    param(c, "id"),
  );
  if (!card) return c.json({ status: "error", message: "Not found" }, 404);
  try {
    const next = deprecateCard(card);
    await appCtx.repos.knowledgeCards.update(next.id, next);
    return c.json({ status: "success", data: { card: next } });
  } catch (e) {
    const message = e instanceof KnowledgeError ? e.message : String(e);
    return c.json({ status: "error", message }, 400);
  }
});

app.get("/api/admin/knowledge/:id/promote", requireAdmin, (c) => {
  assertCanManageKnowledge(c.get("principal"));
  const card = getKnowledgeCardFor(
    c.get("principal"),
    appCtx.repos.knowledgeCards.all(),
    param(c, "id"),
  );
  if (!card) return c.json({ status: "error", message: "Not found" }, 404);
  try {
    const checklist = buildPromoteChecklist(card);
    return c.json({ status: "success", data: { checklist } });
  } catch (e) {
    return c.json({ status: "error", message: String(e) }, 400);
  }
});

app.post("/api/admin/knowledge/:id/mark-settled", requireAdmin, async (c) => {
  assertCanManageKnowledge(c.get("principal"));
  const card = getKnowledgeCardFor(
    c.get("principal"),
    appCtx.repos.knowledgeCards.all(),
    param(c, "id"),
  );
  if (!card) return c.json({ status: "error", message: "Not found" }, 404);
  const body = await jsonBody<{ note: string }>(c);
  try {
    const next = markSettledInCode(card, body.note ?? "");
    await appCtx.repos.knowledgeCards.update(next.id, next);
    return c.json({ status: "success", data: { card: next } });
  } catch (e) {
    const message = e instanceof KnowledgeError ? e.message : String(e);
    return c.json({ status: "error", message }, 400);
  }
});

// ── FR-22.2：厂商 L1 学习队列 + 回归看板 ─────────────────────────────────

function collectCompanyL1ScanInput(companyId: string) {
  const onboarding = appCtx.repos.onboardingSessions.all()
    .find((s) => s.companyId === companyId && s.status !== "published");
  const draft = currentDraft(appCtx.repos.specVersions.all(), companyId);
  const company = appCtx.repos.companies.byId(companyId);
  const bundleId = draft?.id ?? company?.currentPublishedSpecVersionId;
  const bundle = bundleId ? appCtx.repos.specBundles.byId(bundleId) : undefined;
  const revisionsByConversation = new Map<string, NonNullable<
    ReturnType<typeof appCtx.repos.designSessions.all>[number]["revisionRequests"]
  >>();
  for (const s of appCtx.repos.designSessions.all()) {
    if (s.companyId !== companyId || !s.revisionRequests?.length) continue;
    revisionsByConversation.set(s.conversationId, s.revisionRequests);
  }
  const sessionCorrections = collectSessionCorrections({
    companyId,
    conversations: appCtx.repos.conversations.all(),
    revisionsByConversation,
  });
  return {
    companyId,
    unresolved: onboarding?.unresolved,
    modules: bundle?.modules,
    priceGroups: bundle?.priceGroups,
    priceMatrix: bundle?.priceMatrix,
    sessionCorrections,
  };
}

/** 客户消息/修订 → 绑定公司的 L1 draft（幂等；失败静默，不挡主路径）。 */
async function maybeEnqueueSessionCorrection(
  conv: Conversation,
  text: string,
): Promise<void> {
  const hit = detectCorrectionFromText(text, conv.id);
  if (!hit) return;
  const companyIds = [
    ...new Set(conv.perCompanyThreads.map((t) => t.companyId).filter(Boolean)),
  ];
  for (const companyId of companyIds) {
    try {
      const item = proposeFromSessionCorrection({
        companyId,
        summary: hit.summary,
        conversationId: conv.id,
        codingHint: hit.codingHint,
      });
      if (!appCtx.repos.l1LearningQueue.byId(item.id)) {
        await appCtx.repos.l1LearningQueue.insert(item);
      }
    } catch {
      // 纠错入队不得拖垮会话
    }
  }
}

async function persistL1Scan(companyId: string) {
  const proposed = scanCompanyL1Signals(collectCompanyL1ScanInput(companyId));
  const existing = listL1ForCompany(appCtx.repos.l1LearningQueue.all(), companyId);
  const { toInsert, skipped } = mergeProposedDrafts(existing, proposed);
  for (const item of toInsert) {
    await appCtx.repos.l1LearningQueue.insert(item);
  }
  return {
    proposed: proposed.length,
    inserted: toInsert.length,
    skipped,
    items: listL1ForCompany(appCtx.repos.l1LearningQueue.all(), companyId),
  };
}

function l1HttpError(e: unknown): {
  status: 400 | 401 | 403 | 404 | 409;
  message: string;
  code?: string;
} {
  if (e instanceof AccessDeniedError) {
    const status = e.code === "UNAUTHENTICATED" ? 401 as const
      : e.code === "NOT_FOUND" ? 404 as const
        : 403 as const;
    return { status, message: e.message, code: e.code };
  }
  if (e instanceof L1LearnError) {
    const status =
      e.code === "CROSS_TENANT" ? 403 as const
        : e.code === "NO_DRAFT" ? 409 as const
          : e.code === "NOT_FOUND" ? 404 as const
            : 400 as const;
    return { status, message: e.message, code: e.code };
  }
  return { status: 400, message: String(e) };
}

/** Admin：全部或按 companyId 过滤的 L1 队列。 */
app.get("/api/admin/l1-learn", requireAdmin, (c) => {
  const companyId = c.req.query("companyId");
  const all = appCtx.repos.l1LearningQueue.all();
  const items = companyId ? listL1ForCompany(all, companyId) : all;
  return c.json({
    status: "success",
    data: { items, summary: summarizeL1Queue(items) },
  });
});

app.post("/api/admin/l1-learn/scan", requireAdmin, async (c) => {
  const body = await jsonBody<{ companyId: string }>(c);
  if (!body.companyId) return c.json({ status: "error", message: "companyId required" }, 400);
  try {
    assertL1Write(c.get("principal"), body.companyId);
    const result = await persistL1Scan(body.companyId);
    return c.json({ status: "success", data: result });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

app.post("/api/admin/l1-learn/session-signal", requireAdmin, async (c) => {
  const body = await jsonBody<{
    companyId: string;
    summary: string;
    conversationId?: string;
    codingHint?: { pattern: string; meaning: string };
  }>(c);
  if (!body.companyId || !body.summary) {
    return c.json({ status: "error", message: "companyId and summary required" }, 400);
  }
  try {
    assertL1Write(c.get("principal"), body.companyId);
    const item = proposeFromSessionCorrection({
      companyId: body.companyId,
      summary: body.summary,
      conversationId: body.conversationId,
      codingHint: body.codingHint,
    });
    const existing = appCtx.repos.l1LearningQueue.byId(item.id);
    if (!existing) await appCtx.repos.l1LearningQueue.insert(item);
    return c.json({
      status: "success",
      data: { item: appCtx.repos.l1LearningQueue.byId(item.id) ?? item, created: !existing },
    });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

async function mutateL1Item(
  companyId: string,
  itemId: string,
  principal: Principal,
  action: "confirm" | "dismiss" | "apply",
  actor: string,
) {
  assertL1Write(principal, companyId);
  const item = appCtx.repos.l1LearningQueue.byId(itemId);
  if (!item || item.companyId !== companyId) {
    throw new L1LearnError("Not found", "NOT_FOUND");
  }
  if (action === "confirm") {
    const next = confirmL1Item(item, actor, companyId);
    await appCtx.repos.l1LearningQueue.update(next.id, next);
    return { item: next };
  }
  if (action === "dismiss") {
    const next = dismissL1Item(item, actor, companyId);
    await appCtx.repos.l1LearningQueue.update(next.id, next);
    return { item: next };
  }
  const confirmed = item.status === "draft"
    ? confirmL1Item(item, actor, companyId)
    : item;
  const { item: applied, draft } = applyL1ItemToDraft({
    item: confirmed,
    companyId,
    versions: appCtx.repos.specVersions.all(),
  });
  await appCtx.repos.specVersions.update(draft.id, draft);
  await appCtx.repos.l1LearningQueue.update(applied.id, applied);
  return { item: applied, draft };
}

app.post("/api/admin/l1-learn/:id/confirm", requireAdmin, async (c) => {
  const body = await jsonBody<{ companyId: string }>(c);
  if (!body.companyId) return c.json({ status: "error", message: "companyId required" }, 400);
  try {
    const data = await mutateL1Item(
      body.companyId, param(c, "id"), c.get("principal"), "confirm", "admin",
    );
    return c.json({ status: "success", data });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

app.post("/api/admin/l1-learn/:id/dismiss", requireAdmin, async (c) => {
  const body = await jsonBody<{ companyId: string }>(c);
  if (!body.companyId) return c.json({ status: "error", message: "companyId required" }, 400);
  try {
    const data = await mutateL1Item(
      body.companyId, param(c, "id"), c.get("principal"), "dismiss", "admin",
    );
    return c.json({ status: "success", data });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

app.post("/api/admin/l1-learn/:id/apply", requireAdmin, async (c) => {
  const body = await jsonBody<{ companyId: string }>(c);
  if (!body.companyId) return c.json({ status: "error", message: "companyId required" }, 400);
  try {
    const data = await mutateL1Item(
      body.companyId, param(c, "id"), c.get("principal"), "apply", "admin",
    );
    return c.json({ status: "success", data });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

/** 回归看板：metrics + sim-out + L1 队列 + 知识卡状态。 */
app.get("/api/admin/regression-dashboard", requireAdmin, (c) => {
  const dash = buildRegressionDashboard({
    dataDir: appCtx.dataDir,
    cwd: process.cwd(),
    l1Items: appCtx.repos.l1LearningQueue.all(),
    knowledgeCards: appCtx.repos.knowledgeCards.all(),
  });
  return c.json({ status: "success", data: dash });
});

/** 公司侧：本厂 L1 队列。 */
app.get("/api/company/:companyId/l1-learn", requireCompany, (c) => {
  const companyId = param(c, "companyId");
  try {
    assertL1Read(c.get("principal"), companyId);
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
  const items = listL1ForCompany(appCtx.repos.l1LearningQueue.all(), companyId);
  return c.json({ status: "success", data: { items, summary: summarizeL1Queue(items) } });
});

app.post("/api/company/:companyId/l1-learn/scan", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  try {
    assertL1Write(c.get("principal"), companyId);
    const result = await persistL1Scan(companyId);
    return c.json({ status: "success", data: result });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

app.post("/api/company/:companyId/l1-learn/session-signal", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  const body = await jsonBody<{
    summary: string;
    conversationId?: string;
    codingHint?: { pattern: string; meaning: string };
  }>(c);
  if (!body.summary) return c.json({ status: "error", message: "summary required" }, 400);
  try {
    assertL1Write(c.get("principal"), companyId);
    const item = proposeFromSessionCorrection({
      companyId,
      summary: body.summary,
      conversationId: body.conversationId,
      codingHint: body.codingHint,
    });
    const existing = appCtx.repos.l1LearningQueue.byId(item.id);
    if (!existing) await appCtx.repos.l1LearningQueue.insert(item);
    return c.json({
      status: "success",
      data: { item: appCtx.repos.l1LearningQueue.byId(item.id) ?? item, created: !existing },
    });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

app.post("/api/company/:companyId/l1-learn/:id/confirm", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  try {
    const data = await mutateL1Item(
      companyId, param(c, "id"), c.get("principal"), "confirm", "company",
    );
    return c.json({ status: "success", data });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

app.post("/api/company/:companyId/l1-learn/:id/dismiss", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  try {
    const data = await mutateL1Item(
      companyId, param(c, "id"), c.get("principal"), "dismiss", "company",
    );
    return c.json({ status: "success", data });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

app.post("/api/company/:companyId/l1-learn/:id/apply", requireCompany, async (c) => {
  const companyId = param(c, "companyId");
  try {
    const data = await mutateL1Item(
      companyId, param(c, "id"), c.get("principal"), "apply", "company",
    );
    return c.json({ status: "success", data });
  } catch (e) {
    const err = l1HttpError(e);
    return c.json({ status: "error", message: err.message, code: err.code }, err.status);
  }
});

/** 客户探测：有账号也不能枚举 L0 卡实体。 */
app.get("/api/knowledge", requireAccount, (c) => {
  const cards = listKnowledgeCardsFor(c.get("principal"), appCtx.repos.knowledgeCards.all());
  return c.json({
    status: "success",
    data: {
      cards,
      note: "L0 card entities are admin-only; runtime uses published overlays/handbook only.",
    },
  });
});

/**
 * 给一家商家开后台入口（SCENARIOS 场景 A 第 1 点、场景 I 第 6 点）。
 *
 * 令牌**只在这一次回包里出现**，之后任何接口都不再吐出它——公司目录是公开的，
 * 令牌一旦出现在那里，隔离就等于没有。运营把它交给商家，丢了就重开一个。
 */
app.post("/api/admin/companies", requireAdmin, async (c) => {
  const body = await jsonBody<{
    id: string; name: string; aliases: string[]; quoteEmail: string;
    province: string; serviceAreas: string[];
    subscription: "none" | "trial" | "active"; leadFeeEnabled: boolean;
  }>(c);
  if (!body.name || !body.quoteEmail) {
    return c.json({ error: "Company name and quote email are required" }, 400);
  }
  const id = body.id || `co_${randomUUID().slice(0, 8)}`;
  if (appCtx.repos.companies.byId(id)) return c.json({ error: `Company ${id} already exists` }, 409);

  const accessToken = generateCompanyToken();
  const company: CabinetCompany = {
    id, name: body.name,
    aliases: body.aliases ?? [],
    quoteEmail: body.quoteEmail,
    province: (body.province ?? "ON") as CabinetCompany["province"],
    serviceAreas: body.serviceAreas ?? [],
    createdAt: now(),
    billingPlan: {
      leadFeeEnabled: body.leadFeeEnabled ?? true,
      personalizationSubscription: body.subscription ?? "none",
    },
    accessToken,
  };
  await appCtx.repos.companies.insert(company);
  return c.json({
    company: { ...company, accessToken: undefined },
    // 只此一次
    accessToken,
    note: "This token appears only in this response — give it to the seller and store it securely.",
  }, 201);
});

/** 改订阅状态。发布 + 订阅同时满足，公司才真的 active（场景 A 第 8 点）。 */
app.post("/api/admin/companies/:id/subscription", requireAdmin, async (c) => {
  const company = appCtx.repos.companies.byId(param(c, "id"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const body = await jsonBody<{ subscription: "none" | "trial" | "active" }>(c);
  if (!["none", "trial", "active"].includes(body.subscription ?? "")) {
    return c.json({ error: "Subscription status must be none / trial / active" }, 400);
  }
  const next: CabinetCompany = {
    ...company,
    billingPlan: { ...company.billingPlan, personalizationSubscription: body.subscription! },
  };
  await appCtx.repos.companies.update(next.id, next);
  return c.json({
    company: { ...next, accessToken: undefined },
    // status 是**派生值**，不是可独立编辑的字段（§6.2）
    active: isCompanyActive(next),
  });
});

app.post("/api/admin/billing/:eventId/resolve", requireAdmin, async (c) => {
  const event = appCtx.repos.billingEvents.byId(param(c, "eventId"));
  if (!event) return c.json({ error: "Billing event not found" }, 404);
  const body = await jsonBody<{ resolution: string; resolvedBy: string }>(c);
  try {
    const updated = resolveDispute(event, {
      resolvedBy: body.resolvedBy ?? "ops",
      resolution: (body.resolution as never) ?? "upheld",
      at: now(),
    });
    await appCtx.repos.billingEvents.update(updated.id, updated);
    return c.json({ event: updated });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

/**
 * 销售看板：按归一化名聚合的提及信号（FR-12.3）。
 * **去标识化**：只给聚合计数与外联话术，不含任何客户身份（FR-13 第 3 条）。
 */
app.get("/api/admin/mention-signals", requireAdmin, (c) =>
  c.json({
    aggregated: aggregateSignals(appCtx.repos.mentionSignals.all()).map((a) => ({
      normalizedName: a.normalizedName,
      count: a.count,
      latestAt: a.latestAt,
      outreachLine: deIdentifySignal(a.count),
    })),
  }));

/**
 * 上线闸门状态（docs/LAUNCH_BLOCKERS.md）。
 *
 * 放在运营端点里，是为了让「还差哪几项才能上线」随时查得到，
 * 而不是等到某次部署时才想起来。
 */
app.get("/api/admin/launch-gates", requireAdmin, (c) => c.json(launchGateSummary()));

/** 留存清除：返回**计划**而不是直接执行，便于预演与审计（FR-13 第 4 条）。 */
app.get("/api/admin/retention/plan", requireAdmin, (c) =>
  c.json({
    plan: planRetentionSweep({
      conversations: appCtx.repos.conversations.all(),
      estimates: appCtx.repos.estimates.all(),
      quotes: appCtx.repos.quotes.all(),
      billingEvents: appCtx.repos.billingEvents.all(),
      auditEvents: appCtx.repos.auditEvents.all(),
      at: now(),
    }),
  }));

async function runRetentionSweepNow(opts?: { dryRun?: boolean }) {
  const at = now();
  const plan = planRetentionSweep({
    conversations: appCtx.repos.conversations.all(),
    estimates: appCtx.repos.estimates.all(),
    quotes: appCtx.repos.quotes.all(),
    billingEvents: appCtx.repos.billingEvents.all(),
    auditEvents: appCtx.repos.auditEvents.all(),
    at,
  });
  return executeRetentionSweep({
    plan,
    at,
    dryRun: opts?.dryRun,
    deleteConversation: async (id) => { await appCtx.repos.conversations.remove(id); },
    deleteEstimate: async (id) => { await appCtx.repos.estimates.remove(id); },
    deIdentifyQuote: async (id) => {
      const q = appCtx.repos.quotes.byId(id);
      if (q) await appCtx.repos.quotes.update(id, deIdentifyQuote(q));
    },
    deIdentifyBilling: async (id) => {
      const e = appCtx.repos.billingEvents.byId(id);
      if (e) await appCtx.repos.billingEvents.update(id, deIdentifyBillingEvent(e));
    },
    deleteAudit: async (id) => { await appCtx.repos.auditEvents.remove(id); },
  });
}

/**
 * B6：执行留存清除（默认 dryRun；`{"dryRun":false}` 才真删/去标识化）。
 * 与启动时 `RETENTION_CRON_MS` 定时任务共用同一执行函数。
 */
app.post("/api/admin/retention/run", requireAdmin, async (c) => {
  const body = await jsonBody<{ dryRun?: boolean }>(c).catch(() => ({} as { dryRun?: boolean }));
  const dryRun = body.dryRun !== false; // 缺省预演，防止误触
  const result = await runRetentionSweepNow({ dryRun });
  return c.json({ status: "success", data: result });
});

// ── 数据主体权利（FR-13 第 5 条）──────────────────────────────────────────

app.get("/api/me/export", requireAccount, (c) => {
  const account = c.get("account");
  const lang = (c.req.query("lang") === "zh" ? "zh" : "en") as "en" | "zh";
  return c.json(exportAccountData(account, {
    conversations: appCtx.repos.conversations.all(),
    estimates: appCtx.repos.estimates.all(),
    quotes: appCtx.repos.quotes.all(),
  }, now(), lang));
});

/**
 * 删除权。与法定留存冲突时执行**去标识化保留**并如实说明，
 * 而不是拒绝整个请求（FR-13 第 5 条）。
 */
app.post("/api/me/delete", requireAccount, async (c) => {
  const account = c.get("account");
  const body = await jsonBody<{ lang?: string }>(c).catch(() => ({ lang: undefined }));
  const lang = (body.lang === "zh" || c.req.query("lang") === "zh" ? "zh" : "en") as "en" | "zh";
  const outcome = executeDeletionRequest(account.id, {
    conversations: appCtx.repos.conversations.all(),
    estimates: appCtx.repos.estimates.all(),
    quotes: appCtx.repos.quotes.all(),
    billingEvents: appCtx.repos.billingEvents.all(),
  }, lang);

  for (const id of outcome.conversationsDeleted) await appCtx.repos.conversations.remove(id);
  for (const id of outcome.estimatesDeleted) await appCtx.repos.estimates.remove(id);
  for (const id of outcome.quotesDeIdentified) {
    const q = appCtx.repos.quotes.byId(id);
    if (q) await appCtx.repos.quotes.update(id, deIdentifyQuote(q));
  }
  for (const id of outcome.billingDeIdentified) {
    const e = appCtx.repos.billingEvents.byId(id);
    if (e) await appCtx.repos.billingEvents.update(id, deIdentifyBillingEvent(e));
  }
  return c.json({ outcome });
});

// ── 贸易账号：多项目管理（FR-11、场景 F）───────────────────────────────────

/**
 * 项目列表。
 *
 * 消费者账号也能调——建商与消费者的差别是"同时手上有几单"，
 * 不是"有没有项目"这个概念。给消费者返回的通常就一条。
 */
app.get("/api/me/projects", requireAccount, (c) => {
  const account = c.get("account");
  const lang = (c.req.query("lang") === "zh" ? "zh" : "en") as "en" | "zh";
  const projects = listProjects({
    account,
    conversations: appCtx.repos.conversations.all(),
    quotes: appCtx.repos.quotes.all(),
    at: now(),
    language: lang,
  });
  return c.json({
    projects,
    portfolio: summarizePortfolio(projects, appCtx.repos.quotes.all()),
    portfolioFormatted: format(summarizePortfolio(projects, appCtx.repos.quotes.all()).sentValue),
  });
});

/** 当前账号的交互模式与贸易价门槛状态——前端据此决定引导到哪一步。 */
app.get("/api/me/profile", requireAccount, (c) => {
  const account = c.get("account");
  const verification = verificationFor(account.id);
  const gate = canSeeTradePricing(account, verification);
  const effective = effectiveAccountType(account, verification);
  const isPlatformAdmin = (account.platformRoles ?? []).includes("platform_admin");
  return c.json({
    accountType: account.accountType,
    /** 定价实际按哪种账号走——与 accountType 可能不同，如实告知。 */
    effectiveAccountType: effective,
    displayName: account.displayName,
    email: account.email,
    province: account.province,
    ...(account.companyName ? { companyName: account.companyName } : {}),
    capabilities: {
      adminConsole: isPlatformAdmin,
      trainer: isPlatformAdmin,
    },
    interaction: interactionProfile(effective),
    // 界面开场白里那一段"这里卖的是 RTA"。默认英文；会话里若客户切了中文，
    // 前端用会话 language 再取一次（见 GET conversation）。
    rtaIntro: rtaIntro(DEFAULT_LANGUAGE),
    rtaIntroByLang: { en: rtaIntro("en"), zh: rtaIntro("zh") },
    defaultLanguage: DEFAULT_LANGUAGE,
    tradePricing: gate,
    verification: verification
      ? { status: verification.status, submittedAt: verification.submittedAt,
          reviewedAt: verification.reviewedAt, rejectionReason: verification.rejectionReason }
      : { status: "unverified" as const },
  });
});

/** 提交贸易资质。只收编号与注册名，不收证件影像（PIPEDA 最小化）。 */
app.post("/api/me/verification", requireAccount, async (c) => {
  const account = c.get("account");
  if (account.accountType !== "trade") {
    return c.json({ error: "Only trade accounts submit verification" }, 400);
  }
  const body = await jsonBody<{ businessNumber: string; legalName: string }>(c);
  try {
    const next = submitVerification(verificationFor(account.id), {
      accountId: account.id,
      businessNumber: body.businessNumber ?? "",
      legalName: body.legalName ?? "",
      at: now(),
    });
    await appCtx.repos.tradeVerifications.upsert(next);
    return c.json({ verification: { status: next.status, submittedAt: next.submittedAt } }, 201);
  } catch (e) {
    if (e instanceof VerificationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** 运营侧：待审队列。 */
app.get("/api/admin/verifications", requireAdmin, (c) => {
  const pending = appCtx.repos.tradeVerifications.filter((v) => v.status === "pending");
  return c.json({
    verifications: pending.map((v) => {
      const account = appCtx.repos.accounts.byId(v.accountId);
      return {
        ...v,
        accountEmail: account?.email,
        accountProvince: account?.province,
        // 号码格式对得上时给个提示，减少人工比对量
        gstFormatOk: v.businessNumber ? looksLikeGstNumber(v.businessNumber) : false,
      };
    }),
  });
});

app.post("/api/admin/verifications/:accountId/review", requireAdmin, async (c) => {
  const current = appCtx.repos.tradeVerifications.byId(param(c, "accountId"));
  if (!current) return c.json({ error: "Verification request not found" }, 404);
  const body = await jsonBody<{ approve: boolean; reviewedBy: string; reason: string }>(c);
  try {
    const next = reviewVerification(current, {
      approve: body.approve === true,
      reviewedBy: body.reviewedBy ?? "ops",
      ...(body.reason ? { reason: body.reason } : {}),
      at: now(),
    });
    await appCtx.repos.tradeVerifications.update(next.id, next);
    return c.json({ verification: next });
  } catch (e) {
    if (e instanceof VerificationError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

// ── 计费争议：公司侧透明度与运营侧裁定（FR-7、8.1）────────────────────────

/**
 * 公司侧的争议视图。
 *
 * 与 `/api/company/:id/billing` 的区别：这里补上**争议窗口还剩几天**与
 * 每条计费对应的报价摘要——公司要判断"这条线索是不是真的"，
 * 光有一个 id 和金额是判断不了的。
 */
app.get("/api/company/:companyId/billing/disputes", requireCompany, (c) => {
  const companyId = param(c, "companyId");
  const scope = new TenantScope(companyId);
  const at = now();
  return c.json({
    events: scope.filter(appCtx.repos.billingEvents.all()).map((e) => {
      const q = appCtx.repos.quotes.byId(e.quoteId);
      return {
        event: e,
        feeFormatted: format(e.feeAmount),
        disputeWindowEndsAt: disputeWindowEndsAt(e),
        canDispute: e.dispute === undefined && isWithinDisputeWindow(e, at),
        // 只给公司自己那份报价的摘要，不含客户身份（FR-13 第 3 条）
        quote: q
          ? { id: q.id, sentAt: e.sentAt, lineCount: q.lineItems.length, total: format(q.total) }
          : undefined,
      };
    }),
  });
});

/**
 * 运营侧的争议裁定台。
 *
 * 裁定要有依据，所以这里把**审计事件链**一并给出——每条事件带当时的内容哈希，
 * 能证明"发出去的确实是这一版报价"（§3.6）。运营不该凭公司一面之词裁定。
 */
app.get("/api/admin/disputes", requireAdmin, (c) => {
  // 未裁定 = 有 dispute 且还没写 resolution
  const open = appCtx.repos.billingEvents.filter(
    (e) => e.dispute !== undefined && e.dispute.resolution === undefined);
  return c.json({
    disputes: open.map((e) => {
      const q = appCtx.repos.quotes.byId(e.quoteId);
      const events = appCtx.repos.auditEvents.filter((a) => a.quoteId === e.quoteId);
      return {
        event: e,
        feeFormatted: format(e.feeAmount),
        company: appCtx.repos.companies.byId(e.companyId)?.name ?? e.companyId,
        withinWindow: isWithinDisputeWindow(e, e.dispute!.openedAt),
        evidence: {
          auditTrail: events.map((a) => ({
            at: a.at, actor: a.actor, action: a.action, contentHash: a.contentHash,
            details: a.details,
          })),
          // 报价内容与「发送时刻记录的哈希」是否仍然一致——事后被改过就查得出来。
          // 注意这里比的是内容哈希，不是拿当前规格复算：公司发布了新版本
          // 本来就会算出不同的价，那不是篡改。
          snapshotIntact: q
            ? events.filter((a) => a.action === "sent")
                .every((a) => a.contentHash === quoteContentHash(q))
            : undefined,
          quoteStatus: q?.status,
        },
      };
    }),
  });
});

// ── 辅助 ──────────────────────────────────────────────────────────────────

function ownedFloorPlan(c: Ctx, id: string): FloorPlan | undefined {
  const plan = appCtx.repos.floorPlans.byId(id);
  if (!plan) return undefined;
  const conv = appCtx.repos.conversations.byId(plan.conversationId);
  return conv && conv.customerAccountId === c.get("account").id ? plan : undefined;
}

/** 按公司的面框/覆盖方式出四视图——这两个是渲染参数（REQUIREMENTS 3.3 第 5 点）。 */
function viewsFor(plan: FloorPlan, layout: GeneratedLayout, companyId: string) {
  const { construction, overlay } = renderStyleFor(appCtx, companyId);
  return plan.parsedGeometry.wallRuns.map((run) => ({
    runLabel: run.label,
    runId: run.id,
    views: renderFourViews(run, layout.placements, {
      construction, overlay, faceFrameWidth: 1.5, pxPerInch: 6, showDimensions: true,
    }),
  }));
}

/**
 * 图纸的解释 —— 「这是什么图」+「为什么这么排」。
 *
 * 四视图对客户是陌生的表达形式。没有解释，他只能凭直觉说「感觉怪怪的」，
 * 说不出哪里怪，修改意见就无从提起。
 *
 * 解释全部来自实际算出来的结果（几何、人体工程检查、美观评分），不是模板文案。
 */
function explanationFor(
  plan: FloorPlan,
  layout: GeneratedLayout,
  companyId: string,
  prefs: CustomerPreferences,
  language: UiLanguage = DEFAULT_LANGUAGE,
) {
  const { construction, overlay } = renderStyleFor(appCtx, companyId);
  const guide = explainViews({
    construction, overlay,
    hasWallCabinets: layout.placements.some((p) => p.layer === "wall"),
    hasFillers: layout.placements.some((p) => p.kind === "filler"),
    hasAppliances: layout.placements.some((p) => p.kind === "appliance"),
    language,
  });

  const perRun = plan.parsedGeometry.wallRuns.map((run) => {
    const score = layout.aesthetics.find((a) => a.wallRunId === run.id)?.score;
    const rationale = explainDesign({
      run,
      placements: layout.placements,
      ...(score ? { aesthetics: score } : {}),
      ergonomics: layout.ergonomics.filter((v) => !v.wallRunId || v.wallRunId === run.id),
      warnings: layout.warnings.filter((w) => !w.wallRunId || w.wallRunId === run.id),
      acceptable: layout.acceptable,
      language,
      ...(prefs.storage ? { storagePreference: prefs.storage } : {}),
    });
    return {
      runId: run.id,
      runLabel: run.label,
      rationale,
      text: renderRationaleText(rationale),
      html: renderRationaleHtml(rationale),
    };
  });

  return {
    viewGuide: guide,
    viewGuideText: renderViewGuideText(guide, language),
    viewGuideHtml: renderViewGuideHtml(guide, language),
    perRun,
  };
}

function convLanguage(conv: Conversation): UiLanguage {
  return resolveLanguage(conv.preferences?.shared);
}

function toHistory(m: ChatMessage): { role: "user" | "assistant"; content: string } {
  return { role: m.role, content: m.content };
}

/** 这句话是不是「只在切换语言」，没有夹带别的需求。 */
function isLanguageSwitchOnly(text: string): boolean {
  if (!detectLanguageSwitch(text)) return false;
  const stripped = text
    .replace(/用中文|说中文|讲中文|改成中文|切换到中文|请用中文|能不能用中文|可以中文|中文回答|中文交流/g, "")
    .replace(/用英文|说英文|讲英文|改成英文|切换到英文|请用英文|英文回答|英文交流/g, "")
    .replace(/\b(in\s+chinese|speak\s+chinese|switch\s+to\s+chinese|reply\s+in\s+chinese|in\s+english|speak\s+english|switch\s+to\s+english|talk\s+in\s+english|reply\s+in\s+english|can you (?:talk|speak|reply) in english)\b/gi, "")
    .replace(/[,.!?，。！？\s]+/g, "")
    .trim();
  return stripped.length === 0;
}

/**
 * 已经连着几轮在问同样的缺失字段。
 *
 * 返回**次数**而不是布尔值：只知道"重复了"没法决定该说什么，第二次和第五次
 * 该说的话不一样（见 orchestrator.ts 的 fallbackPrompt）。
 *
 * `currentAsks` 是这一轮实际会问出口的那几句话（检查表 openAsks 的
 * askHint/brief，或者兜底的字段名）——不能只看 `missingFields()`：
 * 户型/上下水这类检查表缺口走的是 `openAsks`，跟 style/budget/province
 * 这套自由文本字段是两条不同的判断，只查后者会漏掉前者反复问同一句的情况
 * （客户已经报了尺寸/布局，checklist 卡在"上传户型图/上下水"上无限重复，
 * 但 style/budget 这层永远看不出"问过"）。
 */
function askedSameFieldsBefore(
  conv: Conversation, nextRequirements: string, currentAsks: readonly string[] = [],
): number {
  const stillMissing = missingFields(nextRequirements);
  if (stillMissing.length === 0 && currentAsks.length === 0) return 0;

  // 数的是**总共问过几次**，不是"连着问了几次"。
  //
  // 连续计数有个反直觉的坑：追问两次后系统换成一句不点名字段的软化说法，
  // 这句话本身会把连续计数打断，于是下一轮又从"第一次问"开始，客户会看到
  // 「问 → 换选择题 → 软化 → 又问」的循环。问过两次就是问过两次。
  return conv.messages.filter(
    (m) => m.role === "assistant" && !m.companyId && (
      stillMissing.some((f) =>
        m.content.includes(f)
        || m.content.includes(fieldLabel(f, "en"))
        || m.content.includes(fieldLabel(f, "zh")))
      || currentAsks.some((a) => a.trim() && m.content.includes(a))
    ),
  ).length;
}

/** 把这一轮的输入并进需求摘要后的样子——用于判断本轮是否有进展。 */
function designRequirementsAfter(conv: Conversation, text: string): string {
  return mergeRequirements(conv.designRequirements, text);
}

/**
 * 连续几轮没有新信息被收集。
 *
 * 判据是**需求摘要有没有变长**——`mergeRequirements` 只在真的有新内容时才追加。
 * 用它当「有没有进展」的代理指标，比让模型自述可靠。
 */
function turnsWithoutProgress(conv: Conversation): number {
  const userTurns = conv.messages.filter((m) => m.role === "user").length;
  if (userTurns === 0) return 0;
  // 需求摘要按行累积；行数明显少于用户轮次，说明有若干轮没带来新信息
  const lines = conv.designRequirements.split("\n").filter((l) => l.trim()).length;
  return Math.max(0, userTurns - lines);
}

/** 组装 PDF 报价单的输入。邮件附件与下载端点共用，保证两边是同一份。 */
function renderQuotePdf(
  q: Quote, plan: FloorPlan, layout: GeneratedLayout, account: CustomerAccount,
) {
  const company = appCtx.repos.companies.byId(q.companyId);
  const bundle = publishedBundle(appCtx, q.companyId);
  const sender = resolveSenderIdentity();
  const style = renderStyleFor(appCtx, q.companyId);
  const doorStyle = bundle?.doorStyles.find((d) => d.id === q.doorStyleId);
  const boxMaterial = bundle?.boxMaterialOptions?.find((m) => m.id === q.boxMaterialId);

  return buildQuotePdf({
    quote: q,
    companyName: company?.name ?? q.companyId,
    customerName: account.displayName,
    customerEmail: account.email,
    province: q.province,
    doorStyleName: doorStyle?.name ?? q.doorStyleId,
    // PDF 是英文文档、用的是只覆盖 Latin-1 的 base-14 字体：印商家的中文名
    // 会变成一串 `?`。印归一化类别的英文名——商家叫法各异，`code` 是同一个。
    ...(boxMaterial ? { boxMaterialName: BOX_MATERIAL_LABEL_EN[boxMaterial.code] } : {}),
    runs: plan.parsedGeometry.wallRuns.map((run) => ({
      run,
      placements: layout.placements.filter((p) => p.wallRunId === run.id),
    })),
    senderName: sender.name,
    ...(sender.contact ? { senderContact: sender.contact } : {}),
    construction: style.construction,
    overlay: style.overlay,
  });
}

/** 报价单的纯文本呈现（HTML 内嵌四视图版本属 MVP-2）。 */
function renderQuoteText(q: Quote): string {
  const lines = q.lineItems.map((l) =>
    `  ${l.moduleCode.padEnd(10)} ${l.width}"x${l.height}"x${l.depth}"  x${String(l.qty).padStart(2)}  ` +
    `${format(l.unitNetPrice).padStart(10)}  ${format(l.lineSubtotal).padStart(11)}`);
  return [
    "  SKU         Size                Qty         Net           Line",
    "  " + "-".repeat(62),
    ...lines,
    "  " + "-".repeat(62),
    `  Subtotal: ${format(q.subtotal)}`,
    ...q.discounts.map((d) => `  ${d.description}: -${format(d.amount)}`),
    `  Shipping: ${format(q.shipping.amount)}`,
    ...q.taxes.map((t) => `  ${t.name} ${t.ratePercent}%: ${format(t.amount)}`),
    `  Total (${q.currency}): ${format(q.total)}`,
    "",
    `  Valid until ${q.validUntil.slice(0, 10)}`,
  ].join("\n");
}

// ── 启动 ──────────────────────────────────────────────────────────────────

/** 供 CLI / 测试套件取与 HTTP 同一套 repos（勿另开 createAppContext）。 */
export function getAppContext(): AppContext {
  return appCtx;
}

export async function createApp(opts: Parameters<typeof createAppContext>[0] = {}) {
  appCtx = await createAppContext(opts);
  gate = siteGateDisabledExplicitly()
    ? { secret: "", enabled: false }
    : resolveSiteGate();
  accountSessionCfg = resolveAccountSessionConfig();
  return app;
}

let retentionCron: RetentionCronHandle | undefined;

export async function start(port = Number(process.env.PORT || 8790)) {
  try {
    // 生产环境有未核实的阻断项就不启动。这些项错了不会报错，只会安静地
    // 产出错误结果（税率、NKBA 净空），所以必须在这里拦住。
    assertLaunchReady();
    await createApp();
  } catch (e) {
    // 配置/流程的疏漏要响亮地失败，而不是静默地跑起来
    if (e instanceof SiteGateMisconfigured || e instanceof LaunchGatesNotMet) {
      console.error(`\n[rta-hub] 启动中止：\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  // B6：留存清除 cron（RETENTION_CRON_MS>0 时启动；真执行，非 dryRun）
  const cronMs = retentionCronIntervalMs();
  retentionCron = startRetentionCron({
    intervalMs: cronMs,
    run: () => runRetentionSweepNow({ dryRun: false }),
    log: (line) => console.log(`[rta-hub] ${line}`),
  });
  return serve({ fetch: app.fetch, port }, (info) => {
    const smtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    const company = appCtx.repos.companies.all()[0];
    const bundle = company ? publishedBundle(appCtx, company.id) : undefined;
    console.log(`[rta-hub] http://localhost:${info.port}`);
    console.log(`[rta-hub] 试点公司：${company?.name ?? "（无）"}（${bundle?.modules.length ?? 0} 个型号）`);
    console.log(`[rta-hub] LLM：${appCtx.llm ? "已接入" : "未配置 —— 对话降级为确定性问答"}`);
    console.log(`[rta-hub] Vision(户型图)：${appCtx.vision ? "已接入" : "未配置 —— 上传后手动录入尺寸"}`);
    console.log(`[rta-hub] SMTP：${smtp ? "已配置" : "未配置 —— 发送为 dry-run"}`);
    console.log(`[rta-hub] 留存 cron：${cronMs > 0 ? `每 ${cronMs}ms` : "未启用（设 RETENTION_CRON_MS）"}`);
    console.log(`[rta-hub] ${startupNotice(gate)}`);
    console.log(`[rta-hub] ${startupNoticeForAccountSession(accountSessionCfg)}`);
    for (const line of tierReport(resolveModelTiers())) console.log(`[rta-hub] ${line}`);
    for (const line of launchGateReport()) console.log(`[rta-hub] ${line}`);
  });
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) void start();

export { app };
