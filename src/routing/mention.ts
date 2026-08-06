/**
 * @ 路由 —— REQUIREMENTS FR-1（v0.4 强化：路由必须是确定性的）。
 *
 * **LLM 永远不参与「用户指的是哪家公司」这个判断。**
 * 在一个以数据隔离为硬性要求的系统里，「客户以为 @ 的是 A、实际路由给了 B」
 * 是不可接受的故障模式。
 *
 * 优先级：
 *   1. 结构化 mention token（前端联想选择器选中后带 companyId）→ 直接路由
 *   2. 自由文本 → 归一化后与 name/aliases 做**精确**匹配
 *      - 唯一命中且 active  → 路由
 *      - 命中多个           → 不路由，回问澄清
 *      - 命中 0 个或非 active → 不路由，走冷启动通用层（场景 B）
 */
import type {
  CabinetCompany, CompanyMentionSignal, CompanyProspect, MentionResolution,
} from "../domain/types.js";

/** 需要在归一化时剥离的企业后缀（中英文）。 */
const SUFFIXES = [
  "incorporated", "inc", "limited", "ltd", "llc", "llp", "corporation", "corp",
  "company", "co", "cabinets", "cabinetry",
  "有限责任公司", "股份有限公司", "有限公司", "公司", "橱柜", "家居",
];

/**
 * 名称归一化 —— 让 "IKEA"/"ikea"/"IKEA Inc."/"宜家" 里能统一的部分统一。
 *
 * 注意：这不做翻译，也不做模糊匹配。"IKEA" 与 "宜家" 仍是两个不同的归一化名，
 * 要让它们等价必须由公司在 `aliases` 里显式登记——猜译名是路由错配的常见来源。
 */
export function normalizeCompanyName(raw: string): string {
  let s = raw
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    // 全角转半角后，去掉标点与空白
    .replace(/[\s　]+/g, "")
    .replace(/[.,'"`·、，。（）()【】\[\]<>《》!！?？:：;；&＆\-—_/\\]/g, "");

  // 反复剥离尾部的企业后缀（"Maple Cabinets Inc" → "maple"）
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of SUFFIXES) {
      if (s.length > suffix.length && s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return s;
}

/** 从消息文本中解析出所有 @ 提及。支持一句话 @ 多家。 */
export function parseMentions(text: string): string[] {
  // @ 后跟非空白、非 @ 的连续字符；中文名不含空格，英文名允许一个内部空格
  const re = /@([^\s@]+(?:\s[A-Za-z0-9&.'-]+)*)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = (m[1] ?? "").trim();
    if (name) out.push(name);
  }
  return out;
}

/** 前端联想选择器选中后携带的结构化 token。 */
export interface MentionToken {
  companyId: string;
  displayName: string;
}

export type RouteOutcome =
  | { kind: "routed"; company: CabinetCompany }
  | { kind: "ambiguous"; candidates: CabinetCompany[]; rawText: string }
  | { kind: "notActive"; company: CabinetCompany; rawText: string }
  | { kind: "unknown"; rawText: string };

export interface RoutingInput {
  companies: readonly CabinetCompany[];
  /** 判定某公司是否 active（由 deriveCompanyStatus 得出，不直接读字段）。 */
  isActive: (company: CabinetCompany) => boolean;
}

/** 按结构化 token 路由——最可靠的路径，前端选择器选中后走这里。 */
export function routeByToken(input: RoutingInput, token: MentionToken): RouteOutcome {
  const company = input.companies.find((c) => c.id === token.companyId);
  if (!company) return { kind: "unknown", rawText: token.displayName };
  if (!input.isActive(company)) return { kind: "notActive", company, rawText: token.displayName };
  return { kind: "routed", company };
}

/**
 * 一个 `@` 提及的所有候选解释，**从长到短**。
 *
 * 需要这个是因为公司名可能含空格（"Maple Ridge"），而 `@` 后面紧跟的往往是正文
 * （"@Maple Ridge B30 有多大"）。逐词回退让两种情况都能命中，且仍然是精确匹配：
 * 先试 "Maple Ridge B30"，不中再试 "Maple Ridge"，再试 "Maple"。
 */
export function mentionVariants(raw: string): string[] {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let n = words.length; n >= 1; n--) out.push(words.slice(0, n).join(" "));
  return out;
}

/**
 * 按自由文本路由 —— 归一化后**精确**匹配 name 与 aliases。
 * 不做前缀匹配、不做编辑距离、不问 LLM；只按「候选解释从长到短」回退。
 */
export function routeByText(input: RoutingInput, rawText: string): RouteOutcome {
  for (const variant of mentionVariants(rawText)) {
    const target = normalizeCompanyName(variant);
    if (!target) continue;

    const matches = input.companies.filter((c) =>
      [c.name, ...c.aliases].some((n) => normalizeCompanyName(n) === target));

    if (matches.length === 0) continue;
    // 命中即止 —— 更长的解释优先，避免 "Maple Ridge" 被短的 "Maple" 抢走
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches, rawText: variant };

    const only = matches[0]!;
    return input.isActive(only)
      ? { kind: "routed", company: only }
      : { kind: "notActive", company: only, rawText: variant };
  }
  return { kind: "unknown", rawText };
}

// ── 销售信号 ──────────────────────────────────────────────────────────────

let signalSeq = 0;

/**
 * 为一次未能路由（或路由到非 active 公司）的提及生成销售信号。
 *
 * `normalizedName` 让销售看板能按公司聚合计数，避免
 * "Maple Cabinets"/"maple cabinets inc"/"Maple" 碎成三条（REQUIREMENTS 6.6）。
 */
export function buildMentionSignal(
  outcome: Exclude<RouteOutcome, { kind: "routed" }>,
  ctx: {
    conversationId: string;
    customerAccountId: string;
    prospects: readonly CompanyProspect[];
    at: string;
  },
): CompanyMentionSignal {
  const rawMentionText = outcome.rawText;
  const normalizedName = normalizeCompanyName(rawMentionText);

  let resolvedCompanyId: string | undefined;
  let resolutionStatus: MentionResolution;

  if (outcome.kind === "notActive") {
    resolvedCompanyId = outcome.company.id;
    resolutionStatus = "matchedInactive";
  } else if (outcome.kind === "ambiguous") {
    // 有歧义时不绑定任何一家，交给销售人工判断
    resolutionStatus = "unknown";
  } else {
    resolutionStatus = "unknown";
  }

  // 回溯市场库（FR-12.3）
  const prospect = ctx.prospects.find(
    (p) => normalizeCompanyName(p.name) === normalizedName && p.status !== "archived",
  );
  if (!resolvedCompanyId && prospect) {
    resolutionStatus = "matchedProspect";
  }

  return {
    id: `cms_${Date.now().toString(36)}_${(signalSeq++).toString(36)}`,
    conversationId: ctx.conversationId,
    customerAccountId: ctx.customerAccountId,
    rawMentionText,
    normalizedName,
    resolvedCompanyId,
    resolvedProspectId: prospect?.id,
    resolutionStatus,
    createdAt: ctx.at,
  };
}

/** 销售看板：按归一化名聚合计数。 */
export function aggregateSignals(
  signals: readonly CompanyMentionSignal[],
): { normalizedName: string; count: number; latestAt: string; sampleText: string }[] {
  const byName = new Map<string, { count: number; latestAt: string; sampleText: string }>();
  for (const s of signals) {
    const cur = byName.get(s.normalizedName);
    if (!cur) {
      byName.set(s.normalizedName, { count: 1, latestAt: s.createdAt, sampleText: s.rawMentionText });
    } else {
      cur.count++;
      if (s.createdAt > cur.latestAt) cur.latestAt = s.createdAt;
    }
  }
  return [...byName.entries()]
    .map(([normalizedName, v]) => ({ normalizedName, ...v }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 客户端提示文案 —— **不得暴露入驻/订阅状态这类内部运营细节**
 * （REQUIREMENTS FR-10、场景 B 第 2 点）。
 */
export function clientFacingMessage(outcome: Exclude<RouteOutcome, { kind: "routed" }>): string {
  switch (outcome.kind) {
    case "ambiguous":
      return `有几家名字接近的公司，你指的是哪一家？${outcome.candidates.map((c) => c.name).join(" / ")}`;
    case "notActive":
    case "unknown":
      return "这家公司暂时还不能在平台上直接对话。我可以先按行业通用规格帮你出一版预估，你看可以吗？";
  }
}
