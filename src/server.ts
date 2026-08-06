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
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context, Next } from "hono";

import { fromDollars, format } from "./domain/money.js";
import type { ChatMessage, Conversation, CustomerAccount, Quote } from "./domain/types.js";
import type { FloorPlan } from "./floorplan/types.js";
import type { GeneratedLayout } from "./layout/generate.js";
import { TenantScope } from "./tenancy/scoped-repo.js";
import { authorizeCompany } from "./tenancy/company-auth.js";
import {
  aggregateSignals, buildMentionSignal, clientFacingMessage, parseMentions, routeByText,
} from "./routing/mention.js";
import {
  buildSendDisclosure, confirm, createQuoteFromLlmOutput, recordSendResult,
} from "./app/quote-service.js";
import { openDispute, resolveDispute } from "./billing/lead-events.js";
import { quoteContentHash } from "./quote/state.js";
import { layoutFace, toSvg } from "./render/face-grammar.js";
import { buildFace, BASE_FACE_HEIGHT, matchFaceTemplate, type FaceTemplateId } from "./render/templates.js";
import {
  companyAgentReply, mergeRequirements, missingFields, orchestratorReply,
} from "./agents/orchestrator.js";
import {
  buildEstimateDraft, buildIllustratedEstimate, estimateCountsFromText, renderEstimateText,
} from "./estimate/generic.js";
import { buildQuoteEmail, deIdentifySignal, resolveSenderIdentity, sendEmail } from "./email/sender.js";
import { buildHtmlQuoteEmail } from "./email/html-quote.js";
import { buildComparison, renderComparisonHtml, renderComparisonText } from "./quote/comparison.js";
import {
  addFeature, addWallRun, createFloorPlan, pendingQuestions, resolveCeilingHeight, resolveItem,
  resolveWallLength,
} from "./floorplan/parse.js";
import { isLayoutReady, type WallFeature } from "./floorplan/types.js";
import { generateLayout, regenerateRun, toSelections } from "./layout/generate.js";
import { formatInches, renderFourViews } from "./render/views.js";
import {
  explainDesign, explainViews, renderRationaleHtml, renderRationaleText,
  renderViewGuideHtml, renderViewGuideText,
} from "./render/explain.js";
import { subscribe, SubscriptionError, unsubscribeByToken } from "./marketing/subscriptions.js";
import {
  deIdentifyBillingEvent, deIdentifyQuote, executeDeletionRequest, exportAccountData,
  planRetentionSweep,
} from "./privacy/retention.js";
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
  approvePlan, backToPlan, deferDrawing, grantDrawingConsent, markQuoted, markReadyToDraw,
  newSession, recordPlanRevision, stagePrompt, StageError, allowedArtifacts,
  type DesignSession,
} from "./design/stages.js";
import { renderPlanViews } from "./render/plan-view.js";
import { buildBom, bomToSelections } from "./layout/bom.js";
import { buildQuoteList, renderQuoteListHtml, renderQuoteListText } from "./quote/line-items.js";
import {
  applyPreferencesToSelections, buildApplianceQuestions, buildQuestionSet, drawerBiasFor,
  PreferenceError, resolvePreferences, unappliedPreferences, validatePreferences,
  type CustomerPreferences,
} from "./preferences/questions.js";
import {
  applianceFrom, normalizeAppliances, provenanceNote, violationCaveat,
  type ApplianceKind, type ApplianceSpec,
} from "./floorplan/appliances.js";
import { disputeWindowEndsAt, isWithinDisputeWindow } from "./billing/lead-events.js";
import {
  assertLaunchReady, launchGateReport, launchGateSummary, LaunchGatesNotMet,
} from "./app/launch-gates.js";
import {
  checkPassword, cookieHeader, issueToken, rateLimit, resolveSiteGate,
  siteGate, siteGateDisabledExplicitly, SiteGateMisconfigured, startupNotice, unlockPage,
  type SiteGateConfig,
} from "./app/site-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEAD_FEE = fromDollars(process.env.LEAD_FEE_CAD || "45.00");
const now = (): string => new Date().toISOString();

type AppVars = { account: CustomerAccount };
type Ctx = Context<{ Variables: AppVars }>;

let appCtx: AppContext;

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
    return c.html(unlockPage(`尝试次数过多，请 ${Math.ceil(limit.retryAfterSec / 60)} 分钟后再试。`), 429);
  }

  // 登录页是普通表单提交；同时接受 JSON，便于脚本化测试
  const ct = c.req.header("content-type") ?? "";
  const password = ct.includes("json")
    ? (await jsonBody<{ password: string }>(c as Ctx)).password
    : (await c.req.parseBody())["password"];

  if (!checkPassword(gate, password)) {
    return c.html(unlockPage("口令不正确。"), 401);
  }

  const secure = new URL(c.req.url).protocol === "https:";
  c.header("set-cookie", cookieHeader(issueToken(gate), secure));
  return c.redirect("/", 303);
});

/**
 * MVP-1 的最小鉴权：`X-Account-Id` 头标识调用方。
 * 生产需要真正的登录态与令牌（PRE_LAUNCH_CHECKLIST E1）。
 */
async function requireAccount(c: Ctx, next: Next) {
  const id = c.req.header("x-account-id");
  const account = id ? appCtx.repos.accounts.byId(id) : undefined;
  if (!account) return c.json({ error: "未认证：请在 X-Account-Id 头中提供账号 id" }, 401);
  c.set("account", account);
  await next();
}

/** 平台运营端点的最小保护。未配置 ADMIN_TOKEN 时一律拒绝，不留默认口令。 */
async function requireAdmin(c: Ctx, next: Next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || c.req.header("x-admin-token") !== expected) {
    return c.json({ error: "未授权：需要有效的 X-Admin-Token" }, 401);
  }
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
  await next();
}

function ownedConversation(c: Ctx, id: string): Conversation | undefined {
  const conv = appCtx.repos.conversations.byId(id);
  return conv && conv.customerAccountId === c.get("account").id ? conv : undefined;
}

function ownedQuote(c: Ctx, id: string): Quote | undefined {
  const q = appCtx.repos.quotes.byId(id);
  return q && q.customerAccountId === c.get("account").id ? q : undefined;
}

// ── 户型图与方案的持久化访问（MVP-3：从内存 Map 迁到仓储）─────────────────

/** 某个会话当前在用的户型图。一个会话一张——多张的场景留给 trade 的多项目。 */
function planForConversation(conversationId: string): FloorPlan | undefined {
  return appCtx.repos.floorPlans.find((p) => p.conversationId === conversationId);
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

function verificationFor(accountId: string): TradeVerification | undefined {
  return appCtx.repos.tradeVerifications.byId(accountId);
}

// ── 设计会话阶段（先问再画 → 全局俯视图评审 → 完整图纸）─────────────────

async function sessionFor(conversationId: string, companyId: string): Promise<DesignSession> {
  const existing = appCtx.repos.designSessions.byId(conversationId);
  // 换了公司就重开一段设计进程——排布是绑定公司规格库的
  let session = existing && existing.companyId === companyId
    ? existing
    : newSession({ conversationId, companyId, at: now() });

  // 资料齐了就推进到「该问客户了」。
  // 这个判断放在这里而不是某个 GET 端点里：阶段是**状态的函数**，
  // 不该取决于有没有人先查过一次状态。
  if (session.stage === "collecting" && isReadyToDraw(conversationId)) {
    session = markReadyToDraw(session, now());
  }
  return appCtx.repos.designSessions.upsert(session);
}

/**
 * 能不能开始问「要不要出图」。
 *
 * 判据只有一条：**户型几何完整**（墙段长度、层高都补齐了）。
 *
 * 刻意**不要求**聊天里说全尺寸/布局/风格/预算：
 *   - 尺寸与布局就是户型图本身，再要求打一遍字是多余的；
 *   - 省份在账号上（注册必填，定价要用）；
 *   - 风格与预算是**选择题**的事（FR-1.1），不是从聊天里抠关键词。
 *
 * 把这些当成出图的前置条件，等于让客户为了看一眼排布先做一遍问卷。
 */
function isReadyToDraw(conversationId: string): boolean {
  const plan = planForConversation(conversationId);
  return plan !== undefined && isLayoutReady(plan);
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
function bomFor(plan: FloorPlan, layout: GeneratedLayout, companyId: string) {
  const bundle = publishedBundle(appCtx, companyId);
  return buildBom({
    layout,
    wallRuns: plan.parsedGeometry.wallRuns,
    modules: bundle?.modules ?? [],
    toeKickSystem: toeKickSystemFor(companyId),
  });
}

/**
 * 家电相关的两句话：推定值说明，以及硬约束否决时的注脚。
 *
 * 两者分开，因为用途不同：前者任何时候都该说（客户要知道图是按什么尺寸画的），
 * 后者**只在方案被否决时**才有意义——「你的厨房排不下」和
 * 「按我们猜的尺寸排不下」对客户是完全不同的两句话。
 */
function applianceNotes(plan: FloorPlan, acceptable: boolean): {
  applianceProvenance?: string;
  ergonomicsCaveat?: string;
} {
  const list = plan.appliances ?? [];
  if (list.length === 0) return {};
  const note = provenanceNote(list);
  const caveat = acceptable ? undefined : violationCaveat(list);
  return {
    ...(note ? { applianceProvenance: note } : {}),
    ...(caveat ? { ergonomicsCaveat: caveat } : {}),
  };
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
  if (!conv) return { keys: [], error: "会话不存在" };
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
  await appCtx.repos.conversations.update(conv.id, {
    preferences: { shared: { ...(prev.shared ?? {}), ...split.shared }, byCompany },
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

app.get("/", (c) => c.html(readFileSync(path.join(__dirname, "../web/index.html"), "utf-8")));

// ── 公司目录（只暴露客户可见信息，不暴露订阅/计费状态）────────────────────

app.get("/api/companies", (c) =>
  c.json({
    companies: appCtx.repos.companies.filter(isCompanyActive).map((co) => ({
      id: co.id, name: co.name, aliases: co.aliases, serviceAreas: co.serviceAreas,
    })),
  }));

app.get("/api/companies/:id/spec", (c) => {
  const co = appCtx.repos.companies.byId(param(c, "id"));
  if (!co || !isCompanyActive(co)) return c.json({ error: "公司不存在或暂不可用" }, 404);
  const bundle = publishedBundle(appCtx, co.id);
  if (!bundle) return c.json({ error: "该公司尚无已发布规格" }, 404);
  return c.json({
    company: { id: co.id, name: co.name },
    doorStyles: bundle.doorStyles.map((d) => ({ id: d.id, name: d.name, priceGroupId: d.priceGroupId })),
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
  const conv: Conversation = {
    id: `cv_${randomUUID().slice(0, 8)}`,
    customerAccountId: c.get("account").id,
    messages: [], designRequirements: "", perCompanyThreads: [],
    createdAt: now(),
  };
  await appCtx.repos.conversations.insert(conv);
  return c.json({ conversation: conv }, 201);
});

app.post("/api/conversations/:id/messages", requireAccount, async (c) => {
  const account = c.get("account");
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "会话不存在" }, 404);

  const body = await jsonBody<{ text: string }>(c);
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ error: "text 不能为空" }, 400);

  const at = now();
  const messages: ChatMessage[] = [...conv.messages, { role: "user", content: text, at }];
  const routing = { companies: appCtx.repos.companies.all(), isActive: isCompanyActive };

  const routed: { companyId: string; companyName: string }[] = [];
  const notices: string[] = [];
  const replies: ChatMessage[] = [];
  const perCompanyThreads = conv.perCompanyThreads.map((t) => ({ ...t, messages: [...t.messages] }));

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

      // 公司 Agent：上下文里只有这家公司的 published 规格
      const reply = await companyAgentReply(appCtx.llm, outcome.company.name, bundle,
        { conversationId: conv.id, requirements: conv.designRequirements, history }, text);
      const msg: ChatMessage = { role: "assistant", content: reply.content, companyId: outcome.company.id, at };
      thread.messages.push(msg);
      replies.push(msg);
    } else {
      notices.push(clientFacingMessage(outcome));
      await appCtx.repos.mentionSignals.insert(buildMentionSignal(outcome, {
        conversationId: conv.id, customerAccountId: account.id,
        prospects: appCtx.repos.prospects.all(), at,
      }));
    }
  }

  let designRequirements = conv.designRequirements;
  if (mentions.length === 0) {
    // 交互口吻按**生效**账号类型走：资质没过审的 trade 账号按 consumer 定价，
    // 说话方式也应该一致，否则会出现"按零售价报价却全程行话"的错位
    const effective = effectiveAccountType(account, verificationFor(account.id));

    // 日常轮次走轻量模型，只有确定性触发才上主力（model-tiers.ts）。
    // 「连续几轮没进展」是兜底：轻量模型可能在原地打转，客户已经说了三轮
    // 却一个字段都没被收集到。
    const escalation = escalationDecision({
      userText: text,
      turnsWithoutProgress: turnsWithoutProgress(conv),
      justParsedFloorPlan: false,
    });
    // 上一轮是否已经问过同样的缺失字段——是的话改口去用选择题，别原样再问一遍
    const repeatedAsk = askedSameFieldsBefore(conv, designRequirementsAfter(conv, text));
    const reply = await orchestratorReply(appCtx.llm,
      { conversationId: conv.id, requirements: conv.designRequirements, history: conv.messages.map(toHistory) },
      text, { profile: interactionProfile(effective), escalation, repeatedAsk });
    designRequirements = reply.requirements ?? designRequirements;
    replies.push({ role: "assistant", content: reply.content, at });
  } else {
    designRequirements = mergeRequirements(designRequirements, text);
    if (notices.length > 0 && replies.length === 0) {
      replies.push({ role: "assistant", content: notices[0]!, at });
    }
  }

  const updated = await appCtx.repos.conversations.update(conv.id, {
    messages: [...messages, ...replies], perCompanyThreads, designRequirements,
  });

  // 随回复带上本轮的选择题。
  //
  // 「预算大概多少」这类问题不该用开放式问法——客户不知道一套橱柜该是多少钱，
  // 开放式提问等于让他先去做一遍市场调研。有公司上下文时给出真实门板/五金选项，
  // 没有时至少能给按尺寸锚定的预算区间。
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
  });

  return c.json({
    replies,
    reply: replies[0] ?? null,
    routedTo: routed,
    notices,
    requirements: updated.designRequirements,
    missingFields: missingFields(updated.designRequirements),
    questions,
    questionCompanyId,
  });
});

app.get("/api/conversations/:id", requireAccount, (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  return conv ? c.json({ conversation: conv }) : c.json({ error: "会话不存在" }, 404);
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
  if (!conv) return c.json({ error: "会话不存在" }, 404);

  const companyId = c.req.query("companyId") ?? "";
  const bundle = companyId ? publishedBundle(appCtx, companyId) : undefined;
  if (companyId && !bundle) return c.json({ error: "该公司尚无已发布规格" }, 409);

  const inches = baseRunInches(conv.id);
  const plan = planForConversation(conv.id);
  const stored = plan && companyId
    ? appCtx.repos.storedLayouts.byId(layoutKey(plan.id, companyId))
    : undefined;
  const cabinetCount = stored
    ? stored.moduleCounts.reduce((n, m) => n + m.qty, 0)
    : undefined;

  const effective = effectiveAccountType(account, verificationFor(account.id));
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
  });

  return c.json({
    questions,
    answered: prefsFor(conv, companyId),
    // 没有户型图时预算题问不出来（区间需要尺寸锚定），如实说明而不是给个瞎猜的区间
    ...(inches === undefined
      ? { note: "上传户型图并补齐尺寸后，我们才能给出有依据的预算区间。" }
      : {}),
  });
});

/** 记录客户的选择。跨公司项与该公司项分开存（见 Conversation.preferences）。 */
app.post("/api/conversations/:id/preferences", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "会话不存在" }, 404);

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
  const updated = await appCtx.repos.conversations.update(conv.id, {
    preferences: {
      shared: { ...(prev.shared ?? {}), ...split.shared },
      byCompany,
    },
  });

  return c.json({
    preferences: prefsFor(updated, companyId),
    // 储物偏好会改变排布，已生成的方案需要重排才会生效——不要让客户以为改完就生效了
    layoutAffected: split.shared.storage !== undefined,
  });
});

// ── 冷启动通用预估（FR-10）────────────────────────────────────────────────

app.post("/api/conversations/:id/estimate", requireAccount, async (c) => {
  const account = c.get("account");
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "会话不存在" }, 404);

  // 有户型图就出**含四视图**的版本（MVP-2，场景 B 第 4 点）；否则退回纯文本版
  const plan = appCtx.repos.floorPlans.find((p) => p.conversationId === conv.id && isLayoutReady(p));

  if (plan) {
    const illustrated = buildIllustratedEstimate(appCtx.catalog, plan.parsedGeometry, {
      conversationId: conv.id, province: account.province, at: now(),
    }, { taxRules: appCtx.taxRules, sourceVerified: appCtx.catalogSourceVerified });
    await appCtx.repos.estimates.insert(illustrated.draft);
    return c.json({
      estimate: illustrated.draft,
      text: renderEstimateText(illustrated.draft),
      views: illustrated.viewsByRun,
      viewsDisclaimer: illustrated.viewsDisclaimer,
    }, 201);
  }

  const draft = buildEstimateDraft(appCtx.catalog, {
    conversationId: conv.id,
    moduleCounts: estimateCountsFromText(conv.designRequirements),
    province: account.province,
    at: now(),
  }, { taxRules: appCtx.taxRules, sourceVerified: appCtx.catalogSourceVerified });

  await appCtx.repos.estimates.insert(draft);
  // EstimateDraft 没有 companyId —— 结构上不可能进入发送闸门（FR-8 第 4 条）
  return c.json({ estimate: draft, text: renderEstimateText(draft) }, 201);
});

// ── 报价 ──────────────────────────────────────────────────────────────────

app.post("/api/quotes", requireAccount, async (c) => {
  const account = c.get("account");
  const body = await jsonBody<{
    companyId: string; conversationId: string; doorStyleId: string;
    selections: unknown; designLayoutId: string;
  }>(c);

  const company = body.companyId ? appCtx.repos.companies.byId(body.companyId) : undefined;
  if (!company || !isCompanyActive(company)) return c.json({ error: "公司不存在或暂不可用" }, 404);
  const conv = ownedConversation(c, body.conversationId ?? "");
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  // 客户在选择题里选过门板就直接用，不必再传一遍
  const doorStyleId = body.doorStyleId || prefsFor(conv, company.id).doorStyleId;
  if (!doorStyleId) return c.json({ error: "必须选择门板样式（决定价格组）" }, 400);

  const pricing = pricingContextFor(appCtx, company.id);
  if (!pricing) return c.json({ error: "该公司尚无已发布规格" }, 409);

  // 方案违反人体工程硬约束时不允许出报价——那不是"便宜一点"的取舍，
  // 是灶台旁没处放热锅、洗碗机离水槽太远这类不该发给客户的方案（FR-4）
  const activePlan = planForConversation(conv.id);
  const stored = activePlan
    ? appCtx.repos.storedLayouts.byId(layoutKey(activePlan.id, company.id))
    : undefined;
  if (stored && !stored.acceptable) {
    return c.json({
      error: "当前方案未通过人体工程检查，请先调整",
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
    at: now(),
  });

  for (const e of result.events) await appCtx.repos.auditEvents.insert(e);
  if (!result.ok) return c.json({ error: "报价校验未通过，已拒绝生成", issues: result.issues }, 422);

  await appCtx.repos.quotes.insert(result.quote);

  // 逐项清单：柜体与其门板一组、附件单列、分类汇总。
  // 只给一个总价，客户既判断不了贵在哪，也没法跟别家比（quote/line-items.ts）
  const bom = activePlan && stored
    ? bomFor(activePlan, toGeneratedLayout(stored), company.id) : undefined;
  const list = buildQuoteList({
    quote: result.quote,
    modules: pricing.modules,
    doorStyles: pricing.doorStyles,
    ...(bom ? { bomLines: bom.lines } : {}),
  });

  const session = appCtx.repos.designSessions.byId(conv.id);
  if (session && session.companyId === company.id && session.stage === "fullDrawings") {
    await appCtx.repos.designSessions.upsert(markQuoted(session, now()));
  }

  return c.json({
    quote: result.quote,
    formattedTotal: format(result.quote.total),
    quoteList: list,
    quoteListText: renderQuoteListText(list),
    quoteListHtml: renderQuoteListHtml(list),
    // trade 账号被降级定价时如实说明原因，不静默按零售价出单
    ...(account.accountType === "trade" && !gate.allowed
      ? { tradePricing: { applied: false, reason: gate.reason, nextStep: gate.nextStep } }
      : {}),
  }, 201);
});

app.get("/api/quotes/:id", requireAccount, (c) => {
  const q = ownedQuote(c, param(c, "id"));
  return q ? c.json({ quote: q, formattedTotal: format(q.total) }) : c.json({ error: "报价不存在" }, 404);
});

/** 发送前的二次披露（FR-13 第 2 条）——客户必须先看到这个清单。 */
app.get("/api/quotes/:id/disclosure", requireAccount, (c) => {
  const account = c.get("account");
  const q = ownedQuote(c, param(c, "id"));
  if (!q) return c.json({ error: "报价不存在" }, 404);
  const company = appCtx.repos.companies.byId(q.companyId);
  return c.json(buildSendDisclosure(q, company?.name ?? q.companyId, {
    displayName: account.displayName, email: account.email,
  }));
});

/** 客户确认 —— 独立的服务端状态迁移，留痕。 */
app.post("/api/quotes/:id/confirm", requireAccount, async (c) => {
  const q = ownedQuote(c, param(c, "id"));
  if (!q) return c.json({ error: "报价不存在" }, 404);
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
  if (!q) return c.json({ error: "报价不存在" }, 404);
  if (q.status !== "confirmed") {
    return c.json({ error: `报价当前状态为 ${q.status}，必须先由客户确认才能发送` }, 409);
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
      : { delivered: false, error: "error" in sendResult ? sendResult.error : "未知错误" },
    LEAD_FEE, at,
  );

  await appCtx.repos.quotes.update(outcome.quote.id, outcome.quote);
  for (const e of outcome.events) await appCtx.repos.auditEvents.insert(e);
  if (outcome.billingEvent) await appCtx.repos.billingEvents.insert(outcome.billingEvent);

  return c.json({
    quote: outcome.quote,
    dryRun: sendResult.dryRun,
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
  if (!q) return c.json({ error: "报价不存在" }, 404);

  const plan = planForConversation(q.conversationId);
  const layout = plan ? storedLayoutFor(plan.id, q.companyId) : undefined;
  if (!plan || !layout) return c.json({ error: "该报价没有关联的方案，无法生成图纸版报价单" }, 409);

  const result = renderQuotePdf(q, plan, layout, account);
  return c.body(new Uint8Array(result.pdf), 200, {
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${quoteFilename(q)}"`,
    ...(result.warnings.length ? { "x-pdf-warnings": String(result.warnings.length) } : {}),
  });
});

app.get("/api/quotes/:id/audit", requireAccount, (c) => {
  const q = ownedQuote(c, param(c, "id"));
  if (!q) return c.json({ error: "报价不存在" }, 404);
  return c.json({ events: appCtx.repos.auditEvents.filter((e) => e.quoteId === q.id) });
});

// ── 户型图（FR-3）─────────────────────────────────────────────────────────

app.post("/api/conversations/:id/floorplan", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  const body = await jsonBody<{ fileName: string; mimeType: string; sizeBytes: number; image: string }>(c);

  const plan = await createFloorPlan(
    {
      conversationId: conv.id,
      file: {
        name: body.fileName ?? "floorplan",
        mimeType: body.mimeType ?? "image/png",
        sizeBytes: body.sizeBytes ?? 0,
      },
      at: now(),
    },
    body.image,
    appCtx.vision,
  );
  await appCtx.repos.floorPlans.upsert(plan);
  return c.json({
    floorPlan: plan,
    ready: isLayoutReady(plan),
    // 完整性优先：拿不准的地方逐条追问，不静默跳过（FR-3）
    questions: pendingQuestions(plan),
  }, 201);
});

app.get("/api/floorplans/:id", requireAccount, (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "户型图不存在" }, 404);
  return c.json({ floorPlan: plan, ready: isLayoutReady(plan), questions: pendingQuestions(plan) });
});

/** 客户回答追问 / 手动补齐尺寸。 */
app.post("/api/floorplans/:id/resolve", requireAccount, async (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "户型图不存在" }, 404);
  const body = await jsonBody<{
    itemId: string; wallRunId: string; length: number; ceilingHeight: number;
    addRun: { label: string; length: number };
    addFeature: { wallRunId: string; kind: WallFeature["kind"]; offset: number; width: number };
    /**
     * 这个厨房里的家电（FR-3.2）。
     *
     * 不给 `width` 就走常见尺寸并标 `provenance: "assumed"`——「我不确定」是
     * 合法答案，但推定值要留痕，下游的解释与硬约束提示都读它。
     */
    appliances: {
      kind: ApplianceKind; width?: number;
      clearanceEachSide?: number; preferredZone?: ApplianceSpec["preferredZone"];
    }[];
  }>(c);

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
      if (!run) return c.json({ error: `墙段 ${f.wallRunId} 不存在` }, 400);
      if (typeof f.offset !== "number" || typeof f.width !== "number" || f.width <= 0) {
        return c.json({ error: "特征需要 offset 与正的 width（英寸）" }, 400);
      }
      if (f.offset < 0 || f.offset + f.width > run.length) {
        return c.json({
          error: `${f.kind} 落在 ${formatInches(f.offset)}–${formatInches(f.offset + f.width)}，` +
            `超出了 ${run.label} 的 ${formatInches(run.length)}`,
        }, 400);
      }
      next = addFeature(next, f.wallRunId, {
        kind: f.kind, offset: f.offset, width: f.width,
      }, now());
    }
    if (body.appliances) {
      if (!Array.isArray(body.appliances)) {
        return c.json({ error: "appliances 必须是数组" }, 400);
      }
      next = {
        ...next,
        appliances: normalizeAppliances([
          ...(next.appliances ?? []),
          ...body.appliances.map((a) => applianceFrom(a)),
        ]),
        updatedAt: now(),
      };
    }
    if (body.itemId) next = resolveItem(next, body.itemId, now());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  await appCtx.repos.floorPlans.upsert(next);
  return c.json({
    floorPlan: next, ready: isLayoutReady(next), questions: pendingQuestions(next),
    // 有推定尺寸就如实说出来，并把还能问的问题一并给出——
    // 「我们假设了什么」不该只活在文案里
    ...(next.appliances?.length
      ? {
          appliances: next.appliances,
          ...(provenanceNote(next.appliances) ? { provenanceNote: provenanceNote(next.appliances) } : {}),
          applianceQuestions: buildApplianceQuestions({
            known: next.appliances, kindsAnswered: true, maxPerTurn: 2,
          }),
        }
      : { applianceQuestions: buildApplianceQuestions({ known: [], kindsAnswered: false, maxPerTurn: 1 }) }),
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
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  const companyId = c.req.query("companyId") ?? "";
  if (!companyId) return c.json({ error: "需要 companyId" }, 400);

  const session = await sessionFor(conv.id, companyId);
  const plan = planForConversation(conv.id);
  const missing = missingFields(conv.designRequirements);

  const stored = plan
    ? appCtx.repos.storedLayouts.byId(layoutKey(plan.id, companyId))
    : undefined;

  return c.json({
    session,
    prompt: stagePrompt(session, {
      missingFields: missing,
      ...(stored ? { planAcceptable: stored.acceptable } : {}),
    }),
    allowed: allowedArtifacts(session.stage),
    floorPlanReady: plan ? isLayoutReady(plan) : false,
    missingFields: missing,
  });
});

/**
 * 客户对「要不要出图」的回答，以及后续的阶段推进。
 *
 * 这些是**客户的动作**，不是系统自己往前走——这正是这套阶段机存在的理由。
 */
app.post("/api/conversations/:id/design/advance", requireAccount, async (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  const body = await jsonBody<{
    companyId: string;
    action: "consent" | "defer" | "approvePlan" | "backToPlan" | "revise";
    note: string;
    /** revise 专用：这一轮要改的偏好项（与 /preferences 同一套取值）。 */
    changes: Partial<CustomerPreferences>;
  }>(c);
  const companyId = body.companyId ?? "";
  if (!companyId) return c.json({ error: "需要 companyId" }, 400);

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
            ? { unapplied: "这一轮没有可落到排布上的具体改动，方案与上一版相同。" }
            : {}),
        });
        break;
      }
      default: return c.json({ error: `未知动作 ${String(body.action)}` }, 400);
    }
  } catch (e) {
    if (e instanceof StageError) return c.json({ error: e.message, stage: session.stage }, 409);
    throw e;
  }

  const saved = await appCtx.repos.designSessions.upsert(session);
  const plan = planForConversation(conv.id);
  const stored = plan ? appCtx.repos.storedLayouts.byId(layoutKey(plan.id, companyId)) : undefined;
  return c.json({
    session: saved,
    prompt: stagePrompt(saved, {
      missingFields: missingFields(conv.designRequirements),
      ...(stored ? { planAcceptable: stored.acceptable } : {}),
    }),
    allowed: allowedArtifacts(saved.stage),
    // 这一轮到底改到了什么——客户提的和系统改的分开报，不含糊
    ...(body.action === "revise"
      ? { revision: saved.revisionRequests?.[saved.revisionRequests.length - 1] }
      : {}),
  });
});

/**
 * 全局俯视图 —— 客户第一个看到的图，多轮修改都在它上面进行。
 *
 * 单段墙的俯视图回答不了「L 型两条边怎么接」「U 型中间还剩多宽」，
 * 而这恰恰是客户第一眼要判断的（见 render/plan-view.ts）。
 */
app.post("/api/floorplans/:id/plan-view", requireAccount, async (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "户型图不存在" }, 404);
  if (!isLayoutReady(plan)) {
    return c.json({ error: "户型信息还不完整", questions: pendingQuestions(plan) }, 409);
  }
  const body = await jsonBody<{ companyId: string }>(c);
  const company = body.companyId ? appCtx.repos.companies.byId(body.companyId) : undefined;
  if (!company || !isCompanyActive(company)) return c.json({ error: "公司不存在或暂不可用" }, 404);
  const bundle = publishedBundle(appCtx, company.id);
  if (!bundle) return c.json({ error: "该公司尚无已发布规格" }, 409);

  const session = await sessionFor(plan.conversationId, company.id);
  if (!allowedArtifacts(session.stage).planView) {
    return c.json({
      error: "还没到出图阶段——请先确认「需要我帮你生成设计图吗？」",
      stage: session.stage,
      prompt: stagePrompt(session, { missingFields: [] }),
    }, 409);
  }

  const conv = appCtx.repos.conversations.byId(plan.conversationId);
  const prefs = conv ? prefsFor(conv, company.id) : {};
  const layout = generateLayout(plan.parsedGeometry, bundle.modules, {
    ...(plan.parsedGeometry.ceilingHeight !== undefined
      ? { ceilingHeight: plan.parsedGeometry.ceilingHeight } : {}),
    drawerBias: drawerBiasFor(prefs),
  });
  const lastRevision = session.revisionRequests?.[session.revisionRequests.length - 1];
  const { designLayoutId, revisionNo } = await persistLayout({
    plan, companyId: company.id, layout,
    triggeredBy: session.planRevisions > 0 ? "customerRequest" : "auto",
    // 版本说明要写清「因为客户说了什么才改的」，而不是只留一个轮次编号——
    // 一年后回看这条记录，"第 3 轮调整" 什么也没说明（§3.6 的版本可追溯）
    changeSummary: lastRevision
      ? `第 ${session.planRevisions + 1} 版：${lastRevision.note ?? "客户要求调整"}` +
        (lastRevision.applied.length
          ? `（改动：${lastRevision.applied.join("、")}）`
          : "（无可落到排布上的改动）")
      : "首版全局排布",
  });

  return c.json({
    designLayoutId, revisionNo,
    stage: session.stage,
    planViews: renderPlanViews(plan.parsedGeometry, layout.placements),
    moduleCounts: layout.moduleCounts,
    ergonomics: layout.ergonomics,
    // 推定的家电尺寸会影响硬约束结论——**由推定值导致的否决必须说明它是推定的**，
    // 否则客户会以为自己的厨房真的排不下（FR-3.2）
    ...applianceNotes(plan, layout.acceptable),
    aesthetics: layout.aesthetics,
    acceptable: layout.acceptable,
    warnings: layout.warnings,
    explanation: explanationFor(plan, layout, company.id, prefs),
    prompt: stagePrompt(session, { planAcceptable: layout.acceptable }),
    /** 这一版是应哪次修改而出的——客户能对上自己刚说的话。 */
    ...(lastRevision ? { revision: lastRevision } : {}),
  }, 201);
});

// ── 方案生成与四视图（FR-4 / FR-5）────────────────────────────────────────

app.post("/api/floorplans/:id/layout", requireAccount, async (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "户型图不存在" }, 404);
  if (!isLayoutReady(plan)) {
    return c.json({
      error: "户型信息还不完整，请先补齐待确认项",
      questions: pendingQuestions(plan),
    }, 409);
  }
  const body = await jsonBody<{ companyId: string }>(c);
  const company = body.companyId ? appCtx.repos.companies.byId(body.companyId) : undefined;
  if (!company || !isCompanyActive(company)) return c.json({ error: "公司不存在或暂不可用" }, 404);
  const bundle = publishedBundle(appCtx, company.id);
  if (!bundle) return c.json({ error: "该公司尚无已发布规格" }, 409);

  // 完整四视图要等客户在全局俯视图上点过头——一上来给四张图，
  // 客户不知道该看哪张、该对哪张提意见（design/stages.ts）
  const session = await sessionFor(plan.conversationId, company.id);
  if (!allowedArtifacts(session.stage).fourViews) {
    return c.json({
      error: session.stage === "planReview"
        ? "请先在全局俯视图上确认排布，再出完整四视图"
        : "还没到出图阶段——请先确认「需要我帮你生成设计图吗？」",
      stage: session.stage,
      prompt: stagePrompt(session, { missingFields: [] }),
    }, 409);
  }

  // 储物偏好进的是**排布算法**，不是记下来给人看：选"尽量多做抽屉"会改变装箱
  // 候选的偏好项，进而改变实际排出来的柜型（preferences/questions.ts 的 storage 题）
  const conv = appCtx.repos.conversations.byId(plan.conversationId);
  const prefs = conv ? prefsFor(conv, company.id) : {};
  const layout = generateLayout(plan.parsedGeometry, bundle.modules, {
    ...(plan.parsedGeometry.ceilingHeight !== undefined
      ? { ceilingHeight: plan.parsedGeometry.ceilingHeight } : {}),
    drawerBias: drawerBiasFor(prefs),
  });
  const { designLayoutId, revisionNo } = await persistLayout({
    plan, companyId: company.id, layout,
    triggeredBy: "auto",
    changeSummary: "按户型自动生成初版方案",
  });

  return c.json({
    layoutKey: layoutKey(plan.id, company.id),
    designLayoutId,
    revisionNo,
    warnings: layout.warnings,
    moduleCounts: layout.moduleCounts,
    // 人体工程硬约束与美观评分（FR-4）
    ergonomics: layout.ergonomics,
    ...applianceNotes(plan, layout.acceptable),
    aesthetics: layout.aesthetics,
    acceptable: layout.acceptable,
    // 直接可喂给 /api/quotes（结构里没有任何价格字段，FR-8）。
    // 五金/配件按 appliesTo* 过滤后才加上——加到装不了的柜体上会被定价校验整单拒绝
    // 完整 BOM：柜体 + 填缝条 + 踢脚/地脚 + 收口板。
    // 只报柜体的话，客户拿到的是一份缺料的价格（见 layout/bom.ts）
    selections: applyPreferencesToSelections(
      bomToSelections(bomFor(plan, layout, company.id)), prefs, bundle),
    bomMissing: bomFor(plan, layout, company.id).missing,
    // 偏好没能完全落实时如实说明——静默地部分落实最坏（客户拆箱才发现吊柜是平板的）
    unappliedPreferences: unappliedPreferences(
      bomToSelections(bomFor(plan, layout, company.id)), prefs, bundle),
    planViews: renderPlanViews(plan.parsedGeometry, layout.placements),
    views: viewsFor(plan, layout, company.id),
    // 图纸配解释：这是什么图、为什么这么排（全部来自算出来的结果）
    explanation: explanationFor(plan, layout, company.id, prefs),
    appliedPreferences: prefs,
  }, 201);
});

/** 局部重算：只重排指定墙段，其余原样保留（场景 D 第 4 点）。 */
app.post("/api/floorplans/:id/layout/regenerate", requireAccount, async (c) => {
  const plan = ownedFloorPlan(c, param(c, "id"));
  if (!plan) return c.json({ error: "户型图不存在" }, 404);
  const body = await jsonBody<{ companyId: string; wallRunId: string }>(c);
  const companyId = body.companyId ?? "";
  const current = storedLayoutFor(plan.id, companyId);
  if (!current) return c.json({ error: "还没有生成过方案" }, 404);
  const bundle = companyId ? publishedBundle(appCtx, companyId) : undefined;
  if (!bundle) return c.json({ error: "该公司尚无已发布规格" }, 409);

  const conv = appCtx.repos.conversations.byId(plan.conversationId);
  const prefs = conv ? prefsFor(conv, companyId) : {};
  const next = regenerateRun(current, plan.parsedGeometry, bundle.modules, body.wallRunId ?? "", {
    ...(plan.parsedGeometry.ceilingHeight !== undefined
      ? { ceilingHeight: plan.parsedGeometry.ceilingHeight } : {}),
    drawerBias: drawerBiasFor(prefs),
  });
  const { designLayoutId, revisionNo } = await persistLayout({
    plan, companyId, layout: next,
    triggeredBy: "customerRequest",
    changeSummary: `客户要求重排 ${body.wallRunId ?? ""} 段`,
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
    unappliedPreferences: unappliedPreferences(toSelections(next), prefs, bundle),
    views: viewsFor(plan, next, companyId),
    explanation: explanationFor(plan, next, companyId, prefs),
    appliedPreferences: prefs,
  });
});

// ── 多公司比价（FR-6）─────────────────────────────────────────────────────

app.get("/api/conversations/:id/comparison", requireAccount, (c) => {
  const conv = ownedConversation(c, param(c, "id"));
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  const cmp = buildComparison(
    conv.id,
    appCtx.repos.quotes.filter((q) => q.conversationId === conv.id),
    (id) => appCtx.repos.companies.byId(id)?.name,
    now(),
  );
  return c.json({ comparison: cmp, text: renderComparisonText(cmp), html: renderComparisonHtml(cmp) });
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
    if (!match) return c.json({ error: `型号 ${code} 未能匹配脸型，需人工确认` }, 422);
    templateId = match.templateId;
    params = match.params;
  }
  if (!templateId) return c.json({ error: "需提供 code 或 template" }, 400);

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
  const body = await jsonBody<{ email: string; companyName: string; consent: boolean }>(c);
  const ua = c.req.header("user-agent");
  const ip = c.req.header("x-forwarded-for");
  try {
    const sub = subscribe({
      email: body.email ?? "",
      companyName: body.companyName ?? "",
      consentGiven: body.consent === true,
      termsVersion: appCtx.termsVersion,
      ...(ua ? { userAgent: ua } : {}),
      ...(ip ? { ipAddress: ip } : {}),
      at: now(),
    });
    await appCtx.repos.subscriptions.insert(sub);
    // 匹配市场库，形成「投放 → 订阅 → 入驻」的转化漏斗（场景 I 第 7 点）
    const prospect = appCtx.repos.prospects.find((p) => p.email.toLowerCase() === sub.email);
    if (prospect) await appCtx.repos.prospects.update(prospect.id, { status: "subscribed", lastUpdated: now() });
    return c.json({ ok: true, unsubscribeToken: sub.unsubscribeToken }, 201);
  } catch (e) {
    if (e instanceof SubscriptionError) return c.json({ error: e.message, code: e.code }, 400);
    return c.json({ error: "该邮箱已在邮件列表中" }, 409);
  }
});

/** CASL：退订必须真的生效。GET 便于邮件里直接点击。 */
app.get("/unsubscribe", async (c) => {
  try {
    const updated = unsubscribeByToken(appCtx.repos.subscriptions.all(), c.req.query("token") ?? "", now());
    await appCtx.repos.subscriptions.update(updated.id, updated);
    return c.html("<p>已退订。你不会再收到我们的邮件。</p>");
  } catch {
    return c.html("<p>退订链接无效或已失效。</p>", 400);
  }
});

// ── 公司侧：计费透明度与争议（FR-7 / 8.1）─────────────────────────────────

app.get("/api/company/:companyId/billing", requireCompany, (c) => {
  const scope = new TenantScope(param(c, "companyId"));
  return c.json({ events: scope.filter(appCtx.repos.billingEvents.all()) });
});

app.post("/api/company/:companyId/billing/:eventId/dispute", requireCompany, async (c) => {
  const scope = new TenantScope(param(c, "companyId"));
  const event = scope.find(appCtx.repos.billingEvents.all(), (e) => e.id === param(c, "eventId"));
  if (!event) return c.json({ error: "计费事件不存在" }, 404);
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

// ── 平台运营 ──────────────────────────────────────────────────────────────

app.post("/api/admin/billing/:eventId/resolve", requireAdmin, async (c) => {
  const event = appCtx.repos.billingEvents.byId(param(c, "eventId"));
  if (!event) return c.json({ error: "计费事件不存在" }, 404);
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

// ── 数据主体权利（FR-13 第 5 条）──────────────────────────────────────────

app.get("/api/me/export", requireAccount, (c) =>
  c.json(exportAccountData(c.get("account"), {
    conversations: appCtx.repos.conversations.all(),
    estimates: appCtx.repos.estimates.all(),
    quotes: appCtx.repos.quotes.all(),
  }, now())));

/**
 * 删除权。与法定留存冲突时执行**去标识化保留**并如实说明，
 * 而不是拒绝整个请求（FR-13 第 5 条）。
 */
app.post("/api/me/delete", requireAccount, async (c) => {
  const account = c.get("account");
  const outcome = executeDeletionRequest(account.id, {
    conversations: appCtx.repos.conversations.all(),
    estimates: appCtx.repos.estimates.all(),
    quotes: appCtx.repos.quotes.all(),
    billingEvents: appCtx.repos.billingEvents.all(),
  });

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
  const projects = listProjects({
    account,
    conversations: appCtx.repos.conversations.all(),
    quotes: appCtx.repos.quotes.all(),
    at: now(),
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
  return c.json({
    accountType: account.accountType,
    /** 定价实际按哪种账号走——与 accountType 可能不同，如实告知。 */
    effectiveAccountType: effective,
    interaction: interactionProfile(effective),
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
    return c.json({ error: "只有贸易账号需要提交资质" }, 400);
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
  if (!current) return c.json({ error: "资质申请不存在" }, 404);
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
) {
  const { construction, overlay } = renderStyleFor(appCtx, companyId);
  const guide = explainViews({
    construction, overlay,
    hasWallCabinets: layout.placements.some((p) => p.layer === "wall"),
    hasFillers: layout.placements.some((p) => p.kind === "filler"),
    hasAppliances: layout.placements.some((p) => p.kind === "appliance"),
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
    viewGuideText: renderViewGuideText(guide),
    viewGuideHtml: renderViewGuideHtml(guide),
    perRun,
  };
}

function toHistory(m: ChatMessage): { role: "user" | "assistant"; content: string } {
  return { role: m.role, content: m.content };
}

/**
 * 上一轮助手是否已经问过同样的缺失字段。
 *
 * 判据是「缺失字段集合没变，且上一轮助手确实提过这些字段」——说明客户答了，
 * 但说法对不上我们的关键词（"质感优先" 匹配不到 "风格"）。这时候原样再问
 * 一遍最伤：客户会觉得没在听。
 */
/**
 * 已经连着几轮在问同样的缺失字段。
 *
 * 返回**次数**而不是布尔值：只知道"重复了"没法决定该说什么，第二次和第五次
 * 该说的话不一样（见 orchestrator.ts 的 fallbackPrompt）。
 */
function askedSameFieldsBefore(conv: Conversation, nextRequirements: string): number {
  const stillMissing = missingFields(nextRequirements);
  if (stillMissing.length === 0) return 0;

  // 数的是**总共问过几次**，不是"连着问了几次"。
  //
  // 连续计数有个反直觉的坑：追问两次后系统换成一句不点名字段的软化说法，
  // 这句话本身会把连续计数打断，于是下一轮又从"第一次问"开始，客户会看到
  // 「问 → 换选择题 → 软化 → 又问」的循环。问过两次就是问过两次。
  return conv.messages.filter(
    (m) => m.role === "assistant" && !m.companyId && stillMissing.some((f) => m.content.includes(f)),
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

  return buildQuotePdf({
    quote: q,
    companyName: company?.name ?? q.companyId,
    customerName: account.displayName,
    customerEmail: account.email,
    province: q.province,
    doorStyleName: doorStyle?.name ?? q.doorStyleId,
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
    "  型号        规格                数量        单价          小计",
    "  " + "-".repeat(62),
    ...lines,
    "  " + "-".repeat(62),
    `  小计: ${format(q.subtotal)}`,
    ...q.discounts.map((d) => `  ${d.description}: -${format(d.amount)}`),
    `  运费: ${format(q.shipping.amount)}`,
    ...q.taxes.map((t) => `  ${t.name} ${t.ratePercent}%: ${format(t.amount)}`),
    `  总计（${q.currency}）: ${format(q.total)}`,
    "",
    `  报价有效期至 ${q.validUntil.slice(0, 10)}`,
  ].join("\n");
}

// ── 启动 ──────────────────────────────────────────────────────────────────

export async function createApp(opts: Parameters<typeof createAppContext>[0] = {}) {
  appCtx = await createAppContext(opts);
  gate = siteGateDisabledExplicitly()
    ? { secret: "", enabled: false }
    : resolveSiteGate();
  return app;
}

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
  return serve({ fetch: app.fetch, port }, (info) => {
    const smtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    const company = appCtx.repos.companies.all()[0];
    const bundle = company ? publishedBundle(appCtx, company.id) : undefined;
    console.log(`[rta-hub] http://localhost:${info.port}`);
    console.log(`[rta-hub] 试点公司：${company?.name ?? "（无）"}（${bundle?.modules.length ?? 0} 个型号）`);
    console.log(`[rta-hub] LLM：${appCtx.llm ? "已接入" : "未配置 —— 对话降级为确定性问答"}`);
    console.log(`[rta-hub] SMTP：${smtp ? "已配置" : "未配置 —— 发送为 dry-run"}`);
    console.log(`[rta-hub] ${startupNotice(gate)}`);
    for (const line of tierReport(resolveModelTiers())) console.log(`[rta-hub] ${line}`);
    for (const line of launchGateReport()) console.log(`[rta-hub] ${line}`);
  });
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) void start();

export { app };
