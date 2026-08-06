/**
 * 应用运行上下文 —— 把仓储、LLM 客户端、种子数据装配到一起。
 *
 * 抽出来是为了让服务端与测试用同一套装配逻辑，且能指定独立的数据目录，
 * 避免测试写进真实的 `data/`。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRepositories, type Repositories } from "../store/repositories.js";
import { emptyBundle, toPricingContext, type SpecBundle } from "../spec/bundle.js";
import { SEED_TAX_RULES } from "../pricing/tax.js";
import { createLlmClient } from "../agents/llm-client.js";
import type { CompletionClient } from "../agents/types.js";
import type { VisionExtractor } from "../floorplan/parse.js";
import type { CabinetCompany, GenericCatalog, TaxRule } from "../domain/types.js";
import { deriveCompanyStatus } from "../spec/version.js";
import { genericCatalogVerified } from "./launch-gates.js";
import { generateCompanyToken } from "../tenancy/company-auth.js";
import type { PricingContext } from "../pricing/engine.js";
import * as seed from "./seed.js";
import * as second from "./seed-second.js";

export interface AppContext {
  repos: Repositories;
  taxRules: readonly TaxRule[];
  catalog: GenericCatalog;
  llm: CompletionClient | undefined;
  /** 户型图视觉抽取；未配置时户型录入降级为手动（FR-3）。 */
  vision: VisionExtractor | undefined;
  /**
   * 邮件传输器。默认 undefined —— 走 `sendEmail` 里的 SMTP 解析，
   * 没配 SMTP 就是 dry-run。
   *
   * 留这个注入口是因为「投递成功」这条路径上挂着计费、审计、争议窗口，
   * 是整条链路里最要紧的部分，不能只靠 dry-run 覆盖。
   */
  mailTransport: { sendMail(msg: Record<string, unknown>): Promise<unknown> } | undefined;
  /** GenericCatalog 的价格来源是否已核实（检查清单 A4 / 开放问题 5）。 */
  catalogSourceVerified: boolean;
  termsVersion: string;
  baseUrl: string;
}

export interface CreateContextOptions {
  dataDir?: string;
  /** 用临时目录，测试用。 */
  ephemeral?: boolean;
  llm?: CompletionClient | undefined;
  vision?: VisionExtractor | undefined;
  mailTransport?: AppContext["mailTransport"];
  seedIfEmpty?: boolean;
}

export async function createAppContext(opts: CreateContextOptions = {}): Promise<AppContext> {
  const dataDir = opts.ephemeral
    ? mkdtempSync(path.join(tmpdir(), "rta-hub-"))
    : (opts.dataDir ?? process.env.DATA_DIR ?? path.join(process.cwd(), "data"));

  const repos = openRepositories(dataDir);
  const ctx: AppContext = {
    repos,
    taxRules: SEED_TAX_RULES,
    catalog: seed.genericCatalog,
    llm: opts.llm !== undefined ? opts.llm : createLlmClient(),
    vision: opts.vision,
    mailTransport: opts.mailTransport,
    // 来源尚未定案（开放问题 5 / 闸门 A4），预估文案必须如实标注为占位数据
    catalogSourceVerified: genericCatalogVerified(),
    termsVersion: process.env.TERMS_VERSION || "2026-01",
    baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 8790}`,
  };

  if (opts.seedIfEmpty !== false && repos.companies.all().length === 0) {
    await seedInitialData(ctx);
  }
  return ctx;
}

/** 首次启动时写入试点公司与演示账号。 */
export async function seedInitialData(ctx: AppContext): Promise<void> {
  const { repos } = ctx;
  // 每家公司发一个访问令牌——没有它，公司侧端点就是"谁填哪个 id 就读哪家数据"
  await repos.companies.upsert({ ...seed.pilotCompany, accessToken: generateCompanyToken() });
  await repos.companies.upsert({ ...seed.unsubscribedCompany, accessToken: generateCompanyToken() });
  for (const account of seed.demoAccounts) {
    if (!repos.accounts.byId(account.id)) await repos.accounts.insert(account);
  }
  await repos.specVersions.upsert(seed.pilotSpecVersion);

  const bundle: SpecBundle = {
    ...emptyBundle(seed.PILOT_SPEC_VERSION_ID, seed.PILOT_COMPANY_ID),
    priceGroups: seed.pilotPriceGroups,
    doorStyles: seed.pilotDoorStyles,
    modules: seed.pilotModules,
    priceMatrix: seed.pilotPriceMatrix,
    hardwareOptions: seed.pilotHardware,
    accessoryOptions: seed.pilotAccessories,
    discountRules: seed.pilotDiscounts,
    shippingRule: seed.pilotShipping,
  };
  await repos.specBundles.upsert(bundle);

  // 第二家试点公司：完全通过 FR-2 的模板导入路径建立，验证可复制性
  await repos.companies.upsert({ ...second.secondCompany, accessToken: generateCompanyToken() });
  await repos.specVersions.upsert(second.secondSpecVersion);
  await repos.specBundles.upsert(second.buildSecondCompanyBundle().bundle);
}

/** 公司是否 active —— 由发布状态与订阅派生，不读独立字段（§6.2）。 */
export function isCompanyActive(company: CabinetCompany): boolean {
  return deriveCompanyStatus({
    hasPublishedSpec: !!company.currentPublishedSpecVersionId,
    subscription: company.billingPlan.personalizationSubscription,
    onboardingStarted: true,
    deactivated: company.deactivated,
  }) === "active";
}

/** 取某公司当前发布版本的规格整包。 */
export function publishedBundle(ctx: AppContext, companyId: string): SpecBundle | undefined {
  const company = ctx.repos.companies.byId(companyId);
  if (!company?.currentPublishedSpecVersionId) return undefined;
  return ctx.repos.specBundles.byId(company.currentPublishedSpecVersionId);
}

/** 取某公司的定价上下文。公司未发布规格时返回 undefined。 */
export function pricingContextFor(ctx: AppContext, companyId: string): PricingContext | undefined {
  const bundle = publishedBundle(ctx, companyId);
  return bundle ? toPricingContext(bundle, ctx.taxRules) : undefined;
}

/**
 * 取某公司的渲染参数。
 *
 * 面框/无框与门板覆盖方式存在 `ProductSpecVersion` 上（它们随规格版本走），
 * 不在规格整包里——同一家公司换了做法就是新版本（REQUIREMENTS 3.3 第 5 点）。
 */
export function renderStyleFor(ctx: AppContext, companyId: string): {
  construction: "framed" | "frameless";
  overlay: "full" | "partial" | "inset";
} {
  const company = ctx.repos.companies.byId(companyId);
  const version = company?.currentPublishedSpecVersionId
    ? ctx.repos.specVersions.byId(company.currentPublishedSpecVersionId)
    : undefined;
  return {
    construction: version?.construction ?? "framed",
    overlay: version?.overlay ?? "full",
  };
}
