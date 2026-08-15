/**
 * 账号会话 cookie —— E1 的第一步。
 *
 * 邮箱验证码登录成功后，签发这个 cookie，让"同一个人"在任何浏览器/设备上
 * 都能被认出来，而不再只靠客户端自己声明、服务端照单全收的 `X-Account-Id`
 * 请求头（`server.ts` 的 `requireAccount` 仍然在没有会话 cookie 时接受那个
 * 请求头——这是刻意的向后兼容：脚本、`tsx --test`、贸易/公司等其他身份域
 * 都还在用它，这一步不动它们。真正堵住"任何人改个头就能冒充任意账号"这个
 * 口子，还需要以后禁止已登录账号继续走裸头——这里没做，见 `docs/ACCESS_CONTROL.md`
 * E1）。
 *
 * 令牌格式借用 `app/site-gate.ts` 的思路（HMAC 签名、无状态、不需要
 * session 表），但签的是 accountId，不是"通过了口令"这一个布尔位。
 * 密钥必须与站点口令的 `SESSION_SECRET` 分开：那个密钥在没配置时会从
 * **共享站点口令**派生，知道站点口令的人不该因此就能签发任意账号的登录态。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ACCOUNT_SESSION_COOKIE = "rta_account_session";

/** 登录后多久要重新验证邮箱。30 天——比站点口令的 7 天宽松，因为这是真实身份而非共享闸门。 */
const SESSION_DAYS = 30;

export interface AccountSessionConfig {
  secret: string;
  /** 未配置专用密钥、启动时随机生成——重启后所有登录态失效，仅提醒不阻断启动。 */
  ephemeral: boolean;
}

export function resolveAccountSessionConfig(env: NodeJS.ProcessEnv = process.env): AccountSessionConfig {
  const configured = env["ACCOUNT_SESSION_SECRET"]?.trim();
  if (configured) return { secret: configured, ephemeral: false };
  return { secret: randomBytes(32).toString("hex"), ephemeral: true };
}

/** `<accountId>.<过期毫秒时间戳>.<hmac>`。 */
export function issueAccountSessionToken(
  cfg: AccountSessionConfig,
  accountId: string,
  now = Date.now(),
): string {
  const expiresAt = now + SESSION_DAYS * 86_400_000;
  const payload = `${accountId}.${expiresAt}`;
  return `${payload}.${sign(cfg.secret, payload)}`;
}

/** 验证通过则返回签发时的 accountId；否则 undefined（过期/签名不对/格式不对都算失败，不细分给客户端）。 */
export function verifyAccountSessionToken(
  cfg: AccountSessionConfig,
  token: string | undefined,
  now = Date.now(),
): string | undefined {
  if (!token) return undefined;
  const macDot = token.lastIndexOf(".");
  if (macDot <= 0) return undefined;
  const payload = token.slice(0, macDot);
  const mac = token.slice(macDot + 1);

  const expDot = payload.lastIndexOf(".");
  if (expDot <= 0) return undefined;
  const accountId = payload.slice(0, expDot);
  const expiresAt = payload.slice(expDot + 1);
  if (!/^\d+$/.test(expiresAt)) return undefined;
  if (Number(expiresAt) <= now) return undefined;
  if (!safeEqual(mac, sign(cfg.secret, payload))) return undefined;
  return accountId;
}

export function accountSessionCookieHeader(token: string, secure: boolean): string {
  const maxAge = SESSION_DAYS * 86_400;
  return [
    `${ACCOUNT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** 退出登录：立即过期同名 cookie。 */
export function clearAccountSessionCookieHeader(secure: boolean): string {
  return [
    `${ACCOUNT_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** 定长比较，避免用比较耗时反推签名。 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function startupNoticeForAccountSession(cfg: AccountSessionConfig): string {
  return cfg.ephemeral
    ? "Account session secret: **ephemeral** (random at boot) — logged-in users are signed out on every restart. Set ACCOUNT_SESSION_SECRET before production."
    : "Account session secret: configured";
}
