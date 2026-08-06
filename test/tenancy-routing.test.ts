/**
 * 租户隔离的**负向测试**（PRE_LAUNCH_CHECKLIST E3）+ 确定性 @ 路由。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadOnlyCompanyView, TenantIsolationError, TenantScope } from "../src/tenancy/scoped-repo.js";
import {
  aggregateSignals, buildMentionSignal, clientFacingMessage, mentionVariants,
  normalizeCompanyName, parseMentions, routeByText, routeByToken,
} from "../src/routing/mention.js";
import { deriveCompanyStatus } from "../src/spec/version.js";
import type { CabinetCompany, CompanyProspect } from "../src/domain/types.js";
import { company } from "./fixtures.js";

// ── 租户隔离 ──────────────────────────────────────────────────────────────

const rows = [
  { id: "r1", companyId: "co_a", secret: "A 的价目表" },
  { id: "r2", companyId: "co_b", secret: "B 的价目表" },
  { id: "r3", companyId: "co_a", secret: "A 的报价单" },
];

test("A 公司作用域读不到 B 公司的数据", () => {
  const a = new TenantScope("co_a");
  assert.deepEqual(a.filter(rows).map((r) => r.id), ["r1", "r3"]);
  assert.equal(a.byId(rows, "r2"), undefined);
});

test("即使调用方谓词试图放宽，也漏不出别家数据", () => {
  const a = new TenantScope("co_a");
  // 调用方写了个恒真谓词，仍然只能拿到自己的
  const leaked = a.filter(rows, () => true);
  assert.ok(leaked.every((r) => r.companyId === "co_a"));
  // 甚至显式点名 B 的记录也拿不到
  assert.deepEqual(a.filter(rows, (r) => r.companyId === "co_b"), []);
});

test("跨租户写入被拒绝", () => {
  const a = new TenantScope("co_a");
  assert.throws(
    () => a.assertOwned({ id: "x", companyId: "co_b" }, "报价单"),
    (e: unknown) => e instanceof TenantIsolationError && e.code === "CROSS_TENANT_WRITE",
  );
  assert.doesNotThrow(() => a.assertOwned({ id: "x", companyId: "co_a" }));
});

test("读到别家数据时统一报「不存在」，不泄露存在性", () => {
  const a = new TenantScope("co_a");
  let msg = "";
  try {
    a.assertReadable(rows[1], "报价单");
  } catch (e) {
    msg = (e as Error).message;
  }
  assert.equal(msg, "报价单不存在");
  assert.ok(!msg.includes("co_b"), "错误信息不应泄露真实归属");
});

test("空 companyId 无法构造作用域", () => {
  assert.throws(() => new TenantScope(""), TenantIsolationError);
});

test("Conversation 对公司数据是只读引用", () => {
  const view = new ReadOnlyCompanyView("co_a");
  assert.deepEqual(view.read(rows).map((r) => r.id), ["r1", "r3"]);
  assert.equal(view.readById(rows, "r2"), undefined);
  // 类型层面就没有写方法
  assert.equal((view as unknown as Record<string, unknown>)["insert"], undefined);
});

// ── 公司状态派生 ──────────────────────────────────────────────────────────

test("公司 status 由发布与订阅状态派生", () => {
  assert.equal(deriveCompanyStatus({ hasPublishedSpec: false, subscription: "none", onboardingStarted: false }), "prospect");
  assert.equal(deriveCompanyStatus({ hasPublishedSpec: false, subscription: "none", onboardingStarted: true }), "onboarding");
  // 已发布但未订阅 → 仍不是 active（客户拿 EstimateDraft，FR-10）
  assert.equal(deriveCompanyStatus({ hasPublishedSpec: true, subscription: "none", onboardingStarted: true }), "onboarding");
  assert.equal(deriveCompanyStatus({ hasPublishedSpec: true, subscription: "active", onboardingStarted: true }), "active");
  assert.equal(deriveCompanyStatus({ hasPublishedSpec: true, subscription: "trial", onboardingStarted: true }), "active");
  assert.equal(deriveCompanyStatus({ hasPublishedSpec: true, subscription: "active", onboardingStarted: true, deactivated: true }), "inactive");
});

// ── 名称归一化 ────────────────────────────────────────────────────────────

test("归一化去掉大小写、空格、标点与企业后缀", () => {
  const target = normalizeCompanyName("Maple Cabinetry");
  assert.equal(normalizeCompanyName("maple cabinetry"), target);
  assert.equal(normalizeCompanyName("Maple Cabinetry Inc."), target);
  assert.equal(normalizeCompanyName("  MAPLE  CABINETRY  LTD  "), target);
});

test("归一化不做翻译 —— 译名必须靠 aliases 显式登记", () => {
  assert.notEqual(normalizeCompanyName("IKEA"), normalizeCompanyName("宜家"));
});

test("中文企业后缀被剥离", () => {
  assert.equal(normalizeCompanyName("枫叶橱柜有限公司"), normalizeCompanyName("枫叶"));
});

// ── @ 解析与路由 ──────────────────────────────────────────────────────────

test("解析一句话里的多个 @", () => {
  assert.deepEqual(
    parseMentions("@枫叶橱柜 和 @Northern Wood 你们都有 36 寸转角柜吗"),
    ["枫叶橱柜", "Northern Wood"],
  );
});

const activeCompany = company;
const inactiveCompany: CabinetCompany = {
  ...company, id: "co_pending", name: "Northern Wood", aliases: [],
  billingPlan: { leadFeeEnabled: false, personalizationSubscription: "none" },
};
const routing = {
  companies: [activeCompany, inactiveCompany],
  isActive: (c: CabinetCompany) =>
    deriveCompanyStatus({
      hasPublishedSpec: !!c.currentPublishedSpecVersionId,
      subscription: c.billingPlan.personalizationSubscription,
      onboardingStarted: true,
      deactivated: c.deactivated,
    }) === "active",
};

test("结构化 token 路由是首选路径", () => {
  const r = routeByToken(routing, { companyId: company.id, displayName: "Maple Cabinetry" });
  assert.equal(r.kind, "routed");
});

test("自由文本按别名精确匹配", () => {
  assert.equal(routeByText(routing, "枫叶橱柜").kind, "routed");
  assert.equal(routeByText(routing, "Maple").kind, "routed");
  assert.equal(routeByText(routing, "maple cabinetry inc").kind, "routed");
});

test("不做模糊匹配：拼错就是匹配不上，不猜", () => {
  assert.equal(routeByText(routing, "Maple Cabinets Co").kind, "routed"); // 后缀剥离后仍是 maple
  assert.equal(routeByText(routing, "Mapel").kind, "unknown");            // 拼错 → 不猜
  assert.equal(routeByText(routing, "Map").kind, "unknown");              // 前缀 → 不匹配
});

test("命中多家时返回 ambiguous，不擅自选一家", () => {
  const twin: CabinetCompany = { ...company, id: "co_twin", name: "Maple", aliases: [] };
  const r = routeByText({ ...routing, companies: [...routing.companies, twin] }, "Maple");
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.kind === "ambiguous" ? r.candidates.length : 0, 2);
});

test("已发布但未订阅的公司可被 @，但不路由（FR-10 修正后的口径）", () => {
  const r = routeByText(routing, "Northern Wood");
  assert.equal(r.kind, "notActive");
});

test("客户端文案不暴露入驻/订阅状态", () => {
  const r = routeByText(routing, "Northern Wood");
  assert.notEqual(r.kind, "routed");
  const msg = clientFacingMessage(r as Exclude<typeof r, { kind: "routed" }>);
  for (const leak of ["入驻", "订阅", "未付费", "prospect", "active"]) {
    assert.ok(!msg.includes(leak), `文案泄露了内部状态：${leak}`);
  }
});

// ── 销售信号 ──────────────────────────────────────────────────────────────

const prospects: CompanyProspect[] = [{
  id: "pr_1", name: "Northern Wood Cabinets Ltd", email: "info@nw.example",
  sourceType: "web_scrape", importedAt: "2026-01-01T00:00:00.000Z",
  lastUpdated: "2026-01-01T00:00:00.000Z", status: "prospect",
}];

test("未路由的提及生成带归一化名的销售信号", () => {
  const r = routeByText(routing, "Sunrise Kitchen");
  assert.equal(r.kind, "unknown");
  const sig = buildMentionSignal(r as Exclude<typeof r, { kind: "routed" }>, {
    conversationId: "cv_1", customerAccountId: "ca_1", prospects, at: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(sig.normalizedName, normalizeCompanyName("Sunrise Kitchen"));
  assert.equal(sig.resolutionStatus, "unknown");
});

test("信号回溯市场库", () => {
  const r = routeByText({ ...routing, companies: [] }, "Northern Wood Cabinets Ltd");
  const sig = buildMentionSignal(r as Exclude<typeof r, { kind: "routed" }>, {
    conversationId: "cv_1", customerAccountId: "ca_1", prospects, at: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(sig.resolvedProspectId, "pr_1");
  assert.equal(sig.resolutionStatus, "matchedProspect");
});

test("非 active 公司的信号标为 matchedInactive 并绑定公司 id", () => {
  const r = routeByText(routing, "Northern Wood");
  const sig = buildMentionSignal(r as Exclude<typeof r, { kind: "routed" }>, {
    conversationId: "cv_1", customerAccountId: "ca_1", prospects: [], at: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(sig.resolutionStatus, "matchedInactive");
  assert.equal(sig.resolvedCompanyId, "co_pending");
});

test("销售看板按归一化名聚合，不同写法算同一家", () => {
  const mk = (raw: string, at: string) => buildMentionSignal(
    { kind: "unknown", rawText: raw },
    { conversationId: "cv", customerAccountId: "ca", prospects: [], at },
  );
  const agg = aggregateSignals([
    mk("Sunrise Kitchen", "2026-06-01T00:00:00.000Z"),
    mk("sunrise kitchen inc", "2026-06-02T00:00:00.000Z"),
    mk("SUNRISE KITCHEN LTD.", "2026-06-03T00:00:00.000Z"),
    mk("Other Co", "2026-06-01T00:00:00.000Z"),
  ]);
  assert.equal(agg.length, 2);
  assert.equal(agg[0]!.count, 3);
  assert.equal(agg[0]!.latestAt, "2026-06-03T00:00:00.000Z");
});

test("@ 后面紧跟正文时仍能正确路由（候选解释从长到短回退）", () => {
  // 正则会把紧跟的 ASCII 词一起吞掉，逐词回退把它还原
  assert.equal(routeByText(routing, "Maple Cabinetry B30").kind, "routed");
  assert.equal(routeByText(routing, "枫叶橱柜 B30").kind, "routed");
  assert.equal(routeByText(routing, "Maple B30 30x24").kind, "routed");
});

test("更长的解释优先，不被更短的抢走", () => {
  const shortCo: CabinetCompany = { ...company, id: "co_short", name: "Northern", aliases: [] };
  const routing2 = { ...routing, companies: [inactiveCompany, shortCo] };
  // "Northern Wood" 应命中 Northern Wood（inactive），而不是 Northern
  const r = routeByText(routing2, "Northern Wood");
  assert.equal(r.kind, "notActive");
  assert.equal(r.kind === "notActive" ? r.company.id : "", "co_pending");
});

test("mentionVariants 从长到短", () => {
  assert.deepEqual(mentionVariants("Maple Ridge B30"), ["Maple Ridge B30", "Maple Ridge", "Maple"]);
  assert.deepEqual(mentionVariants("枫叶橱柜"), ["枫叶橱柜"]);
});
