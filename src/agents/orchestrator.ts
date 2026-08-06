/**
 * 总控助手 + 公司 Agent —— FR-1、REQUIREMENTS 3.1。
 *
 * 工程上是**一套 prompt 模板按 companyId 参数化**，不是每家公司一个实例（§3.4）。
 *
 * 三条硬约束体现在代码里：
 *   1. 路由已经在 routing/mention.ts 里确定性完成，Agent 只负责「说什么」，
 *      不负责判断「这是哪家公司」；
 *   2. 公司 Agent 的上下文只注入该公司 published 规格，别家数据在物理上就到不了；
 *   3. Agent 产出的设计意图必须过 `stripPriceFields`——模型给的任何金额都被丢弃。
 */
import type { SpecBundle } from "../spec/bundle.js";
import { stripPriceFields } from "../spec/validation.js";
import type { AgentContext, AgentReply, CompletionClient, DesignIntent } from "./types.js";

const ORCHESTRATOR_SYSTEM = [
  "你是加拿大厨房橱柜平台的总控助手，帮客户理清装修需求。",
  "每轮只问 1-2 个最关键的缺失信息，不要一次列一堆问题。需要收集：",
  "厨房尺寸与布局、风格、材质倾向、预算范围、期望工期、所在省份（省份必填，用于计算税费）。",
  "",
  "边界：",
  "- 你只掌握通用橱柜知识。**不要报出任何具体公司的价格或型号**。",
  "- 客户想问某家公司的具体产品时，提示他用 @公司名 点名，由那家公司的助手来答。",
  "- 需要给价格感觉时，只能说「行业典型区间」，且必须说明这不是任何公司的真实报价。",
].join("\n");

/** 贸易账号的交互更直给——建商懂行业术语，不需要新手引导（FR-11）。 */
const TRADE_ADDENDUM = [
  "",
  "本次对话的客户是专业建商/装修公司账号：",
  "- 可以直接使用行业术语（SKU、价格组、door style、RTA/assembled 等），不必解释基础概念。",
  "- 跳过新手引导式提问，一次可以问多个字段。",
].join("\n");

export interface OrchestratorOptions {
  accountType: "consumer" | "trade";
}

/**
 * 总控助手回复。
 *
 * 无 LLM 客户端时退化为**确定性的引导问答**——这不是降级凑数，
 * 而是保证核心链路（报价、闸门、计费）在没有 API key 的环境里也能端到端跑通。
 */
export async function orchestratorReply(
  client: CompletionClient | undefined,
  ctx: AgentContext,
  userText: string,
  opts: OrchestratorOptions,
): Promise<AgentReply> {
  const requirements = mergeRequirements(ctx.requirements, userText);

  if (!client) {
    return { content: fallbackPrompt(requirements, opts.accountType), requirements };
  }

  const system = ORCHESTRATOR_SYSTEM + (opts.accountType === "trade" ? TRADE_ADDENDUM : "");
  const content = await client.complete({
    system,
    messages: [...ctx.history, { role: "user", content: userText }],
    temperature: 0.3,
  });
  return { content: content.trim() || fallbackPrompt(requirements, opts.accountType), requirements };
}

/** 还缺哪些关键字段——同时用于兜底话术与前端进度提示。 */
export function missingFields(requirements: string): string[] {
  const text = requirements.toLowerCase();
  const checks: [string, RegExp][] = [
    ["厨房尺寸", /(\d+\s*(尺|米|m|ft|英尺|feet|inch|寸))|尺寸|面积|平米|平方/],
    ["布局", /布局|l\s*型|u\s*型|一字|岛台|island|galley/],
    ["风格", /风格|现代|传统|简约|shaker|modern|classic|欧式|美式/],
    ["预算", /预算|budget|万|\$|加币|cad/],
    ["所在省份", /\b(on|bc|ab|qc|mb|sk|ns|nb|nl|pe|yt|nt|nu)\b|安大略|不列颠|阿尔伯塔|魁北克|曼尼托巴|萨斯|新斯科舍|多伦多|温哥华|卡尔加里|蒙特利尔|渥太华/],
  ];
  return checks.filter(([, re]) => !re.test(text)).map(([name]) => name);
}

function fallbackPrompt(requirements: string, accountType: "consumer" | "trade"): string {
  const missing = missingFields(requirements);
  if (missing.length === 0) {
    return "需求信息已经比较完整了。你可以 @ 某家公司问具体产品，或者直接让我出一版方案与报价。";
  }
  if (accountType === "trade") {
    return `还需要：${missing.join("、")}。一次给全就行。`;
  }
  const ask = missing.slice(0, 2);
  return `了解了。还想确认${ask.length > 1 ? "两件事" : "一件事"}：${ask.join("；")}？`;
}

/** 需求摘要的累积——不覆盖已有内容（旧实现的 `??` 会被空串清空）。 */
export function mergeRequirements(previous: string, addition: string): string {
  const add = addition.trim();
  if (!add) return previous;
  if (!previous) return add;
  if (previous.includes(add)) return previous;
  return `${previous}\n${add}`;
}

// ── 公司 Agent ────────────────────────────────────────────────────────────

/**
 * 构造公司 Agent 的 system prompt。
 *
 * 规格清单直接注入——这是"知识边界"的物理实现：上下文里没有别家公司的数据，
 * 模型想借用也无从借起。
 */
export function buildCompanyAgentSystem(companyName: string, bundle: SpecBundle): string {
  const modules = bundle.modules
    .map((m) => `${m.code}(${m.type} 宽:${m.widthOptions.join("/")} 高:${m.heightOptions.join("/")} 深:${m.depthOptions.join("/")})`)
    .join("、");
  const doors = bundle.doorStyles.map((d) => d.name).join("、");
  const hardware = bundle.hardwareOptions.map((h) => h.name).join("、");
  const accessories = bundle.accessoryOptions.map((a) => a.name).join("、");

  return [
    `你是「${companyName}」的产品助手。只能基于下面这份本公司规格库回答问题。`,
    "",
    `可供型号：${modules || "（无）"}`,
    `门板样式：${doors || "（无）"}`,
    `五金选项：${hardware || "（无）"}`,
    `配件选项：${accessories || "（无）"}`,
    "",
    "硬性规则：",
    "1. 只回答上面列出的型号与选项。列表里没有的，直接说本公司不提供，**不要编，也不要提别家公司**。",
    "2. 尺寸只能取型号对应的候选值，不要给「接近的尺寸」。",
    "3. **绝对不要报价格。** 价格由系统按规格库计算，你说的任何金额都会被丢弃。",
    "4. 不确定就说不确定，让客户联系公司确认。",
  ].join("\n");
}

export async function companyAgentReply(
  client: CompletionClient | undefined,
  companyName: string,
  bundle: SpecBundle,
  ctx: AgentContext,
  userText: string,
): Promise<AgentReply> {
  if (!client) {
    return { content: deterministicSpecAnswer(companyName, bundle, userText), companyId: bundle.companyId };
  }
  const content = await client.complete({
    system: buildCompanyAgentSystem(companyName, bundle),
    messages: [...ctx.history, { role: "user", content: userText }],
    temperature: 0.2,
  });
  return {
    content: content.trim() || deterministicSpecAnswer(companyName, bundle, userText),
    companyId: bundle.companyId,
  };
}

/**
 * 无 LLM 时的确定性规格问答：从问题里抽出型号码/尺寸，直接查规格库。
 * 查不到就明确说没有——与有 LLM 时的边界规则一致。
 */
export function deterministicSpecAnswer(companyName: string, bundle: SpecBundle, question: string): string {
  const q = question.toUpperCase();
  const hits = bundle.modules.filter((m) => q.includes(m.code));
  if (hits.length > 0) {
    return hits.map((m) =>
      `${companyName} 的 ${m.code}：${m.type}，宽 ${m.widthOptions.join("/")}"，` +
      `高 ${m.heightOptions.join("/")}"，深 ${m.depthOptions.join("/")}"，` +
      `可选 ${m.assemblyOptions.join(" / ")}。`,
    ).join("\n");
  }

  // 尺寸类提问：「有 36 寸的转角柜吗」
  const size = /(\d+(?:\.\d+)?)\s*(?:寸|英寸|"|inch)/i.exec(question);
  if (size) {
    const w = Number(size[1]);
    const matching = bundle.modules.filter((m) => m.widthOptions.includes(w));
    return matching.length
      ? `${companyName} 有 ${w}" 宽的型号：${matching.map((m) => m.code).join("、")}。`
      : `${companyName} 目前没有 ${w}" 宽的型号。可选宽度是 ${
          [...new Set(bundle.modules.flatMap((m) => m.widthOptions))].sort((a, b) => a - b).join("、")
        }"。`;
  }

  return `${companyName} 目前可供的型号有：${bundle.modules.map((m) => m.code).join("、")}。` +
    `门板样式：${bundle.doorStyles.map((d) => d.name).join("、")}。具体想问哪一个？`;
}

// ── 设计意图 ──────────────────────────────────────────────────────────────

const DESIGN_SCHEMA_HINT = `{
  "selections": [
    { "moduleId": "型号 id", "qty": 数量, "width": 数字, "height": 数字, "depth": 数字,
      "assembly": "RTA" | "assembled",
      "hardwareOptionIds": ["..."], "accessoryOptionIds": ["..."] }
  ],
  "doorStyleId": "门板 id",
  "notes": "一句话说明这版方案的思路"
}`;

/**
 * 让公司 Agent 产出设计意图。
 *
 * **返回值一定过 `stripPriceFields`**——即使模型在 selections 里塞了 unitPrice、
 * total 之类的字段，也到不了下游。这是 FR-8 第 1 条的执行点之一。
 */
export async function proposeDesign(
  client: CompletionClient | undefined,
  companyName: string,
  bundle: SpecBundle,
  requirements: string,
): Promise<DesignIntent> {
  if (!client?.completeJson) {
    return { selections: [], doorStyleId: bundle.doorStyles[0]?.id, notes: "未接入 LLM，需人工或布局算法生成方案" };
  }

  const raw = await client.completeJson<{ selections?: unknown; doorStyleId?: unknown; notes?: unknown }>({
    system: buildCompanyAgentSystem(companyName, bundle) +
      "\n\n现在请基于客户需求，从本公司规格库里选出一组柜体。" +
      "\n**只输出选择，不要输出任何价格字段**——写了也会被系统丢弃。",
    messages: [{ role: "user", content: `客户需求：\n${requirements}` }],
    schemaHint: DESIGN_SCHEMA_HINT,
    temperature: 0.2,
  });

  if (!raw) {
    return { selections: [], doorStyleId: bundle.doorStyles[0]?.id, notes: "模型未能产出合法方案" };
  }

  // ★ 价格字段在这里被丢弃
  const { selections } = stripPriceFields(raw.selections);
  const doorStyleId = typeof raw.doorStyleId === "string" && bundle.doorStyles.some((d) => d.id === raw.doorStyleId)
    ? raw.doorStyleId
    : bundle.doorStyles[0]?.id;

  return {
    selections,
    ...(doorStyleId ? { doorStyleId } : {}),
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}
