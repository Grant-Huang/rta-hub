/**
 * 请求主体（Principal）—— 用户分层的运行时表示。
 *
 * 分层来源：REQUIREMENTS §3.4 / FR-9 / FR-11 / FR-16；隔离细则见 docs/ACCESS_CONTROL.md。
 * 鉴权顺序必须是「先证明你是谁，再按身份过滤」（见 company-auth.ts）。
 *
 * ## 鉴权方案（MVP → 预留）
 *
 * MVP 用请求头证明身份（`X-Account-Id` / `X-Company-Token` / `X-Admin-Token`），
 * 便于本地与集成测试。模型通过 `AuthScheme` / `AuthContext` 预留 session / JWT：
 * 将来只换 `resolvePrincipal` 的凭证解析，不改 Capability 矩阵与 Scope 过滤。
 */
import type { AccountType, CustomerAccount } from "../domain/types.js";
import type { CabinetCompany } from "../domain/types.js";
import { authorizeCompany } from "../tenancy/company-auth.js";

/** 身份域：需求侧拆 consumer / trade，禁止再合并为单一 customer。 */
export type ActorKind =
  | "anonymous"
  | "consumer"
  | "trade"
  | "company"
  | "platform_admin";

/**
 * 凭证方案。MVP 仅实现 `header_mvp`；`session` / `jwt` 为预留枚举，
 * 解析器尚未接线时不得假装已认证。
 */
export type AuthScheme = "header_mvp" | "session" | "jwt";

/**
 * 鉴权上下文（扩展点）。当前全部流量走 `header_mvp`；
 * 引入登录态后由中间件填充 `scheme` + 已验证主体，再交给业务。
 */
export interface AuthContext {
  scheme: AuthScheme;
  /** 已解析主体；未认证则为 anonymous。 */
  principal: Principal;
}

export type Principal =
  | { kind: "anonymous" }
  | {
      kind: "consumer";
      accountId: string;
      accountType: "consumer";
      account: CustomerAccount;
    }
  | {
      kind: "trade";
      accountId: string;
      accountType: "trade";
      account: CustomerAccount;
    }
  | {
      kind: "company";
      companyId: string;
      /**
       * company = 自家令牌（L1 仅本厂）；
       * admin = 运营代操作（L1 跨厂读/写受 ACCESS_STAGE 约束，见 permissions.assertL1*）
       */
      via: "company" | "admin";
    }
  | { kind: "platform_admin" };

export const ANONYMOUS: Principal = { kind: "anonymous" };

/** 需求侧（consumer | trade）主体。 */
export type DemandPrincipal = Extract<Principal, { kind: "consumer" | "trade" }>;

export function isDemandSide(principal: Principal): principal is DemandPrincipal {
  return principal.kind === "consumer" || principal.kind === "trade";
}

export function demandAccountId(principal: Principal): string | undefined {
  return isDemandSide(principal) ? principal.accountId : undefined;
}

/**
 * 由账号记录构造需求侧 Principal。
 * `accountType` 决定身份域（consumer vs trade），不得再折叠为统一 customer。
 */
export function customerPrincipal(account: CustomerAccount): DemandPrincipal {
  if (account.accountType === "trade") {
    return {
      kind: "trade",
      accountId: account.id,
      accountType: "trade",
      account,
    };
  }
  return {
    kind: "consumer",
    accountId: account.id,
    accountType: "consumer",
    account,
  };
}

export function adminPrincipal(): Principal {
  return { kind: "platform_admin" };
}

export function companyPrincipal(
  companyId: string,
  via: "company" | "admin",
): Principal {
  return { kind: "company", companyId, via };
}

export interface ResolvePrincipalInput {
  accountIdHeader?: string;
  companyIdParam?: string;
  companyTokenHeader?: string;
  adminTokenHeader?: string;
  adminExpected?: string;
  lookupAccount: (id: string) => CustomerAccount | undefined;
  lookupCompany: (id: string) => CabinetCompany | undefined;
  /**
   * 预留：显式指定凭证方案。省略时按 header_mvp。
   * session/jwt 未实现时仍回落 anonymous（不静默提权）。
   */
  scheme?: AuthScheme;
}

/**
 * 从请求凭证解析主体。优先级：公司路由鉴权 > 显式运营 > 账号。
 *
 * 注意：运营同时带 admin + company 时，公司路由上 `authorizeCompany` 会走 admin via
 * （company principal，via=admin，principal.companyId = URL companyId）；
 * 纯 `/api/admin/*` 则记为 platform_admin。
 * L1 跨厂读写另见 assertL1Read / assertL1Write（按 ACCESS_STAGE）。
 */
export function resolvePrincipal(input: ResolvePrincipalInput): Principal {
  const scheme: AuthScheme = input.scheme ?? "header_mvp";
  if (scheme !== "header_mvp") {
    // session / jwt 接线前不接受伪造 scheme 提权
    return ANONYMOUS;
  }

  const adminOk =
    Boolean(input.adminExpected) &&
    Boolean(input.adminTokenHeader) &&
    input.adminTokenHeader === input.adminExpected;

  if (input.companyIdParam) {
    const auth = authorizeCompany({
      company: input.lookupCompany(input.companyIdParam),
      presented: input.companyTokenHeader,
      adminPresented: input.adminTokenHeader,
      adminExpected: input.adminExpected,
    });
    if (auth.ok) {
      return companyPrincipal(input.companyIdParam, auth.via);
    }
  }

  if (adminOk) return adminPrincipal();

  if (input.accountIdHeader) {
    const account = input.lookupAccount(input.accountIdHeader);
    if (account) return customerPrincipal(account);
  }

  return ANONYMOUS;
}

/** 组装 AuthContext（供中间件 / 测试统一出口）。 */
export function authContextFromPrincipal(
  principal: Principal,
  scheme: AuthScheme = "header_mvp",
): AuthContext {
  return { scheme, principal };
}

/** 类型收窄用：账号类型与 Principal.kind 对齐。 */
export function accountTypeOf(principal: DemandPrincipal): AccountType {
  return principal.accountType;
}
