/**
 * 把对话里的家电种类/宽度/「接受推定」写回 FloorPlan.appliances。
 *
 * 根因（专家评审 / 会话排查）：就绪检查只认 plan.appliances，而聊天过去只写
 * designRequirements → 全程「家电待确认」。上下水已有 applyChatSiteAnswers，
 * 家电必须有对等路径；禁止靠硬塞「Appliances later.」伪装就绪。
 *
 * 注意：勿把 budget range /「A range is fine」误解析成灶具 range。
 */
import type { FloorPlan } from "../floorplan/types.js";
import {
  applianceFrom, applianceLabel, normalizeAppliances, type ApplianceKind, type ApplianceSpec,
} from "../floorplan/appliances.js";
import type { BlockedEdit } from "./confirm-lock.js";

export type ChatApplianceApplyKind =
  | "kinds" | "widths" | "confirmAssumed" | "defer" | "placement" | "height";

export interface ChatApplianceApplyResult {
  plan: FloorPlan;
  applied: ChatApplianceApplyKind[];
  /** 被"确认锁"拦下的修改尝试（已确认的家电宽度被聊天新数值撞上，未写入）。 */
  blockedEdits: BlockedEdit[];
}

const DEFER_RE =
  /appliances?\s+later|no appliances?\s+yet|家电后定|家电稍后|暂时不谈家电|家电还没定/i;

/** 接受推定宽度（不改数值；保留 provenance=assumed，出图/报价继续披露推定）。 */
const CONFIRM_ASSUMED_RE =
  /assumed\s+(widths?\s+)?(are\s+)?(ok|fine|good|okay)|those\s+(assumed\s+)?widths?\s+(are\s+)?(ok|fine|good)|推定(宽度)?(可以|没问题|ok|OK)|按推定|就按这(个|些)宽|先按常见|widths?\s+look\s+(ok|fine)/i;

/**
 * 冰箱不放在橱柜这面墙——墙长不够时给客户的一条出路。检测到就把冰箱标为
 * `placement: "elsewhere"`：不参与这面墙的落位与「装不装得下」校验，
 * 但仍留在 appliances 列表里（见 ApplianceSpec.placement 的注释）。
 */
const FRIDGE_ELSEWHERE_RE =
  /\b(fridge|refrigerator)\b[^.!?\n]{0,30}\b(elsewhere|separately|in\s+a\s+separate\s+\w+|another\s+(room|spot|location|wall)|not\s+on\s+(this|the|our)\s+wall|in\s+the\s+(pantry|hallway|garage|closet|nook|mudroom))\b|冰箱.{0,10}(不放在|不装在|不摆在|不在).{0,6}(这|那|同)?(面|堵)?墙|冰箱.{0,10}(放|摆|装).{0,6}(别处|别的地方|另一个地方|过道|走廊|储藏间|杂物间|旁边(的)?壁龛)|冰箱.{0,6}(单独|另外)(放|摆|安排)/i;

export function isFridgeElsewhere(text: string): boolean {
  return FRIDGE_ELSEWHERE_RE.test(text);
}

/**
 * 冰箱高度——决定上方能不能装吊柜（见 ApplianceSpec.height 的注释）。
 *
 * 必须带「高/tall/height」这类明确指向高度的词才算数，否则会跟宽度解析
 * （`widthNear`）抢同一个数字——「fridge 33 tall」与「fridge 33 wide」的区别
 * 只在这个词上。
 */
const FRIDGE_HEIGHT_RE = new RegExp(
  // "fridge 70 tall/height/high"
  "\\b(?:fridge|refrigerator)\\b[^.!?\\n]{0,20}?(\\d{2,3})\\s*(?:[\"″]|in(?:ch(?:es)?)?|寸)?\\s*(?:tall|height|high)\\b"
  // "70 tall/high ... fridge"
  + "|\\b(\\d{2,3})\\s*(?:[\"″]|in(?:ch(?:es)?)?|寸)?\\s*(?:tall|high)\\b[^.!?\\n]{0,20}?\\b(?:fridge|refrigerator)\\b"
  // "fridge height/height of the fridge is 70"
  + "|\\b(?:fridge|refrigerator)\\b[^.!?\\n]{0,20}?\\bheight\\b[^.!?\\n]{0,10}?(\\d{2,3})"
  + "|冰箱[^。！？\\n]{0,10}?高(?:度)?[^0-9]{0,4}(\\d{2,3})"
  + "|(\\d{2,3})\\s*(?:寸|英寸)?\\s*高[^。！？\\n]{0,10}?冰箱",
  "i",
);

function fridgeHeightFromChat(text: string): number | undefined {
  const m = FRIDGE_HEIGHT_RE.exec(text);
  if (!m) return undefined;
  const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
  const n = raw !== undefined ? Number(raw) : undefined;
  if (n === undefined || !Number.isFinite(n) || n < 54 || n > 90) return undefined;
  return n;
}

/** 客户只说「推定可以」、尚未点名家电时，用北美常见三件套落库。 */
const DEFAULT_ASSUMED_KINDS: ApplianceKind[] = ["refrigerator", "range", "dishwasher"];

export function isConfirmAssumedAppliances(text: string): boolean {
  return CONFIRM_ASSUMED_RE.test(text);
}

/**
 * 种类识别：灶具 range 不用裸 `\brange\b` 碰 budget range。
 */
const KIND_RES: { kind: ApplianceKind; re: RegExp }[] = [
  { kind: "refrigerator", re: /refrigerator|\bfridge\b|冰箱/i },
  { kind: "dishwasher", re: /dishwasher|洗碗(机)?/i },
  { kind: "wallOven", re: /wall\s*-?\s*oven|嵌入式烤箱|壁挂烤箱|\boven\b|烤箱/i },
  { kind: "cooktop", re: /cook\s*-?\s*top|灶台/i },
  { kind: "rangeHood", re: /range\s*-?\s*hood|抽油烟机|油烟机|烟机/i },
  { kind: "microwave", re: /microwave|微波炉/i },
  // stove / 灶具；孤立 range 另用 mentionsRangeCooker（避开 budget range）
  { kind: "range", re: /\b(stove|cooker|gas\s+range|electric\s+range)\b|灶具|燃气灶|电灶/i },
];

export function isDeferAppliances(text: string): boolean {
  return DEFER_RE.test(text);
}

export function chatMentionsApplianceKinds(text: string): boolean {
  if (isDeferAppliances(text)) return false;
  return KIND_RES.some(({ kind, re }) => {
    if (kind === "range") return mentionsRangeCooker(text);
    return re.test(text);
  });
}

function mentionsRangeCooker(text: string): boolean {
  if (/\b(stove|cooker|gas\s+range|electric\s+range)\b|灶具|燃气灶|电灶/i.test(text)) {
    return true;
  }
  // 孤立 range：排除 budget range / a range is fine（预算话术）
  if (/budget/i.test(text) && !/fridge|refrigerator|dishwasher|stove|冰箱|洗碗|灶/i.test(text)) {
    return false;
  }
  if (/\ba\s+range\s+is\s+fine\b/i.test(text) && /budget|CAD|\$|万/i.test(text)) {
    return false;
  }
  return /(?<!budget\s)\brange\b(?!\s*hood)/i.test(text);
}

const SEGMENT_BREAK_RE = /[、，,；;。！？!?\n]/;

/**
 * 在 kind 命中前后抓宽度。英文/「冰箱36寸」这类关键词在前的说法找关键词之后；
 * 「36寸双门对开冰箱」这类中文惯用的数字在前的说法，则从上一个分隔符（或句首）
 * 到关键词之间找离关键词最近的一个数字——避免吃到上一件家电的英寸数。
 */
function widthNear(text: string, kindRe: RegExp): number | undefined {
  const m = kindRe.exec(text);
  if (!m || m.index === undefined) return undefined;

  const after = text.slice(m.index + m[0].length, m.index + m[0].length + 32);
  const afterMatch = after.match(/^\s*[:=]?\s*(\d{2,3})\s*(?:["″]|in(?:ch(?:es)?)?|寸)?/);
  if (afterMatch) {
    const n = Number(afterMatch[1]);
    if (n >= 12 && n <= 60) return n;
  }

  let breakIdx = 0;
  for (let i = m.index - 1; i >= 0; i -= 1) {
    if (SEGMENT_BREAK_RE.test(text[i]!)) { breakIdx = i + 1; break; }
  }
  const before = text.slice(breakIdx, m.index);
  const beforeMatch = before.match(
    /(\d{2,3})\s*(?:["″]|in(?:ch(?:es)?)?|寸)?[^0-9、，,；;。！？!?\n]{0,12}$/,
  );
  if (beforeMatch) {
    const n = Number(beforeMatch[1]);
    if (n >= 12 && n <= 60) return n;
  }

  return undefined;
}

export function parseAppliancesFromChat(text: string): {
  appliances: ApplianceSpec[];
  deferred: boolean;
  confirmAssumed: boolean;
} {
  const deferred = isDeferAppliances(text);
  const confirmAssumed = CONFIRM_ASSUMED_RE.test(text);
  // 接受推定优先于「家电后定」（历史里常两者并存）
  if (deferred && !confirmAssumed) {
    return { appliances: [], deferred: true, confirmAssumed: false };
  }

  const found: ApplianceSpec[] = [];
  for (const { kind, re } of KIND_RES) {
    if (kind === "range" ? !mentionsRangeCooker(text) : !re.test(text)) continue;
    const widthRe = kind === "range"
      ? /\b(stove|cooker|gas\s+range|electric\s+range|range)\b|灶具|燃气灶|电灶/i
      : re;
    const width = widthNear(text, widthRe);
    found.push(applianceFrom({ kind, ...(width !== undefined ? { width } : {}) }));
  }
  return { appliances: normalizeAppliances(found), deferred: false, confirmAssumed };
}

/**
 * 若本轮能解析家电，写入 plan.appliances；接受推定则升 provenance。
 * 无变化返回 undefined。
 */
export function applyChatApplianceAnswers(
  plan: FloorPlan,
  text: string,
): ChatApplianceApplyResult | undefined {
  const parsed = parseAppliancesFromChat(text);
  const applied: ChatApplianceApplyKind[] = [];
  const blockedEdits: BlockedEdit[] = [];
  let next = plan;
  let list = [...(next.appliances ?? [])];

  if (parsed.deferred) {
    // 推迟不写 appliances；由 readiness 读 designRequirements 的 defer 正则
    return undefined;
  }

  if (parsed.appliances.length > 0) {
    const merged = mergeAppliancesWithLock(list, parsed.appliances, blockedEdits);
    if (JSON.stringify(merged) !== JSON.stringify(list)) {
      list = merged;
      applied.push(
        parsed.appliances.some((a) => a.provenance === "customer") ? "widths" : "kinds",
      );
    }
  }

  if (isFridgeElsewhere(text)) {
    const idx = list.findIndex((a) => a.kind === "refrigerator");
    if (idx >= 0) {
      if (list[idx]!.placement !== "elsewhere") {
        list = [...list.slice(0, idx), { ...list[idx]!, placement: "elsewhere" }, ...list.slice(idx + 1)];
        applied.push("placement");
      }
    } else {
      list = [...list, applianceFrom({ kind: "refrigerator", placement: "elsewhere" })];
      applied.push("placement");
    }
  }

  const fridgeHeight = fridgeHeightFromChat(text);
  if (fridgeHeight !== undefined) {
    const idx = list.findIndex((a) => a.kind === "refrigerator");
    if (idx >= 0) {
      const prev = list[idx]!;
      if (prev.heightProvenance === "customer" && prev.height !== fridgeHeight) {
        blockedEdits.push({
          kind: "appliance", label: `${applianceLabel("refrigerator", "en")} height`,
          current: prev.height!, attempted: fridgeHeight,
        });
      } else if (prev.height !== fridgeHeight || prev.heightProvenance !== "customer") {
        list = [
          ...list.slice(0, idx),
          { ...prev, height: fridgeHeight, heightProvenance: "customer" },
          ...list.slice(idx + 1),
        ];
        applied.push("height");
      }
    } else {
      list = [...list, applianceFrom({ kind: "refrigerator", height: fridgeHeight })];
      applied.push("height");
    }
  }

  if (parsed.confirmAssumed) {
    // 尚无家电时先落入常见推定宽度，Confirmed Tab 才能列出（标签 assumed）
    if (list.length === 0) {
      list = normalizeAppliances(
        DEFAULT_ASSUMED_KINDS.map((kind) => applianceFrom({ kind })),
      );
      applied.push("kinds");
    }
    // 接受推定 ≠ 实测：保留 assumed，就绪由 designRequirements 中的接受句判定
    if (list.some((a) => a.provenance === "assumed")) {
      applied.push("confirmAssumed");
    }
  }

  if (applied.length === 0 && blockedEdits.length === 0) return undefined;
  if (applied.length === 0) return { plan: next, applied, blockedEdits };
  next = { ...next, appliances: list, updatedAt: new Date().toISOString() };
  return { plan: next, applied, blockedEdits };
}

/**
 * 合并新解析出的家电清单，同时应用"确认锁"：已确认（provenance customer）的
 * 宽度不被新解析出的不同数值静默覆盖——无论新解析是 customer 还是 assumed，
 * 都算"想改已确认的"，记入 blocked，交给已确认面板去改（见 confirm-lock.ts）。
 * 正则路径（`applyChatApplianceAnswers`）与 LLM 路径（`applyExtractedAppliances`）
 * 共用这一份逻辑，保证两条路径下的锁行为完全一致。
 */
function mergeAppliancesWithLock(
  list: readonly ApplianceSpec[],
  incoming: readonly ApplianceSpec[],
  blocked: BlockedEdit[],
): ApplianceSpec[] {
  const byKind = new Map<ApplianceKind, ApplianceSpec>();
  for (const a of list) byKind.set(a.kind, a);
  for (const a of incoming) {
    const prev = byKind.get(a.kind);
    if (prev?.provenance === "customer" && a.width !== prev.width) {
      blocked.push({
        kind: "appliance",
        label: applianceLabel(a.kind, "en"),
        current: prev.width,
        attempted: a.width,
      });
      continue;
    }
    if (prev?.provenance === "customer" && a.provenance === "assumed") continue;
    byKind.set(a.kind, a);
  }
  return normalizeAppliances([...byKind.values()]);
}

/**
 * 把 LLM 结构化抽取（`llm-extract.ts`）的家电结果写入 FloorPlan——与正则路径
 * 共用同一把"确认锁"（见 `mergeAppliancesWithLock`）。
 */
export function applyExtractedAppliances(
  plan: FloorPlan,
  extracted: readonly { kind: ApplianceKind; widthInches?: number }[],
  confirmAssumed: boolean,
  blockedOut?: BlockedEdit[],
): FloorPlan {
  const blocked: BlockedEdit[] = [];
  let list = [...(plan.appliances ?? [])];

  if (extracted.length > 0) {
    const incoming = extracted.map((a) => applianceFrom({ kind: a.kind, width: a.widthInches }));
    list = mergeAppliancesWithLock(list, incoming, blocked);
  }

  if (confirmAssumed && list.length === 0) {
    list = normalizeAppliances(DEFAULT_ASSUMED_KINDS.map((kind) => applianceFrom({ kind })));
  }

  if (blockedOut) blockedOut.push(...blocked);
  return { ...plan, appliances: list, updatedAt: new Date().toISOString() };
}
