/**
 * 端到端模拟 —— 三套厨房走完整链路，产出图纸与解释。
 *
 * 走的是**真实的 HTTP 端点**，不是直接调库函数：这样跑出来的东西就是客户
 * 实际会拿到的东西，中间任何一层接错了都会在这里暴露。
 *
 *   建会话 → 聊需求（多轮）→ 上传户型 → 补齐尺寸 → 拿选择题 → 答偏好
 *   → 出 generic 冷启动预估（含四视图）→ 出公司方案（含解释）→ 出报价
 *
 * 用法：npx tsx scripts/simulate.mts [输出目录]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

process.env.SMTP_HOST = "";
process.env.ADMIN_TOKEN = "sim";
process.env.SITE_PASSWORD_DISABLED = "true";

const OUT = process.argv[2] ?? "sim-out";
const CONSUMER = "ca_demo_consumer";
const TRADE = "ca_demo_trade";

// ── 三套厨房 ──────────────────────────────────────────────────────────────

interface WallSpec {
  label: string;
  length: number;
  features?: { kind: string; offset: number; width: number }[];
}

interface KitchenCase {
  id: string;
  name: string;
  shape: string;
  accountId: string;
  /** 模拟的多轮对话。 */
  turns: string[];
  ceilingHeight: number;
  walls: WallSpec[];
  /** 模拟的偏好选择。 */
  prefs: Record<string, unknown>;
  prefNote: string;
}

const KITCHENS: KitchenCase[] = [
  {
    id: "A",
    name: "多伦多公寓 · 一字型厨房",
    shape: "一字型（单面墙）",
    accountId: CONSUMER,
    turns: [
      "我在多伦多，想重做厨房的橱柜",
      "厨房不大，是那种一字型的，一整面墙，大概 12 尺",
      "喜欢简约一点的，白色系；预算不想太高",
      "水槽下面那面墙有个窗户，采光挺好的",
    ],
    ceilingHeight: 96,
    walls: [{
      label: "北墙",
      length: 144,
      features: [
        { kind: "window", offset: 54, width: 36 },
        { kind: "plumbing", offset: 60, width: 24 },
      ],
    }],
    prefs: {
      budgetBand: "economy",
      doorStyleId: "ds_shaker_white",
      storage: "doors",
      assembly: "RTA",
      tradeoff: "price",
    },
    prefNote: "控制成本优先 · Shaker White · 以门板柜为主 · 自己组装",
  },
  {
    id: "B",
    name: "密西沙加独立屋 · L 型厨房",
    shape: "L 型（两面墙成直角）",
    accountId: CONSUMER,
    turns: [
      "安大略省，独立屋，厨房要整体翻新",
      "是 L 型的，长边大概 13 尺，短边 8 尺多一点",
      "希望做多一点抽屉，锅具拿取方便；台面上想留出足够的备餐空间",
      "灶台放在长边，冰箱在短边靠门那头",
    ],
    ceilingHeight: 96,
    walls: [
      {
        label: "北墙",
        length: 156,
        features: [
          { kind: "window", offset: 66, width: 36 },
          { kind: "plumbing", offset: 72, width: 24 },
        ],
      },
      { label: "东墙", length: 102, features: [] },
    ],
    prefs: {
      budgetBand: "standard",
      doorStyleId: "ds_shaker_grey",
      storage: "drawers",
      assembly: "RTA",
      hardwareOptionIds: ["hw_softclose"],
      accessoryOptionIds: ["ac_rollout"],
      tradeoff: "quality",
    },
    prefNote: "中间档 · Shaker Grey · 尽量多做抽屉 · Soft-close + 抽拉层板",
  },
  {
    id: "C",
    name: "建商项目 · U 型厨房",
    shape: "U 型（三面墙）",
    accountId: TRADE,
    turns: [
      "我们是装修公司，手上一个改造项目",
      "U 型厨房，三面墙分别是 11 尺、9 尺、11 尺，层高 8 尺",
      "业主要求质感优先，门板选深色的；五金要 soft-close",
      "水槽放在中间那面墙的窗下，洗碗机紧挨着",
    ],
    ceilingHeight: 96,
    walls: [
      { label: "西墙", length: 132, features: [] },
      {
        label: "北墙",
        length: 108,
        features: [
          { kind: "window", offset: 36, width: 36 },
          { kind: "plumbing", offset: 42, width: 24 },
        ],
      },
      { label: "东墙", length: 132, features: [] },
    ],
    prefs: {
      budgetBand: "premium",
      doorStyleId: "ds_navy",
      storage: "balanced",
      assembly: "assembled",
      hardwareOptionIds: ["hw_softclose", "hw_handle_bar"],
      tradeoff: "lookAndFeel",
    },
    prefNote: "不设上限 · Navy Shaker（高档价格组）· 均衡 · 组装好发货",
  },
];

// ── 跑一遍 ────────────────────────────────────────────────────────────────

type Json = Record<string, any>;

async function main(): Promise<void> {
  const mod = await import("../src/server.js");
  const app = await mod.createApp({ ephemeral: true, llm: undefined });

  const call = async (p: string, init: RequestInit & { acct?: string } = {}): Promise<Json> => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (init.acct) headers.set("x-account-id", init.acct);
    const res = await app.fetch(new Request("http://sim" + p, { ...init, headers }));
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status >= 500) throw new Error(`${p} → ${res.status} ${JSON.stringify(body)}`);
    return { ...body, __status: res.status };
  };

  mkdirSync(OUT, { recursive: true });
  const results: Json[] = [];

  for (const k of KITCHENS) {
    console.log(`\n${"═".repeat(70)}\n${k.id}. ${k.name}（${k.shape}）\n${"═".repeat(70)}`);

    // 1. 建会话 + 多轮对话
    const { conversation } = await call("/api/conversations", { method: "POST", acct: k.accountId });
    const transcript: { role: string; text: string }[] = [];
    let lastQuestions: Json[] = [];

    for (const turn of k.turns) {
      const r = await call(`/api/conversations/${conversation.id}/messages`, {
        method: "POST", acct: k.accountId, body: JSON.stringify({ text: turn }),
      });
      transcript.push({ role: "user", text: turn });
      for (const reply of r.replies ?? []) transcript.push({ role: "assistant", text: reply.content });
      lastQuestions = r.questions ?? [];
      console.log(`  用户：${turn}`);
      console.log(`  助手：${(r.replies?.[0]?.content ?? "（无）").slice(0, 70)}`);
    }

    // 2. 上传户型 + 补齐尺寸（无视觉模型 → 手动逐项确认，FR-3 的降级路径）
    const fp = await call(`/api/conversations/${conversation.id}/floorplan`, {
      method: "POST", acct: k.accountId,
      body: JSON.stringify({ fileName: `kitchen-${k.id}.png`, mimeType: "image/png", sizeBytes: 204800 }),
    });
    const floorPlanId = fp.floorPlan.id;
    console.log(`  户型待确认项：${(fp.questions ?? []).length} 条（无视觉模型，降级为手动录入）`);

    for (const w of k.walls) {
      await call(`/api/floorplans/${floorPlanId}/resolve`, {
        method: "POST", acct: k.accountId,
        body: JSON.stringify({ addRun: { label: w.label, length: w.length } }),
      });
    }
    const resolved = await call(`/api/floorplans/${floorPlanId}/resolve`, {
      method: "POST", acct: k.accountId,
      body: JSON.stringify({ ceilingHeight: k.ceilingHeight }),
    });

    // 补充窗户/上下水位置。没有视觉模型时这一步必须由客户自己说，
    // 否则排布引擎不知道水槽该放哪（走的是真实端点，不是改内存对象）
    const runs = (await call(`/api/floorplans/${floorPlanId}`, { acct: k.accountId }))
      .floorPlan.parsedGeometry.wallRuns as Json[];
    for (const w of k.walls) {
      const run = runs.find((r) => r.label === w.label);
      if (!run) continue;
      for (const f of w.features ?? []) {
        const r = await call(`/api/floorplans/${floorPlanId}/resolve`, {
          method: "POST", acct: k.accountId,
          body: JSON.stringify({ addFeature: { wallRunId: run.id, ...f } }),
        });
        if (r.__status !== 200) console.log(`    ⚠ 加特征失败：${r.error}`);
      }
    }
    console.log(`  户型就绪：${resolved.ready}，${k.walls.length} 段墙，` +
      `${k.walls.reduce((n, w) => n + (w.features?.length ?? 0), 0)} 个特征（窗/上下水）`);

    // 3. 选择题 → 答偏好
    const qs = await call(
      `/api/conversations/${conversation.id}/questions?companyId=co_pilot`, { acct: k.accountId });
    console.log(`  本轮选择题 ${(qs.questions ?? []).length} 道：` +
      (qs.questions ?? []).map((q: Json) => q.key).join("、"));

    await call(`/api/conversations/${conversation.id}/preferences`, {
      method: "POST", acct: k.accountId,
      body: JSON.stringify({ companyId: "co_pilot", ...k.prefs }),
    });
    console.log(`  已记录偏好：${k.prefNote}`);

    // 4. generic 冷启动预估（含四视图）—— 没有选定公司时客户拿到的东西
    const est = await call(`/api/conversations/${conversation.id}/estimate`, {
      method: "POST", acct: k.accountId,
    });

    // 5. 公司方案（含解释）
    const layout = await call(`/api/floorplans/${floorPlanId}/layout`, {
      method: "POST", acct: k.accountId, body: JSON.stringify({ companyId: "co_pilot" }),
    });
    console.log(`  方案：${(layout.moduleCounts ?? []).map((m: Json) => `${m.moduleCode}×${m.qty}`).join(" ")}`);
    console.log(`  人体工程：${layout.acceptable ? "全部通过" : "未通过"}` +
      `　美观评分：${(layout.aesthetics ?? []).map((a: Json) => a.score.total).join("/")}`);
    for (const n of layout.unappliedPreferences ?? []) console.log(`  ⚠ ${n}`);

    // 6. 报价
    const quote = await call("/api/quotes", {
      method: "POST", acct: k.accountId,
      body: JSON.stringify({
        companyId: "co_pilot", conversationId: conversation.id, selections: layout.selections,
      }),
    });
    if (quote.__status === 201) {
      console.log(`  报价：${quote.formattedTotal}` +
        (quote.tradePricing ? `（${quote.tradePricing.reason?.slice(0, 24)}…）` : ""));
    } else {
      console.log(`  报价被拒（${quote.__status}）：${quote.error}`);
    }

    results.push({
      kitchen: k, conversation, transcript, questions: lastQuestions,
      offeredQuestions: qs.questions ?? [], estimate: est, layout, quote,
    });
  }

  // ── 产出 ──
  const html = renderHtml(results);
  writeFileSync(path.join(OUT, "designs.html"), html, "utf-8");

  const txt = renderText(results);
  writeFileSync(path.join(OUT, "explanations.txt"), txt, "utf-8");

  // 单独存 SVG，方便单张查看
  for (const r of results) {
    for (const run of r.layout.views ?? []) {
      for (const [key, svg] of Object.entries(run.views as Record<string, string>)) {
        writeFileSync(path.join(OUT, `${r.kitchen.id}-${run.runId}-${key}.svg`), svg, "utf-8");
      }
    }
  }

  console.log(`\n产出写入 ${OUT}/：designs.html、explanations.txt、以及各视图 SVG`);
}

// ── 呈现 ──────────────────────────────────────────────────────────────────

const VIEW_NAMES: Record<string, string> = {
  front: "正视图", topBase: "俯视图 · 地柜层", topWall: "俯视图 · 吊柜层", side: "侧视图",
};

function renderText(results: Json[]): string {
  const out: string[] = ["RTA-Hub 端到端模拟 —— 三套厨房的设计方案与解释", "=".repeat(72), ""];

  for (const r of results) {
    const k = r.kitchen;
    out.push("", "█".repeat(72), `${k.id}. ${k.name}`, `   ${k.shape}　层高 ${k.ceilingHeight}"`, "█".repeat(72), "");

    out.push("【模拟对话】");
    for (const t of r.transcript) {
      out.push(`  ${t.role === "user" ? "客户" : "助手"}：${t.text}`);
    }
    out.push("");

    out.push("【系统提出的选择题】（选项来自真实规格库，价格影响由代码算出）");
    for (const q of r.offeredQuestions) {
      out.push(`  ▸ ${q.prompt}`);
      out.push(`    （${q.why}）`);
      for (const o of q.options) {
        out.push(`     · ${o.label.padEnd(24)} → ${o.priceNote}${o.recommended ? "　[常见选择]" : ""}`);
      }
    }
    out.push("");
    out.push(`【客户的选择】${k.prefNote}`, "");

    out.push("【generic 冷启动预估】（还没选定公司时拿到的东西，FR-10）");
    if (r.estimate.estimate) {
      out.push(indent(r.estimate.text, 2));
      if (r.estimate.viewsDisclaimer) out.push(`  ⚠ ${r.estimate.viewsDisclaimer}`);
    }
    out.push("");

    out.push("【选定公司后的方案】Maple Ridge Cabinetry");
    out.push(`  型号：${(r.layout.moduleCounts ?? []).map((m: Json) => `${m.moduleCode}×${m.qty}`).join("  ")}`);
    out.push("");

    if (r.layout.explanation?.viewGuideText) {
      out.push(indent(r.layout.explanation.viewGuideText, 2), "");
    }
    for (const per of r.layout.explanation?.perRun ?? []) {
      out.push(`── ${per.runLabel} ${"─".repeat(Math.max(0, 60 - per.runLabel.length * 2))}`);
      out.push(indent(per.text, 2), "");
    }

    out.push(`【报价】${r.quote.formattedTotal ?? `被拒：${r.quote.error}`}`);
    if (r.quote.tradePricing && !r.quote.tradePricing.applied) {
      out.push(`  注：${r.quote.tradePricing.reason}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function renderHtml(results: Json[]): string {
  const sections = results.map((r) => {
    const k = r.kitchen;

    const chat = r.transcript.map((t: Json) =>
      `<div class="msg ${t.role}"><b>${t.role === "user" ? "客户" : "助手"}</b>${esc(t.text)}</div>`).join("");

    const questions = r.offeredQuestions.map((q: Json) => `
      <div class="qcard">
        <div class="qp">${esc(q.prompt)}</div>
        <div class="qw">${esc(q.why)}</div>
        <div class="opts">${q.options.map((o: Json) => `
          <div class="opt${o.recommended ? " rec" : ""}">
            <span class="ol">${esc(o.label)}</span>
            ${o.detail ? `<span class="od">${esc(o.detail)}</span>` : ""}
            <span class="op">${esc(o.priceNote)}</span>
          </div>`).join("")}</div>
      </div>`).join("");

    const genericViews = (r.estimate.views ?? []).map((run: Json) => `
      <div class="run">
        <h4>${esc(run.runLabel)}</h4>
        <div class="views">${Object.entries(run.views as Record<string, string>).map(([key, svg]) =>
          `<figure>${svg}<figcaption>${VIEW_NAMES[key] ?? key}</figcaption></figure>`).join("")}</div>
      </div>`).join("");

    const companyViews = (r.layout.views ?? []).map((run: Json) => {
      const per = (r.layout.explanation?.perRun ?? []).find((p: Json) => p.runId === run.runId);
      return `
      <div class="run">
        <h4>${esc(run.runLabel)}</h4>
        <div class="views">${Object.entries(run.views as Record<string, string>).map(([key, svg]) =>
          `<figure>${svg}<figcaption>${VIEW_NAMES[key] ?? key}</figcaption></figure>`).join("")}</div>
        ${per?.html ?? ""}
      </div>`;
    }).join("");

    const counts = (r.layout.moduleCounts ?? [])
      .map((m: Json) => `<code>${esc(m.moduleCode)}</code>×${m.qty}`).join("　");

    return `
    <section class="kitchen">
      <h2><span class="tag">${esc(k.id)}</span>${esc(k.name)}</h2>
      <p class="meta">${esc(k.shape)}　层高 ${k.ceilingHeight}"　${k.walls.length} 段墙　账号：${
        k.accountId === "ca_demo_trade" ? "建商（trade）" : "消费者"}</p>

      <h3>1 · 模拟对话</h3>
      <div class="chat">${chat}</div>

      <h3>2 · 系统提出的选择题</h3>
      <p class="note">选项来自公司真实规格库；价格影响由定价引擎从价格矩阵算出，不是模型生成的。</p>
      ${questions}
      <p class="picked">客户的选择：<b>${esc(k.prefNote)}</b></p>

      <h3>3 · generic 冷启动预估（尚未选定公司）</h3>
      <p class="note">${esc(r.estimate.viewsDisclaimer ?? "")}</p>
      <pre>${esc(r.estimate.text ?? "")}</pre>
      ${genericViews}

      <h3>4 · 选定公司后的方案与解释</h3>
      <p class="meta">Maple Ridge Cabinetry　${counts}</p>
      ${r.layout.explanation?.viewGuideHtml ?? ""}
      ${companyViews}

      <h3>5 · 报价</h3>
      <p class="quote">${esc(r.quote.formattedTotal ?? `被拒绝：${r.quote.error}`)}</p>
      ${r.quote.tradePricing && !r.quote.tradePricing.applied
        ? `<p class="note">${esc(r.quote.tradePricing.reason)}</p>` : ""}
    </section>`;
  }).join("");

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>RTA-Hub · 三套厨房的设计方案与解释</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#0f1216; color:#e6e8eb; line-height:1.6;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .wrap { max-width:1120px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  .lede { color:#8b94a3; font-size:13.5px; margin:0 0 28px; }
  .kitchen { border:1px solid #262b33; border-radius:14px; padding:22px; margin-bottom:28px; background:#141920; }
  h2 { font-size:18px; margin:0 0 4px; display:flex; align-items:center; gap:10px; }
  .tag { background:#2a5bd7; color:#fff; border-radius:8px; padding:1px 10px; font-size:14px; }
  h3 { font-size:14px; margin:24px 0 8px; color:#9aa4b2; border-bottom:1px solid #262b33; padding-bottom:5px; }
  h4 { font-size:13px; margin:16px 0 6px; }
  .meta, .note { color:#8b94a3; font-size:12.5px; margin:0 0 10px; }
  .chat { display:flex; flex-direction:column; gap:6px; margin-bottom:8px; }
  .msg { padding:7px 12px; border-radius:10px; font-size:13px; max-width:82%; }
  .msg b { display:block; font-size:10.5px; opacity:.65; font-weight:600; margin-bottom:1px; }
  .msg.user { background:#2a5bd7; color:#fff; align-self:flex-end; }
  .msg.assistant { background:#1c2129; align-self:flex-start; }
  .qcard { background:#1c2129; border:1px solid #3a4250; border-radius:10px; padding:12px; margin:8px 0; }
  .qp { font-size:13px; font-weight:600; }
  .qw { font-size:11.5px; color:#8b94a3; margin:3px 0 9px; }
  .opts { display:flex; flex-wrap:wrap; gap:7px; }
  .opt { background:#262b33; border:1px solid #3a4250; border-radius:9px; padding:7px 10px; font-size:12.5px; }
  .opt.rec { border-color:#4c9a5f; }
  .ol { display:block; font-weight:500; }
  .od { display:block; color:#8b94a3; font-size:11px; }
  .op { display:block; color:#7bc0d8; font-size:11px; margin-top:2px; }
  .picked { font-size:13px; background:#1e3566; border-radius:9px; padding:9px 12px; }
  pre { background:#0b0e12; border:1px solid #262b33; border-radius:9px; padding:12px;
        font-size:11.5px; overflow-x:auto; white-space:pre-wrap; color:#c6cdd6; }
  .run { border-top:1px solid #262b33; padding-top:10px; margin-top:14px; }
  .views { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:12px; }
  figure { margin:0; background:#fff; border-radius:9px; padding:8px; overflow:auto; }
  figure svg { max-width:100%; height:auto; display:block; }
  figcaption { color:#555; font-size:11px; text-align:center; padding-top:4px; }
  .quote { font-size:19px; font-weight:600; color:#7bd88f; margin:0; }
  .x-rationale h4, .x-guide h4 { font-size:12.5px; margin:12px 0 5px; color:#9aa4b2; }
  .x-guide h5 { font-size:12.5px; margin:10px 0 3px; }
  .x-rationale .x-head { font-size:13px; margin:0 0 4px; }
  .x-rationale ul, .x-guide ul { margin:0; padding-left:16px; }
  .x-rationale li, .x-guide li, .x-guide p { font-size:12.5px; line-height:1.65; margin:2px 0; }
  .x-rationale li { list-style:none; position:relative; padding-left:14px; margin-left:-16px; }
  .x-rationale li::before { position:absolute; left:0; }
  .x-fact { color:#8b94a3; } .x-fact::before { content:"·"; color:#6a7382; }
  .x-good { color:#c6cdd6; } .x-good::before { content:"✓"; color:#7bd88f; }
  .x-tradeoff { color:#c6cdd6; } .x-tradeoff::before { content:"△"; color:#d8c37b; }
  .x-warn { color:#e0b4b4; } .x-warn::before { content:"!"; color:#d87b7b; font-weight:700; }
  .x-guide p { color:#8b94a3; }
  .x-guide, .x-rationale { background:#1c2129; border:1px solid #3a4250;
                           border-radius:10px; padding:12px; margin:10px 0; }
</style></head><body><div class="wrap">
<h1>RTA-Hub · 三套厨房的设计方案与解释</h1>
<p class="lede">全部由 <code>scripts/simulate.mts</code> 走真实 HTTP 端点生成：
建会话 → 多轮对话 → 上传户型 → 补齐尺寸 → 回答选择题 → 冷启动预估 → 公司方案 → 报价。
未配置 LLM，所以对话走的是确定性引导问答；视图、解释、价格全部由代码计算。</p>
${sections}
</div></body></html>`;
}

await main();
