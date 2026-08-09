/**
 * 厂商 L1 学习队列（FR-22.2）—— 信号 → draft 建议 → 人工确认 → 落入本公司 draft。
 *
 * 硬边界：
 *   - 按 companyId 隔离；禁止跨厂读写
 *   - 禁止写入 PlatformKnowledgeCard / L0
 *   - 禁止自动改 published 价目或写入矩阵价格数字
 */
import { createHash } from "node:crypto";
import type {
  CompanyCodingRules,
  ModuleSpec,
  PriceGroup,
  PriceMatrixEntry,
  ProductSpecVersion,
} from "../domain/types.js";
import { isFinishDependent } from "../spec/finish.js";
import type { UnresolvedItem } from "../spec/import.js";
import { capabilityQuestions } from "../spec/capabilities.js";
import { currentDraft } from "../spec/version.js";
import type {
  CompanyLearningItem,
  L1LearnProposal,
  L1LearnSource,
  L1SettleTarget,
} from "./l1-types.js";

export class L1LearnError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "L1LearnError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function digestId(companyId: string, source: L1LearnSource, signalRef: string): string {
  const h = createHash("sha1")
    .update(`${companyId}|${source}|${signalRef}`)
    .digest("hex")
    .slice(0, 12);
  return `l1q_${h}`;
}

export function assertSameCompany(item: CompanyLearningItem, companyId: string): void {
  if (item.companyId !== companyId) {
    throw new L1LearnError(
      "L1 learning item belongs to another company",
      "CROSS_TENANT",
    );
  }
}

/** 列表过滤：永远只返回该公司条目。 */
export function listL1ForCompany(
  items: readonly CompanyLearningItem[],
  companyId: string,
): CompanyLearningItem[] {
  return items.filter((i) => i.companyId === companyId);
}

export interface L1SignalInput {
  companyId: string;
  source: L1LearnSource;
  settleTarget: L1SettleTarget;
  title: string;
  summary: string;
  signalRef: string;
  proposal?: L1LearnProposal;
  at?: string;
}

/**
 * 从单条信号建 draft。同一 companyId+source+signalRef 稳定 id，便于幂等插入。
 * **不**写 L0。
 */
export function proposeL1Draft(signal: L1SignalInput): CompanyLearningItem {
  if (!signal.companyId) {
    throw new L1LearnError("companyId required", "MISSING_COMPANY");
  }
  // 价格洞只能进 note，禁止提案里塞 listPrice
  if (signal.proposal) {
    const raw = JSON.stringify(signal.proposal);
    if (/listPrice|tradePrice|"amount"\s*:/i.test(raw)) {
      throw new L1LearnError(
        "L1 proposal must not include price amounts; fill matrix manually on draft",
        "PRICE_FORBIDDEN",
      );
    }
  }
  return {
    id: digestId(signal.companyId, signal.source, signal.signalRef),
    companyId: signal.companyId,
    status: "draft",
    source: signal.source,
    settleTarget: signal.settleTarget,
    title: signal.title,
    summary: signal.summary,
    proposal: signal.proposal,
    signalRef: signal.signalRef,
    createdAt: signal.at ?? nowIso(),
  };
}

/** 已有同 id 则跳过（保持 draft 不被刷成新时间戳以外的状态）。 */
export function mergeProposedDrafts(
  existing: readonly CompanyLearningItem[],
  proposed: readonly CompanyLearningItem[],
): { toInsert: CompanyLearningItem[]; skipped: number } {
  const have = new Set(existing.map((i) => i.id));
  const toInsert: CompanyLearningItem[] = [];
  let skipped = 0;
  for (const p of proposed) {
    if (have.has(p.id)) {
      skipped += 1;
      continue;
    }
    // 再挡一次：禁止把别厂条目混进本批（调用方失误）
    toInsert.push(p);
    have.add(p.id);
  }
  return { toInsert, skipped };
}

/** 导入待确认 → L1 draft。 */
export function proposeFromImportUnresolved(
  companyId: string,
  unresolved: readonly UnresolvedItem[],
): CompanyLearningItem[] {
  return unresolved.map((u) => {
    const ref = `${u.sheet}:${u.rowNumber}:${u.field}:${u.raw ?? ""}`;
    const isFaceOrCap =
      /face|capabilit|sellUnit|role/i.test(u.field) ||
      /face|capabilit|sellUnit/i.test(u.reason);
    return proposeL1Draft({
      companyId,
      source: "import_unresolved",
      settleTarget: isFaceOrCap ? "specDraftNote" : "handbook",
      title: `Import: ${u.field} row ${u.rowNumber}`,
      summary: u.reason + (u.raw ? ` (raw: ${u.raw})` : ""),
      signalRef: ref,
      proposal: {
        note: `Import unresolved on ${u.sheet}.${u.field}: ${u.reason}`,
        handbookAppend: !isFaceOrCap
          ? `[Import correction] ${u.sheet} row ${u.rowNumber} ${u.field}: ${u.reason}`
          : undefined,
        moduleCode: u.raw,
        field: u.field,
      },
    });
  });
}

/** 能力标签低可信 → L1 draft。 */
export function proposeFromCapabilityPending(
  companyId: string,
  modules: readonly ModuleSpec[],
): CompanyLearningItem[] {
  return capabilityQuestions(modules).map((q) =>
    proposeL1Draft({
      companyId,
      source: "capability_pending",
      settleTarget: "specDraftNote",
      title: `Capability pending: ${q.moduleCode}`,
      summary: q.reason,
      signalRef: `cap:${q.moduleCode}`,
      proposal: {
        moduleCode: q.moduleCode,
        note:
          `Confirm capabilities for ${q.moduleCode}: ${q.reason}. ` +
          `Proposed roles: ${q.proposed.roles.join(", ") || "(none)"}.`,
      },
    }),
  );
}

export interface MatrixHole {
  moduleCode: string;
  moduleId: string;
  priceGroupId: string;
  priceGroupCode: string;
}

/** 报价矩阵洞（缺行）——只提议「人工补矩阵」，绝不写价格。 */
export function findPriceMatrixHoles(input: {
  modules: readonly ModuleSpec[];
  priceGroups: readonly PriceGroup[];
  priceMatrix: readonly PriceMatrixEntry[];
}): MatrixHole[] {
  const keys = new Set(
    input.priceMatrix.map((e) => `${e.moduleId}:${e.priceGroupId}`),
  );
  const holes: MatrixHole[] = [];
  for (const mod of input.modules) {
    if (!isFinishDependent(mod)) {
      const any = input.priceMatrix.some((e) => e.moduleId === mod.id);
      if (!any && input.priceGroups[0]) {
        holes.push({
          moduleCode: mod.code,
          moduleId: mod.id,
          priceGroupId: input.priceGroups[0].id,
          priceGroupCode: input.priceGroups[0].code,
        });
      }
      continue;
    }
    for (const pg of input.priceGroups) {
      if (!keys.has(`${mod.id}:${pg.id}`)) {
        holes.push({
          moduleCode: mod.code,
          moduleId: mod.id,
          priceGroupId: pg.id,
          priceGroupCode: pg.code,
        });
      }
    }
  }
  return holes;
}

export function proposeFromPriceMatrixHoles(
  companyId: string,
  holes: readonly MatrixHole[],
  opts?: { limit?: number },
): CompanyLearningItem[] {
  const limit = opts?.limit ?? 40;
  return holes.slice(0, limit).map((h) =>
    proposeL1Draft({
      companyId,
      source: "price_matrix_hole",
      settleTarget: "specDraftNote",
      title: `Price matrix hole: ${h.moduleCode} × ${h.priceGroupCode}`,
      summary:
        `No price matrix row for ${h.moduleCode} / ${h.priceGroupCode}. ` +
        `Fill on a draft import — never auto-priced.`,
      signalRef: `hole:${h.moduleId}:${h.priceGroupId}`,
      proposal: {
        moduleCode: h.moduleCode,
        note:
          `Missing matrix cell ${h.moduleCode} × ${h.priceGroupCode}. ` +
          `Add a draft priceMatrix row manually; published prices must not be auto-written.`,
      },
    }),
  );
}

/** 客户要 assembled 但型号不提供 → handbook / note。 */
export function proposeFromAssembledUnavailable(
  companyId: string,
  modules: readonly ModuleSpec[],
): CompanyLearningItem[] {
  const onlyRta = modules.filter(
    (m) =>
      m.assemblyOptions.length > 0 &&
      !m.assemblyOptions.includes("assembled") &&
      !["filler", "panel", "toeKick", "crown", "leg"].includes(m.type),
  );
  // 聚合一条总览 + 按型号抽样，避免刷屏
  if (onlyRta.length === 0) return [];
  const sample = onlyRta.slice(0, 12);
  const codes = sample.map((m) => m.code).join(", ");
  const items = [
    proposeL1Draft({
      companyId,
      source: "assembled_unavailable",
      settleTarget: "handbook",
      title: "Assembled shipping not offered (catalog)",
      summary:
        `${onlyRta.length} cabinet SKU(s) are RTA-only. ` +
        `Document for agents; do not invent assembled upcharges.`,
      signalRef: "assembled:summary",
      proposal: {
        handbookAppend:
          `[Assembly] The following SKUs ship RTA-only (no assembled option): ${codes}` +
          (onlyRta.length > sample.length ? ` … (+${onlyRta.length - sample.length} more)` : "") +
          `. Tell customers honestly; never invent assembled prices.`,
        note: `RTA-only count: ${onlyRta.length}`,
      },
    }),
  ];
  for (const m of sample.slice(0, 5)) {
    items.push(
      proposeL1Draft({
        companyId,
        source: "assembled_unavailable",
        settleTarget: "specDraftNote",
        title: `RTA-only: ${m.code}`,
        summary: `${m.code} assemblyOptions=[${m.assemblyOptions.join(",")}]`,
        signalRef: `assembled:${m.code}`,
        proposal: {
          moduleCode: m.code,
          note: `Consider adding assembled to assemblyOptions on a draft if the factory offers it.`,
        },
      }),
    );
  }
  return items;
}

/** 会话纠错信号（显式传入摘要，不读跨厂会话）。 */
export function proposeFromSessionCorrection(input: {
  companyId: string;
  summary: string;
  conversationId?: string;
  codingHint?: { pattern: string; meaning: string };
}): CompanyLearningItem {
  const ref = `session:${input.conversationId ?? "anon"}:${input.summary.slice(0, 80)}`;
  const settleTarget: L1SettleTarget = input.codingHint ? "codingRules" : "handbook";
  return proposeL1Draft({
    companyId: input.companyId,
    source: "session",
    settleTarget,
    title: "Session correction",
    summary: input.summary,
    signalRef: ref,
    proposal: {
      handbookAppend: settleTarget === "handbook"
        ? `[Session] ${input.summary}`
        : undefined,
      codingRulesPatch: input.codingHint
        ? { prefixGuideAppend: [input.codingHint] }
        : undefined,
      note: input.summary,
    },
  });
}

export interface ScanL1Input {
  companyId: string;
  unresolved?: readonly UnresolvedItem[];
  modules?: readonly ModuleSpec[];
  priceGroups?: readonly PriceGroup[];
  priceMatrix?: readonly PriceMatrixEntry[];
  sessionCorrections?: readonly {
    summary: string;
    conversationId?: string;
    codingHint?: { pattern: string; meaning: string };
  }[];
}

/** 扫描本公司信号，产出 draft 列表（调用方负责持久化与去重）。 */
export function scanCompanyL1Signals(input: ScanL1Input): CompanyLearningItem[] {
  const out: CompanyLearningItem[] = [];
  if (input.unresolved?.length) {
    out.push(...proposeFromImportUnresolved(input.companyId, input.unresolved));
  }
  if (input.modules?.length) {
    out.push(...proposeFromCapabilityPending(input.companyId, input.modules));
    out.push(...proposeFromAssembledUnavailable(input.companyId, input.modules));
  }
  if (input.modules && input.priceGroups && input.priceMatrix) {
    const holes = findPriceMatrixHoles({
      modules: input.modules,
      priceGroups: input.priceGroups,
      priceMatrix: input.priceMatrix,
    });
    out.push(...proposeFromPriceMatrixHoles(input.companyId, holes));
  }
  for (const s of input.sessionCorrections ?? []) {
    out.push(
      proposeFromSessionCorrection({
        companyId: input.companyId,
        summary: s.summary,
        conversationId: s.conversationId,
        codingHint: s.codingHint,
      }),
    );
  }
  // 防御：混入其他 companyId 的条目
  return out.filter((i) => i.companyId === input.companyId);
}

export function confirmL1Item(
  item: CompanyLearningItem,
  confirmedBy: string,
  companyId: string,
): CompanyLearningItem {
  assertSameCompany(item, companyId);
  if (item.status !== "draft") {
    throw new L1LearnError(`cannot confirm from ${item.status}`, "BAD_STATUS");
  }
  return {
    ...item,
    status: "confirmed",
    confirmedBy,
    confirmedAt: nowIso(),
    updatedAt: nowIso(),
  };
}

export function dismissL1Item(
  item: CompanyLearningItem,
  dismissedBy: string,
  companyId: string,
): CompanyLearningItem {
  assertSameCompany(item, companyId);
  if (item.status === "applied") {
    throw new L1LearnError("cannot dismiss an applied item", "BAD_STATUS");
  }
  return {
    ...item,
    status: "dismissed",
    dismissedBy,
    updatedAt: nowIso(),
  };
}

function mergeCodingRules(
  base: CompanyCodingRules | undefined,
  patch: NonNullable<L1LearnProposal["codingRulesPatch"]>,
): CompanyCodingRules {
  const prefixGuide = [
    ...(base?.prefixGuide ?? []),
    ...(patch.prefixGuideAppend ?? []),
  ];
  return {
    prefixGuide,
    usesBoxDoorSuffixes: patch.usesBoxDoorSuffixes ?? base?.usesBoxDoorSuffixes ?? false,
    materialTokens: { ...(base?.materialTokens ?? {}), ...(patch.materialTokens ?? {}) },
    finishTokens: { ...(base?.finishTokens ?? {}), ...(patch.finishTokens ?? {}) },
  };
}

/**
 * 将已确认项落入该公司 **draft** ProductSpecVersion。
 * 不改 published；不写价格矩阵。
 */
export function applyL1ItemToDraft(input: {
  item: CompanyLearningItem;
  companyId: string;
  versions: readonly ProductSpecVersion[];
}): {
  item: CompanyLearningItem;
  draft: ProductSpecVersion;
} {
  assertSameCompany(input.item, input.companyId);
  if (input.item.status !== "confirmed" && input.item.status !== "draft") {
    throw new L1LearnError(`cannot apply from ${input.item.status}`, "BAD_STATUS");
  }
  const draft = currentDraft(input.versions, input.companyId);
  if (!draft) {
    throw new L1LearnError(
      "No draft ProductSpecVersion for this company; start an onboarding session first",
      "NO_DRAFT",
    );
  }
  if (draft.status !== "draft") {
    throw new L1LearnError("Target version is not draft", "NOT_DRAFT");
  }
  if (draft.companyId !== input.companyId) {
    throw new L1LearnError("Draft company mismatch", "CROSS_TENANT");
  }

  let next: ProductSpecVersion = { ...draft };
  const p = input.item.proposal;

  if (input.item.settleTarget === "handbook" && p?.handbookAppend) {
    const prev = draft.handbook?.text?.trim() ?? "";
    const append = p.handbookAppend.trim();
    const text = prev.includes(append)
      ? prev
      : prev
        ? `${prev}\n\n${append}`
        : append;
    next = { ...next, handbook: { text } };
  }

  if (input.item.settleTarget === "codingRules" && p?.codingRulesPatch) {
    next = {
      ...next,
      codingRules: mergeCodingRules(draft.codingRules, p.codingRulesPatch),
    };
  }

  if (input.item.settleTarget === "specDraftNote" && p?.note) {
    // 矩阵洞 / 能力待确认：只把说明追加到 handbook 候选区，不写价
    const marker = `[L1 queue] ${p.note}`;
    const prev = next.handbook?.text?.trim() ?? "";
    if (!prev.includes(marker)) {
      next = {
        ...next,
        handbook: { text: prev ? `${prev}\n\n${marker}` : marker },
      };
    }
  }

  const applied: CompanyLearningItem = {
    ...input.item,
    status: "applied",
    appliedAt: nowIso(),
    appliedToSpecVersionId: draft.id,
    updatedAt: nowIso(),
    ...(input.item.status === "draft"
      ? { confirmedBy: "system:apply", confirmedAt: nowIso() }
      : {}),
  };

  return { item: applied, draft: next };
}

/** 队列状态汇总（看板用）。 */
export function summarizeL1Queue(items: readonly CompanyLearningItem[]): {
  total: number;
  byStatus: Record<L1LearnStatusLike, number>;
  byCompany: Record<string, number>;
  bySource: Record<string, number>;
} {
  const byStatus: Record<string, number> = {
    draft: 0, confirmed: 0, applied: 0, dismissed: 0,
  };
  const byCompany: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const i of items) {
    byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    byCompany[i.companyId] = (byCompany[i.companyId] ?? 0) + 1;
    bySource[i.source] = (bySource[i.source] ?? 0) + 1;
  }
  return {
    total: items.length,
    byStatus: byStatus as Record<L1LearnStatusLike, number>,
    byCompany,
    bySource,
  };
}

type L1LearnStatusLike = CompanyLearningItem["status"];
