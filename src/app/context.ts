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
import type { CabinetCompany, GenericCatalog, TaxRule } from "../domain/types.js";
import { deriveCompanyStatus } from "../spec/version.js";
import type { PricingContext } from "../pricing/engine.js";
import * as seed from "./seed.js";

export interface AppContext {
  repos: Repositories;
  taxRules: readonly TaxRule[];
  catalog: GenericCatalog;
  llm: CompletionClient | undefined;
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
    // 来源尚未定案（开放问题 5），预估文案必须如实标注为占位数据
    catalogSourceVerified: process.env.GENERIC_CATALOG_VERIFIED === "true",
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
  await repos.companies.upsert(seed.pilotCompany);
  await repos.companies.upsert(seed.unsubscribedCompany);
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
