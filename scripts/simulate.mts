/**
 * 端到端模拟 —— 场景由 LLM 动态生成，走真实 HTTP 端点跑完整链路。
 *
 * 走的是**真实的 HTTP 端点**，不是直接调库函数：跑出来的东西就是客户实际会
 * 拿到的东西，中间任何一层接错了都会在这里暴露。
 *
 * 场景**不是写死的剧本**（`scripts/scenarios.mts`）——手写场景只覆盖我想得到
 * 的情况，而真实客户会给出我没想到的尺寸、说我没预料到的话。没有 LLM 时回退
 * 到按维度组合展开的确定性生成器，并在输出里如实标注。
 *
 * 完整链路：
 *   建会话 → 多轮对话 → 上传户型 → 补齐尺寸与窗/上下水 → 回答选择题
 *   → **问客户要不要出图** → 全局俯视图（多轮改）→ 认可排布
 *   → 完整四视图 + 解释 → 报价清单（分组分类）
 *
 * 用法：npx tsx scripts/simulate.mts [输出目录] [场景数]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateScenarios, type Scenario, type ScenarioSet } from "./scenarios.mts";

process.env.SMTP_HOST = "";
process.env.ADMIN_TOKEN = "sim";
process.env.SITE_PASSWORD_DISABLED = "true";

const OUT = process.argv[2] ?? "sim-out";
const COUNT = Number(process.argv[3] ?? 4);
const ACCOUNTS = { consumer: "ca_demo_consumer", trade: "ca_demo_trade" } as const;

// ── 跑一遍 ────────────────────────────────────────────────────────────────

type Json = Record<string, any>;

async function main(): Promise<void> {
  const mod = await import("../src/server.js");
  const ctxMod = await import("../src/app/context.js");
  const app = await mod.createApp({ ephemeral: true });
  // 场景生成用同一个 LLM 客户端（没配 key 时为 undefined → 走确定性回退）
  const appCtx = { llm: (await ctxMod.createAppContext({ ephemeral: true })).llm };

  const call = async (p: string, init: RequestInit & { acct?: string } = {}): Promise<Json> => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (init.acct) headers.set("x-account-id", init.acct);
    const res = await app.fetch(new Request("http://sim" + p, { ...init, headers }));
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok && res.status >= 500) throw new Error(`${p} → ${res.status} ${JSON.stringify(body)}`);
    return { ...body, __status: res.status };
  };

  mkdirSync(OUT, { recursive: true });
  const results: Json[] = [];
  /** 冒烟断言的失败项。非空时进程以非 0 退出，CI 才拦得住。 */
  const failures: string[] = [];

  // 场景由 LLM 生成（没有 key 时回退到确定性生成器，并如实标注）
  const bundle = await call("/api/companies/co_pilot/spec");
  const scenarioSet: ScenarioSet = await generateScenarios({
    client: appCtx?.llm,
    count: COUNT,
    doorStyleIds: (bundle.doorStyles ?? []).map((d: Json) => d.id),
    hardwareIds: (bundle.hardwareOptions ?? []).map((h: Json) => h.id),
    accessoryIds: (bundle.accessoryOptions ?? []).map((a: Json) => a.id),
  });
  console.log(`\n场景来源：${scenarioSet.source}　${scenarioSet.note}\n`);

  for (const k of scenarioSet.scenarios) {
    const acct = ACCOUNTS[k.accountType];
    console.log(`\n${"═".repeat(72)}\n${k.id}. ${k.name}（${k.shape}）` +
      `\n   覆盖：${k.covers}\n${"═".repeat(72)}`);

    // 1. 建会话 + 多轮对话
    const { conversation } = await call("/api/conversations", { method: "POST", acct });
    const transcript: { role: string; text: string }[] = [];
    let lastQuestions: Json[] = [];

    for (const turn of k.turns) {
      const r = await call(`/api/conversations/${conversation.id}/messages`, {
        method: "POST", acct, body: JSON.stringify({ text: turn }),
      });
      transcript.push({ role: "user", text: turn });
      for (const reply of r.replies ?? []) transcript.push({ role: "assistant", text: reply.content });
      lastQuestions = r.questions ?? [];
      console.log(`  客户：${turn}`);
      console.log(`  助手：${(r.replies?.[0]?.content ?? "（无）").slice(0, 76)}`);
    }

    // 2. 上传户型 + 补齐尺寸与特征
    const fp = await call(`/api/conversations/${conversation.id}/floorplan`, {
      method: "POST", acct,
      body: JSON.stringify({ fileName: `kitchen-${k.id}.png`, mimeType: "image/png", sizeBytes: 204800 }),
    });
    const floorPlanId = fp.floorPlan.id;

    for (const w of k.walls) {
      await call(`/api/floorplans/${floorPlanId}/resolve`, {
        method: "POST", acct, body: JSON.stringify({ addRun: { label: w.label, length: w.length } }),
      });
    }
    await call(`/api/floorplans/${floorPlanId}/resolve`, {
      method: "POST", acct, body: JSON.stringify({ ceilingHeight: k.ceilingHeight }),
    });

    const runs = (await call(`/api/floorplans/${floorPlanId}`, { acct }))
      .floorPlan.parsedGeometry.wallRuns as Json[];
    let featureCount = 0;
    for (const w of k.walls) {
      const run = runs.find((r) => r.label === w.label);
      if (!run) continue;
      for (const f of w.features) {
        const r = await call(`/api/floorplans/${floorPlanId}/resolve`, {
          method: "POST", acct, body: JSON.stringify({ addFeature: { wallRunId: run.id, ...f } }),
        });
        if (r.__status === 200) featureCount++;
        else console.log(`    ⚠ 加特征失败：${r.error}`);
      }
    }
    console.log(`  户型：${k.walls.length} 段墙，${featureCount} 个特征，层高 ${k.ceilingHeight}"`);

    // 3. 选择题 → 答偏好
    const qs = await call(
      `/api/conversations/${conversation.id}/questions?companyId=co_pilot`, { acct });
    await call(`/api/conversations/${conversation.id}/preferences`, {
      method: "POST", acct, body: JSON.stringify({ companyId: "co_pilot", ...k.prefs }),
    });
    console.log(`  选择题 ${(qs.questions ?? []).length} 道　偏好已记录`);

    // 4. **先问再画**：拿到「需要我帮你生成设计图吗？」
    const askDesign = await call(
      `/api/conversations/${conversation.id}/design?companyId=co_pilot`, { acct });
    console.log(`  阶段 ${askDesign.session?.stage}：${(askDesign.prompt?.message ?? "").split("\n")[0]}`);
    transcript.push({ role: "assistant", text: askDesign.prompt?.message ?? "" });

    // 5. 客户点头 → 全局俯视图（多轮改）
    await call(`/api/conversations/${conversation.id}/design/advance`, {
      method: "POST", acct, body: JSON.stringify({ companyId: "co_pilot", action: "consent" }),
    });
    transcript.push({ role: "user", text: "好，出图看看" });

    // 每一版都记下型号构成，用来验证「客户提的改动真的改到了图上」——
    // 光看接口返回 200 说明不了任何事，同一张图返回一百次也全是 200
    let planView: Json = {};
    const planRounds: { label: string; mix: string; applied: string[]; unapplied?: string }[] = [];
    const mixOf = (v: Json) =>
      (v.moduleCounts ?? []).map((m: Json) => `${m.moduleCode}×${m.qty}`).join(" ");

    for (let round = 0; round <= k.revisions.length; round++) {
      planView = await call(`/api/floorplans/${floorPlanId}/plan-view`, {
        method: "POST", acct, body: JSON.stringify({ companyId: "co_pilot" }),
      });
      if (planView.__status !== 201) { console.log(`    ⚠ 出俯视图失败：${planView.error}`); break; }
      const mix = mixOf(planView);
      const prev = planRounds[planRounds.length - 1];
      planRounds.push({
        label: `第 ${round + 1} 版`, mix,
        applied: planView.revision?.applied ?? [],
        ...(planView.revision?.unapplied ? { unapplied: planView.revision.unapplied } : {}),
      });
      console.log(`  全局俯视图 第 ${round + 1} 版：${mix}` +
        (prev ? (prev.mix === mix ? "　（与上一版相同）" : "　← 排布已变") : ""));
      transcript.push({ role: "assistant", text: `全局俯视图 第 ${round + 1} 版：${mix}` });

      const rev = k.revisions[round];
      if (!rev) break;
      const adv = await call(`/api/conversations/${conversation.id}/design/advance`, {
        method: "POST", acct,
        body: JSON.stringify({
          companyId: "co_pilot", action: "revise", note: rev.note, changes: rev.changes,
        }),
      });
      transcript.push({ role: "user", text: rev.note });
      const applied: string[] = adv.revision?.applied ?? [];
      const line = applied.length
        ? `好的，这就按「${applied.join("、")}」重排一版。`
        : (adv.revision?.unapplied ?? "这条我暂时改不到排布上。");
      transcript.push({ role: "assistant", text: line });
      console.log(`  客户：${rev.note}\n  助手：${line}`);
    }

    // 6. 认可排布 → 完整四视图
    await call(`/api/conversations/${conversation.id}/design/advance`, {
      method: "POST", acct, body: JSON.stringify({ companyId: "co_pilot", action: "approvePlan" }),
    });
    transcript.push({ role: "user", text: "排布可以了，出完整图纸" });

    const layout = await call(`/api/floorplans/${floorPlanId}/layout`, {
      method: "POST", acct, body: JSON.stringify({ companyId: "co_pilot" }),
    });
    console.log(`  完整四视图：人体工程${layout.acceptable ? "全过" : "未过"}　` +
      `美观 ${(layout.aesthetics ?? []).map((a: Json) => a.score.total).join("/")}`);
    for (const n of layout.bomMissing ?? []) console.log(`    ⚠ 缺辅料型号：${n}`);
    for (const n of layout.unappliedPreferences ?? []) console.log(`    ⚠ ${n}`);

    // 7. 报价 + 清单
    const quote = await call("/api/quotes", {
      method: "POST", acct,
      body: JSON.stringify({
        companyId: "co_pilot", conversationId: conversation.id, selections: layout.selections,
      }),
    });
    if (quote.__status === 201) {
      const sums = (quote.quoteList?.subtotals ?? [])
        .map((x: Json) => `${x.label} ${x.includedIn ? "含在柜体价内" : fmtMoney(x.amount)}`).join("　");
      console.log(`  报价 ${quote.formattedTotal}　${sums}`);
      if (quote.quoteList?.reconciliationDelta) {
        console.log(`    ⚠ 清单与小计差 ${fmtMoney(quote.quoteList.reconciliationDelta)}`);
      }
    } else {
      console.log(`  报价被拒（${quote.__status}）：${quote.error}` +
        (quote.issues ? ` ${JSON.stringify(quote.issues)}` : ""));
    }

    // ── 冒烟断言 ──
    //
    // 跑完不报错 ≠ 跑对了。上面每一步都可能"成功地"产出错东西：阶段没推进、
    // 报价缺了填缝条、客户提的改动没落下去。这些在 CI 里必须让构建变红，
    // 否则这个脚本只是个会打印漂亮文字的程序。
    const fail = (msg: string) => { failures.push(`${k.id}. ${k.name}：${msg}`); };

    if (askDesign.session?.stage !== "readyToDraw") {
      fail(`资料齐了却停在 ${askDesign.session?.stage}，没走到「先问再画」`);
    }
    if (!(askDesign.prompt?.message ?? "").includes("需要我帮你生成设计图吗")) {
      fail("出图前没有征询客户意见");
    }
    if (planRounds.length !== k.revisions.length + 1) {
      fail(`应出 ${k.revisions.length + 1} 版俯视图，实际 ${planRounds.length} 版`);
    }
    // 客户提了能落下去的改动，图就必须真的变
    for (const [i, rev] of k.revisions.entries()) {
      const before = planRounds[i];
      const after = planRounds[i + 1];
      if (!before || !after) continue;
      const meaningful = Object.keys(rev.changes).length > 0;
      if (meaningful && after.applied.length === 0) {
        fail(`第 ${i + 1} 轮修改「${rev.note}」没有落到任何偏好项上`);
      }
      if (!meaningful && before.mix !== after.mix) {
        fail(`第 ${i + 1} 轮没有任何改动，排布却变了——说明结果不稳定`);
      }
    }
    if (layout.__status !== 201 && layout.__status !== 200) {
      fail(`四视图未能生成：${layout.error}`);
    }
    if ((layout.bomMissing ?? []).length > 0) {
      fail(`物料清单缺型号：${(layout.bomMissing ?? []).join("、")}`);
    }
    if (!layout.acceptable) {
      fail(`方案未通过人体工程检查：${(layout.ergonomics ?? [])
        .filter((v: Json) => v.severity === "blocking").map((v: Json) => v.code).join("、")}`);
    } else if (quote.__status !== 201) {
      fail(`合格方案却报不出价（${quote.__status}）：${quote.error}`);
    } else {
      if (quote.quoteList?.reconciliationDelta) {
        fail(`报价清单逐行合计与小计差 ${fmtMoney(quote.quoteList.reconciliationDelta)}`);
      }
      // 报价里必须有填缝/收口件——那正是这套 BOM 要补的缺口
      if (!(quote.quoteList?.subtotals ?? []).some((s: Json) => s.category === "trim")) {
        fail("报价清单里没有填缝与收口件，客户会拿到一份缺料的价格");
      }
      const door = (quote.quoteList?.subtotals ?? []).find((s: Json) => s.category === "door");
      if (!door?.includedIn) {
        fail("门板分类没有说明「含在柜体价内」，0 元会被读成免费");
      }
    }

    results.push({
      kitchen: k, conversation, transcript, questions: lastQuestions,
      offeredQuestions: qs.questions ?? [], planView, planRounds, layout, quote,
      designPrompt: askDesign.prompt,
    });
  }

  // ── 产出 ──
  const html = renderHtml(results, scenarioSet);
  writeFileSync(path.join(OUT, "designs.html"), html, "utf-8");

  const txt = renderText(results, scenarioSet);
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

  if (failures.length > 0) {
    console.error(`\n✖ 冒烟检查未通过（${failures.length} 项）：`);
    for (const f of failures) console.error(`  · ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✔ 冒烟检查通过：${results.length} 个场景全程走通，报价清单与物料清单自洽。`);
}

function fmtMoney(cents: number): string {
  return "$" + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\.))/g, ",");
}

// ── 呈现 ──────────────────────────────────────────────────────────────────

const VIEW_NAMES: Record<string, string> = {
  front: "正视图", topBase: "俯视图 · 地柜层", topWall: "俯视图 · 吊柜层", side: "侧视图",
};

function prefNote(k: Scenario): string {
  const map: Record<string, string> = {
    economy: "控制成本", standard: "中间档", premium: "不设上限", unsure: "还没想好",
    drawers: "尽量多做抽屉", doors: "以门板柜为主", balanced: "均衡",
    RTA: "自己组装", assembled: "组装好发货",
    price: "保总价", quality: "保用料", lookAndFeel: "保外观",
  };
  const parts = [k.prefs.budgetBand, k.prefs.storage, k.prefs.assembly, k.prefs.tradeoff]
    .filter(Boolean).map((v) => map[String(v)] ?? String(v));
  if (k.prefs.doorStyleId) parts.push(k.prefs.doorStyleId);
  const extras = [...(k.prefs.hardwareOptionIds ?? []), ...(k.prefs.accessoryOptionIds ?? [])];
  if (extras.length) parts.push(extras.join("+"));
  return parts.join(" · ");
}

function renderText(results: Json[], set: ScenarioSet): string {
  const out: string[] = [
    "RTA-Hub 端到端模拟 —— 会话内容、设计图与报价清单",
    "=".repeat(76), "",
    `场景来源：${set.source === "llm" ? "LLM 动态生成" : "确定性生成器（未配置 LLM）"}`,
    set.note, "",
  ];

  for (const r of results) {
    const k = r.kitchen as Scenario;
    out.push("", "█".repeat(76), `${k.id}. ${k.name}`,
      `   ${k.shape}　层高 ${k.ceilingHeight}"　账号 ${k.accountType}`,
      `   覆盖意图：${k.covers}`, "█".repeat(76), "");

    out.push("【会话内容】");
    for (const t of r.transcript) {
      const who = t.role === "user" ? "客户" : "助手";
      out.push(...String(t.text).split("\n").map((line, i) =>
        `  ${i === 0 ? who + "：" : "     "}${line}`));
    }
    out.push("");

    out.push("【系统提出的选择题】（选项来自真实规格库，价格影响由代码算出）");
    for (const q of r.offeredQuestions) {
      out.push(`  ▸ ${q.prompt}`);
      for (const o of q.options) {
        out.push(`     · ${String(o.label).padEnd(24)} → ${o.priceNote}${o.recommended ? "　[常见选择]" : ""}`);
      }
    }
    out.push("", `【客户的选择】${prefNote(k)}`, "");

    out.push(`【全局俯视图】客户在这一版上改了 ${k.revisions.length} 轮`);
    for (const [i, round] of (r.planRounds ?? []).entries()) {
      const prev = (r.planRounds ?? [])[i - 1];
      out.push(`  ${round.label}：${round.mix}` +
        (prev ? (prev.mix === round.mix ? "　（排布未变）" : "　← 排布已变") : ""));
      if (round.applied?.length) out.push(`    应客户要求改动：${round.applied.join("、")}`);
      if (round.unapplied) out.push(`    ${round.unapplied}`);
    }
    out.push("");

    if (r.layout?.explanation?.viewGuideText) {
      out.push(indent(r.layout.explanation.viewGuideText, 2), "");
    }
    for (const per of r.layout?.explanation?.perRun ?? []) {
      out.push(`── ${per.runLabel} ${"─".repeat(Math.max(0, 56 - per.runLabel.length * 2))}`);
      out.push(indent(per.text, 2), "");
    }

    out.push("【报价清单】");
    if (r.quote?.quoteListText) out.push(indent(r.quote.quoteListText, 2));
    out.push("", `  总计（含税运）：${r.quote?.formattedTotal ?? `被拒：${r.quote?.error}`}`);
    if (r.quote?.tradePricing && !r.quote.tradePricing.applied) {
      out.push(`  注：${r.quote.tradePricing.reason}`);
    }
    for (const n of r.layout?.unappliedPreferences ?? []) out.push(`  ⚠ ${n}`);
    out.push("");
  }
  return out.join("\n");
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return String(s).split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function renderHtml(results: Json[], set: ScenarioSet): string {
  const VIEW_NAMES: Record<string, string> = {
    front: "正视图", topBase: "俯视图 · 地柜层", topWall: "俯视图 · 吊柜层", side: "侧视图",
  };

  const sections = results.map((r) => {
    const k = r.kitchen as Scenario;

    const chat = r.transcript.map((t: Json) =>
      `<div class="msg ${t.role}"><b>${t.role === "user" ? "客户" : "助手"}</b>${
        esc(t.text).replace(/\n/g, "<br/>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</div>`).join("");

    const questions = r.offeredQuestions.map((q: Json) => `
      <div class="qcard"><div class="qp">${esc(q.prompt)}</div>
        <div class="qw">${esc(q.why)}</div>
        <div class="opts">${q.options.map((o: Json) => `
          <div class="opt${o.recommended ? " rec" : ""}"><span class="ol">${esc(o.label)}</span>
          ${o.detail ? `<span class="od">${esc(o.detail)}</span>` : ""}
          <span class="op">${esc(o.priceNote)}</span></div>`).join("")}</div></div>`).join("");

    const planViews = r.planView?.planViews
      ? `<div class="views">
           <figure>${r.planView.planViews.base}<figcaption>全局俯视图 · 地柜层</figcaption></figure>
           <figure>${r.planView.planViews.wall}<figcaption>全局俯视图 · 吊柜层</figcaption></figure>
         </div>` : "";

    const fourViews = (r.layout?.views ?? []).map((run: Json) => {
      const per = (r.layout.explanation?.perRun ?? []).find((p: Json) => p.runId === run.runId);
      return `<div class="run"><h4>${esc(run.runLabel)}</h4>
        <div class="views">${Object.entries(run.views as Record<string, string>).map(([key, svg]) =>
          `<figure>${svg}<figcaption>${VIEW_NAMES[key] ?? key}</figcaption></figure>`).join("")}</div>
        ${per?.html ?? ""}</div>`;
    }).join("");

    return `<section class="kitchen">
      <h2><span class="tag">${esc(k.id)}</span>${esc(k.name)}</h2>
      <p class="meta">${esc(k.shape)}　层高 ${k.ceilingHeight}"　${k.walls.length} 段墙　
        ${k.accountType === "trade" ? "建商（trade）" : "消费者"}账号</p>
      <p class="covers"><b>覆盖意图：</b>${esc(k.covers)}</p>

      <h3>1 · 会话内容</h3>
      <div class="chat">${chat}</div>

      <h3>2 · 系统提出的选择题</h3>
      <p class="note">选项来自公司真实规格库；价格影响由定价引擎从价格矩阵算出。</p>
      ${questions}
      <p class="picked">客户的选择：<b>${esc(prefNote(k))}</b></p>

      <h3>3 · 全局俯视图（先看排布，改了 ${k.revisions.length} 轮）</h3>
      <ol class="rounds">${(r.planRounds ?? []).map((rd: Json, i: number) => {
        const prev = (r.planRounds ?? [])[i - 1];
        const changed = prev ? (prev.mix === rd.mix ? "（排布未变）" : "← 排布已变") : "";
        return `<li>${esc(rd.label)}：<code>${esc(rd.mix)}</code> ${esc(changed)}` +
          (rd.applied?.length ? `<br><span class="note">应客户要求改动：${esc(rd.applied.join("、"))}</span>` : "") +
          (rd.unapplied ? `<br><span class="note">${esc(rd.unapplied)}</span>` : "") + "</li>";
      }).join("")}</ol>
      ${planViews}

      <h3>4 · 完整四视图与解释</h3>
      ${r.layout?.explanation?.viewGuideHtml ?? ""}
      ${fourViews}

      <h3>5 · 报价清单</h3>
      ${r.quote?.quoteListHtml ?? `<p class="note">${esc(r.quote?.error ?? "")}</p>`}
      <p class="quote">总计（含税运）：${esc(r.quote?.formattedTotal ?? "—")}</p>
      ${(r.layout?.unappliedPreferences ?? []).map((n: string) =>
        `<p class="warn">⚠ ${esc(n)}</p>`).join("")}
    </section>`;
  }).join("");

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>RTA-Hub · 端到端模拟</title><meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  :root { color-scheme: light dark; } * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#0f1216; color:#e6e8eb; line-height:1.6;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  .lede { color:#8b94a3; font-size:13.5px; margin:0 0 12px; }
  .src { background:#1e3566; border-radius:9px; padding:10px 14px; font-size:13px; margin:0 0 26px; }
  .kitchen { border:1px solid #262b33; border-radius:14px; padding:22px; margin-bottom:28px; background:#141920; }
  h2 { font-size:18px; margin:0 0 4px; display:flex; align-items:center; gap:10px; }
  .tag { background:#2a5bd7; color:#fff; border-radius:8px; padding:1px 10px; font-size:14px; }
  h3 { font-size:14px; margin:24px 0 8px; color:#9aa4b2; border-bottom:1px solid #262b33; padding-bottom:5px; }
  h4 { font-size:13px; margin:16px 0 6px; }
  .meta,.note { color:#8b94a3; font-size:12.5px; margin:0 0 10px; }
  .covers { font-size:12.5px; color:#d8c37b; margin:0 0 10px; }
  .chat { display:flex; flex-direction:column; gap:6px; }
  .msg { padding:7px 12px; border-radius:10px; font-size:13px; max-width:84%; }
  .msg b { display:block; font-size:10.5px; opacity:.65; margin-bottom:1px; }
  .msg.user { background:#2a5bd7; color:#fff; align-self:flex-end; }
  .msg.assistant { background:#1c2129; align-self:flex-start; }
  .qcard { background:#1c2129; border:1px solid #3a4250; border-radius:10px; padding:12px; margin:8px 0; }
  .qp { font-size:13px; font-weight:600; } .qw { font-size:11.5px; color:#8b94a3; margin:3px 0 9px; }
  .opts { display:flex; flex-wrap:wrap; gap:7px; }
  .opt { background:#262b33; border:1px solid #3a4250; border-radius:9px; padding:7px 10px; font-size:12.5px; }
  .opt.rec { border-color:#4c9a5f; }
  .ol { display:block; font-weight:500; } .od { display:block; color:#8b94a3; font-size:11px; }
  .op { display:block; color:#7bc0d8; font-size:11px; margin-top:2px; }
  .picked { font-size:13px; background:#1e3566; border-radius:9px; padding:9px 12px; }
  .run { border-top:1px solid #262b33; padding-top:10px; margin-top:14px; }
  .views { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:12px; }
  figure { margin:0; background:#fff; border-radius:9px; padding:8px; overflow:auto; }
  figure svg { max-width:100%; height:auto; display:block; }
  figcaption { color:#555; font-size:11px; text-align:center; padding-top:4px; }
  .quote { font-size:19px; font-weight:600; color:#7bd88f; }
  .warn { color:#d8c37b; font-size:12.5px; }
  table.ql { width:100%; border-collapse:collapse; font-size:12.5px; margin-bottom:12px; }
  table.ql th,table.ql td { text-align:left; padding:5px 6px; border-bottom:1px solid #262b33; vertical-align:top; }
  table.ql th { color:#9aa4b2; font-weight:500; font-size:11.5px; }
  table.ql .num { text-align:right; font-variant-numeric:tabular-nums; }
  .ql-spec,.ql-note { display:block; color:#6a7382; font-size:11px; }
  .ql-door td { color:#8b94a3; font-size:11.5px; padding-top:0; }
  .ql-mod td { color:#7bc0d8; font-size:11.5px; }
  .ql-total td { font-weight:600; border-top:1px solid #3a4250; }
  .ql-warn { color:#d87b7b; font-size:12px; }
  .quote-list h4 { color:#9aa4b2; }
  .x-rationale,.x-guide { background:#1c2129; border:1px solid #3a4250; border-radius:10px; padding:12px; margin:10px 0; }
  .x-rationale h4,.x-guide h4 { font-size:12.5px; margin:12px 0 5px; color:#9aa4b2; }
  .x-guide h5 { font-size:12.5px; margin:10px 0 3px; }
  .x-rationale .x-head { font-size:13px; margin:0 0 4px; }
  .x-rationale ul,.x-guide ul { margin:0; padding-left:16px; }
  .x-rationale li,.x-guide li,.x-guide p { font-size:12.5px; line-height:1.65; margin:2px 0; }
  .x-rationale li { list-style:none; position:relative; padding-left:14px; margin-left:-16px; }
  .x-rationale li::before { position:absolute; left:0; }
  .x-fact { color:#8b94a3; } .x-fact::before { content:"·"; color:#6a7382; }
  .x-good { color:#c6cdd6; } .x-good::before { content:"✓"; color:#7bd88f; }
  .x-tradeoff { color:#c6cdd6; } .x-tradeoff::before { content:"△"; color:#d8c37b; }
  .x-warn { color:#e0b4b4; } .x-warn::before { content:"!"; color:#d87b7b; font-weight:700; }
  .x-guide p { color:#8b94a3; }
</style></head><body><div class="wrap">
<h1>RTA-Hub · 端到端模拟</h1>
<p class="lede">走真实 HTTP 端点：建会话 → 多轮对话 → 上传户型 → 补齐尺寸与窗/上下水 →
回答选择题 → <b>问客户要不要出图</b> → 全局俯视图（多轮改）→ 认可排布 →
完整四视图 + 解释 → 报价清单。</p>
<p class="src"><b>场景来源：</b>${set.source === "llm" ? "LLM 动态生成" : "确定性生成器"}　${esc(set.note)}</p>
${sections}
</div></body></html>`;
}

await main();
