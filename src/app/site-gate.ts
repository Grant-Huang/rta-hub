/**
 * 整站访问口令 —— 公开部署前的外层闸门。
 *
 * ## 它解决什么、不解决什么
 *
 * 现在的账号鉴权是 `X-Account-Id` 请求头，服务端**不做任何校验**——在 localhost 上
 * 这是已知的 MVP 取舍（检查清单 E1），但放到公网上，任何人把头改成别的账号 id
 * 就能读那个账号的数据，而这个系统里存的是姓名、邮箱、户型图这类 PIPEDA 管辖的信息。
 *
 * 这道口令是**外层**闸门：把整个站挡在一个共享密码后面，让"谁能碰到这个系统"
 * 先收敛到已知的一小群人。它**不是**真正的登录态，也不替代 E1——
 * 口令后面的人仍然可以互相冒充账号。要让真实客户使用，E1 还是绕不过去。
 *
 * ## 一个刻意的设计：配置错了要**响亮地失败**
 *
 * 常见做法是"没配密码就不启用"。那样最危险的场景恰恰不会报警：
 * 生产环境忘了配 `SITE_PASSWORD`，站点就静默地全开着。
 *
 * 所以这里的规则是：
 *   - 配了口令        → 启用闸门；
 *   - 没配 + 非生产   → 不启用，但**每次启动都打印醒目警告**；
 *   - 没配 + 生产     → **拒绝启动**。
 *
 * 让配置失误变成一次启动失败，而不是一次数据泄露。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

export const SITE_COOKIE = "rta_site";

/** 通过后多久要重新输入。演示场景 7 天足够，不必每天烦人。 */
const SESSION_DAYS = 7;

/**
 * 免于口令的路径。
 *
 * `/unsubscribe` **必须**留在这里：CASL 要求退订链接真的能用。一个需要先输密码
 * 才能退订的链接不算有效的退订机制——收件人根本没有这个密码。
 *
 * `/health` 留着是为了让部署平台的健康检查不必知道口令。
 */
const EXEMPT_PREFIXES = ["/health", "/unsubscribe", "/__unlock"];

export interface SiteGateConfig {
  /** 未配置口令时为 undefined —— 闸门不启用。 */
  password?: string;
  /** 签发会话 cookie 用的密钥。 */
  secret: string;
  enabled: boolean;
}

export class SiteGateMisconfigured extends Error {}

export function resolveSiteGate(env: NodeJS.ProcessEnv = process.env): SiteGateConfig {
  const password = env["SITE_PASSWORD"]?.trim();
  const isProduction = env["NODE_ENV"] === "production";

  if (!password) {
    if (isProduction) {
      throw new SiteGateMisconfigured(
        "生产环境必须设置 SITE_PASSWORD。\n" +
        "现在的账号鉴权是不校验的 X-Account-Id 头（检查清单 E1），" +
        "没有这道口令，任何人都能冒充任意账号读取姓名、邮箱与户型图。\n" +
        "确实要开放公网访问，请显式设置 SITE_PASSWORD_DISABLED=true。",
      );
    }
    return { secret: randomBytes(32).toString("hex"), enabled: false };
  }

  // 会话密钥独立于口令：改口令不必然踢掉所有人，但没配就从口令派生（够用且无需额外配置）
  const secret = env["SESSION_SECRET"]?.trim() || `derived:${password}`;
  return { password, secret, enabled: true };
}

/** 显式关闭闸门的逃生口——必须是有意为之，不能是"忘了配"。 */
export function siteGateDisabledExplicitly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SITE_PASSWORD_DISABLED"] === "true";
}

// ── 会话令牌 ──────────────────────────────────────────────────────────────

/** `<过期毫秒时间戳>.<hmac>`。无状态，重启不掉线，也不需要存 session 表。 */
export function issueToken(cfg: SiteGateConfig, now = Date.now()): string {
  const expiresAt = now + SESSION_DAYS * 86_400_000;
  return `${expiresAt}.${sign(cfg.secret, String(expiresAt))}`;
}

export function verifyToken(cfg: SiteGateConfig, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const expiresAt = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(expiresAt)) return false;
  if (Number(expiresAt) <= now) return false;
  return safeEqual(mac, sign(cfg.secret, expiresAt));
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** 定长比较，避免用比较耗时反推口令。 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function checkPassword(cfg: SiteGateConfig, attempt: unknown): boolean {
  if (!cfg.password || typeof attempt !== "string") return false;
  // 先比长度会泄露长度信息，但 timingSafeEqual 要求等长；
  // 用 HMAC 把两边都变成定长再比，长度信息也一并抹掉
  return safeEqual(sign(cfg.secret, attempt), sign(cfg.secret, cfg.password));
}

// ── 简易限速 ──────────────────────────────────────────────────────────────

/**
 * 按来源 IP 限制尝试次数。
 *
 * 单进程内存计数，重启即清零——挡不住有备而来的分布式爆破，但能把
 * "拿字典跑一晚上"变成不现实。真正的防线是口令本身要够长。
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60_000;

export function rateLimit(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
  const rec = attempts.get(key);
  if (!rec || now >= rec.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  rec.count++;
  if (rec.count > MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSec: Math.ceil((rec.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function clearRateLimit(key?: string): void {
  if (key) attempts.delete(key);
  else attempts.clear();
}

// ── 中间件 ────────────────────────────────────────────────────────────────

export function isExempt(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function cookieHeader(token: string, secure: boolean): string {
  const maxAge = SESSION_DAYS * 86_400;
  return [
    `${SITE_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** 建中间件。`cfg.enabled` 为假时直接放行，不产生任何开销。 */
export function siteGate(cfg: SiteGateConfig) {
  return async (c: Context, next: Next) => {
    if (!cfg.enabled) return next();

    const url = new URL(c.req.url);
    if (isExempt(url.pathname)) return next();

    const token = readCookie(c.req.header("cookie"), SITE_COOKIE);
    if (verifyToken(cfg, token)) return next();

    // API 请求返回 401 JSON，页面请求返回登录页——前端才好分辨该跳转还是该提示
    if (url.pathname.startsWith("/api/")) {
      return c.json({ error: "需要访问口令", code: "SITE_LOCKED" }, 401);
    }
    return c.html(unlockPage(), 401);
  };
}

/** 登录页。刻意不提示"口令错误还是账号不存在"这类细节——这里只有一个口令。 */
export function unlockPage(error?: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>RTA-Hub · 需要访问口令</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0f1216; color:#e6e8eb;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  form { background:#1c2129; border:1px solid #3a4250; border-radius:12px;
         padding:28px; width:min(360px,90vw); }
  h1 { font-size:16px; margin:0 0 6px; }
  p { color:#8b94a3; font-size:12.5px; line-height:1.6; margin:0 0 18px; }
  input { width:100%; background:#0f1216; border:1px solid #3a4250; color:inherit;
          padding:10px; border-radius:8px; font-size:14px; margin-bottom:12px; }
  button { width:100%; background:#2a5bd7; border:none; color:#fff; padding:10px;
           border-radius:8px; font-size:14px; cursor:pointer; }
  .err { color:#d87b7b; font-size:12.5px; margin-bottom:10px; }
</style></head>
<body>
  <form method="POST" action="/__unlock">
    <h1>RTA-Hub</h1>
    <p>这是一个尚未公开的预览环境，需要访问口令。</p>
    ${error ? `<div class="err">${error}</div>` : ""}
    <input type="password" name="password" placeholder="访问口令" autofocus required />
    <button type="submit">进入</button>
  </form>
</body></html>`;
}

/** 启动时的状态说明——不启用时必须说清楚，免得以为有保护。 */
export function startupNotice(cfg: SiteGateConfig): string {
  return cfg.enabled
    ? "整站口令：已启用"
    : "整站口令：**未启用** —— 任何能访问本端口的人都能冒充任意账号（检查清单 E1）。" +
      "仅限本地开发使用；对外暴露前必须设置 SITE_PASSWORD。";
}
