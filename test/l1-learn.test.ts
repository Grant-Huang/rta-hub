/**
 * FR-22.2：厂商 L1 学习队列 —— 隔离、禁止写价、确认落入 draft。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyL1ItemToDraft,
  confirmL1Item,
  dismissL1Item,
  findPriceMatrixHoles,
  listL1ForCompany,
  mergeProposedDrafts,
  proposeFromAssembledUnavailable,
  proposeFromPriceMatrixHoles,
  proposeFromSessionCorrection,
  proposeL1Draft,
  scanCompanyL1Signals,
} from "../src/knowledge/l1-learn.js";
import type { CompanyLearningItem } from "../src/knowledge/l1-types.js";
import type { ModuleSpec, PriceGroup, PriceMatrixEntry, ProductSpecVersion } from "../src/domain/types.js";
import { fromDollars } from "../src/domain/money.js";

const CO_A = "co_alpha";
const CO_B = "co_beta";

function mod(partial: Partial<ModuleSpec> & Pick<ModuleSpec, "id" | "code">): ModuleSpec {
  return {
    specVersionId: "sv_d",
    companyId: CO_A,
    type: "base",
    widthOptions: [12],
    heightOptions: [34.5],
    depthOptions: [24],
    assemblyOptions: ["RTA"],
    ...partial,
  };
}

test("L1 draft 必须带 companyId，且列表按厂隔离", () => {
  const a = proposeL1Draft({
    companyId: CO_A,
    source: "session",
    settleTarget: "handbook",
    title: "A note",
    summary: "alpha correction",
    signalRef: "s1",
  });
  const b = proposeL1Draft({
    companyId: CO_B,
    source: "session",
    settleTarget: "handbook",
    title: "B note",
    summary: "beta correction",
    signalRef: "s1",
  });
  assert.equal(a.companyId, CO_A);
  assert.equal(b.companyId, CO_B);
  assert.notEqual(a.id, b.id, "同 signalRef 不同厂必须不同 id");
  const listed = listL1ForCompany([a, b], CO_A);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.companyId, CO_A);
});

test("提案禁止夹带 listPrice / 金额", () => {
  assert.throws(
    () =>
      proposeL1Draft({
        companyId: CO_A,
        source: "price_matrix_hole",
        settleTarget: "specDraftNote",
        title: "bad",
        summary: "x",
        signalRef: "p1",
        proposal: { note: "fill", handbookAppend: '{"listPrice":123}' },
      }),
    /PRICE_FORBIDDEN|price/i,
  );
});

test("矩阵洞只产出 note，不写价格；确认后落入 draft handbook", () => {
  const modules = [mod({ id: "m1", code: "B12", assemblyOptions: ["RTA", "assembled"] })];
  const groups: PriceGroup[] = [
    { id: "pg_a", specVersionId: "sv_d", companyId: CO_A, code: "A", displayName: "A", rank: 1 },
    { id: "pg_b", specVersionId: "sv_d", companyId: CO_A, code: "B", displayName: "B", rank: 2 },
  ];
  const matrix: PriceMatrixEntry[] = [
    {
      specVersionId: "sv_d",
      companyId: CO_A,
      moduleId: "m1",
      priceGroupId: "pg_a",
      listPrice: fromDollars("100.00"),
    },
  ];
  const holes = findPriceMatrixHoles({ modules, priceGroups: groups, priceMatrix: matrix });
  assert.equal(holes.length, 1);
  assert.equal(holes[0]!.priceGroupCode, "B");

  const drafts = proposeFromPriceMatrixHoles(CO_A, holes);
  assert.equal(drafts[0]!.status, "draft");
  assert.match(drafts[0]!.proposal!.note!, /manually/i);
  assert.ok(!JSON.stringify(drafts[0]).includes("listPrice"));

  const confirmed = confirmL1Item(drafts[0]!, "admin", CO_A);
  const draftVer: ProductSpecVersion = {
    id: "sv_draft",
    companyId: CO_A,
    versionNo: 2,
    status: "draft",
    currency: "CAD",
    construction: "framed",
    overlay: "full",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  };
  const applied = applyL1ItemToDraft({
    item: confirmed,
    companyId: CO_A,
    versions: [draftVer],
  });
  assert.equal(applied.item.status, "applied");
  assert.equal(applied.item.appliedToSpecVersionId, "sv_draft");
  assert.match(applied.draft.handbook!.text, /Missing matrix/);
  assert.equal(applied.draft.status, "draft");
});

test("禁止把 A 厂条目确认到 B 厂", () => {
  const item = proposeFromSessionCorrection({
    companyId: CO_A,
    summary: "B12 means 1 drawer",
    codingHint: { pattern: "^B\\d", meaning: "base 1 drawer over door" },
  });
  assert.throws(
    () => confirmL1Item(item, "x", CO_B),
    (e: unknown) => e instanceof Error && /CROSS_TENANT|another company/i.test(String(e)),
  );
});

test("assembled 不可用 → handbook 候选；dismiss 可用", () => {
  const items = proposeFromAssembledUnavailable(CO_A, [
    mod({ id: "m_w", code: "W3030", type: "wall", assemblyOptions: ["RTA"] }),
  ]);
  assert.ok(items.some((i) => i.settleTarget === "handbook"));
  const d = dismissL1Item(items[0]!, "mgr", CO_A);
  assert.equal(d.status, "dismissed");
});

test("scan 不会混入其他 companyId；merge 幂等", () => {
  const proposed = scanCompanyL1Signals({
    companyId: CO_A,
    modules: [mod({ id: "m1", code: "X99", type: "tall", faceTemplateId: undefined })],
    sessionCorrections: [{ summary: "fix prefix guide", codingHint: { pattern: "^X", meaning: "tall" } }],
  });
  assert.ok(proposed.every((p) => p.companyId === CO_A));
  const existing: CompanyLearningItem[] = [proposed[0]!];
  const { toInsert, skipped } = mergeProposedDrafts(existing, proposed);
  assert.ok(skipped >= 1);
  assert.ok(toInsert.every((i) => i.id !== existing[0]!.id));
});

test("无 draft 时 apply 失败，不碰 published", () => {
  const item = confirmL1Item(
    proposeFromSessionCorrection({ companyId: CO_A, summary: "note" }),
    "admin",
    CO_A,
  );
  const published: ProductSpecVersion = {
    id: "sv_pub",
    companyId: CO_A,
    versionNo: 1,
    status: "published",
    currency: "CAD",
    construction: "framed",
    overlay: "full",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    handbook: { text: "keep me" },
  };
  assert.throws(
    () => applyL1ItemToDraft({ item, companyId: CO_A, versions: [published] }),
    (e: unknown) => e instanceof Error && /NO_DRAFT|No draft/i.test(String(e)),
  );
  assert.equal(published.handbook!.text, "keep me");
});
