/**
 * 单用例：意图驱动对话循环（非写死脚本）。
 *
 * - 用户 agent：人设 + 测试意图 + 私有世界，在系统/厂商引导下发挥
 * - harness：执行 UI 动作；上传后**对齐 simulate** 用蓝图 /resolve 补齐几何与家电，
 *   使 test:user 能走到出图/报价（纯聊天落库仍由对话路径覆盖）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionClient } from "../agents/types.js";
import {
  userAgentTurn, type UserAgentSource, type UserUiAction,
} from "../../scripts/user-agent.mts";
import type { TestScenarioBlueprint } from "./scenario-from-points.js";
import type { TestCaseResult } from "./types.js";
import type { TestFetch } from "./http-client.js";

export interface RunCaseInput {
  call: TestFetch;
  blueprint: TestScenarioBlueprint;
  accountId: string;
  userLlm?: CompletionClient;
  caseId: string;
}

interface Progress {
  floorPlanId?: string;
  floorUploaded: boolean;
  mentioned: boolean;
  stage?: string;
  readyToAskDesign: boolean;
  planViewOk: boolean;
  fourViewsOk: boolean;
  quoteOk: boolean;
  revisionDone: boolean;
  earlyFitBlocked: boolean;
  lastDesignLayoutId?: string;
  lastSelections?: unknown;
}

const SAMPLES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "samples",
);

/**
 * 上传户型：尽量带样例图字节（对齐 simulate）；再按蓝图 /resolve 写墙/层高/特征/家电。
 * 设 `TEST_USER_CHAT_ONLY=1` 时退回「仅元数据空壳」，强制走纯聊天落库。
 */
async function uploadAndSeedFloorplan(
  call: TestFetch,
  accountId: string,
  conversationId: string,
  bp: TestScenarioBlueprint,
  notes: string[],
): Promise<string> {
  const chatOnly = process.env.TEST_USER_CHAT_ONLY === "1"
    || process.env.TEST_USER_CHAT_ONLY === "true";

  let body: Record<string, unknown> = {
    fileName: `${bp.titleTag}.png`, mimeType: "image/png", sizeBytes: 102400,
  };
  const sampleName = bp.walls.length <= 1
    ? "sample-floorplan-minimal.png"
    : "sample-floorplan.png";
  const samplePath = path.join(SAMPLES_DIR, sampleName);
  if (!chatOnly && existsSync(samplePath)) {
    const bytes = readFileSync(samplePath);
    const mime = "image/png";
    body = {
      fileName: sampleName,
      mimeType: mime,
      sizeBytes: bytes.length,
      image: `data:${mime};base64,${bytes.toString("base64")}`,
    };
    notes.push("ui:upload_floorplan_image");
  } else {
    notes.push("ui:upload_floorplan_shell");
  }

  const fp = await call(`/api/conversations/${conversationId}/floorplan`, {
    method: "POST", accountId,
    body: JSON.stringify(body),
  });
  const floorPlanId = String((fp.floorPlan as { id: string }).id);

  if (chatOnly) return floorPlanId;

  // ── 对齐 simulate：蓝图几何 / 家电经 resolve 写入（出图链路可测）──
  const snap = await call(`/api/floorplans/${floorPlanId}`, { accountId });
  const existing = ((snap.floorPlan as {
    parsedGeometry?: { wallRuns?: { id: string; length: number }[] };
  })?.parsedGeometry?.wallRuns ?? []);

  for (let i = 0; i < bp.walls.length; i++) {
    const w = bp.walls[i]!;
    const run = existing[i];
    if (run?.id && (run.length ?? 0) <= 0) {
      await call(`/api/floorplans/${floorPlanId}/resolve`, {
        method: "POST", accountId,
        body: JSON.stringify({ wallRunId: run.id, length: w.length }),
      });
    } else if (!run?.id || (run.length ?? 0) <= 0) {
      await call(`/api/floorplans/${floorPlanId}/resolve`, {
        method: "POST", accountId,
        body: JSON.stringify({
          addRun: {
            label: w.label,
            length: w.length,
            ...(w.kind ? { kind: w.kind } : {}),
            ...(w.depth !== undefined ? { depth: w.depth } : {}),
          },
        }),
      });
    }
  }

  await call(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId,
    body: JSON.stringify({ ceilingHeight: bp.ceilingHeight }),
  });

  const afterGeom = await call(`/api/floorplans/${floorPlanId}`, { accountId });
  const runs = ((afterGeom.floorPlan as {
    parsedGeometry?: { wallRuns?: { id: string; label: string }[] };
  })?.parsedGeometry?.wallRuns ?? []);

  for (let wi = 0; wi < bp.walls.length; wi++) {
    const w = bp.walls[wi]!;
    const run = runs.find((r) => r.label === w.label) ?? runs[wi];
    if (!run?.id || !w.features?.length) continue;
    for (const f of w.features) {
      await call(`/api/floorplans/${floorPlanId}/resolve`, {
        method: "POST", accountId,
        body: JSON.stringify({
          addFeature: { wallRunId: run.id, kind: f.kind, offset: f.offset, width: f.width },
        }),
      });
    }
  }

  if (bp.appliances?.length) {
    await call(`/api/floorplans/${floorPlanId}/resolve`, {
      method: "POST", accountId,
      body: JSON.stringify({
        appliances: bp.appliances.map((a) => ({
          kind: a.kind,
          ...(a.width !== undefined ? { width: a.width } : {}),
        })),
      }),
    });
  }

  const pending = await call(`/api/floorplans/${floorPlanId}`, { accountId });
  for (const u of ((pending.floorPlan as { unresolvedItems?: { id: string; resolved?: boolean }[] })
    ?.unresolvedItems ?? [])) {
    if (u.resolved) continue;
    await call(`/api/floorplans/${floorPlanId}/resolve`, {
      method: "POST", accountId,
      body: JSON.stringify({ itemId: u.id }),
    });
  }

  // 封口意图字段（风格/预算/省/窗），与 simulate FR-15 seal 同目的
  const seal = [
    bp.facts.style ? `${bp.facts.style} style.` : "Modern style.",
    bp.facts.budget ?? "Budget CAD $10–20k.",
    bp.facts.province ?? "Ontario ON.",
    bp.facts.windows ?? "No windows.",
    bp.facts.appliances ?? "",
  ].filter(Boolean).join(" ");
  await call(`/api/conversations/${conversationId}/messages`, {
    method: "POST", accountId,
    body: JSON.stringify({ text: seal }),
  });
  notes.push("ui:seed_geometry_like_simulate");

  return floorPlanId;
}

function progressHint(p: Progress, bp: TestScenarioBlueprint): string {
  const bits = [
    `persona=${bp.persona}`,
    `floorplan=${p.floorUploaded ? "uploaded" : "not yet"}`,
    `stage=${p.stage ?? "unknown"}`,
    `readyToAskDesign=${p.readyToAskDesign}`,
    `planView=${p.planViewOk}`,
    `fourViews=${p.fourViewsOk}`,
    `quote=${p.quoteOk}`,
    `mentionedSeller=${p.mentioned}`,
  ];
  if (p.floorUploaded && !p.readyToAskDesign && p.stage === "collecting") {
    bits.push(
      "HINT: still collecting — answer open asks from PRIVATE WORLD "
        + "(style/budget/province/appliances if missing); "
        + "if they say space is too tight, shrink appliances or give longer walls; "
        + "do not spam consent_design until readyToAskDesign=true",
    );
  }
  if (p.readyToAskDesign && !p.planViewOk) {
    bits.push("HINT: ready — prefer consent_design / yes to generate");
  }
  if (p.planViewOk && (bp.observe.fourViews || bp.observe.quote) && !p.fourViewsOk) {
    bits.push("HINT: plan overview ready — prefer approve_plan or request_quote if that matches your goals");
  }
  if (bp.observe.mentionCompany && !p.mentioned) {
    bits.push(`HINT: when product price/SKU comes up, @ ${bp.companyMention}`);
  }
  return bits.join("; ");
}

function maxTurns(persona: TestScenarioBlueprint["persona"]): number {
  if (persona === "beginner") return 16;
  if (persona === "trade_pro") return 12;
  return 14;
}

function goalsSatisfied(bp: TestScenarioBlueprint, p: Progress): boolean {
  const o = bp.observe;
  if (o.earlyFitBlock) {
    return p.earlyFitBlocked;
  }
  if (o.mentionCompany && !p.mentioned) return false;
  if (o.planView && !p.planViewOk) return false;
  if (o.fourViews && !p.fourViewsOk) return false;
  if (o.quote && !p.quoteOk) return false;
  if (o.revision && !p.revisionDone) return false;
  if (!o.mentionCompany && !o.planView && !o.fourViews && !o.quote && !o.revision) {
    return p.readyToAskDesign || p.planViewOk || p.stage === "readyToDraw";
  }
  return true;
}

async function refreshStage(
  call: TestFetch,
  accountId: string,
  conversationId: string,
  companyId: string,
  p: Progress,
): Promise<void> {
  const designSnap = await call(
    `/api/conversations/${conversationId}/design?companyId=${encodeURIComponent(companyId)}`,
    { accountId },
  );
  p.stage = (designSnap.session as { stage?: string } | undefined)?.stage;
  p.readyToAskDesign = Boolean(
    (designSnap.designBrief as { readyToAskDesign?: boolean } | undefined)?.readyToAskDesign,
  );
  const open = ((designSnap.designBrief as {
    openItems?: { id?: string; status?: string; brief?: string }[];
  } | undefined)?.openItems ?? []);
  const fitBlocked = open.some((i) => i.id === "appliances_fit" && i.status === "missing")
    || open.some((i) => /放不下|need more wall|墙长超过|too tight/i.test(String(i.brief ?? "")));
  if (fitBlocked) p.earlyFitBlocked = true;
}

async function runUiAction(
  action: UserUiAction,
  ctx: {
    call: TestFetch;
    accountId: string;
    conversationId: string;
    bp: TestScenarioBlueprint;
    progress: Progress;
    notes: string[];
    errors: string[];
    userText: string;
  },
): Promise<void> {
  const { call, accountId, conversationId, bp, progress: p, notes, errors } = ctx;
  if (action === "none") return;

  if (action === "upload_floorplan") {
    if (p.floorUploaded && p.floorPlanId) {
      notes.push("ui:upload_skip");
      return;
    }
    p.floorPlanId = await uploadAndSeedFloorplan(call, accountId, conversationId, bp, notes);
    p.floorUploaded = true;
    await refreshStage(call, accountId, conversationId, bp.companyId, p);
    return;
  }

  if (action === "consent_design") {
    await refreshStage(call, accountId, conversationId, bp.companyId, p);
    if (p.stage !== "readyToDraw" && p.stage !== "planReview") {
      notes.push(`ui:consent_wait:stage=${p.stage ?? "?"};ready=${p.readyToAskDesign}`);
      return;
    }
    if (p.stage === "planReview" && p.planViewOk) {
      notes.push("ui:consent_skip:already_planReview");
      return;
    }
    const adv = await call(`/api/conversations/${conversationId}/design/advance`, {
      method: "POST", accountId,
      body: JSON.stringify({ companyId: bp.companyId, action: "consent", note: "ok draw" }),
    });
    notes.push(`ui:consent:${String(adv.__status ?? "")}`);
    if (!p.floorPlanId) {
      errors.push("consent without floorPlanId");
      return;
    }
    const pv = await call(`/api/floorplans/${p.floorPlanId}/plan-view`, {
      method: "POST", accountId,
      body: JSON.stringify({ companyId: bp.companyId }),
    });
    const st = Number(pv.__status ?? 0);
    notes.push(`ui:planView:${st}`);
    if (st >= 200 && st < 300) p.planViewOk = true;
    else if (st >= 400) errors.push(`planView ${String(pv.error ?? st)}`);
    await refreshStage(call, accountId, conversationId, bp.companyId, p);
    return;
  }

  if (action === "approve_plan") {
    if (!p.planViewOk) {
      notes.push("ui:approve_wait:no_plan");
      return;
    }
    const adv = await call(`/api/conversations/${conversationId}/design/advance`, {
      method: "POST", accountId,
      body: JSON.stringify({ companyId: bp.companyId, action: "approvePlan" }),
    });
    notes.push(`ui:approve:${String(adv.__status ?? "")}`);
    if (!p.floorPlanId) return;
    const layout = await call(`/api/floorplans/${p.floorPlanId}/layout`, {
      method: "POST", accountId,
      body: JSON.stringify({ companyId: bp.companyId }),
    });
    const st = Number(layout.__status ?? 0);
    notes.push(`ui:fourViews:${st}`);
    if (st >= 200 && st < 300) {
      p.fourViewsOk = true;
      p.lastDesignLayoutId = String(
        (layout.designLayoutId as string | undefined)
        ?? (layout.layoutKey as string | undefined)
        ?? "",
      ) || undefined;
      p.lastSelections = layout.selections;
    } else if (st >= 400) {
      errors.push(`layout ${String(layout.error ?? st)}`);
    }
    await refreshStage(call, accountId, conversationId, bp.companyId, p);
    return;
  }

  if (action === "request_quote") {
    if (!p.fourViewsOk && p.planViewOk) {
      await runUiAction("approve_plan", ctx);
    }
    if (!p.lastSelections && p.floorPlanId) {
      const layout = await call(`/api/floorplans/${p.floorPlanId}/layout`, {
        method: "POST", accountId,
        body: JSON.stringify({ companyId: bp.companyId }),
      });
      if (Number(layout.__status ?? 0) < 300) {
        p.fourViewsOk = true;
        p.lastSelections = layout.selections;
      }
    }
    const quote = await call("/api/quotes", {
      method: "POST", accountId,
      body: JSON.stringify({
        companyId: bp.companyId,
        conversationId,
        doorStyleId: bp.prefs.doorStyleId ?? "ds_shaker_white",
        selections: p.lastSelections ?? [],
      }),
    });
    const st = Number(quote.__status ?? 0);
    notes.push(`ui:quote:${st}`);
    if (st >= 200 && st < 300) p.quoteOk = true;
    else if (st >= 400 && st !== 409) errors.push(`quote ${String(quote.error ?? st)}`);
    await refreshStage(call, accountId, conversationId, bp.companyId, p);
    return;
  }

  if (action === "revise_plan") {
    if (!p.planViewOk) {
      notes.push("ui:revise_wait");
      return;
    }
    const adv = await call(`/api/conversations/${conversationId}/design/advance`, {
      method: "POST", accountId,
      body: JSON.stringify({
        companyId: bp.companyId,
        action: "revise",
        note: ctx.userText.slice(0, 120) || "look grander",
        changes: {},
      }),
    });
    notes.push(`ui:revise:${String(adv.__status ?? "")}`);
    if (Number(adv.__status ?? 0) < 300) p.revisionDone = true;
    await refreshStage(call, accountId, conversationId, bp.companyId, p);
  }
}

export async function runTestCase(input: RunCaseInput): Promise<TestCaseResult> {
  const { call, blueprint: bp, accountId, userLlm, caseId } = input;
  const startedAt = new Date().toISOString();
  const notes: string[] = [`persona:${bp.persona}`];
  const errors: string[] = [];
  let userAgentSource: UserAgentSource = "deterministic";
  let conversationId: string | undefined;
  const title = bp.titleTag;
  const progress: Progress = {
    floorUploaded: false,
    mentioned: false,
    readyToAskDesign: false,
    planViewOk: false,
    fourViewsOk: false,
    quoteOk: false,
    revisionDone: false,
    earlyFitBlocked: false,
  };

  try {
    const created = await call("/api/conversations", {
      method: "POST",
      accountId,
      body: JSON.stringify({
        tags: ["test-user", `persona:${bp.persona}`, ...bp.pointIds],
      }),
    });
    if ((created.__status as number) >= 400) {
      throw new Error(`create conversation failed: ${JSON.stringify(created)}`);
    }
    conversationId = String((created.conversation as { id: string }).id);
    const assistantHistory: string[] = [];
    const turns = maxTurns(bp.persona);

    for (let i = 0; i < turns; i++) {
      const opening = i === 0;
      const turn = await userAgentTurn({
        client: userLlm,
        facts: bp.facts,
        persona: bp.persona,
        mission: bp.mission,
        assistantHistory,
        opening,
        progressHint: progressHint(progress, bp),
      });
      userAgentSource = turn.source;

      let text = turn.text;
      if (opening && !text.startsWith("test-")) {
        text = `${title}: ${text}`;
      }

      if (text.includes("@") && bp.companyMention && text.includes(bp.companyMention)) {
        progress.mentioned = true;
        notes.push("mention:chat");
      }

      const r = await call(`/api/conversations/${conversationId}/messages`, {
        method: "POST", accountId,
        body: JSON.stringify({ text }),
      });
      for (const reply of (r.replies as { content?: string; companyId?: string }[] | undefined) ?? []) {
        if (reply.content) assistantHistory.push(reply.content);
        if (reply.companyId === bp.companyId) {
          progress.mentioned = true;
          notes.push("mention:routed");
        }
        if (/空间不够|Space check|放不下|need more wall|墙长超过/i.test(reply.content ?? "")) {
          progress.earlyFitBlocked = true;
          notes.push("early_fit:chat");
        }
      }
      if (r.designBrief && (r.designBrief as { readyToAskDesign?: boolean }).readyToAskDesign) {
        progress.readyToAskDesign = true;
      }

      let action = turn.uiAction;
      const last = assistantHistory[assistantHistory.length - 1] ?? "";
      if (
        action === "none"
        && /shall i generate|需要我帮你生成设计/i.test(last)
        && /\b(yes|ok|okay|sure|please)\b|好的|可以|出一版|出图|生成/i.test(text)
        && (progress.readyToAskDesign || progress.stage === "readyToDraw")
      ) {
        action = "consent_design";
      }
      // 资料已齐仍未出图：主动同意出图（对齐 simulate）
      if (
        action === "none"
        && progress.readyToAskDesign
        && !progress.planViewOk
        && (bp.observe.planView || bp.observe.fourViews || bp.observe.quote)
        && i >= 1
      ) {
        action = "consent_design";
        notes.push("ui:auto_consent_when_ready");
      }
      if (
        progress.planViewOk
        && (action === "consent_design" || action === "none")
        && (bp.observe.fourViews || bp.observe.quote)
        && !progress.fourViewsOk
        && i >= 2
      ) {
        action = bp.observe.quote ? "request_quote" : "approve_plan";
      }
      if (
        action === "consent_design"
        && !progress.readyToAskDesign
        && progress.stage !== "readyToDraw"
      ) {
        if (!progress.floorUploaded && (bp.observe.planView || bp.observe.fourViews)) {
          action = "upload_floorplan";
          notes.push("ui:consent→upload");
        } else {
          action = "none";
          notes.push("ui:consent_ignored_not_ready");
        }
      }
      if (action !== "none") {
        await runUiAction(action, {
          call, accountId, conversationId: conversationId!, bp, progress, notes, errors, userText: text,
        });
      }

      // 开场后尽快上传，便于 seed 几何
      if (
        !progress.floorUploaded
        && (bp.observe.planView || bp.observe.fourViews || bp.observe.quote)
        && i === 0
      ) {
        await runUiAction("upload_floorplan", {
          call, accountId, conversationId: conversationId!, bp, progress, notes, errors, userText: text,
        });
      }

      await refreshStage(call, accountId, conversationId!, bp.companyId, progress);

      if (goalsSatisfied(bp, progress)) {
        notes.push(`done@turn:${i + 1}`);
        break;
      }
    }

    const o = bp.observe;
    if (o.earlyFitBlock && !progress.earlyFitBlocked) {
      errors.push("goal:earlyFitBlock not reached (expected appliances_fit to block)");
    }
    if (o.mentionCompany && !progress.mentioned) errors.push("goal:mentionCompany not reached");
    if (o.planView && !progress.planViewOk) errors.push("goal:planView not reached");
    if (o.fourViews && !progress.fourViewsOk) errors.push("goal:fourViews not reached");
    if (o.quote && !progress.quoteOk) errors.push("goal:quote not reached");
    if (o.revision && !progress.revisionDone) errors.push("goal:revision not reached");

    return {
      id: caseId,
      title,
      pointIds: bp.pointIds,
      persona: bp.persona,
      status: errors.length ? "failed" : "passed",
      conversationId,
      startedAt,
      finishedAt: new Date().toISOString(),
      notes: [...notes, `userAgent:${userAgentSource}`],
      errors,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      id: caseId,
      title,
      pointIds: bp.pointIds,
      persona: bp.persona,
      status: "failed",
      conversationId,
      startedAt,
      finishedAt: new Date().toISOString(),
      notes,
      errors: [...errors, msg],
    };
  }
}
