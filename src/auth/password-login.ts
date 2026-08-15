/**
 * 本地/联调用的账号口令登录（不是 E1 邮箱验证码）。
 *
 * 仅种子账号 `ca_test`（用户名 `test`）可用。口令默认 Grant123，可用
 * `TEST_ACCOUNT_PASSWORD` 覆盖。不要把口令写进 accounts JSON。
 */
import { scryptSync, timingSafeEqual } from "node:crypto";

export const TEST_ACCOUNT_ID = "ca_test";
export const TEST_ACCOUNT_EMAIL = "test@rta-hub.local";
export const TEST_ACCOUNT_USERNAME = "test";

const SALT = "rta-hub-ca-test-v1";

export function testAccountPassword(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["TEST_ACCOUNT_PASSWORD"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "Grant123";
}

export function isTestAccountLogin(login: string): boolean {
  const t = login.trim().toLowerCase();
  return t === TEST_ACCOUNT_USERNAME || t === TEST_ACCOUNT_EMAIL;
}

export function verifyTestAccountPassword(
  password: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof password !== "string" || password.length === 0) return false;
  const expected = scryptSync(testAccountPassword(env), SALT, 32);
  const got = scryptSync(password, SALT, 32);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
