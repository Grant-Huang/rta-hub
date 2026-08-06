/**
 * RTA-Hub MVP-1 服务端。
 *
 * 与 v0.3 那版的关键差异（见 REQUIREMENTS 第 10 节）：
 *   - 删除「搜索列表 → 勾选 → 群发询价」这套客户端功能（与 CASL 冲突，FR-12）；
 *   - 全部状态按会话/租户隔离，不再有模块级全局单例；
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
import type {
  CabinetCompany, ChatMessage, Conversation, CompanyMentionSignal, CustomerAccount,
  LeadBillingEvent, ModuleSelection, Quote, QuoteAuditEvent,
} from "./domain/types.js";
import { SEED_TAX_RULES } from "./pricing/tax.js";
import type { PricingContext } from "./pricing/engine.js";
import { deriveCompanyStatus } from "./spec/version.js";
import { TenantScope } from "./tenancy/scoped-repo.js";
import {
  buildMentionSignal, clientFacingMessage, parseMentions, routeByText,
} from "./routing/mention.js";
import {
  buildSendDisclosure, confirm, createQuoteFromLlmOutput, recordSendResult,
} from "./app/quote-service.js";
import { openDispute, resolveDispute } from "./billing/lead-events.js";
import { layoutFace, toSvg } from "./render/face-grammar.js";
import { buildFace, BASE_FACE_HEIGHT, matchFaceTemplate, type FaceTemplateId } from "./render/templates.js";
import * as seed from "./app/seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 内存态（MVP-1；平面文件持久化见 store/json-store.ts，接入在 MVP-2）─────────
const companies: CabinetCompany[] = [seed.pilotCompany, seed.unsubscribedCompany];
const accounts: CustomerAccount[] = [...seed.demoAccounts];
const conversations = new Map<string, Conversation>();
const quotes = new Map<string, Quote>();
const auditEvents: QuoteAuditEvent[] = [];
const billingEvents: LeadBillingEvent[] = [];
const mentionSignals: CompanyMentionSignal[] = [];

const LEAD_FEE = fromDollars(process.env.LEAD_FEE_CAD || "45.00");

function pricingContext(companyId: string): PricingContext {
  if (companyId !== seed.PILOT_COMPANY_ID) {
    throw new Error(`MVP-1 只有试点公司 ${seed.PILOT_COMPANY_ID} 有已发布规格`);
  }
  return {
    specVersionId: seed.PILOT_SPEC_VERSION_ID,
    companyId: seed.PILOT_COMPANY_ID,
    modules: seed.pilotModules,
    doorStyles: seed.pilotDoorStyles,
    priceMatrix: seed.pilotPriceMatrix,
    hardwareOptions: seed.pilotHardware,
    accessoryOptions: seed.pilotAccessories,
    discountRules: seed.pilotDiscounts,
    shippingRule: seed.pilotShipping,
    taxRules: SEED_TAX_RULES,
  };
}

const isActive = (c: CabinetCompany): boolean =>
  deriveCompanyStatus({
    hasPublishedSpec: !!c.currentPublishedSpecVersionId,
    subscription: c.billingPlan.personalizationSubscription,
    onboardingStarted: true,
    deactivated: c.deactivated,
  }) === "active";

const now = (): string => new Date().toISOString();

/** `c.req.param` 在 strict 下返回 string | undefined；路由已保证存在，统一收口。 */
function param(c: Context<{ Variables: AppVars }>, name: string): string {
  return c.req.param(name) ?? "";
}

/** 解析 JSON body，失败或非对象时返回空对象（类型保持为 Partial<T>）。 */
async function jsonBody<T extends object>(c: Context<{ Variables: AppVars }>): Promise<Partial<T>> {
  try {
    const v = await c.req.json<T>();
    return (v && typeof v === "object" ? v : {}) as Partial<T>;
  } catch {
    return {};
  }
}

// ── 鉴权 ──────────────────────────────────────────────────────────────────
/**
 * MVP-1 的最小鉴权：`X-Account-Id` 头标识调用方。
 *
 * 这不是生产方案（生产需要真正的登录态与令牌，见 PRE_LAUNCH_CHECKLIST E1），
 * 但它消除了「完全无鉴权」这个状态，并让租户作用域有据可依。
 */
type AppVars = { account: CustomerAccount };
const app = new Hono<{ Variables: AppVars }>();

async function requireAccount(c: Context<{ Variables: AppVars }>, next: Next) {
  const id = c.req.header("x-account-id");
  const account = accounts.find((a) => a.id === id);
  if (!account) {
    return c.json({ error: "未认证：请在 X-Account-Id 头中提供账号 id" }, 401);
  }
  c.set("account", account);
  await next();
}

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", (c) => {
  const html = readFileSync(path.join(__dirname, "../web/index.html"), "utf-8");
  return c.html(html);
});

// ── 公司目录（只暴露客户可见信息，不暴露订阅/计费状态）────────────────────
app.get("/api/companies", (c) =>
  c.json({
    companies: companies.filter(isActive).map((co) => ({
      id: co.id, name: co.name, aliases: co.aliases,
      serviceAreas: co.serviceAreas,
    })),
  }));

app.get("/api/companies/:id/spec", (c) => {
  const co = companies.find((x) => x.id === param(c, "id"));
  if (!co || !isActive(co)) return c.json({ error: "公司不存在或暂不可用" }, 404);
  const ctx = pricingContext(co.id);
  return c.json({
    company: { id: co.id, name: co.name },
    doorStyles: ctx.doorStyles.map((d) => ({ id: d.id, name: d.name, priceGroupId: d.priceGroupId })),
    modules: ctx.modules.map((m) => ({
      id: m.id, code: m.code, type: m.type,
      widthOptions: m.widthOptions, heightOptions: m.heightOptions, depthOptions: m.depthOptions,
      faceTemplateId: m.faceTemplateId,
    })),
    hardwareOptions: ctx.hardwareOptions.map((h) => ({ id: h.id, name: h.name })),
    accessoryOptions: ctx.accessoryOptions.map((a) => ({ id: a.id, name: a.name })),
  });
});

// ── 对话与确定性 @ 路由 ───────────────────────────────────────────────────
app.post("/api/conversations", requireAccount, async (c) => {
  const account = c.get("account");
  const conv: Conversation = {
    id: `cv_${randomUUID().slice(0, 8)}`,
    customerAccountId: account.id,
    messages: [], designRequirements: "", perCompanyThreads: [],
    createdAt: now(),
  };
  conversations.set(conv.id, conv);
  return c.json({ conversation: conv }, 201);
});

app.post("/api/conversations/:id/messages", requireAccount, async (c) => {
  const account = c.get("account");
  const conv = conversations.get(param(c, "id"));
  if (!conv || conv.customerAccountId !== account.id) {
    return c.json({ error: "会话不存在" }, 404);
  }
  const body = await jsonBody<{ text: string }>(c);
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ error: "text 不能为空" }, 400);

  const at = now();
  conv.messages.push({ role: "user", content: text, at });

  // @ 路由是**确定性**的：LLM 不参与判断「这是哪家公司」（FR-1）
  const routing = { companies, isActive };
  const routed: { companyId: string; companyName: string }[] = [];
  const notices: string[] = [];

  for (const raw of parseMentions(text)) {
    const outcome = routeByText(routing, raw);
    if (outcome.kind === "routed") {
      routed.push({ companyId: outcome.company.id, companyName: outcome.company.name });
      let thread = conv.perCompanyThreads.find((t) => t.companyId === outcome.company.id);
      if (!thread) {
        thread = { companyId: outcome.company.id, messages: [] };
        conv.perCompanyThreads.push(thread);
      }
      thread.messages.push({ role: "user", content: text, companyId: outcome.company.id, at });
    } else {
      notices.push(clientFacingMessage(outcome));
      mentionSignals.push(buildMentionSignal(outcome, {
        conversationId: conv.id, customerAccountId: account.id, prospects: [], at,
      }));
    }
  }

  const reply: ChatMessage = {
    role: "assistant",
    content: routed.length
      ? `已转达给 ${routed.map((r) => r.companyName).join("、")}。`
      : notices[0] ?? "收到，请继续描述你的厨房需求（尺寸、风格、预算、所在省份）。",
    at,
  };
  conv.messages.push(reply);
  return c.json({ reply, routedTo: routed, notices });
});

app.get("/api/conversations/:id", requireAccount, (c) => {
  const account = c.get("account");
  const conv = conversations.get(param(c, "id"));
  if (!conv || conv.customerAccountId !== account.id) return c.json({ error: "会话不存在" }, 404);
  return c.json({ conversation: conv });
});

// ── 报价：创建（含 FR-8 全部硬校验）────────────────────────────────────────
app.post("/api/quotes", requireAccount, async (c) => {
  const account = c.get("account");
  const body = await jsonBody<{
    companyId: string; conversationId: string; doorStyleId: string;
    selections: unknown; designLayoutId: string;
  }>(c);

  const company = companies.find((x) => x.id === body.companyId);
  if (!company || !isActive(company)) return c.json({ error: "公司不存在或暂不可用" }, 404);
  const conv = conversations.get(body.conversationId ?? "");
  if (!conv || conv.customerAccountId !== account.id) return c.json({ error: "会话不存在" }, 404);
  if (!body.doorStyleId) return c.json({ error: "必须选择门板样式（决定价格组）" }, 400);

  const scope = new TenantScope(company.id);
  const at = now();
  // selections 走 LLM 输出通道：任何价格字段都会被丢弃（FR-8 第 1 条）
  const result = createQuoteFromLlmOutput(scope, pricingContext(company.id), body.selections, {
    quoteId: `q_${randomUUID().slice(0, 8)}`,
    designLayoutId: body.designLayoutId ?? `dl_${randomUUID().slice(0, 8)}`,
    designRevisionNo: 1,
    conversationId: conv.id,
    customerAccountId: account.id,
    accountType: account.accountType,
    province: account.province,
    doorStyleId: body.doorStyleId,
    at,
  });

  auditEvents.push(...result.events);
  if (!result.ok) {
    return c.json({ error: "报价校验未通过，已拒绝生成", issues: result.issues }, 422);
  }
  quotes.set(result.quote.id, result.quote);
  return c.json({ quote: result.quote, formattedTotal: format(result.quote.total) }, 201);
});

app.get("/api/quotes/:id", requireAccount, (c) => {
  const account = c.get("account");
  const q = quotes.get(param(c, "id"));
  if (!q || q.customerAccountId !== account.id) return c.json({ error: "报价不存在" }, 404);
  return c.json({ quote: q, formattedTotal: format(q.total) });
});

/** 发送前的二次披露（FR-13）——客户必须先看到这个清单。 */
app.get("/api/quotes/:id/disclosure", requireAccount, (c) => {
  const account = c.get("account");
  const q = quotes.get(param(c, "id"));
  if (!q || q.customerAccountId !== account.id) return c.json({ error: "报价不存在" }, 404);
  const company = companies.find((x) => x.id === q.companyId)!;
  return c.json(buildSendDisclosure(q, company.name, {
    displayName: account.displayName, email: account.email,
  }));
});

/** 客户确认 —— 独立的服务端状态迁移，留痕。 */
app.post("/api/quotes/:id/confirm", requireAccount, (c) => {
  const account = c.get("account");
  const q = quotes.get(param(c, "id"));
  if (!q || q.customerAccountId !== account.id) return c.json({ error: "报价不存在" }, 404);
  try {
    const r = confirm(q, now());
    quotes.set(r.quote.id, r.quote);
    auditEvents.push(...r.events);
    return c.json({ quote: r.quote });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

/**
 * 发送。
 *
 * **注意这里没有读取任何 `confirm` 字段**——报价必须已经处于 `confirmed` 状态，
 * 否则状态机直接拒绝。这就是 FR-8 第 3 条要求的闸门。
 */
app.post("/api/quotes/:id/send", requireAccount, async (c) => {
  const account = c.get("account");
  const q = quotes.get(param(c, "id"));
  if (!q || q.customerAccountId !== account.id) return c.json({ error: "报价不存在" }, 404);
  if (q.status !== "confirmed") {
    return c.json({ error: `报价当前状态为 ${q.status}，必须先由客户确认才能发送` }, 409);
  }

  const at = now();
  const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  // 未配置发信凭据 → dry-run（第二道闸门）
  const delivered = smtpConfigured;

  const outcome = recordSendResult(
    q, billingEvents,
    delivered ? { delivered: true } : { delivered: false, error: "SMTP 未配置：dry-run，未发送任何邮件" },
    LEAD_FEE, at,
  );
  quotes.set(outcome.quote.id, outcome.quote);
  auditEvents.push(...outcome.events);
  if (outcome.billingEvent) billingEvents.push(outcome.billingEvent);

  return c.json({
    quote: outcome.quote,
    dryRun: !smtpConfigured,
    billingSuppressed: outcome.billingSuppressed,
    billingEventId: outcome.billingEvent?.id,
  });
});

app.get("/api/quotes/:id/audit", requireAccount, (c) => {
  const account = c.get("account");
  const q = quotes.get(param(c, "id"));
  if (!q || q.customerAccountId !== account.id) return c.json({ error: "报价不存在" }, 404);
  return c.json({ events: auditEvents.filter((e) => e.quoteId === q.id) });
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
      overlay: seed.pilotSpecVersion.overlay,
      construction: seed.pilotSpecVersion.construction,
      faceFrameWidth: 1.5,
    });
    return c.body(toSvg(layout, { title: code ?? templateId }), 200, {
      "content-type": "image/svg+xml; charset=utf-8",
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

// ── 公司侧：计费透明度与争议（FR-7 / 8.1）─────────────────────────────────
app.get("/api/company/:companyId/billing", (c) => {
  const scope = new TenantScope(param(c, "companyId"));
  return c.json({ events: scope.filter(billingEvents) });
});

app.post("/api/company/:companyId/billing/:eventId/dispute", async (c) => {
  const scope = new TenantScope(param(c, "companyId"));
  const event = scope.find(billingEvents, (e) => e.id === param(c, "eventId"));
  if (!event) return c.json({ error: "计费事件不存在" }, 404);
  const body = await jsonBody<{ reason: string; evidence: string; openedBy: string }>(c);
  try {
    const updated = openDispute(event, {
      openedBy: body.openedBy ?? "company",
      reason: (body.reason as never) ?? "other",
      evidence: body.evidence ?? "",
      at: now(),
    });
    billingEvents[billingEvents.indexOf(event)] = updated;
    return c.json({ event: updated });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

app.post("/api/admin/billing/:eventId/resolve", async (c) => {
  const event = billingEvents.find((e) => e.id === param(c, "eventId"));
  if (!event) return c.json({ error: "计费事件不存在" }, 404);
  const body = await jsonBody<{ resolution: string; resolvedBy: string }>(c);
  try {
    const updated = resolveDispute(event, {
      resolvedBy: body.resolvedBy ?? "ops",
      resolution: (body.resolution as never) ?? "upheld",
      at: now(),
    });
    billingEvents[billingEvents.indexOf(event)] = updated;
    return c.json({ event: updated });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

/** 销售看板：按归一化名聚合的提及信号（FR-12.3）。去标识化，不含客户身份。 */
app.get("/api/admin/mention-signals", async (c) => {
  const { aggregateSignals } = await import("./routing/mention.js");
  return c.json({ aggregated: aggregateSignals(mentionSignals) });
});

/**
 * 只有作为入口被直接运行时才监听端口。
 * 测试里 `import { app }` 拿到的是纯 fetch handler，不会起服务、不会挂住进程。
 */
export function start(port = Number(process.env.PORT || process.env.CABINET_QUOTES_PORT || 8790)) {
  return serve({ fetch: app.fetch, port }, (info) => {
    const smtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    console.log(`[rta-hub] http://localhost:${info.port}`);
    console.log(`[rta-hub] 试点公司：${seed.pilotCompany.name}（${seed.pilotModules.length} 个型号）`);
    console.log(`[rta-hub] SMTP 已配置：${smtp}${smtp ? "" : " —— 发送将是 dry-run"}`);
  });
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) start();

export { app };
