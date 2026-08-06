/**
 * 公司发现库的运营 CLI —— REQUIREMENTS FR-12.1 / FR-12.2。
 *
 * 用法（由管理员手动触发，非定时任务）：
 *   pnpm ops:prospects import [--cities Toronto,Vancouver] [--max 6]
 *   pnpm ops:prospects list [--province ON] [--status prospect]
 *   pnpm ops:prospects add --name "X Cabinets" --email a@b.com [--city Toronto]
 *   pnpm ops:prospects set <id> --status contacted [--notes "..."]
 *   pnpm ops:prospects archive <id>
 *   pnpm ops:prospects export [--out prospects.csv]
 *
 * 数据落在 data/companies.json（平面文件，见 REQUIREMENTS 6.7）。
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { LlmService, loadConfig } from "@meso.ai/let-it-flow/runtime";
import { JsonCollection } from "../store/json-store.js";
import type { CompanyProspect, Province } from "../domain/types.js";
import { discoverCompanyProspects } from "./company-discovery.js";

const DATA_FILE = process.env.PROSPECTS_FILE ?? path.join(process.cwd(), "data", "companies.json");

export function openStore(file = DATA_FILE): JsonCollection<CompanyProspect> {
  // email 唯一 —— 去重在数据层兜底，不依赖调用方判重（FR-12.1）
  return new JsonCollection<CompanyProspect>(file).addUniqueKey("email", (p) => p.email.toLowerCase());
}

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      flags[token.slice(2)] = rest[i + 1] ?? "true";
      i++;
    } else {
      positional.push(token);
    }
  }
  return { cmd, positional, flags };
}

const now = () => new Date().toISOString();

/** 导入：抓取 → 按 email 去重合并。已存在则只更新 lastUpdated，保留原 importedAt。 */
export async function runImport(
  store: JsonCollection<CompanyProspect>,
  opts: { cities?: string[]; maxQueries?: number } = {},
): Promise<{ created: number; updated: number }> {
  const llm = new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig: loadConfig(),
  });

  const leads = await discoverCompanyProspects(llm, {
    ...(opts.cities ? { cities: opts.cities } : {}),
    ...(opts.maxQueries ? { maxQueries: opts.maxQueries } : {}),
    onProgress: (m) => console.log(`  ${m}`),
  });

  let created = 0;
  let updated = 0;
  for (const lead of leads) {
    const email = lead.email.toLowerCase();
    const existing = store.find((p) => p.email.toLowerCase() === email);
    if (existing) {
      await store.update(existing.id, { lastUpdated: now() });
      updated++;
    } else {
      await store.insert({
        id: `pr_${randomUUID().slice(0, 8)}`,
        name: lead.companyName,
        email,
        ...(lead.website ? { website: lead.website } : {}),
        ...(lead.phone ? { phone: lead.phone } : {}),
        ...(lead.city ? { city: lead.city } : {}),
        ...(lead.province ? { province: lead.province as Province } : {}),
        sourceType: "web_scrape",
        importedAt: now(),
        lastUpdated: now(),
        status: "prospect",
      });
      created++;
    }
  }
  return { created, updated };
}

export function toCsv(rows: readonly CompanyProspect[]): string {
  const cols = ["id", "name", "email", "website", "phone", "city", "province", "status", "importedAt"] as const;
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  const store = openStore();

  switch (cmd) {
    case "import": {
      console.log("⚠️  抓到的邮箱仅用于识别与匹配，不得用于冷邮件群发（CASL，见 FR-12）");
      const result = await runImport(store, {
        ...(flags["cities"] ? { cities: flags["cities"].split(",") } : {}),
        ...(flags["max"] ? { maxQueries: Number(flags["max"]) } : {}),
      });
      console.log(`完成：新增 ${result.created} 家，更新 ${result.updated} 家。共 ${store.all().length} 家。`);
      break;
    }
    case "list": {
      const rows = store.filter((p) =>
        (!flags["province"] || p.province === flags["province"]) &&
        (!flags["status"] || p.status === flags["status"]));
      for (const p of rows) {
        console.log(`${p.id}  ${p.status.padEnd(10)} ${p.name}  <${p.email}>  ${p.city ?? "-"}/${p.province ?? "-"}`);
      }
      console.log(`\n共 ${rows.length} 家（库内合计 ${store.all().length}）`);
      break;
    }
    case "add": {
      if (!flags["name"] || !flags["email"]) {
        console.error("需要 --name 与 --email");
        process.exitCode = 1;
        return;
      }
      const created = await store.insert({
        id: `pr_${randomUUID().slice(0, 8)}`,
        name: flags["name"], email: flags["email"].toLowerCase(),
        ...(flags["city"] ? { city: flags["city"] } : {}),
        ...(flags["province"] ? { province: flags["province"] as Province } : {}),
        sourceType: "manual", importedAt: now(), lastUpdated: now(), status: "prospect",
      });
      console.log(`已新增 ${created.id}`);
      break;
    }
    case "set": {
      const id = positional[0];
      if (!id) { console.error("需要 <id>"); process.exitCode = 1; return; }
      const patch: Partial<CompanyProspect> = { lastUpdated: now() };
      if (flags["status"]) patch.status = flags["status"] as CompanyProspect["status"];
      if (flags["notes"]) patch.notes = flags["notes"];
      if (flags["name"]) patch.name = flags["name"];
      await store.update(id, patch);
      console.log(`已更新 ${id}`);
      break;
    }
    case "archive": {
      const id = positional[0];
      if (!id) { console.error("需要 <id>"); process.exitCode = 1; return; }
      // 归档而非物理删除 —— CompanyMentionSignal 的回溯还要用它
      await store.update(id, { status: "archived", lastUpdated: now() });
      console.log(`已归档 ${id}（保留历史供信号回溯）`);
      break;
    }
    case "export": {
      const csv = toCsv(store.filter((p) => p.status !== "archived"));
      const out = flags["out"];
      if (out) {
        writeFileSync(out, csv, "utf-8");
        console.log(`已导出到 ${out}`);
      } else {
        console.log(csv);
      }
      break;
    }
    default:
      console.log(`用法：
  pnpm ops:prospects import [--cities A,B] [--max 6]   抓取并去重合并
  pnpm ops:prospects list [--province ON] [--status prospect]
  pnpm ops:prospects add --name "X" --email a@b.com [--city Toronto] [--province ON]
  pnpm ops:prospects set <id> --status contacted [--notes "..."]
  pnpm ops:prospects archive <id>
  pnpm ops:prospects export [--out prospects.csv]     供社媒受众定向使用

数据文件：${DATA_FILE}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
