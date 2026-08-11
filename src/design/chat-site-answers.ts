/**
 * 把对话里对现场特征（上下水/窗/门/层高）的确认写回 FloorPlan。
 *
 * Design Basis / 排布都读 plan.features；若只把句子记进 designRequirements，
 * 会出现「聊过了但 Tab1 仍显示未确认、永远进不了出图」的断裂。
 *
 * FR-19：客户按 Q# 作答时同样走此路径。
 */
import type { FloorPlan, WallFeatureKind, WallRun } from "../floorplan/types.js";
import { addFeature, addWallRun, resolveCeilingHeight, resolveItem, resolveWallLength } from "../floorplan/parse.js";
import { wallRunProvenance } from "../floorplan/design-input.js";
import { compassWallsAdjacent } from "../layout/plan-model.js";
import type { SiteQuestion } from "./site-questions.js";
import type { BlockedEdit } from "./confirm-lock.js";

const DEFAULT_PLUMBING_WIDTH = 24;
const DEFAULT_WINDOW_WIDTH = 36;
const DEFAULT_DOOR_WIDTH = 32;
const DEFAULT_PLUMBING_OFFSET_RATIO = 0.4;

/**
 * 墙名/方位与数字之间容许的口语插入词——"North **about** 7 ft" 这类含糊表述
 * 不该因为中间多了一个 "about"/"大概" 就让整段墙长解析失败（beginner 人设的
 * 真实说法，见测试报告 Bug②）。
 */
const HEDGE_WORDS = "\\s*(?:(?:is|are|was|were|about|around|roughly|approx(?:imately)?|"
  + "maybe|probably|like|大概|大约|差不多|将近|好像|可能)\\s*)?";

export interface ParsedFeatureAnswer {
  wallRunId: string;
  offset: number;
  width: number;
}

export interface ParsedCeilingAnswer {
  height: number;
}

export type ChatSiteApplyKind = "plumbing" | "window" | "door" | "ceiling" | "wallLength";

export interface ChatSiteApplyResult {
  plan: FloorPlan;
  applied: ChatSiteApplyKind[];
  /** 被"确认锁"拦下的修改尝试（已确认字段被聊天新数值撞上，未写入）。 */
  blockedEdits: BlockedEdit[];
}

/** 从客户话术解析上下水位置；能落到某段墙才返回。 */
export function parsePlumbingFromChat(
  text: string,
  plan: FloorPlan,
): ParsedFeatureAnswer | undefined {
  const runs = plan.parsedGeometry.wallRuns.filter((r) => r.length > 0);
  if (runs.length === 0) return undefined;
  if (!mentionsPlumbing(text)) return undefined;
  if (isDeferPlumbing(text)) return undefined;

  const wall = resolveWallMention(text, runs);
  if (!wall) return undefined;

  const offset = parseOffset(text, wall.length, DEFAULT_PLUMBING_WIDTH);
  const width = Math.min(DEFAULT_PLUMBING_WIDTH, wall.length);
  const maxOffset = Math.max(0, wall.length - width);
  const clamped = Math.max(0, Math.min(offset, maxOffset));
  return { wallRunId: wall.id, offset: clamped, width };
}

export function isDeferPlumbing(text: string): boolean {
  return /no plumbing|without plumbing|plumbing later|sink later|后装(下水|水管)|暂无上下水|没有上下水|下水稍后|水槽后定/i
    .test(text);
}

export function isDeferWindows(text: string): boolean {
  return /no windows?|without windows?|没有窗|无窗|这几面墙没有窗|walls? have no windows?/i.test(text);
}

export function isDeferDoors(text: string): boolean {
  return /no doors?|without doors?|没有门洞|无门洞|no door openings?/i.test(text);
}

/** 层高：`Q1: 96` / `ceiling 8 ft` / `层高 240cm` / 纯数字答 Q#。 */
export function parseCeilingFromChat(text: string): ParsedCeilingAnswer | undefined {
  const trimmed = text.trim();
  const inRange = (n: number) => n >= 84 && n <= 144;
  const fromUnit = (raw: string, unitRaw: string | undefined): number | undefined => {
    let n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    const unit = (unitRaw ?? "").toLowerCase();
    if (unit === "ft" || unit === "feet" || unit === "'" || unit === "尺") n *= 12;
    if (unit === "cm") n = Math.round(n / 2.54);
    return inRange(n) ? Math.round(n) : undefined;
  };

  // Q# 答层高：`Q1: 96` / `Q1 96"` / `答Q1：108`（过去整句带 Q 时 pureNumber 失败 → 层高「失忆」）
  const qAns = trimmed.match(
    /^\s*Q\s*(\d+)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(["″]|in(?:ch(?:es)?)?|ft|feet|'|尺|寸|cm)?\s*$/i,
  );
  if (qAns) {
    const h = fromUnit(qAns[2]!, qAns[3]);
    if (h !== undefined) return { height: h };
  }

  const pureNumber = /^\s*(\d+(?:\.\d+)?)\s*(?:["″]|in(?:ch(?:es)?)?|ft|feet|'|尺|寸|cm)?\s*$/i.exec(trimmed);
  const hasCeilingWord = /ceiling|层高|净高|天花|吊顶/i.test(text);
  if (!hasCeilingWord && !pureNumber) return undefined;

  if (hasCeilingWord) {
    const ft = text.match(
      /(?:ceiling|层高|净高|天花|吊顶)[^\d]{0,24}(\d+(?:\.\d+)?)\s*(?:ft|feet|')\b/i,
    );
    if (ft) {
      const h = fromUnit(ft[1]!, "ft");
      if (h !== undefined) return { height: h };
    }
    const cm = text.match(
      /(?:ceiling|层高|净高|天花|吊顶)[^\d]{0,24}(\d+(?:\.\d+)?)\s*cm\b/i,
    );
    if (cm) {
      const h = fromUnit(cm[1]!, "cm");
      if (h !== undefined) return { height: h };
    }
    const chi = text.match(
      /(?:ceiling|层高|净高|天花|吊顶)[^\d]{0,24}(\d+(?:\.\d+)?)\s*尺/i,
    );
    if (chi) {
      const h = fromUnit(chi[1]!, "尺");
      if (h !== undefined) return { height: h };
    }
    const inch = text.match(
      /(?:ceiling|层高|净高|天花|吊顶)[^\d]{0,24}(\d+(?:\.\d+)?)\s*(?:["″]|in(?:ch(?:es)?)?|寸)?/i,
    );
    if (inch) {
      const h = fromUnit(inch[1]!, inch[0].match(/ft|feet|尺|cm/i)?.[0]);
      if (h !== undefined) return { height: h };
    }
  }

  if (pureNumber) {
    const h = fromUnit(pureNumber[1]!, pureNumber[0].match(/ft|feet|尺|cm/i)?.[0]);
    if (h !== undefined) return { height: h };
  }
  return undefined;
}

/** 窗：墙名 + 尺寸；或「no windows」。 */
export function parseWindowFromChat(
  text: string,
  plan: FloorPlan,
): ParsedFeatureAnswer | "none" | undefined {
  if (isDeferWindows(text)) return "none";
  if (!/window|窗/i.test(text)) return undefined;
  const runs = plan.parsedGeometry.wallRuns.filter((r) => r.length > 0);
  if (runs.length === 0) return undefined;
  const wall = resolveWallMention(text, runs);
  if (!wall) return undefined;
  const width = parseWidth(text, DEFAULT_WINDOW_WIDTH, wall.length);
  const offset = parseOffset(text, wall.length, width);
  const maxOffset = Math.max(0, wall.length - width);
  return {
    wallRunId: wall.id,
    offset: Math.max(0, Math.min(offset, maxOffset)),
    width,
  };
}

/** 门洞。 */
export function parseDoorFromChat(
  text: string,
  plan: FloorPlan,
): ParsedFeatureAnswer | "none" | undefined {
  if (isDeferDoors(text)) return "none";
  if (!/door|门洞|门口|开门/i.test(text)) return undefined;
  // 避免把门板样式（door style）误当成门洞
  if (/door\s*style|门板|shaker|slab/i.test(text) && !/opening|门洞|门口/i.test(text)) {
    return undefined;
  }
  const runs = plan.parsedGeometry.wallRuns.filter((r) => r.length > 0);
  if (runs.length === 0) return undefined;
  const wall = resolveWallMention(text, runs);
  if (!wall) return undefined;
  const width = parseWidth(text, DEFAULT_DOOR_WIDTH, wall.length);
  const offset = parseOffset(text, wall.length, width);
  const maxOffset = Math.max(0, wall.length - width);
  return {
    wallRunId: wall.id,
    offset: Math.max(0, Math.min(offset, maxOffset)),
    width,
  };
}

/**
 * 若本轮话术能解析出上下水，写入 features 并返回新 plan；否则 undefined。
 * 已有 plumbing feature 时不覆盖。
 */
export function applyChatPlumbingAnswer(
  plan: FloorPlan,
  text: string,
  at: string,
): FloorPlan | undefined {
  const already = plan.parsedGeometry.wallRuns.some((r) =>
    r.features.some((f) => f.kind === "plumbing"));
  if (already) return undefined;
  const parsed = parsePlumbingFromChat(text, plan);
  if (!parsed) return undefined;
  return addFeature(plan, parsed.wallRunId, {
    kind: "plumbing",
    offset: parsed.offset,
    width: parsed.width,
  }, at);
}

/** 墙长英寸：支持 ft / inches / cm / 尺。 */
export function parseWallLengthInches(
  raw: string,
  unitRaw: string | undefined,
): number | undefined {
  let n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const unit = (unitRaw ?? "").toLowerCase();
  if (unit === "ft" || unit === "feet" || unit === "'" || unit === "尺") n *= 12;
  else if (unit === "cm") n = Math.round(n / 2.54);
  // 无单位：12–20 更像英尺口语；≥24 当英寸
  else if (!unit) {
    if (n >= 8 && n <= 20) n *= 12;
  }
  if (!(n >= 24 && n <= 360)) return undefined;
  return Math.round(n);
}

const ORIENT_LABEL: Record<string, string> = {
  left: "Left", right: "Right", back: "Back", front: "Front",
  long: "Long", short: "Short",
  north: "North", south: "South", east: "East", west: "West",
  左: "Left", 右: "Right", 前: "Front", 后: "Back",
  东: "East", 南: "South", 西: "West", 北: "North",
};

/**
 * 已确认（无待处理项）的墙长被聊天新解析出的不同数值撞上时，不静默覆盖——
 * 记一条 `BlockedEdit`，由上层引导客户去"已确认"面板手动改（见 `confirm-lock.ts`）。
 * 墙段还没定长（`length === 0`）或还挂着待确认项时，照常写入，不算"改已确认的"。
 */
function tryResolveWallLength(
  plan: FloorPlan,
  runId: string,
  inches: number,
  at: string,
  blocked: BlockedEdit[],
): { plan: FloorPlan; changed: boolean } {
  const run = plan.parsedGeometry.wallRuns.find((r) => r.id === runId);
  if (!run || run.length === inches) return { plan, changed: false };
  if (run.length > 0 && wallRunProvenance(plan, runId) === "customer") {
    blocked.push({ kind: "wallLength", label: run.label, current: run.length, attempted: inches });
    return { plan, changed: false };
  }
  return { plan: resolveWallLength(plan, runId, inches, at), changed: true };
}

/**
 * 手输墙长：`North 84"` / `left wall 12ft` / `南墙 120"` —— 识图失败或无图对话的主路径。
 * 若计划里还没有对应墙段，会按口语方向新建（L 型 left+back 等）。
 *
 * `blockedOut` 可选——传入一个数组来接收被"确认锁"拦下的修改尝试（不传不影响行为）。
 */
export function applyChatWallLengths(
  plan: FloorPlan,
  text: string,
  at: string,
  blockedOut?: BlockedEdit[],
): FloorPlan | undefined {
  let next = plan;
  let changed = false;
  const blocked: BlockedEdit[] = [];

  // 1) 更新已有 label 匹配的墙
  for (const run of next.parsedGeometry.wallRuns) {
    const lab = run.label.trim();
    if (!lab) continue;
    const esc = lab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(?:^|[^\\w])${esc}\\s*(?:墙|wall|leg)?${HEDGE_WORDS}[:=]?\\s*(\\d+(?:\\.\\d+)?)`
        // 单位前的空白必须跟单位绑在一起，否则会吞掉「East 120 North 144」里下一墙前的空格
        + `(?:\\s*(ft|feet|'|尺|["″]|in(?:ch(?:es)?)?|寸|cm))?`
        + `(?!\\s*(?:["″]\\s*)?from)`,
      "i",
    );
    const m = text.match(re);
    if (!m) continue;
    const n = parseWallLengthInches(m[1]!, m[2]);
    if (n === undefined) continue;
    const r = tryResolveWallLength(next, run.id, n, at, blocked);
    next = r.plan;
    if (r.changed) changed = true;
  }

  // 2) 口语方向：left/back/long leg 等 → 新建或更新
  const mentionRe = new RegExp(
    `(?:^|[^\\w])(?:(left|right|back|front|long|short|north|south|east|west)\\s*(?:wall|leg)?`
      // 「wall A」「A墙」「A 墙」——字母后可选紧跟中文「墙」（口语常见写法，非「wall A: 120」不受影响）
      + `|(?:wall\\s*)?([A-D])\\s*墙?`
      + `|([东西南北左右前后])(?:侧)?墙)`
      + `${HEDGE_WORDS}[:=]?\\s*(\\d+(?:\\.\\d+)?)`
      + `(?:\\s*(ft|feet|'|尺|["″]|in(?:ch(?:es)?)?|寸|cm))?`
      + `(?!\\s*(?:["″]\\s*)?from)`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(text)) !== null) {
    const key = (m[1] ?? m[3] ?? "").toLowerCase();
    const letter = (m[2] ?? "").toUpperCase();
    const inches = parseWallLengthInches(m[4]!, m[5]);
    if (inches === undefined) continue;

    let label = key ? (ORIENT_LABEL[key] ?? key) : (letter ? `Wall ${letter}` : "");
    if (!label) continue;

    const existing = next.parsedGeometry.wallRuns.find((r) =>
      r.label.toLowerCase() === label.toLowerCase()
      || (key && new RegExp(`^${key}\\b`, "i").test(r.label)));
    if (existing) {
      const r = tryResolveWallLength(next, existing.id, inches, at, blocked);
      next = r.plan;
      if (r.changed) changed = true;
      continue;
    }
    next = addWallRun(next, {
      label,
      length: inches,
      startsAtCorner: shouldJoinNewWall(next, label),
      endsAtCorner: false,
    }, at);
    changed = true;
  }

  // 3) L/U 型 + 「12ft / 10ft」无墙名时，按常见口语补两段（仅空壳或墙长未齐时）
  if (
    /l\s*-?\s*shape|l\s*型|u\s*-?\s*shape|u\s*型/i.test(text)
    && next.parsedGeometry.wallRuns.filter((r) => r.length > 0).length < 2
  ) {
    const ftHits = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(ft|feet|'|尺)\b/gi)]
      .map((x) => parseWallLengthInches(x[1]!, x[2]))
      .filter((n): n is number => n !== undefined);
    if (ftHits.length >= 2) {
      const labels = /u\s*-?\s*shape|u\s*型/i.test(text)
        ? ["Left", "Back", "Right"]
        : ["Left", "Back"];
      for (let i = 0; i < labels.length && i < ftHits.length; i++) {
        const label = labels[i]!;
        const inches = ftHits[i]!;
        const existing = next.parsedGeometry.wallRuns.find((r) =>
          r.label.toLowerCase() === label.toLowerCase());
        if (existing) {
          const r = tryResolveWallLength(next, existing.id, inches, at, blocked);
          next = r.plan;
          if (r.changed) changed = true;
        } else {
          next = addWallRun(next, {
            label,
            length: inches,
            startsAtCorner: shouldJoinNewWall(next, label),
            endsAtCorner: false,
          }, at);
          changed = true;
        }
      }
    }
  }

  // 4) 快捷回答：「One wall ~12 ft」/「两面墙各 10 尺」——必须落成墙段，不能只当 intake 关键词
  {
    const known = () => next.parsedGeometry.wallRuns.filter((r) => r.length > 0).length;
    const twoEach = text.match(
      /(?:two\s+walls?|两面墙(?:各)?)[^\d]{0,24}(\d+(?:\.\d+)?)\s*(ft|feet|'|尺|["″]|in(?:ch(?:es)?)?|寸|cm)?/i,
    );
    const one = !twoEach
      ? text.match(
        /(?:one\s+wall|一面墙)[^\d]{0,16}~?\s*(\d+(?:\.\d+)?)\s*(ft|feet|'|尺|["″]|in(?:ch(?:es)?)?|寸|cm)?/i,
      )
      : null;

    if (twoEach && known() < 2) {
      const inches = parseWallLengthInches(twoEach[1]!, twoEach[2]);
      if (inches !== undefined) {
        for (const label of ["Wall A", "Wall B"]) {
          const existing = next.parsedGeometry.wallRuns.find((r) =>
            r.label.toLowerCase() === label.toLowerCase());
          if (existing) {
            const r = tryResolveWallLength(next, existing.id, inches, at, blocked);
            next = r.plan;
            if (r.changed) changed = true;
          } else {
            next = addWallRun(next, {
              label,
              length: inches,
              startsAtCorner: shouldJoinNewWall(next, label),
              endsAtCorner: false,
            }, at);
            changed = true;
          }
        }
      }
    } else if (one && known() === 0) {
      const inches = parseWallLengthInches(one[1]!, one[2]);
      if (inches !== undefined) {
        next = addWallRun(next, {
          label: "Wall A",
          length: inches,
          startsAtCorner: false,
          endsAtCorner: false,
        }, at);
        changed = true;
      }
    }
  }

  if (blockedOut) {
    // 同一面墙可能同时命中「标签匹配」与「口语方位」两条规则，被拦下的是
    // 同一次修改尝试——按 (墙名, 想改成的值) 去重，不重复上报。
    const seen = new Set<string>();
    for (const b of blocked) {
      const key = `${b.label} ${b.attempted}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blockedOut.push(b);
    }
  }
  return changed ? next : undefined;
}

/** 罗盘相对墙（东西对望）不得当成内墙角相接，否则会画出假 L 并把方位画反。 */
function shouldJoinNewWall(plan: FloorPlan, newLabel: string): boolean {
  const prev = [...plan.parsedGeometry.wallRuns].reverse().find((r) => r.kind !== "island");
  if (!prev || prev.length <= 0) return false;
  if (compassWallsAdjacent(prev.label, newLabel) === false) return false;
  return true;
}

/** 文本是否像在报墙长/层高（用于无户型时建壳）。 */
export function chatMentionsGeometry(text: string): boolean {
  if (/ceiling|层高|净高|天花|吊顶/i.test(text) && /\d/.test(text)) return true;
  if (/(?:left|right|back|front|long|short|north|south|east|west)\s*(?:wall|leg)/i.test(text)
    && /\d/.test(text)) {
    return true;
  }
  if (/[东西南北左右前后](?:侧)?墙/.test(text) && /\d/.test(text)) return true;
  if (/\b(?:wall\s*)?[A-D]\b\s*[:=]?\s*\d+/i.test(text)) return true;
  // 「A墙120」——字母直接接中文「墙」，不带空格/冒号（口语常见，非「wall A」也非方位墙）
  if (/\b[A-D]\s*墙/i.test(text) && /\d/.test(text)) return true;
  if (/\b(?:North|South|East|West)\s*[:=]?\s*\d+/i.test(text)) return true;
  // 快捷回答：One wall ~12 ft / 两面墙各 10 尺
  if (/(?:one\s+wall|two\s+walls?|一面墙|两面墙)/i.test(text) && /\d/.test(text)) return true;
  return false;
}

/**
 * 一次尝试解析并写入：墙长 / 层高 / 上下水 / 窗 / 门（可多项）。
 * 无任何落库时返回 undefined。
 *
 * `siteQuestions` 用于把「Q3: 36」绑到出题时的 wallRunId/kind，避免裸数字落到层高或错墙。
 */
export function applyChatSiteAnswers(
  plan: FloorPlan,
  text: string,
  at: string,
  siteQuestions?: readonly SiteQuestion[],
): ChatSiteApplyResult | undefined {
  let next = plan;
  const applied: ChatSiteApplyKind[] = [];
  const blockedEdits: BlockedEdit[] = [];

  if (siteQuestions && siteQuestions.length > 0) {
    const numbered = applyNumberedSiteAnswers(next, text, at, siteQuestions);
    if (numbered) {
      next = numbered.plan;
      for (const k of numbered.applied) {
        if (!applied.includes(k)) applied.push(k);
      }
    }
  }

  const walls = applyChatWallLengths(next, text, at, blockedEdits);
  if (walls) {
    next = walls;
    applied.push("wallLength");
  }

  if (next.parsedGeometry.ceilingHeight == null) {
    const ceil = parseCeilingFromChat(text);
    if (ceil) {
      next = resolveCeilingHeight(next, ceil.height, at);
      applied.push("ceiling");
    }
  }

  const hasKind = (kind: WallFeatureKind) =>
    next.parsedGeometry.wallRuns.some((r) => r.features.some((f) => f.kind === kind));

  if (!hasKind("plumbing")) {
    const p = parsePlumbingFromChat(text, next);
    if (p) {
      next = addFeature(next, p.wallRunId, {
        kind: "plumbing", offset: p.offset, width: p.width,
      }, at);
      applied.push("plumbing");
    }
  }

  if (!hasKind("window")) {
    const w = parseWindowFromChat(text, next);
    if (w === "none") {
      // 推迟：不写 feature，由 readiness / site-questions 的 defer 正则认
    } else if (w) {
      next = addFeature(next, w.wallRunId, {
        kind: "window", offset: w.offset, width: w.width,
      }, at);
      applied.push("window");
    }
  }

  if (!hasKind("door")) {
    const d = parseDoorFromChat(text, next);
    if (d && d !== "none") {
      next = addFeature(next, d.wallRunId, {
        kind: "door", offset: d.offset, width: d.width,
      }, at);
      applied.push("door");
    }
  }

  if (applied.length === 0 && blockedEdits.length === 0) return undefined;
  return { plan: next, applied, blockedEdits };
}

/**
 * 按会话里当前的 Q# 题面写回：`Q2: 120` / `Q3: North window 36"`。
 */
function applyNumberedSiteAnswers(
  plan: FloorPlan,
  text: string,
  at: string,
  questions: readonly SiteQuestion[],
): ChatSiteApplyResult | undefined {
  let next = plan;
  const applied: ChatSiteApplyKind[] = [];
  const byQ = new Map(questions.map((q) => [q.q, q]));

  for (const m of text.matchAll(/(?:^|\n)\s*Q\s*(\d+)\s*[:：]\s*([^\n]+)/gi)) {
    const q = byQ.get(Number(m[1]));
    if (!q) continue;
    const body = m[2]!.trim();
    if (!body) continue;

    if (q.kind === "ceiling") {
      if (next.parsedGeometry.ceilingHeight != null) continue;
      const ceil = parseCeilingFromChat(`ceiling ${body}`) ?? parseCeilingFromChat(`Q${q.q}: ${body}`);
      if (ceil) {
        next = resolveCeilingHeight(next, ceil.height, at);
        applied.push("ceiling");
      }
      continue;
    }

    if ((q.kind === "wall_length" || q.kind === "wall_confirm") && q.wallRunId) {
      const n = body.match(/(\d+(?:\.\d+)?)\s*(ft|feet|'|尺|["″]|in(?:ch(?:es)?)?|寸|cm)?/i);
      if (!n) continue;
      let inches = Number(n[1]);
      const unit = (n[2] ?? "").toLowerCase();
      if (unit === "ft" || unit === "feet" || unit === "'" || unit === "尺") inches *= 12;
      if (unit === "cm") inches = Math.round(inches / 2.54);
      if (!Number.isFinite(inches) || inches < 24 || inches > 600) continue;
      next = resolveWallLength(next, q.wallRunId, Math.round(inches), at);
      applied.push("wallLength");
      continue;
    }

    if (q.kind === "plumbing" || q.kind === "window" || q.kind === "door") {
      const hasKind = next.parsedGeometry.wallRuns.some((r) =>
        r.features.some((f) => f.kind === q.kind));
      if (hasKind) {
        // 已经有这类特征了——但可能是户型模板预填、还没经客户确认过（FR-17.4）。
        // 这一问不是"再加一个"，是"这个对不对"：非推迟话术的回复就当作确认。
        if (q.kind === "window" && isDeferWindows(body)) continue;
        if (q.kind === "door" && isDeferDoors(body)) continue;
        if (q.kind === "plumbing" && isDeferPlumbing(body)) continue;
        const pending = next.unresolvedItems.find((u) =>
          !u.resolved && u.target.kind === "feature"
          && next.parsedGeometry.wallRuns.some((r) => r.features.some(
            (f) => f.id === u.target.id && f.kind === q.kind)));
        if (pending) {
          next = resolveItem(next, pending.id, at);
          applied.push(q.kind);
        }
        continue;
      }

      if (q.kind === "window" && isDeferWindows(body)) continue;
      if (q.kind === "door" && isDeferDoors(body)) continue;
      if (q.kind === "plumbing" && isDeferPlumbing(body)) continue;

      const runs = next.parsedGeometry.wallRuns.filter((r) => r.length > 0);
      let wall = q.wallRunId
        ? runs.find((r) => r.id === q.wallRunId)
        : resolveWallMention(body, runs);
      if (!wall && q.wallLabel) {
        wall = runs.find((r) => r.label.toLowerCase() === q.wallLabel!.toLowerCase());
      }
      // 题面绑了墙但答句另指墙名时，以答句为准
      const mentioned = resolveWallMention(body, runs);
      if (mentioned) wall = mentioned;
      if (!wall) continue;

      const widthDefault = q.kind === "door"
        ? DEFAULT_DOOR_WIDTH
        : q.kind === "window"
          ? DEFAULT_WINDOW_WIDTH
          : DEFAULT_PLUMBING_WIDTH;
      const width = parseWidth(body, widthDefault, wall.length);
      const offset = parseOffset(body, wall.length, width);
      const maxOffset = Math.max(0, wall.length - width);
      next = addFeature(next, wall.id, {
        kind: q.kind,
        offset: Math.max(0, Math.min(offset, maxOffset)),
        width,
      }, at);
      applied.push(q.kind);
    }
  }

  if (applied.length === 0) return undefined;
  return { plan: next, applied, blockedEdits: [] };
}

function mentionsPlumbing(text: string): boolean {
  return /plumbing|sink|下水|上下水|水槽|洗菜盆|洗涤盆/i.test(text);
}

function resolveWallMention(text: string, runs: WallRun[]): WallRun | undefined {
  const lower = text.toLowerCase();

  const byLabel = [...runs]
    .sort((a, b) => b.label.length - a.label.length)
    .find((r) => {
      const lab = r.label.trim();
      if (!lab) return false;
      const esc = lab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^\\w])${esc}(?:[^\\w]|$)`, "i").test(text);
    });
  if (byLabel) return byLabel;

  if (/(?:^|[^a-z])left(?:\s+wall)?\b|左(?:侧)?墙|左边墙/i.test(lower)) {
    return runs.find((r) => /left|左/i.test(r.label)) ?? runs[0];
  }
  if (/(?:^|[^a-z])right(?:\s+wall)?\b|右(?:侧)?墙|右边墙/i.test(lower)) {
    return runs.find((r) => /right|右/i.test(r.label)) ?? runs[runs.length - 1];
  }

  const compass: [RegExp, RegExp][] = [
    [/\bnorth\b|北墙|北边/i, /north|北/i],
    [/\bsouth\b|南墙|南边/i, /south|南/i],
    [/\beast\b|东墙|东边/i, /east|东/i],
    [/\bwest\b|西墙|西边/i, /west|西/i],
  ];
  for (const [mention, labelRe] of compass) {
    if (mention.test(text)) {
      const hit = runs.find((r) => labelRe.test(r.label));
      if (hit) return hit;
    }
  }

  const letter = text.match(/\b(?:wall\s*)?([A-D])\b|([A-D])\s*墙|墙\s*([A-D])/i);
  if (letter) {
    const L = (letter[1] ?? letter[2] ?? letter[3] ?? "").toUpperCase();
    const hit = runs.find((r) =>
      new RegExp(`(?:^|\\b)${L}(?:\\b|$)|wall\\s*${L}`, "i").test(r.label));
    if (hit) return hit;
    const idx = L.charCodeAt(0) - 65;
    if (idx >= 0 && idx < runs.length) return runs[idx];
  }

  return undefined;
}

function parseOffset(text: string, wallLength: number, featureWidth: number): number {
  const m = text.match(
    /(?:距|离|from\s+(?:a\s+)?corner|from\s+the\s+end|offset)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(?:["″]|in(?:ch(?:es)?)?|寸)?/i,
  );
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0 && n <= wallLength) return n;
  }
  // 「about 60" from …」无 corner 关键词时也认第一个合理英寸数（非宽度语境）
  const loose = text.match(
    /(\d+(?:\.\d+)?)\s*(?:["″]|in(?:ch(?:es)?)?)\s*(?:from|距|离)/i,
  );
  if (loose) {
    const n = Number(loose[1]);
    if (Number.isFinite(n) && n >= 0 && n <= wallLength) return n;
  }
  if (/middle|center|中间|居中/i.test(text)) {
    return Math.max(0, wallLength / 2 - featureWidth / 2);
  }
  return wallLength * DEFAULT_PLUMBING_OFFSET_RATIO;
}

function parseWidth(text: string, fallback: number, wallLength: number): number {
  const m = text.match(
    /(?:width|宽|宽约|大约)?[^\d]{0,8}(\d+(?:\.\d+)?)\s*(?:["″]|in(?:ch(?:es)?)?|寸)/i,
  );
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 12 && n <= wallLength) return n;
  }
  return Math.min(fallback, wallLength);
}

/** 需求文案里是否已用自然语言确认过上下水（供 readiness 叙事，未写成 feature 时）。 */
export function chatConfirmedPlumbing(requirements: string): boolean {
  if (isDeferPlumbing(requirements)) return false;
  if (!mentionsPlumbing(requirements)) return false;
  return /(?:left|right|north|south|east|west)\s+wall|左(?:侧)?墙|右(?:侧)?墙|[东西南北]墙|wall\s*[A-D]|[A-D]\s*墙/i
    .test(requirements);
}
