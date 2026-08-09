/**
 * 统一权限检查 —— 角色 → 能力；禁止在路由里复制 if 分支。
 *
 * Trade 与 Consumer 分属不同身份域，能力矩阵**分别定义**（见 docs/ACCESS_CONTROL.md）。
 * 数据隔离仍靠 TenantScope / AccountScope；本模块回答「允不允许做这类事」。
 */
import type { Principal } from "./principal.js";
import { isDemandSide } from "./principal.js";
import {
  currentAccessStage,
  type AccessStage,
} from "./access-stage.js";

export type Capability =
  /** 读写本账号下的会话 / 报价 / 户型 */
  | "account.self"
  /** 同一账号下多项目（多 Conversation）并行 —— trade 域 */
  | "account.multi_project"
  /** 贸易价受众资格（最终是否到手仍受 verification / effectiveAccountType 约束） */
  | "pricing.trade"
  /** 公司租户数据（规格、计费、入驻） */
  | "company.tenant"
  /** 需求侧 / 公司运行时：仅消费已发布 L0（handbook / overlay 注入） */
  | "knowledge.l0.consume_published"
  /** 运营：训练、草稿、发布、导出 L0 卡实体 */
  | "knowledge.l0.manage"
  /** 读取某公司 L1（规格 / CodingRules）；资源上再校验 companyId */
  | "knowledge.l1.read"
  /** 写入某公司 L1 */
  | "knowledge.l1.write"
  /** 跨 SessionRun / 跨账号运营只读 */
  | "admin.cross_session"
  /** 平台运营杂项（公司开户、争议、核实） */
  | "admin.ops";

export class AccessDeniedError extends Error {
  constructor(
    message: string,
    readonly code:
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CROSS_TENANT"
      | "CROSS_ACCOUNT" = "FORBIDDEN",
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

/**
 * 分身份域能力矩阵 —— consumer 与 trade **不得**共用同一数组引用。
 * 重叠能力（如 account.self）是各自声明的交集，不是「一套 ACL」。
 */
const CONSUMER_CAPS: readonly Capability[] = [
  "account.self",
  "knowledge.l0.consume_published",
  "knowledge.l1.read",
];

const TRADE_CAPS: readonly Capability[] = [
  "account.self",
  "account.multi_project",
  "pricing.trade",
  "knowledge.l0.consume_published",
  "knowledge.l1.read",
];

const COMPANY_CAPS: readonly Capability[] = [
  "company.tenant",
  "knowledge.l0.consume_published",
  "knowledge.l1.read",
  "knowledge.l1.write",
];

const ADMIN_CAPS: readonly Capability[] = [
  "account.self",
  "account.multi_project",
  "pricing.trade",
  "company.tenant",
  "knowledge.l0.consume_published",
  "knowledge.l0.manage",
  "knowledge.l1.read",
  "knowledge.l1.write",
  "admin.cross_session",
  "admin.ops",
];

const MATRIX: Record<Principal["kind"], readonly Capability[]> = {
  anonymous: [],
  consumer: CONSUMER_CAPS,
  trade: TRADE_CAPS,
  company: COMPANY_CAPS,
  platform_admin: ADMIN_CAPS,
};

export function capabilitiesFor(kind: Principal["kind"]): readonly Capability[] {
  return MATRIX[kind];
}

export function hasCapability(principal: Principal, cap: Capability): boolean {
  return MATRIX[principal.kind].includes(cap);
}

export function assertCapability(principal: Principal, cap: Capability): void {
  if (!hasCapability(principal, cap)) {
    if (principal.kind === "anonymous") {
      throw new AccessDeniedError("Unauthenticated", "UNAUTHENTICATED");
    }
    throw new AccessDeniedError(`Forbidden: missing ${cap}`, "FORBIDDEN");
  }
}

/** 客户只能碰自己的 accountId；admin 可跨账号（运营）。 */
export function assertAccountAccess(principal: Principal, accountId: string): void {
  assertCapability(principal, "account.self");
  if (principal.kind === "platform_admin") return;
  if (isDemandSide(principal) && principal.accountId === accountId) return;
  throw new AccessDeniedError("Conversation not found", "NOT_FOUND");
}

/**
 * 公司租户访问：company principal 必须匹配 URL companyId；
 * platform_admin 可跨租户；company via=admin 仅代操**当前** companyId（见 assertCompanyAccess）。
 */
export function assertCompanyAccess(principal: Principal, companyId: string): void {
  assertCapability(principal, "company.tenant");
  if (principal.kind === "platform_admin") return;
  if (principal.kind === "company" && principal.companyId === companyId) return;
  throw new AccessDeniedError("Company not found", "NOT_FOUND");
}

/** platform_admin，或公司路由上的 admin 代操。 */
function isAdminL1Actor(principal: Principal): boolean {
  return (
    principal.kind === "platform_admin" ||
    (principal.kind === "company" && principal.via === "admin")
  );
}

/**
 * L1 读：
 * - 需求侧：会话中 @ 厂商后注入该厂 published（调用方绑定 companyId）
 * - 公司令牌：仅本厂
 * - admin（platform_admin / via=admin）：任意公司（design 与 production 均可读）
 */
export function assertL1Read(
  principal: Principal,
  companyId: string,
  _stage: AccessStage = currentAccessStage(),
): void {
  assertCapability(principal, "knowledge.l1.read");
  if (isAdminL1Actor(principal) || isDemandSide(principal)) return;
  if (principal.kind === "company" && principal.companyId === companyId) return;
  throw new AccessDeniedError("Spec not found", "NOT_FOUND");
}

/**
 * L1 写（按 ACCESS_STAGE / NODE_ENV 分支，见 docs/ACCESS_CONTROL.md §3.2）：
 * - 公司令牌（via=company）：仅本厂（design / production 相同）
 * - admin（platform_admin / via=admin）：
 *   - design：可写任意公司
 *   - production：拒绝写（可读，见 assertL1Read）
 */
export function assertL1Write(
  principal: Principal,
  companyId: string,
  stage: AccessStage = currentAccessStage(),
): void {
  assertCapability(principal, "knowledge.l1.write");
  if (isAdminL1Actor(principal)) {
    if (stage === "production") {
      throw new AccessDeniedError(
        "Forbidden: admin cannot write L1 in production",
        "FORBIDDEN",
      );
    }
    return;
  }
  if (principal.kind === "company" && principal.companyId === companyId) return;
  throw new AccessDeniedError("Forbidden: cannot write another tenant's L1", "CROSS_TENANT");
}

/** L0 训练 / 卡管理：仅 platform_admin。 */
export function assertL0Manage(principal: Principal): void {
  assertCapability(principal, "knowledge.l0.manage");
}

/** 多项目：仅 trade（及运营）；consumer 无此能力。 */
export function assertMultiProject(principal: Principal): void {
  assertCapability(principal, "account.multi_project");
}

/** 贸易价能力声明；真正到手仍走 effectiveAccountType。 */
export function assertTradePricingCapability(principal: Principal): void {
  assertCapability(principal, "pricing.trade");
}
