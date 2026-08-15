/**
 * 邮箱验证码 —— 免密码登录第一步：生成一次性验证码、核验，真正发信交给调用方。
 *
 * 单进程内存存储：重启即清零，够用（MVP，与 `app/site-gate.ts` 的限速取舍一致）。
 * 复用 `site-gate` 的限速器，防止验证码请求 / 校验被刷。
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { rateLimit } from "../app/site-gate.js";

/** 验证码有效期。 */
const CODE_TTL_MS = 10 * 60_000;
/** 校验失败超过这个次数，验证码作废——挡暴力枚举 6 位数字。 */
const MAX_VERIFY_ATTEMPTS = 5;

interface PendingCode {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

const pending = new Map<string, PendingCode>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashCode(email: string, code: string): string {
  return createHash("sha256").update(`${email}:${code}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface RequestCodeResult {
  ok: boolean;
  /** ok 时才有——调用方拿去发邮件，这个模块不碰发信通道。 */
  code?: string;
  retryAfterSec?: number;
}

/** 生成并记下验证码；按邮箱限速，防止同一邮箱被刷验证码请求。 */
export function requestLoginCode(email: string): RequestCodeResult {
  const normalized = normalizeEmail(email);
  const limit = rateLimit(`otp-request:${normalized}`);
  if (!limit.allowed) return { ok: false, retryAfterSec: limit.retryAfterSec };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  pending.set(normalized, {
    codeHash: hashCode(normalized, code),
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
  });
  return { ok: true, code };
}

export interface VerifyCodeResult {
  ok: boolean;
  reason?: "expired" | "mismatch" | "too_many_attempts" | "rate_limited";
}

export function verifyLoginCode(email: string, code: string): VerifyCodeResult {
  const normalized = normalizeEmail(email);
  const limit = rateLimit(`otp-verify:${normalized}`);
  if (!limit.allowed) return { ok: false, reason: "rate_limited" };

  const entry = pending.get(normalized);
  if (!entry) return { ok: false, reason: "mismatch" };
  if (Date.now() > entry.expiresAt) {
    pending.delete(normalized);
    return { ok: false, reason: "expired" };
  }
  entry.attempts += 1;
  if (entry.attempts > MAX_VERIFY_ATTEMPTS) {
    pending.delete(normalized);
    return { ok: false, reason: "too_many_attempts" };
  }
  if (!safeEqual(hashCode(normalized, code), entry.codeHash)) {
    return { ok: false, reason: "mismatch" };
  }
  pending.delete(normalized);
  return { ok: true };
}

/** 仅测试用：清空验证码状态与限速计数，避免用例互相污染。 */
export function resetLoginCodesForTest(): void {
  pending.clear();
}
