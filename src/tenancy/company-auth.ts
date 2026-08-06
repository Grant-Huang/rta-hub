/**
 * 公司侧鉴权 —— 让租户隔离**真的**成立。
 *
 * ## 这里原来有个洞
 *
 * 公司侧端点长这样：
 *
 * ```ts
 * app.get("/api/company/:companyId/billing", (c) => {
 *   const scope = new TenantScope(param(c, "companyId"));   // ← id 来自 URL
 *   return c.json({ events: scope.filter(...) });
 * });
 * ```
 *
 * `TenantScope` 确实按 companyId 过滤了，但**那个 id 是调用方自己填的**。
 * 这不是隔离，是拿攻击者可控的输入做过滤——换一个 companyId 就能读到别家的
 * 计费事件（含客户账号 id、会话 id、报价 id、金额），还能代别家提争议。
 *
 * 这正是 FR-9 与 §3.4 承诺不会发生的事。租户隔离的前提是**先证明你是谁**，
 * 再按你的身份过滤；顺序反了，过滤就只是装饰。
 *
 * ## 这里做了什么、没做什么
 *
 * 做了：每家公司一个访问令牌，`X-Company-Token` 必须与 URL 里的 companyId 对得上。
 * 定长比较，避免用比较耗时反推令牌。运营令牌（ADMIN_TOKEN）可以代任意公司操作——
 * 客服代公司提争议是真实需求。
 *
 * 没做：这**不是**公司账号体系。没有登录、没有多用户、没有权限分级、没有令牌轮换。
 * 那些属于检查清单 E1，跟消费者侧的登录态一起做。这里只是把「谁都能读别家数据」
 * 这个洞堵上——它不该等到 E1 才修。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CabinetCompany } from "../domain/types.js";

/** 令牌长度：32 字节 base64url，足够抗爆破。 */
export function generateCompanyToken(): string {
  return randomBytes(32).toString("base64url");
}

export type CompanyAuthResult =
  | { ok: true; via: "company" | "admin" }
  | { ok: false; status: 401 | 404; error: string };

export interface CompanyAuthInput {
  company: CabinetCompany | undefined;
  /** 请求头里的 X-Company-Token。 */
  presented: string | undefined;
  /** 请求头里的 X-Admin-Token。 */
  adminPresented: string | undefined;
  /** 环境里配置的 ADMIN_TOKEN；未配置时运营通道一律关闭。 */
  adminExpected: string | undefined;
}

/**
 * 校验公司身份。
 *
 * 注意**公司不存在与令牌不对返回的信息量要一致**：都不能让调用方据此枚举出
 * 系统里有哪些公司。所以两种情况都返回同一句话，只有状态码区分
 * （404 给的是"这个 id 没有可访问的资源"，与"存在但你没权限"在外部看来一样）。
 */
export function authorizeCompany(input: CompanyAuthInput): CompanyAuthResult {
  // 运营通道：客服代公司操作是真实需求（例如公司打电话来说这条线索不对）
  if (input.adminExpected && input.adminPresented
      && safeEqual(input.adminPresented, input.adminExpected)) {
    return input.company
      ? { ok: true, via: "admin" }
      : { ok: false, status: 404, error: "公司不存在" };
  }

  const denied: CompanyAuthResult = {
    ok: false, status: 401,
    error: "未授权：需要与该公司匹配的 X-Company-Token",
  };

  if (!input.company) return denied;
  const expected = input.company.accessToken;
  if (!expected) {
    return {
      ok: false, status: 401,
      error: "该公司尚未配置访问令牌，请联系平台运营开通",
    };
  }
  if (!input.presented || !safeEqual(input.presented, expected)) return denied;
  return { ok: true, via: "company" };
}

/**
 * 定长比较。
 *
 * 先 HMAC 成定长再比：`timingSafeEqual` 要求两边等长，而长度本身也是信息
 * （与 site-gate 里同样的处理）。
 */
const SESSION_SALT = randomBytes(16).toString("hex");

function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", SESSION_SALT).update(a).digest();
  const hb = createHmac("sha256", SESSION_SALT).update(b).digest();
  return timingSafeEqual(ha, hb);
}
