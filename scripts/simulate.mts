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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_SCENARIO_COUNT, generateScenarios, type Scenario, type ScenarioSet,
} from "./scenarios.mts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = path.join(SCRIPT_DIR, "..", "test", "sources");

function asksForDrawing(text: string): boolean {
  return /需要我帮你生成设计图吗|Shall I generate a design drawing/i.test(text);
}

process.env.SMTP_HOST = "";
process.env.ADMIN_TOKEN = "sim";
process.env.SITE_PASSWORD_DISABLED = "true";

import {
  formatTokenSummary, resetTokenMeter, tokenSnapshot, type TokenSnapshot,
} from "../src/agents/token-meter.js";

const OUT = process.argv[2] ?? "sim-out";
/** 默认跑**全部**内置场景。少跑几个的报告和跑全了的报告长得一模一样。 */
const COUNT = Number(process.argv[3] ?? BUILTIN_SCENARIO_COUNT);
const ACCOUNTS = { consumer: "ca_demo_consumer", trade: "ca_demo_trade" } as const;

// ── 跑一遍 ────────────────────────────────────────────────────────────────

type Json = Record<string, any>;

/**
 * 时间线上的一条事件。
 *
 * ## 为什么产出物要按时间组织，而不是按数据种类
 *
 * 上一版报告分成「会话内容 / 选择题 / 全局俯视图 / 四视图 / 报价清单」五节。
 * 每一节的内容都是对的，顺序也是对的，但读者在第一节末尾看到
 * 「客户：排布可以了」，再往下才看到图——**读起来就是"先确认后看图"**，
 * 而实际调用顺序恰恰相反（planReview 阶段才出俯视图，approvePlan 之后才出四视图，
 * 且有闸门与测试保证）。
 *
 * 教训：**产出物的结构本身会传达一个因果关系。** 按数据种类分节是实现者的视角；
 * 客户的视角是时间。分节方式选错，正确的数据也会讲出一个错误的故事。
 *
 * 所以改成一条时间线：每样东西出现在它**真正被产出的那一刻**。
 */
type Beat =
  | { kind: "say"; role: "user" | "assistant"; text: string }
  /** 系统就地给出的选择题（出现在它被提出的那一轮，不是集中到末尾）。 */
  | { kind: "questions"; questions: Json[] }
  /** 客户在选择题上的作答。 */
  | { kind: "answered"; note: string }
  /** 户型录入完成。 */
  | { kind: "floorPlan"; walls: number; features: number; ceilingHeight: number }
  /** 一版全局俯视图。 */
  | {
      kind: "planViews"; label: string; mix: string; changed: boolean | undefined;
      applied: string[]; unapplied?: string; views: { base?: string; wall?: string; note?: string };
    }
  /** 完整四视图 + 解释。 */
  | { kind: "fourViews"; runs: Json[]; explanation: Json; acceptable: boolean; aesthetics: Json[] }
  /** 报价清单。 */
  | { kind: "quote"; ok: boolean; text?: string; html?: string; total?: string; error?: string }
  /** 交付前审核的结论——**在把东西给客户之前**跑的那一遍。 */
  | { kind: "audit"; on: string; ok: boolean; text: string; checked: string[] }
  /** 提示 / 警告，就地出现。 */
  | { kind: "note"; level: "info" | "warn"; text: string };

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

  /** 每个场景的模型用量。上线定线索费要靠它——见 agents/token-meter.ts。 */
  const tokenByScenario: { id: string; name: string; snapshot: TokenSnapshot }[] = [];

  for (const k of scenarioSet.scenarios) {
    const acct = ACCOUNTS[k.accountType];
    console.log(`\n${"═".repeat(72)}\n${k.id}. ${k.name}（${k.shape}）` +
      `\n   覆盖：${k.covers}\n${"═".repeat(72)}`);
    // 每个场景单独计量。**从这里清零**——场景之间的用量不能累加到一起，
    // 「一个客户烧多少」才是要回答的问题
    resetTokenMeter();

    // 1. 建会话 + 多轮对话
    const { conversation } = await call("/api/conversations", { method: "POST", acct });
    /** 这一单从头到尾发生的事，按发生顺序。渲染只按这条线走。 */
    const timeline: Beat[] = [];
    const said = (role: "user" | "assistant", text: string) =>
      timeline.push({ kind: "say", role, text });
    let lastQuestions: Json[] = [];

    for (const turn of k.turns) {
      const r = await call(`/api/conversations/${conversation.id}/messages`, {
        method: "POST", acct, body: JSON.stringify({ text: turn }),
      });
      said("user", turn);
      for (const reply of r.replies ?? []) said("assistant", reply.content);
      lastQuestions = r.questions ?? [];
      console.log(`  客户：${turn}`);
      console.log(`  助手：${(r.replies?.[0]?.content ?? "（无）").slice(0, 76)}`);
    }

    // 2. 上传户型 + 补齐尺寸与特征
    // 有 sourceImage 时上传真实样例图（覆盖「用户上传户型图」路径）；否则仍用占位元数据。
    let floorplanBody: Record<string, unknown> = {
      fileName: `kitchen-${k.id}.png`, mimeType: "image/png", sizeBytes: 204800,
    };
    if (k.sourceImage) {
      const imgPath = path.join(SOURCES_DIR, k.sourceImage);
      if (!existsSync(imgPath)) {
        failures.push(`${k.id}. ${k.name}：缺少样例户型图 ${k.sourceImage}`);
        continue;
      }
      const bytes = readFileSync(imgPath);
      const mime = k.sourceImage.toLowerCase().endsWith(".jpg") || k.sourceImage.toLowerCase().endsWith(".jpeg")
        ? "image/jpeg" : "image/png";
      floorplanBody = {
        fileName: k.sourceImage,
        mimeType: mime,
        sizeBytes: bytes.length,
        image: `data:${mime};base64,${bytes.toString("base64")}`,
      };
      console.log(`  上传真实户型图：${k.sourceImage}（${(bytes.length / 1024).toFixed(0)} KB）`);
      timeline.push({
        kind: "note", level: "info",
        text: `Uploaded floor-plan image: ${k.sourceImage} (${bytes.length} bytes)`,
      });
    }
    const fp = await call(`/api/conversations/${conversation.id}/floorplan`, {
      method: "POST", acct,
      body: JSON.stringify(floorplanBody),
    });
    const floorPlanId = fp.floorPlan.id;
    if (fp.extractionNote) {
      console.log(`  抽取说明：${String(fp.extractionNote).slice(0, 120)}`);
      timeline.push({ kind: "note", level: "info", text: String(fp.extractionNote) });
    }

    // 有真实图时：优先确认视觉抽出的墙段长度（不另加一堆 length=0 的墙导致永远不 ready）
    // 没抽出墙时：退回手动 addRun（与无图场景同一路径）
    let runsAfterGeom: Json[] = [];
    {
      const snap = await call(`/api/floorplans/${floorPlanId}`, { acct });
      const existing = (snap.floorPlan?.parsedGeometry?.wallRuns ?? []) as Json[];
      const usableVision = existing.length > 0 && existing.length <= k.walls.length + 1;
      if (k.sourceImage && usableVision) {
        for (let i = 0; i < k.walls.length; i++) {
          const w = k.walls[i]!;
          const run = existing[i];
          if (run?.id) {
            await call(`/api/floorplans/${floorPlanId}/resolve`, {
              method: "POST", acct,
              body: JSON.stringify({ wallRunId: run.id, length: w.length }),
            });
          } else {
            await call(`/api/floorplans/${floorPlanId}/resolve`, {
              method: "POST", acct,
              body: JSON.stringify({
                addRun: {
                  label: w.label, length: w.length,
                  ...(w.kind ? { kind: w.kind } : {}),
                  ...(w.depth !== undefined ? { depth: w.depth } : {}),
                },
              }),
            });
          }
        }
      } else {
        for (const w of k.walls) {
          await call(`/api/floorplans/${floorPlanId}/resolve`, {
            method: "POST", acct,
            // 岛台要带上 kind/depth——不带的话它会被当成一段普通的墙接到上一段后面，
            // 全局俯视图上就变成"厨房多了一面墙"，而不是中间摆了个岛台
            body: JSON.stringify({
              addRun: {
                label: w.label, length: w.length,
                ...(w.kind ? { kind: w.kind } : {}),
                ...(w.depth !== undefined ? { depth: w.depth } : {}),
              },
            }),
          });
        }
      }
      await call(`/api/floorplans/${floorPlanId}/resolve`, {
        method: "POST", acct, body: JSON.stringify({ ceilingHeight: k.ceilingHeight }),
      });
      // 消解视觉留下的待确认项（全局 wallRuns / 低置信字段），否则 FR-15 几何永远不齐
      const pending = await call(`/api/floorplans/${floorPlanId}`, { acct });
      for (const u of (pending.floorPlan?.unresolvedItems ?? []) as Json[]) {
        if (u.resolved) continue;
        await call(`/api/floorplans/${floorPlanId}/resolve`, {
          method: "POST", acct, body: JSON.stringify({ itemId: u.id }),
        });
      }
      runsAfterGeom = ((await call(`/api/floorplans/${floorPlanId}`, { acct }))
        .floorPlan.parsedGeometry.wallRuns ?? []) as Json[];
    }
    // 客户声明的家电（FR-3.2）。不声明就走推定值（冰箱 + 灶具），
    // 那条路径已经被别的场景覆盖了；这里要测的是**声明之后**的行为：
    // 留空按实际尺寸算、说不确定的如实标成推定、配套柜按能力标签查。
    if (k.appliances?.length) {
      await call(`/api/floorplans/${floorPlanId}/resolve`, {
        method: "POST", acct, body: JSON.stringify({ appliances: k.appliances }),
      });
      const known = k.appliances.filter((a) => a.width !== undefined).length;
      console.log(`  家电：${k.appliances.length} 件（${known} 件给了尺寸，` +
        `${k.appliances.length - known} 件按常见款推定）`);
      timeline.push({
        kind: "note", level: "info",
        text: `家电已录入：${k.appliances.length} 件，其中 ` +
          `${k.appliances.length - known} 件尺寸不确定、按常见款推定`,
      });
    }

    const runs = runsAfterGeom.length
      ? runsAfterGeom
      : ((await call(`/api/floorplans/${floorPlanId}`, { acct }))
        .floorPlan.parsedGeometry.wallRuns as Json[]);
    let featureCount = 0;
    for (let wi = 0; wi < k.walls.length; wi++) {
      const w = k.walls[wi]!;
      // 真实图抽取的标签可能是 Wall 1 / 北墙，与场景里的 North 对不上——按序号对齐
      const run = runs.find((r) => r.label === w.label) ?? runs[wi];
      if (!run) continue;
      for (const f of w.features) {
        const r = await call(`/api/floorplans/${floorPlanId}/resolve`, {
          method: "POST", acct, body: JSON.stringify({ addFeature: { wallRunId: run.id, ...f } }),
        });
        if (r.__status === 200) featureCount++;
        else {
          console.log(`    ⚠ 加特征失败：${r.error}`);
          timeline.push({ kind: "note", level: "warn", text: `加特征失败：${r.error}` });
        }
      }
    }
    timeline.push({
      kind: "floorPlan", walls: k.walls.length,
      features: featureCount, ceilingHeight: k.ceilingHeight,
    });
    console.log(`  户型：${k.walls.length} 段墙，${featureCount} 个特征，层高 ${k.ceilingHeight}"`);

    // 3. 选择题 → 答偏好
    const qs = await call(
      `/api/conversations/${conversation.id}/questions?companyId=co_pilot`, { acct });
    timeline.push({ kind: "questions", questions: qs.questions ?? [] });
    await call(`/api/conversations/${conversation.id}/preferences`, {
      method: "POST", acct, body: JSON.stringify({ companyId: "co_pilot", ...k.prefs }),
    });
    timeline.push({ kind: "answered", note: prefNote(k) });
    console.log(`  选择题 ${(qs.questions ?? []).length} 道　偏好已记录`);

    // 3b. FR-15：出图前用白话补齐检查表关键项（风格/省份；无窗/无家电则明示推迟）
    // 预算可由 preferences.budgetBand 满足；不能猜上下水——场景 walls.features 必须带 plumbing。
    {
      const hasWindows = k.walls.some((w) => w.features.some((f) => f.kind === "window"));
      const hasPlumbing = k.walls.some((w) => w.features.some((f) => f.kind === "plumbing"));
      if (!hasPlumbing) {
        failures.push(`${k.id}. ${k.name}：场景未声明上下水，违反 FR-15（不能猜）`);
      }
      const sealParts = [
        /modern|shaker|style|风格|现代|北欧|简约/i.test(k.turns.join("\n"))
          ? "" : "Modern style.",
        /ontario|\bon\b|安大略|bc|alberta|province/i.test(k.turns.join("\n"))
          ? "" : "Ontario ON.",
        hasWindows ? "" : "No windows.",
        k.appliances?.length ? "" : "Appliances later.",
      ].filter(Boolean);
      if (sealParts.length) {
        const seal = sealParts.join(" ");
        const sealRes = await call(`/api/conversations/${conversation.id}/messages`, {
          method: "POST", acct, body: JSON.stringify({ text: seal }),
        });
        said("user", seal);
        for (const reply of sealRes.replies ?? []) said("assistant", reply.content);
        console.log(`  FR-15 确认：${seal}`);
      }
    }

    // 4. **先问再画**：拿到「需要我帮你生成设计图吗？」/ Shall I generate…
    const askDesign = await call(
      `/api/conversations/${conversation.id}/design?companyId=co_pilot`, { acct });
    console.log(`  阶段 ${askDesign.session?.stage}：${(askDesign.prompt?.message ?? "").split("\n")[0]}`);
    if (askDesign.designBrief?.confirmationText) {
      timeline.push({
        kind: "note", level: "info",
        text: `Design brief ready=${Boolean(askDesign.designBrief.readyToAskDesign)}`,
      });
    }
    said("assistant", askDesign.prompt?.message ?? "");

    // 5. 客户点头 → 全局俯视图（多轮改）
    await call(`/api/conversations/${conversation.id}/design/advance`, {
      method: "POST", acct, body: JSON.stringify({ companyId: "co_pilot", action: "consent" }),
    });
    said("user", "好，出图看看");

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
      if (planView.__status !== 201) {
        console.log(`    ⚠ 出俯视图失败：${planView.error}`);
        timeline.push({ kind: "note", level: "warn", text: `出俯视图失败：${planView.error}` });
        break;
      }
      const mix = mixOf(planView);
      const prev = planRounds[planRounds.length - 1];
      const label = `第 ${round + 1} 版`;
      planRounds.push({
        label, mix,
        applied: planView.revision?.applied ?? [],
        ...(planView.revision?.unapplied ? { unapplied: planView.revision.unapplied } : {}),
      });

      // 上一轮什么都没改到的话，别说"重排了一版"——那与刚说过的
      // "这一轮没有可落到排布上的具体改动"自相矛盾
      const appliedLast: string[] = planView.revision?.applied ?? [];
      said("assistant", round === 0
        ? "这是全局俯视图，分地柜层和吊柜层。先看排布——哪个柜子该挪、哪里想换成抽屉，直接说。"
        : appliedLast.length
          ? `按你说的重排了一版（${label}）。`
          : `这是${label}。刚才那条我没法落到排布上，所以和上一版一样——还有别的要改吗？`);
      if (planView.audit) {
        timeline.push({
          kind: "audit", on: `全局俯视图 ${label}`,
          ok: Boolean(planView.audit.ok), text: planView.auditText ?? "",
          checked: planView.audit.checked ?? [],
        });
      }
      timeline.push({
        kind: "planViews", label, mix,
        changed: prev ? prev.mix !== mix : undefined,
        applied: planView.revision?.applied ?? [],
        ...(planView.revision?.unapplied ? { unapplied: planView.revision.unapplied } : {}),
        views: planView.planViews ?? {},
      });
      console.log(`  全局俯视图 ${label}：${mix}` +
        (prev ? (prev.mix === mix ? "　（与上一版相同）" : "　← 排布已变") : ""));

      const rev = k.revisions[round];
      if (!rev) break;
      const adv = await call(`/api/conversations/${conversation.id}/design/advance`, {
        method: "POST", acct,
        body: JSON.stringify({
          companyId: "co_pilot", action: "revise", note: rev.note, changes: rev.changes,
        }),
      });
      said("user", rev.note);
      const applied: string[] = adv.revision?.applied ?? [];
      const line = applied.length
        ? `好的，这就按「${applied.join("、")}」重排一版。`
        : (adv.revision?.unapplied ?? "这条我暂时改不到排布上。");
      said("assistant", line);
      console.log(`  客户：${rev.note}\n  助手：${line}`);
    }

    // 6. 认可排布 → 完整四视图
    await call(`/api/conversations/${conversation.id}/design/advance`, {
      method: "POST", acct, body: JSON.stringify({ companyId: "co_pilot", action: "approvePlan" }),
    });
    said("user", "排布可以了，出完整图纸");

    const layout = await call(`/api/floorplans/${floorPlanId}/layout`, {
      method: "POST", acct, body: JSON.stringify({ companyId: "co_pilot" }),
    });
    console.log(`  完整四视图：人体工程${layout.acceptable ? "全过" : "未过"}　` +
      `美观 ${(layout.aesthetics ?? []).map((a: Json) => a.score.total).join("/")}`);
    said("assistant", "排布定下来了，这是完整的四视图和逐条说明。");
    if (layout.audit) {
      timeline.push({
        kind: "audit", on: "完整四视图",
        ok: Boolean(layout.audit.ok), text: layout.auditText ?? "",
        checked: layout.audit.checked ?? [],
      });
    }
    timeline.push({
      kind: "fourViews", runs: layout.views ?? [],
      explanation: layout.explanation ?? {},
      acceptable: Boolean(layout.acceptable),
      aesthetics: layout.aesthetics ?? [],
    });
    for (const n of layout.bomMissing ?? []) {
      console.log(`    ⚠ 缺辅料型号：${n}`);
      timeline.push({ kind: "note", level: "warn", text: `缺辅料型号：${n}` });
    }
    for (const n of layout.unappliedPreferences ?? []) {
      console.log(`    ⚠ ${n}`);
      timeline.push({ kind: "note", level: "warn", text: String(n) });
    }

    // 7. 报价 + 清单
    const quote = await call("/api/quotes", {
      method: "POST", acct,
      body: JSON.stringify({
        companyId: "co_pilot", conversationId: conversation.id, selections: layout.selections,
      }),
    });
    if (quote.audit) {
      timeline.push({
        kind: "audit", on: "报价清单",
        ok: Boolean(quote.audit.ok), text: quote.auditText ?? "",
        checked: quote.audit.checked ?? [],
      });
    }
    if (quote.__status === 201) {
      const sums = (quote.quoteList?.subtotals ?? [])
        .map((x: Json) => `${x.label} ${x.includedIn ? "含在柜体价内" : fmtMoney(x.amount)}`).join("　");
      console.log(`  报价 ${quote.formattedTotal}　${sums}`);
      timeline.push({
        kind: "quote", ok: true,
        ...(quote.quoteListText ? { text: quote.quoteListText } : {}),
        ...(quote.quoteListHtml ? { html: quote.quoteListHtml } : {}),
        ...(quote.formattedTotal ? { total: quote.formattedTotal } : {}),
      });
      if (quote.quoteList?.reconciliationDelta) {
        console.log(`    ⚠ 清单与小计差 ${fmtMoney(quote.quoteList.reconciliationDelta)}`);
        timeline.push({
          kind: "note", level: "warn",
          text: `清单与小计差 ${fmtMoney(quote.quoteList.reconciliationDelta)}`,
        });
      }
      if (quote.tradePricing && !quote.tradePricing.applied) {
        timeline.push({ kind: "note", level: "info", text: String(quote.tradePricing.reason) });
      }
    } else {
      console.log(`  报价被拒（${quote.__status}）：${quote.error}` +
        (quote.issues ? ` ${JSON.stringify(quote.issues)}` : ""));
      timeline.push({ kind: "quote", ok: false, error: String(quote.error ?? "") });
    }

    // ── 冒烟断言 ──
    //
    // 跑完不报错 ≠ 跑对了。上面每一步都可能"成功地"产出错东西：阶段没推进、
    // 报价缺了填缝条、客户提的改动没落下去。这些在 CI 里必须让构建变红，
    // 否则这个脚本只是个会打印漂亮文字的程序。
    const fail = (msg: string) => { failures.push(`${k.id}. ${k.name}：${msg}`); };

    if (askDesign.session?.stage !== "readyToDraw") {
      fail(`资料齐了却停在 ${askDesign.session?.stage}，没走到「先问再画」` +
        (askDesign.designBrief?.openItems
          ? `；openItems=${JSON.stringify(askDesign.designBrief.openItems.map((i: Json) => i.id))}`
          : ""));
    }
    if (!asksForDrawing(askDesign.prompt?.message ?? "")) {
      fail("出图前没有征询客户意见");
    }
    if (planRounds.length !== k.revisions.length + 1) {
      fail(`应出 ${k.revisions.length + 1} 版俯视图，实际 ${planRounds.length} 版`);
    }

    // 时间线的**顺序**本身就是一条要守的规则。上一版报告数据全对、顺序也对，
    // 但分节方式让它读起来是"先确认后看图"——产出物的结构会传达因果关系，
    // 所以这里直接盯住产出物里事件的先后。
    const at = (pred: (b: Beat) => boolean) => timeline.findIndex(pred);
    const iAsk = at((b) => b.kind === "say" && asksForDrawing(b.text));
    const iFirstPlan = at((b) => b.kind === "planViews");
    const iApprove = at((b) => b.kind === "say" && b.text.includes("排布可以了"));
    const iFour = at((b) => b.kind === "fourViews");
    const iQuote = at((b) => b.kind === "quote");

    for (const [label, idx] of [
      ["询问是否出图", iAsk], ["首版俯视图", iFirstPlan],
      ["客户认可排布", iApprove], ["完整四视图", iFour], ["报价清单", iQuote],
    ] as [string, number][]) {
      if (idx < 0) fail(`时间线上找不到「${label}」`);
    }
    if (iAsk >= 0 && iFirstPlan >= 0 && iAsk > iFirstPlan) {
      fail("时间线上「问要不要出图」排在了首版俯视图之后");
    }
    if (iFirstPlan >= 0 && iApprove >= 0 && iFirstPlan > iApprove) {
      fail("时间线上首版俯视图排在了客户认可之后——客户得先看到图才能认可");
    }
    if (iApprove >= 0 && iFour >= 0 && iApprove > iFour) {
      fail("时间线上四视图排在了客户认可之前");
    }
    if (iFour >= 0 && iQuote >= 0 && iFour > iQuote) {
      fail("时间线上报价清单排在了四视图之前");
    }
    // 交付前审核必须**真的跑过**，而不是"没查所以没问题"
    const audits = timeline.filter((b): b is Extract<Beat, { kind: "audit" }> => b.kind === "audit");
    if (audits.length === 0) {
      fail("整条链路上一次交付前审核都没跑");
    }
    for (const a of audits) {
      if (a.checked.length === 0) fail(`${a.on} 的审核一项都没查——「没查」不等于「查过没问题」`);
      if (!a.ok) fail(`${a.on} 未通过交付前审核：${a.text.replace(/\n/g, " ").slice(0, 120)}`);
    }
    // 报价这一步查得最严，必须包含对账与快照复算
    const quoteAudit = audits.find((a) => a.on === "报价清单");
    if (quoteAudit) {
      for (const need of ["QUOTE_RECONCILIATION", "PRICE_SNAPSHOT", "BOM_INCOMPLETE"]) {
        if (!quoteAudit.checked.includes(need)) {
          fail(`报价交付前没有跑 ${need} 这项检查`);
        }
      }
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

    const usage = tokenSnapshot();
    tokenByScenario.push({ id: k.id, name: k.name, snapshot: usage });
    console.log(`  ${formatTokenSummary(usage)}`);

    results.push({
      kitchen: k, conversation, timeline, questions: lastQuestions,
      planRounds, layout, quote, designPrompt: askDesign.prompt,
      usage: usage as unknown as Json,
    });
  }

  reportTokens(tokenByScenario);

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

/**
 * Token 消耗汇总。
 *
 * 按**调用点**分列而不是只报总量：总量告诉你"贵了"，分调用点才告诉你"贵在哪"。
 * 如果绝大部分 token 花在总控助手的日常闲聊上，该做的是把那一层压到更便宜的
 * 模型（`model-tiers.ts` 已经这么分层），而不是笼统地"优化 prompt"。
 */
function reportTokens(rows: { id: string; name: string; snapshot: TokenSnapshot }[]): void {
  if (rows.length === 0) return;
  const estimated = rows.every((r) => r.snapshot.allEstimated || r.snapshot.calls === 0);

  console.log(`\n${"─".repeat(72)}\nToken 消耗${estimated ? "（估算：未配置模型，走确定性问答）" : ""}`);
  console.log("─".repeat(72));
  console.log("场景                                     调用   输入      输出      合计");
  let calls = 0; let input = 0; let output = 0;
  for (const r of rows) {
    const s = r.snapshot;
    calls += s.calls; input += s.inputTokens; output += s.outputTokens;
    const label = `${r.id}. ${r.name}`.slice(0, 38).padEnd(38);
    console.log(`${label} ${String(s.calls).padStart(4)} ${String(s.inputTokens).padStart(8)} ` +
      `${String(s.outputTokens).padStart(9)} ${String(s.totalTokens).padStart(9)}`);
  }
  console.log("─".repeat(72));
  console.log(`${"合计".padEnd(38)} ${String(calls).padStart(4)} ${String(input).padStart(8)} ` +
    `${String(output).padStart(9)} ${String(input + output).padStart(9)}`);
  console.log(`${"每场景均值".padEnd(38)} ${String(Math.round(calls / rows.length)).padStart(4)} ` +
    `${String(Math.round(input / rows.length)).padStart(8)} ` +
    `${String(Math.round(output / rows.length)).padStart(9)} ` +
    `${String(Math.round((input + output) / rows.length)).padStart(9)}`);

  // 按调用点：成本花在哪
  const bySite = new Map<string, { calls: number; tokens: number }>();
  for (const r of rows) {
    for (const [site, v] of Object.entries(r.snapshot.byCallSite)) {
      const cur = bySite.get(site) ?? { calls: 0, tokens: 0 };
      cur.calls += v.calls;
      cur.tokens += v.inputTokens + v.outputTokens;
      bySite.set(site, cur);
    }
  }
  if (bySite.size > 0) {
    console.log("\n按调用点：");
    const total = input + output || 1;
    for (const [site, v] of [...bySite].sort((a, b) => b[1].tokens - a[1].tokens)) {
      console.log(`  ${site.padEnd(22)} ${String(v.calls).padStart(4)} 次　` +
        `${String(v.tokens).padStart(8)} token　${(v.tokens / total * 100).toFixed(1)}%`);
    }
  }
  if (estimated) {
    console.log("\n⚠ 以上是**估算值**：本次运行没有配置模型，走的是确定性问答路径。");
    console.log("  估算按 prompt 字符数换算（约 2.5 字符/token，中英混排的折中值），");
    console.log("  只用于判断量级。配置 OPENAI_API_KEY 后这里会换成 API 返回的真实用量。");
  }
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

/**
 * 纯文本报告 —— **按时间线走**，不按数据种类分节。
 *
 * 每样东西出现在它真正被产出的那一刻：客户说了什么、系统就地给出哪几道选择题、
 * 哪一刻出的俯视图、客户在图上提了什么、哪一刻才认可、然后才是四视图与报价。
 * 见 Beat 的注释。
 */
function renderText(results: Json[], set: ScenarioSet): string {
  const out: string[] = [
    "RTA-Hub 端到端模拟 —— 按时间顺序记录的完整会话",
    "=".repeat(76), "",
    `场景来源：${set.source === "llm" ? "LLM 动态生成" : "确定性生成器（未配置 LLM）"}`,
    set.note, "",
    "说明：下面是一条时间线。图纸出现在它实际被生成的位置——",
    "     客户先看到全局俯视图、在上面改，**改到认可之后**才有四视图与报价清单。",
    "",
  ];

  for (const r of results) {
    const k = r.kitchen as Scenario;
    out.push("", "█".repeat(76), `${k.id}. ${k.name}`,
      `   ${k.shape}　层高 ${k.ceilingHeight}"　账号 ${k.accountType}`,
      `   覆盖意图：${k.covers}`, "█".repeat(76), "");

    for (const b of (r.timeline ?? []) as Beat[]) {
      switch (b.kind) {
        case "say": {
          const who = b.role === "user" ? "客户" : "助手";
          out.push(...b.text.split("\n").map((line, i) =>
            `  ${i === 0 ? who + "：" : "     "}${line}`));
          break;
        }
        case "floorPlan":
          out.push("",
            `  ▣ 户型已录入：${b.walls} 段墙、${b.features} 个特征、层高 ${b.ceilingHeight}"`, "");
          break;
        case "questions":
          out.push("", "  ▸ 系统就地给出选择题（选项来自真实规格库，价格影响由代码算出）：");
          for (const q of b.questions) {
            out.push(`      ${q.prompt}`);
            for (const o of q.options ?? []) {
              out.push(`        · ${String(o.label).padEnd(24)} → ${o.priceNote}` +
                `${o.recommended ? "　[常见选择]" : ""}`);
            }
          }
          break;
        case "answered":
          out.push(`  客户（在选项上勾选）：${b.note}`, "");
          break;
        case "planViews": {
          const changed = b.changed === undefined ? ""
            : b.changed ? "　← 排布已变" : "　（排布未变）";
          out.push(`  ▤ 全局俯视图 ${b.label}：${b.mix}${changed}`);
          // unapplied 上一条助手发言已经说过了，这里不复述
          if (b.applied.length) out.push(`      应客户要求改动：${b.applied.join("、")}`);
          if (b.views.note) out.push(`      ${b.views.note}`);
          out.push("");
          break;
        }
        case "fourViews":
          out.push(`  ▦ 完整四视图（人体工程${b.acceptable ? "全部通过" : "未通过"}）`, "");
          if (b.explanation?.viewGuideText) {
            out.push(indent(b.explanation.viewGuideText, 4), "");
          }
          for (const per of b.explanation?.perRun ?? []) {
            out.push(`  ── ${per.runLabel} ` +
              `${"─".repeat(Math.max(0, 54 - String(per.runLabel).length * 2))}`);
            out.push(indent(per.text, 4), "");
          }
          break;
        case "quote":
          out.push("  ▥ 报价清单");
          if (b.text) out.push(indent(b.text, 4));
          out.push("", `     总计（含税运）：${b.ok ? b.total : `被拒：${b.error}`}`, "");
          break;
        case "audit":
          out.push(`  ${b.ok ? "✔" : "✖"} 交付前审核（${b.on}）：` +
            `跑了 ${b.checked.length} 项`);
          if (b.text) out.push(indent(b.text, 4));
          out.push("");
          break;
        case "note":
          out.push(`  ${b.level === "warn" ? "⚠" : "·"} ${b.text}`);
          break;
      }
    }
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

  /** 一条时间线上的一个事件 → 一段 HTML。顺序就是发生的顺序。 */
  const beatHtml = (b: Beat): string => {
    switch (b.kind) {
      case "say":
        return `<div class="msg ${b.role}"><b>${b.role === "user" ? "客户" : "助手"}</b>${
          esc(b.text).replace(/\n/g, "<br/>")
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</div>`;

      case "floorPlan":
        return `<div class="beat sys">▣ 户型已录入：${b.walls} 段墙、${b.features} 个特征、` +
          `层高 ${b.ceilingHeight}"</div>`;

      case "questions":
        return `<div class="beat">
          <div class="note">系统就地给出选择题——选项来自公司真实规格库，价格影响由定价引擎算出。</div>
          ${b.questions.map((q: Json) => `
            <div class="qcard"><div class="qp">${esc(q.prompt)}</div>
              <div class="qw">${esc(q.why)}</div>
              <div class="opts">${(q.options ?? []).map((o: Json) => `
                <div class="opt${o.recommended ? " rec" : ""}"><span class="ol">${esc(o.label)}</span>
                ${o.detail ? `<span class="od">${esc(o.detail)}</span>` : ""}
                <span class="op">${esc(o.priceNote)}</span></div>`).join("")}</div></div>`).join("")}
        </div>`;

      case "answered":
        return `<div class="msg user"><b>客户（在选项上勾选）</b>${esc(b.note)}</div>`;

      case "planViews": {
        const changed = b.changed === undefined ? ""
          : b.changed ? `<span class="chg">← 排布已变</span>`
          : `<span class="same">（排布未变）</span>`;
        return `<div class="beat">
          <div class="bt">▤ 全局俯视图 ${esc(b.label)} ${changed}</div>
          <div class="mix"><code>${esc(b.mix)}</code></div>
          ${b.applied.length ? `<div class="note">应客户要求改动：${esc(b.applied.join("、"))}</div>` : ""}
          ${b.views.note ? `<div class="warn">${esc(b.views.note)}</div>` : ""}
          <div class="views">
            ${b.views.base ? `<figure>${b.views.base}<figcaption>地柜层</figcaption></figure>` : ""}
            ${b.views.wall ? `<figure>${b.views.wall}<figcaption>吊柜层</figcaption></figure>` : ""}
          </div>
        </div>`;
      }

      case "fourViews":
        return `<div class="beat">
          <div class="bt">▦ 完整四视图（人体工程${b.acceptable ? "全部通过" : "未通过"}）</div>
          ${b.explanation?.viewGuideHtml ?? ""}
          ${b.runs.map((run: Json) => {
            const per = (b.explanation?.perRun ?? []).find((p: Json) => p.runId === run.runId);
            return `<div class="run"><h4>${esc(run.runLabel)}</h4>
              <div class="views">${Object.entries(run.views as Record<string, string>)
                .map(([key, svg]) =>
                  `<figure>${svg}<figcaption>${VIEW_NAMES[key] ?? key}</figcaption></figure>`)
                .join("")}</div>
              ${per?.html ?? ""}</div>`;
          }).join("")}
        </div>`;

      case "quote":
        return `<div class="beat">
          <div class="bt">▥ 报价清单</div>
          ${b.ok ? (b.html ?? "") : `<p class="warn">${esc(b.error)}</p>`}
          <p class="quote">总计（含税运）：${esc(b.ok ? (b.total ?? "—") : "被拒")}</p>
        </div>`;

      case "audit":
        return `<div class="beat audit ${b.ok ? "pass" : "fail"}">
          <div class="bt">${b.ok ? "✔" : "✖"} 交付前审核（${esc(b.on)}）` +
          `<span class="note"> 跑了 ${b.checked.length} 项</span></div>
          ${b.text ? `<pre class="auditText">${esc(b.text)}</pre>` : ""}
        </div>`;

      case "note":
        return `<p class="${b.level === "warn" ? "warn" : "note"}">` +
          `${b.level === "warn" ? "⚠" : "·"} ${esc(b.text)}</p>`;
    }
  };

  const sections = results.map((r) => {
    const k = r.kitchen as Scenario;
    return `<section class="kitchen">
      <h2><span class="tag">${esc(k.id)}</span>${esc(k.name)}</h2>
      <p class="meta">${esc(k.shape)}　层高 ${k.ceilingHeight}"　${k.walls.length} 段墙　
        ${k.accountType === "trade" ? "建商（trade）" : "消费者"}账号</p>
      <p class="covers"><b>覆盖意图：</b>${esc(k.covers)}</p>
      <div class="timeline">${((r.timeline ?? []) as Beat[]).map(beatHtml).join("")}</div>
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
  /* 时间线：一条竖线串起所有事件，顺序即发生顺序 */
  .timeline { display:flex; flex-direction:column; gap:8px;
              border-left:2px solid #262b33; padding-left:16px; margin-top:14px; }
  .beat { background:#171c24; border:1px solid #262b33; border-radius:11px; padding:12px 14px; }
  .beat.sys { background:none; border:none; padding:2px 0; color:#8b94a3; font-size:12.5px; }
  .bt { font-size:13px; font-weight:600; margin-bottom:7px; }
  .mix code { font-size:11.5px; color:#9aa4b2; word-break:break-all; }
  .chg { color:#7bd88f; font-size:11.5px; font-weight:400; margin-left:6px; }
  .same { color:#8b94a3; font-size:11.5px; font-weight:400; margin-left:6px; }
  .beat.audit.pass { border-color:#2f5c3d; }
  .beat.audit.fail { border-color:#7a3b3b; background:#231a1a; }
  .auditText { font-size:11.5px; color:#c6cdd6; white-space:pre-wrap; margin:6px 0 0; }
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
<p class="lede">走真实 HTTP 端点。下面是一条<b>时间线</b>——每样东西出现在它真正被产出的那一刻：
客户先看到全局俯视图、在上面改，<b>改到认可之后</b>才有四视图与报价清单。</p>
<p class="src"><b>场景来源：</b>${set.source === "llm" ? "LLM 动态生成" : "确定性生成器"}　${esc(set.note)}</p>
${sections}
</div></body></html>`;
}

await main();
