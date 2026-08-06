/**
 * 公司发现（运营工具）—— docs/COMPANY_DISCOVERY.md、REQUIREMENTS FR-12。
 *
 * ⚠️ **定位已变更**：这个模块不再是「消费者群发询价」的数据源。
 * 抓来的邮箱**只用于识别与匹配**，不是可投递的营销名单——向抓取来的地址发冷邮件
 * 违反 CASL。合法获客路径是「社媒广告 → 企业主动注册邮件列表」（FR-12）。
 *
 * 现有用途：
 *   1. 社媒广告的受众定向与地域投放决策；
 *   2. CompanyMentionSignal 的回溯匹配数据源（FR-12.3）；
 *   3. 市场情报（玩家数量、地域分布、覆盖缺口）。
 *
 * 由管理员在后台**手动触发**，非定时自动跑。
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import {
  createTavilyProvider,
  createNativeProvider,
  type LlmService,
  type SearchProvider,
  type SearchResult,
} from "@meso.ai/let-it-flow/runtime";
import { extractHtml } from "./html-extract.js";
import type { Lead } from "../types.js";

const DEFAULT_CITIES = [
  "Toronto",
  "Vancouver",
  "Calgary",
  "Ottawa",
  "Montreal",
  "Edmonton",
  "Mississauga",
  "Winnipeg",
];

const MAX_RESULTS_PER_QUERY = 8;
const MAX_FETCH_BYTES = 800_000;
const FETCH_TIMEOUT_MS = 15_000;

/** 生成检索查询词变体：通用词 + 逐城市细化，覆盖英语（+ 魁北克法语）。 */
export function buildSearchQueries(cities: string[] = DEFAULT_CITIES): string[] {
  const queries = [
    "custom kitchen cabinets Canada request a quote contact email",
    "kitchen cabinet manufacturer Canada RFQ contact us email",
    "armoires de cuisine sur mesure devis Québec courriel contact",
  ];
  for (const city of cities) {
    queries.push(`kitchen cabinets quote ${city} Canada contact email`);
  }
  return queries;
}

function resolveSearchProvider(): SearchProvider {
  const apiKey = process.env.TAVILY_API_KEY;
  return apiKey ? createTavilyProvider(apiKey) : createNativeProvider();
}

/** mailto: 链接正则抽取（原始 HTML，抓取正文前）——比 LLM 抽取更可靠。 */
function extractMailtoEmails(html: string): string[] {
  const out = new Set<string>();
  const re = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.add((m[1] ?? "").toLowerCase());
  }
  return [...out];
}

const JUNK_EMAIL_PATTERNS = [
  /^(no-?reply|donotreply|noreply)@/i,
  /^(webmaster|postmaster|abuse|privacy|unsubscribe)@/i,
  /@(sentry\.io|wixpress\.com|godaddy\.com|example\.com|schema\.org)$/i,
];

function isJunkEmail(email: string): boolean {
  return JUNK_EMAIL_PATTERNS.some((re) => re.test(email));
}

interface FetchedPage {
  url: string;
  title: string;
  content: string;
  mailtoEmails: string[];
  error?: string;
}

/**
 * SSRF 防护：拒绝非 http(s)、以及指向内网/环回/链路本地地址的 URL。
 *
 * 当前入口只吃搜索结果，风险中等；但一旦这个函数被用户可控的 URL 调用就是漏洞，
 * 所以护栏放在函数本身而不是调用点。
 */
export function blockedUrlReason(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "URL 无法解析";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `不支持的协议 ${u.protocol}`;

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return "指向本机或内网域名";
  }
  // IPv4 私网/环回/链路本地/元数据地址
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||        // 含云元数据 169.254.169.254
        (a === 100 && b >= 64 && b <= 127) // CGNAT
    ) {
      return `指向私网地址 ${host}`;
    }
  }
  // IPv6 环回与唯一本地地址
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return `指向私网地址 ${host}`;
  }
  return undefined;
}

/** 流式读取响应体，累计超过 maxBytes 即中断，避免大响应打满内存。 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.length) break;
    const slice = chunk.subarray(0, merged.length - offset);
    merged.set(slice, offset);
    offset += slice.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

async function fetchPage(url: string): Promise<FetchedPage> {
  const blocked = blockedUrlReason(url);
  if (blocked) return { url, title: url, content: "", mailtoEmails: [], error: blocked };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; let-it-flow-cabinet-scraper/0.1)" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { url, title: url, content: "", mailtoEmails: [], error: `HTTP ${res.status}` };
    const ctype = res.headers.get("content-type") ?? "";
    // 流式读取并在超限时提前中断——旧实现先 await res.arrayBuffer() 再切片，
    // 上限完全没起作用，整个响应体已经进内存了。
    const raw = await readCapped(res, MAX_FETCH_BYTES);
    if (!ctype.includes("text/html")) return { url, title: url, content: raw, mailtoEmails: [] };
    const { title, content } = extractHtml(raw);
    const mailtoEmails = extractMailtoEmails(raw).filter((e) => !isJunkEmail(e));
    return { url, title: title || url, content, mailtoEmails };
  } catch (e) {
    return { url, title: url, content: "", mailtoEmails: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const ExtractedLeadSchema = z.object({
  companyName: z.string().min(1),
  contactName: z.string().optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
});
const ExtractionResultSchema = z.object({ leads: z.array(ExtractedLeadSchema).max(5) });

async function extractLeadsFromPage(
  page: FetchedPage,
  llm: LlmService,
): Promise<Omit<Lead, "id" | "sourceUrl" | "foundAt">[]> {
  if (!page.content && page.mailtoEmails.length === 0) return [];

  const model = llm.model("summarizer");
  const foldSystem = llm.compatMode;
  const system = [
    "你是一个 B2B 线索抽取器。从网页正文中识别「加拿大橱柜（kitchen cabinet）供应商/制造商/经销商」的公司信息。",
    "只抽取该公司自己的业务联系邮箱（销售/报价/客服），不要抽取第三方、隐私政策、社媒插件等无关邮箱。",
    "如果页面明显不是橱柜/厨柜相关企业，返回空数组。",
    "email 字段必须是合法邮箱格式；找不到邮箱的候选公司不要输出。",
  ].join("\n");
  const mailtoHint = page.mailtoEmails.length
    ? `\n\n页面中已提取到的 mailto 邮箱（优先使用，若能匹配到公司信息）：${page.mailtoEmails.join(", ")}`
    : "";
  const user = `网页标题：${page.title}\n网页 URL：${page.url}${mailtoHint}\n\n正文（截断）：\n${page.content.slice(0, 6000)}`;

  const callArgs = foldSystem
    ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${user}` }] }
    : { system, messages: [{ role: "user" as const, content: user }] };

  try {
    const { output } = await generateText({
      model,
      ...callArgs,
      output: Output.object({ schema: ExtractionResultSchema }),
      temperature: 0,
    });
    if (!output) return [];
    return output.leads
      .filter((l) => !isJunkEmail(l.email))
      .map((l) => ({ ...l, website: new URL(page.url).origin }));
  } catch {
    // LLM 抽取失败时，退化为仅用 mailto 正则结果（无法得知公司名，跳过——宁可漏抓不误报）。
    return [];
  }
}

export interface DiscoveryOptions {
  cities?: string[];
  maxQueries?: number;
  onProgress?: (message: string) => void;
}

/** 完整管线：检索 → 去重 URL → 抓取 → LLM 抽取 → 按邮箱去重。 */
export async function discoverCompanyProspects(
  llm: LlmService,
  opts: DiscoveryOptions = {},
): Promise<Lead[]> {
  const provider = resolveSearchProvider();
  const queries = buildSearchQueries(opts.cities).slice(0, opts.maxQueries ?? 6);
  const notify = opts.onProgress ?? (() => {});

  const seenUrls = new Set<string>();
  const results: SearchResult[] = [];
  for (const q of queries) {
    notify(`检索：${q}`);
    try {
      const r = await provider.search(q, { maxResults: MAX_RESULTS_PER_QUERY });
      for (const item of r) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          results.push(item);
        }
      }
    } catch (e) {
      notify(`检索失败（${q}）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  notify(`共 ${results.length} 个候选网页，开始抓取…`);
  const leadsByEmail = new Map<string, Lead>();
  let idx = 0;
  for (const r of results) {
    idx++;
    notify(`抓取 [${idx}/${results.length}] ${r.url}`);
    const page = await fetchPage(r.url);
    if (page.error) continue;
    const extracted = await extractLeadsFromPage(page, llm);
    for (const lead of extracted) {
      const key = lead.email.toLowerCase();
      if (leadsByEmail.has(key)) continue;
      leadsByEmail.set(key, {
        id: `lead_${key.replace(/[^a-z0-9]/g, "_")}`,
        sourceUrl: r.url,
        foundAt: new Date().toISOString(),
        ...lead,
      });
    }
  }

  notify(`抽取完成：共 ${leadsByEmail.size} 条线索（去重后）。`);
  return [...leadsByEmail.values()];
}
