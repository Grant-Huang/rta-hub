/**
 * 运营工具：SSRF 护栏、字节上限、CSV 导出（PRE_LAUNCH_CHECKLIST E5）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { blockedUrlReason } from "../src/ops/company-discovery.js";
import { openStore, toCsv } from "../src/ops/prospects-cli.js";
import type { CompanyProspect } from "../src/domain/types.js";
import { UniqueConstraintError } from "../src/store/json-store.js";

test("SSRF 护栏拦截私网与环回地址", () => {
  const blocked = [
    "http://127.0.0.1/admin",
    "http://localhost:8080/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", // 云元数据端点
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://internal.service.internal/",
  ];
  for (const url of blocked) {
    assert.ok(blockedUrlReason(url), `应拦截 ${url}`);
  }
});

test("SSRF 护栏拦截非 http(s) 协议", () => {
  assert.ok(blockedUrlReason("file:///etc/passwd"));
  assert.ok(blockedUrlReason("ftp://example.com/"));
  assert.ok(blockedUrlReason("gopher://example.com/"));
  assert.ok(blockedUrlReason("not a url"));
});

test("SSRF 护栏放行正常公网地址", () => {
  for (const url of [
    "https://example.com/contact",
    "http://cabinets.ca/quote",
    "https://8.8.8.8/",
    "https://172.32.0.1/",  // 172.32 不在私网段内
    "https://192.169.1.1/", // 192.169 不在私网段内
  ]) {
    assert.equal(blockedUrlReason(url), undefined, `不应拦截 ${url}`);
  }
});

// ── 公司发现库 ────────────────────────────────────────────────────────────

function tmpStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "rta-prospects-"));
  return openStore(path.join(dir, "companies.json"));
}

const row = (over: Partial<CompanyProspect> = {}): CompanyProspect => ({
  id: "pr_1", name: "Maple Ridge Cabinetry", email: "info@mapleridge.example",
  city: "Toronto", province: "ON", sourceType: "web_scrape",
  importedAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z",
  status: "prospect", ...over,
});

test("email 唯一约束在数据层兜底，重复导入不会产生两条", async () => {
  const store = tmpStore();
  await store.insert(row());
  await assert.rejects(
    () => store.insert(row({ id: "pr_2" })),
    (e: unknown) => e instanceof UniqueConstraintError && e.constraintName === "email",
  );
  assert.equal(store.all().length, 1);
});

test("归档保留记录，不物理删除（信号回溯还要用）", async () => {
  const store = tmpStore();
  await store.insert(row());
  await store.update("pr_1", { status: "archived" });
  assert.equal(store.all().length, 1);
  assert.equal(store.byId("pr_1")!.status, "archived");
});

test("CSV 导出转义引号与逗号", () => {
  const csv = toCsv([
    row({ name: 'Smith, "Bob" Cabinets' }),
    row({ id: "pr_2", email: "b@x.example", name: "Plain" }),
  ]);
  const lines = csv.split("\n");
  assert.match(lines[0]!, /^id,name,email/);
  assert.ok(lines[1]!.includes('"Smith, ""Bob"" Cabinets"'));
  assert.equal(lines.length, 3);
});
