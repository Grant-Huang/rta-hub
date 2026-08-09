/**
 * 用户分层权限与知识/数据隔离（docs/ACCESS_CONTROL.md v1.2）。
 * Trade 与 Consumer 分身份域、分能力矩阵；admin L1 按 ACCESS_STAGE。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  AccessDeniedError,
  adminPrincipal,
  assertAccountAccess,
  assertCompanyAccess,
  assertL0Manage,
  assertL1Read,
  assertL1Write,
  assertMultiProject,
  assertTradePricingCapability,
  authContextFromPrincipal,
  capabilitiesFor,
  companyPrincipal,
  customerPrincipal,
  hasCapability,
  isDemandSide,
  resolveAccessStage,
  resolvePrincipal,
  type Capability,
} from "../src/auth/index.js";
import { AccountScope } from "../src/tenancy/account-scope.js";
import { TenantIsolationError } from "../src/tenancy/scoped-repo.js";
import {
  canSeeKnowledgeCard,
  cardsForRuntimeInjection,
  createDraftCard,
  listKnowledgeCardsFor,
  platformKnowledgeRuntime,
  publishCard,
  confirmCard,
  type PlatformKnowledgeCard,
} from "../src/knowledge/index.js";
import type { CustomerAccount } from "../src/domain/types.js";

process.env.SITE_PASSWORD_DISABLED = "true";
process.env.ADMIN_TOKEN = "test-admin-token";

function acct(
  id: string,
  accountType: "consumer" | "trade",
): CustomerAccount {
  return {
    id,
    accountType,
    email: `${id}@b.c`,
    displayName: id,
    province: "ON",
    consentRecords: [],
  };
}

function draftCard(): PlatformKnowledgeCard {
  return createDraftCard({
    kind: "domain_fact",
    scope: ["orchestrator"],
    settleTarget: "handbook",
    title: "Draft note",
    body: { en: "Only ops should see this draft card body." },
    provenance: {
      trainerConversationId: "tc_test",
      taughtBy: "admin",
      taughtAt: new Date().toISOString(),
    },
  });
}

test("consumer 与 trade 是不同 Principal.kind，矩阵分别定义", () => {
  const consumer = customerPrincipal(acct("ca_x", "consumer"));
  const trade = customerPrincipal(acct("ca_t", "trade"));

  assert.equal(consumer.kind, "consumer");
  assert.equal(trade.kind, "trade");
  assert.ok(isDemandSide(consumer));
  assert.ok(isDemandSide(trade));

  // 禁止共享同一数组引用（「同一套 ACL」）
  assert.notEqual(capabilitiesFor("consumer"), capabilitiesFor("trade"));

  const consumerOnly: Capability[] = ["account.multi_project", "pricing.trade"];
  for (const cap of consumerOnly) {
    assert.equal(hasCapability(consumer, cap), false, `consumer 不应有 ${cap}`);
    assert.equal(hasCapability(trade, cap), true, `trade 应有 ${cap}`);
  }

  assert.throws(() => assertMultiProject(consumer), AccessDeniedError);
  assert.doesNotThrow(() => assertMultiProject(trade));
  assert.throws(() => assertTradePricingCapability(consumer), AccessDeniedError);
  assert.doesNotThrow(() => assertTradePricingCapability(trade));
});

test("capability matrix：需求侧不能 manage L0；运营可以", () => {
  const consumer = customerPrincipal(acct("ca_x", "consumer"));
  const trade = customerPrincipal(acct("ca_t", "trade"));
  const company = companyPrincipal("co_a", "company");
  const admin = adminPrincipal();

  assert.equal(hasCapability(consumer, "knowledge.l0.manage"), false);
  assert.equal(hasCapability(trade, "knowledge.l0.manage"), false);
  assert.equal(hasCapability(company, "knowledge.l0.manage"), false);
  assert.equal(hasCapability(admin, "knowledge.l0.manage"), true);
  assert.equal(hasCapability(consumer, "knowledge.l0.consume_published"), true);
  assert.equal(hasCapability(trade, "knowledge.l0.consume_published"), true);
  assert.throws(() => assertL0Manage(consumer), AccessDeniedError);
  assert.throws(() => assertL0Manage(trade), AccessDeniedError);
  assert.throws(() => assertL1Write(company, "co_other"), AccessDeniedError);
  assert.doesNotThrow(() => assertL1Write(company, "co_a"));
  assert.doesNotThrow(() => assertCompanyAccess(admin, "co_any"));
  assert.throws(() => assertAccountAccess(consumer, "ca_other"), (e: unknown) =>
    e instanceof AccessDeniedError && e.code === "NOT_FOUND");
  assert.throws(() => assertAccountAccess(trade, "ca_other"), (e: unknown) =>
    e instanceof AccessDeniedError && e.code === "NOT_FOUND");
});

test("ACCESS_STAGE：未设置时非 production NODE_ENV 默认为 design", () => {
  assert.equal(resolveAccessStage({}), "design");
  assert.equal(resolveAccessStage({ NODE_ENV: "development" }), "design");
  assert.equal(resolveAccessStage({ NODE_ENV: "production" }), "production");
  assert.equal(resolveAccessStage({ ACCESS_STAGE: "design", NODE_ENV: "production" }), "design");
  assert.equal(resolveAccessStage({ ACCESS_STAGE: "production" }), "production");
  assert.equal(resolveAccessStage({ RTA_STAGE: "prod" }), "production");
});

test("design：admin / 代公司可读写任意公司 L1；公司令牌仍仅本厂", () => {
  const proxy = companyPrincipal("co_a", "admin");
  assert.equal(proxy.kind, "company");
  assert.equal(proxy.kind === "company" ? proxy.via : null, "admin");
  assert.doesNotThrow(() => assertL1Read(proxy, "co_a", "design"));
  assert.doesNotThrow(() => assertL1Write(proxy, "co_a", "design"));
  assert.doesNotThrow(() => assertL1Read(proxy, "co_other", "design"));
  assert.doesNotThrow(() => assertL1Write(proxy, "co_other", "design"));

  const admin = adminPrincipal();
  assert.doesNotThrow(() => assertL1Write(admin, "co_other", "design"));
  assert.doesNotThrow(() => assertL1Read(admin, "co_other", "design"));

  const company = companyPrincipal("co_a", "company");
  assert.doesNotThrow(() => assertL1Write(company, "co_a", "design"));
  assert.throws(() => assertL1Write(company, "co_other", "design"), (e: unknown) =>
    e instanceof AccessDeniedError && e.code === "CROSS_TENANT");
  assert.throws(() => assertL1Read(company, "co_other", "design"), AccessDeniedError);
});

test("production：admin 可读任意公司 L1，禁止写；公司令牌仍可写本厂", () => {
  const proxy = companyPrincipal("co_a", "admin");
  const admin = adminPrincipal();
  const company = companyPrincipal("co_a", "company");

  assert.doesNotThrow(() => assertL1Read(proxy, "co_other", "production"));
  assert.doesNotThrow(() => assertL1Read(admin, "co_other", "production"));
  assert.throws(() => assertL1Write(proxy, "co_a", "production"), (e: unknown) =>
    e instanceof AccessDeniedError && e.code === "FORBIDDEN");
  assert.throws(() => assertL1Write(admin, "co_other", "production"), (e: unknown) =>
    e instanceof AccessDeniedError && e.code === "FORBIDDEN");

  assert.doesNotThrow(() => assertL1Write(company, "co_a", "production"));
  assert.throws(() => assertL1Write(company, "co_other", "production"), AccessDeniedError);
});

test("需求侧具备 L0 消费与 L1 读能力（会话注入 / @ 厂商），不能写 L1", () => {
  const consumer = customerPrincipal(acct("ca_x", "consumer"));
  const trade = customerPrincipal(acct("ca_t", "trade"));
  for (const p of [consumer, trade]) {
    assert.equal(hasCapability(p, "knowledge.l0.consume_published"), true);
    assert.equal(hasCapability(p, "knowledge.l1.read"), true);
    assert.equal(hasCapability(p, "knowledge.l1.write"), false);
    assert.doesNotThrow(() => assertL1Read(p, "co_mentioned"));
    assert.throws(() => assertL1Write(p, "co_mentioned"), AccessDeniedError);
  }
});

test("未实现的 AuthScheme 不提权", () => {
  const p = resolvePrincipal({
    scheme: "jwt",
    accountIdHeader: "ca_x",
    adminTokenHeader: "test-admin-token",
    adminExpected: "test-admin-token",
    lookupAccount: () => acct("ca_x", "consumer"),
    lookupCompany: () => undefined,
  });
  assert.equal(p.kind, "anonymous");
  const ctx = authContextFromPrincipal(adminPrincipal(), "header_mvp");
  assert.equal(ctx.scheme, "header_mvp");
  assert.equal(ctx.principal.kind, "platform_admin");
});

test("AccountScope 跨账号读报不存在", () => {
  const scope = new AccountScope("ca_a");
  const items = [
    { id: "1", customerAccountId: "ca_a" },
    { id: "2", customerAccountId: "ca_b" },
  ];
  assert.equal(scope.byId(items, "2"), undefined);
  assert.throws(
    () => scope.assertReadable(items[1], "会话"),
    (e: unknown) => e instanceof TenantIsolationError && e.code === "NOT_FOUND",
  );
  assert.deepEqual(scope.filter(items).map((i) => i.id), ["1"]);
});

test("未 publish 的知识卡不进客户运行时注入", () => {
  const d = draftCard();
  assert.deepEqual(cardsForRuntimeInjection([d]), []);
  assert.equal(platformKnowledgeRuntime([d]).handbook("en"), "");
  const published = publishCard(confirmCard(d), "admin");
  assert.equal(cardsForRuntimeInjection([published]).length, 1);
  assert.ok(platformKnowledgeRuntime([published]).handbook("en").includes("Draft note"));
});

test("consumer / trade 均不能经 API 看见 L0 知识卡正文", () => {
  const consumer = customerPrincipal(acct("ca_x", "consumer"));
  const trade = customerPrincipal(acct("ca_t", "trade"));
  const published = publishCard(confirmCard(draftCard()), "admin");
  assert.deepEqual(listKnowledgeCardsFor(consumer, [published]), []);
  assert.deepEqual(listKnowledgeCardsFor(trade, [published]), []);
  assert.equal(canSeeKnowledgeCard(consumer, published), false);
  assert.equal(canSeeKnowledgeCard(trade, published), false);
  assert.equal(canSeeKnowledgeCard(adminPrincipal(), published), true);
});

let app: { fetch: (req: Request) => Response | Promise<Response> };

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: undefined });
});

function req(path: string, init: RequestInit & { accountId?: string; admin?: boolean } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  if (init.admin) headers.set("x-admin-token", "test-admin-token");
  return app.fetch(new Request("http://test" + path, { ...init, headers }));
}

test("HTTP：客户不能读 admin 知识列表；探测接口返回空卡", async () => {
  const denied = await req("/api/admin/knowledge", { accountId: "ca_demo_consumer" });
  assert.equal(denied.status, 401);

  const probe = await req("/api/knowledge", { accountId: "ca_demo_consumer" });
  assert.equal(probe.status, 200);
  const body = await probe.json() as { status: string; data: { cards: unknown[] } };
  assert.equal(body.status, "success");
  assert.deepEqual(body.data.cards, []);

  const tradeProbe = await req("/api/knowledge", { accountId: "ca_demo_trade" });
  assert.equal(tradeProbe.status, 200);
  const tradeBody = await tradeProbe.json() as { status: string; data: { cards: unknown[] } };
  assert.deepEqual(tradeBody.data.cards, []);
});

test("HTTP：运营可开训练会话；公司令牌不能开", async () => {
  const ok = await req("/api/admin/trainer/conversations", { method: "POST", admin: true });
  assert.equal(ok.status, 201);

  const companyDenied = await req("/api/admin/trainer/conversations", {
    method: "POST",
    headers: { "x-company-token": "anything" },
  });
  assert.equal(companyDenied.status, 401);
});

test("HTTP：账号 A 读不到账号 B 的会话（跨 consumer/trade）", async () => {
  const a = await req("/api/conversations", { method: "POST", accountId: "ca_demo_consumer" });
  const { conversation } = await a.json() as { conversation: { id: string } };
  const cross = await req(`/api/conversations/${conversation.id}`, {
    accountId: "ca_demo_trade",
  });
  assert.equal(cross.status, 404);
});
