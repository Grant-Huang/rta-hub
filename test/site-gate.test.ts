/**
 * 整站访问口令 —— 公开部署前的外层闸门。
 *
 * 最要紧的一条断言：**生产环境没配口令必须拒绝启动**。
 * "没配就不启用"的做法，会让最危险的那个场景（生产忘配）静默通过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPassword, clearRateLimit, cookieHeader, isExempt, issueToken, rateLimit, readCookie,
  resolveSiteGate, SITE_COOKIE, SiteGateMisconfigured, siteGateDisabledExplicitly,
  startupNotice, verifyToken,
} from "../src/app/site-gate.js";

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });

// ── 配置解析 ──────────────────────────────────────────────────────────────

test("配了口令就启用", () => {
  const cfg = resolveSiteGate(env({ SITE_PASSWORD: "hunter2hunter2" }));
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.password, "hunter2hunter2");
});

test("生产环境没配口令 → 拒绝启动，而不是静默全开", () => {
  assert.throws(
    () => resolveSiteGate(env({ NODE_ENV: "production" })),
    SiteGateMisconfigured,
  );
  // 报错必须说清楚为什么，以及怎么显式绕过
  try {
    resolveSiteGate(env({ NODE_ENV: "production" }));
  } catch (e) {
    assert.match((e as Error).message, /SITE_PASSWORD/);
    assert.match((e as Error).message, /SITE_PASSWORD_DISABLED/);
  }
});

test("非生产没配口令 → 不启用，但启动提示必须说明没有保护", () => {
  const cfg = resolveSiteGate(env({}));
  assert.equal(cfg.enabled, false);
  assert.match(startupNotice(cfg), /未启用/);
  assert.match(startupNotice(cfg), /冒充任意账号/);
});

test("显式关闭是逃生口，必须是有意为之", () => {
  assert.equal(siteGateDisabledExplicitly(env({ SITE_PASSWORD_DISABLED: "true" })), true);
  // 拼错、留空、设成别的值都不算关闭——只有确切的 "true"
  assert.equal(siteGateDisabledExplicitly(env({ SITE_PASSWORD_DISABLED: "1" })), false);
  assert.equal(siteGateDisabledExplicitly(env({ SITE_PASSWORD_DISABLED: "" })), false);
  assert.equal(siteGateDisabledExplicitly(env({})), false);
});

test("空白口令不算配了口令", () => {
  assert.throws(
    () => resolveSiteGate(env({ SITE_PASSWORD: "   ", NODE_ENV: "production" })),
    SiteGateMisconfigured,
  );
});

test("会话密钥可独立配置——改口令不必然踢掉所有人", () => {
  const a = resolveSiteGate(env({ SITE_PASSWORD: "pw1", SESSION_SECRET: "shared" }));
  const b = resolveSiteGate(env({ SITE_PASSWORD: "pw2", SESSION_SECRET: "shared" }));
  assert.ok(verifyToken(b, issueToken(a)), "同一 SESSION_SECRET 下令牌互认");

  // 没配 SESSION_SECRET 时从口令派生：换口令即失效
  const c = resolveSiteGate(env({ SITE_PASSWORD: "pw1" }));
  const d = resolveSiteGate(env({ SITE_PASSWORD: "pw2" }));
  assert.ok(!verifyToken(d, issueToken(c)));
});

// ── 口令比对 ──────────────────────────────────────────────────────────────

const cfg = resolveSiteGate(env({ SITE_PASSWORD: "correct-horse-battery" }));

test("口令正确才通过", () => {
  assert.equal(checkPassword(cfg, "correct-horse-battery"), true);
  assert.equal(checkPassword(cfg, "correct-horse-batter"), false);
  assert.equal(checkPassword(cfg, ""), false);
  assert.equal(checkPassword(cfg, undefined), false);
  assert.equal(checkPassword(cfg, 12345), false, "非字符串不能通过");
  assert.equal(checkPassword(cfg, { toString: () => "correct-horse-battery" }), false);
});

test("长度不同的猜测也走定长比较——不泄露口令长度", () => {
  // 只能断言行为正确；时序本身由 HMAC + timingSafeEqual 保证
  assert.equal(checkPassword(cfg, "x"), false);
  assert.equal(checkPassword(cfg, "x".repeat(500)), false);
});

test("闸门未启用时任何口令都不通过——避免空口令误开", () => {
  const off = resolveSiteGate(env({}));
  assert.equal(checkPassword(off, ""), false);
  assert.equal(checkPassword(off, "anything"), false);
});

// ── 会话令牌 ──────────────────────────────────────────────────────────────

test("签发的令牌能验过，篡改的验不过", () => {
  const token = issueToken(cfg);
  assert.equal(verifyToken(cfg, token), true);

  const [exp, mac] = token.split(".");
  assert.equal(verifyToken(cfg, `${exp}.${mac!.slice(0, -1)}0`), false, "改签名");
  assert.equal(verifyToken(cfg, `${Number(exp) + 86_400_000}.${mac}`), false, "改过期时间");
  assert.equal(verifyToken(cfg, undefined), false);
  assert.equal(verifyToken(cfg, ""), false);
  assert.equal(verifyToken(cfg, "garbage"), false);
  assert.equal(verifyToken(cfg, ".abc"), false);
  assert.equal(verifyToken(cfg, "notanumber.abc"), false);
});

test("过期令牌失效", () => {
  const now = Date.now();
  const token = issueToken(cfg, now);
  assert.equal(verifyToken(cfg, token, now + 6 * 86_400_000), true);
  assert.equal(verifyToken(cfg, token, now + 8 * 86_400_000), false);
});

test("换了密钥的令牌验不过", () => {
  const other = resolveSiteGate(env({ SITE_PASSWORD: "different-password" }));
  assert.equal(verifyToken(other, issueToken(cfg)), false);
});

// ── 免于口令的路径 ────────────────────────────────────────────────────────

test("退订链接必须免于口令——CASL 要求退订真的能用", () => {
  assert.equal(isExempt("/unsubscribe"), true);
  assert.equal(isExempt("/unsubscribe?token=abc".split("?")[0]!), true);
  assert.equal(isExempt("/health"), true);
  assert.equal(isExempt("/__unlock"), true);
});

test("其余路径一律要口令", () => {
  for (const p of ["/", "/api/companies", "/api/quotes", "/api/admin/disputes"]) {
    assert.equal(isExempt(p), false, `${p} 不该免于口令`);
  }
  // 前缀不能被"蹭"——/unsubscribe-all 不是 /unsubscribe
  assert.equal(isExempt("/unsubscribe-all"), false);
  assert.equal(isExempt("/healthz"), false);
});

// ── cookie ────────────────────────────────────────────────────────────────

test("cookie 解析", () => {
  assert.equal(readCookie(`${SITE_COOKIE}=abc`, SITE_COOKIE), "abc");
  assert.equal(readCookie(`other=1; ${SITE_COOKIE}=abc; more=2`, SITE_COOKIE), "abc");
  assert.equal(readCookie("other=1", SITE_COOKIE), undefined);
  assert.equal(readCookie(undefined, SITE_COOKIE), undefined);
  // 前缀相同的别的 cookie 不能被误读
  assert.equal(readCookie(`${SITE_COOKIE}_other=nope`, SITE_COOKIE), undefined);
});

test("cookie 带 HttpOnly / SameSite，https 下带 Secure", () => {
  const plain = cookieHeader("tok", false);
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.ok(!plain.includes("Secure"));
  assert.match(cookieHeader("tok", true), /Secure/);
});

// ── 限速 ──────────────────────────────────────────────────────────────────

test("同一来源尝试过多被限速，窗口过后恢复", () => {
  clearRateLimit();
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    assert.equal(rateLimit("1.2.3.4", now).allowed, true, `第 ${i + 1} 次应放行`);
  }
  const blocked = rateLimit("1.2.3.4", now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0);

  // 别的来源不受影响
  assert.equal(rateLimit("5.6.7.8", now).allowed, true);
  // 窗口过后恢复
  assert.equal(rateLimit("1.2.3.4", now + 16 * 60_000).allowed, true);
  clearRateLimit();
});
