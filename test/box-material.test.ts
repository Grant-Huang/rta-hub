/**
 * 箱体板材 —— 柜体用什么板，与门板花色是**两个独立的维度**。
 *
 * 客户提的问题：「要区分柜体和柜门的材料，比如柜体分实木、夹板 plywood 和
 * 颗粒板 particle board，价格也不同。」
 *
 * 这一组盯的是三件最容易做错的事：
 *   1. **两个维度真的正交**——换箱体不该动价格组，换花色不该动箱体加价；
 *   2. **没箱体的件不加价**——填缝条、踢脚板、塑料地脚是一块板或一个塑料件，
 *      给它们乘上全夹板的加价是凭空加价（与塑料地脚不随花色变是同一类判断）；
 *   3. **报价单上要写明按的是哪一档**——客户拿它去跟另一家比，
 *      那一家报的可能是颗粒板箱体，不写就成了两个数看起来可比。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePrice, PricingError, type PricingContext } from "../src/pricing/engine.js";
import { percentOf } from "../src/domain/money.js";
import { hasCarcass, resolveBoxMaterial, sortBoxMaterials } from "../src/spec/carcass.js";
import { validateSelections } from "../src/spec/validation.js";
import { buildQuoteList, renderQuoteListText } from "../src/quote/line-items.js";
import { compareFinishes } from "../src/quote/finish-comparison.js";
import {
  pilotModules, pilotPriceMatrix, pilotDoorStyles, pilotBoxMaterials,
  pilotHardware, pilotAccessories, pilotDiscounts, pilotShipping,
  PILOT_SPEC_VERSION_ID, PILOT_COMPANY_ID,
} from "../src/app/seed.js";
import { SEED_TAX_RULES } from "../src/pricing/tax.js";
import { importSpecTemplates, blankTemplates } from "../src/spec/import.js";
import { buildSecondCompanyBundle } from "../src/app/seed-second.js";
import { buildThirdCompanyBundle } from "../src/app/seed-third.js";
import type { ModuleSelection, Quote } from "../src/domain/types.js";

const ctx: PricingContext = {
  specVersionId: PILOT_SPEC_VERSION_ID,
  companyId: PILOT_COMPANY_ID,
  modules: pilotModules,
  doorStyles: pilotDoorStyles,
  priceMatrix: pilotPriceMatrix,
  hardwareOptions: pilotHardware,
  accessoryOptions: pilotAccessories,
  boxMaterialOptions: pilotBoxMaterials,
  discountRules: pilotDiscounts,
  shippingRule: pilotShipping,
  taxRules: SEED_TAX_RULES,
};

const mod = (code: string) => {
  const m = pilotModules.find((x) => x.code === code);
  assert.ok(m, `种子里没有型号 ${code}`);
  return m;
};

function sel(code: string, qty = 1): ModuleSelection {
  const m = mod(code);
  return {
    moduleId: m.id, qty,
    width: m.widthOptions[0]!, height: m.heightOptions[0]!, depth: m.depthOptions[0]!,
    assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [],
  };
}

const at = "2026-03-01T00:00:00.000Z";
const selections = [sel("B30", 2), sel("SB36"), sel("W3030", 2), sel("BF3", 2), sel("LEG", 12)];
const priceWith = (boxMaterialId?: string, doorStyleId = pilotDoorStyles[0]!.id) =>
  computePrice(ctx, {
    selections, doorStyleId,
    ...(boxMaterialId ? { boxMaterialId } : {}),
    accountType: "consumer", province: "ON", at,
  });

const PARTICLE = "bm_particle", PLYWOOD = "bm_plywood", SOLID = "bm_solid";

// ── 两个维度是正交的 ─────────────────────────────────────────────────────

test("同一款门板，三档箱体是三个价——箱体不是白送的", () => {
  const totals = [PARTICLE, PLYWOOD, SOLID].map((id) => priceWith(id).total);
  assert.equal(new Set(totals).size, 3, `三档箱体报出了相同的价：${totals.join("、")}`);
  // 顺序必须是 颗粒板 < 夹板 < 实木
  assert.ok(totals[0]! < totals[1]! && totals[1]! < totals[2]!,
    `箱体越高档反而越便宜：${totals.join(" / ")}`);
});

test("换箱体不改价格组——价格组只由门板决定", () => {
  const groups = [PARTICLE, PLYWOOD, SOLID].map((id) => priceWith(id).priceGroupId);
  assert.equal(new Set(groups).size, 1,
    "换了箱体板材，价格组跟着变了——那说明两个维度被混在了一起");
});

test("换门板花色不改箱体加价的比例——逐行看", () => {
  // 加价是**该行标价**的百分比。标价随花色变，比例本身不该变。
  // 断言的是「加价 === 该行标价的 18%（分为单位，四舍五入）」本身，
  // 而不是两个比值相等——金额按分取整，比值本来就不会分毫不差。
  const check = (doorStyleId: string) => {
    const line = priceWith(PLYWOOD, doorStyleId).lineItems.find((l) => l.moduleCode === "B30")!;
    const box = line.modifiers.find((m) => m.kind === "boxMaterial")!;
    assert.equal(box.amount, percentOf(line.unitListPrice, 18),
      `${doorStyleId} 下夹板加价不是标价的 18%`);
  };
  check(pilotDoorStyles[0]!.id);
  check(pilotDoorStyles[pilotDoorStyles.length - 1]!.id);
});

test("整单的箱体涨幅**不等于**那 18%，而且随花色略有不同", () => {
  // 这不是 bug，是正确结果：填缝条、塑料地脚不跟着涨，它们在整单里占的比重
  // 又随花色变（塑料地脚连花色都不跟）。所以"整单涨 18%"这句话是错的，
  // 不能拿它去跟客户解释——要说就说"柜体涨 18%，配件不涨"。
  const orderRatio = (doorStyleId: string) => {
    const plain = priceWith(PARTICLE, doorStyleId);
    const ply = priceWith(PLYWOOD, doorStyleId);
    return (ply.subtotal - plain.subtotal) / plain.subtotal;
  };
  const a = orderRatio(pilotDoorStyles[0]!.id);
  const b = orderRatio(pilotDoorStyles[pilotDoorStyles.length - 1]!.id);
  assert.ok(a < 0.18 && b < 0.18,
    `整单涨幅达到了逐行的 18%——那意味着不该涨的件也涨了（${a} / ${b}）`);
  assert.notEqual(a, b, "整单涨幅在两个花色下完全相同，反而可疑");
});

// ── 没箱体的件不加价 ─────────────────────────────────────────────────────

test("填缝条、踢脚板、塑料地脚没有箱体", () => {
  for (const code of ["BF3", "WF3", "TK8", "LEG", "BEP"]) {
    assert.equal(hasCarcass(mod(code)), false, `${code} 不该被当成有箱体的件`);
  }
  for (const code of ["B30", "SB36", "W3030", "PC1884"]) {
    assert.equal(hasCarcass(mod(code)), true, `${code} 是一个箱体，该跟着箱体板材走`);
  }
});

test("升级全夹板时，填缝条与塑料地脚一分钱都不涨", () => {
  const plain = priceWith(PARTICLE);
  const ply = priceWith(PLYWOOD);
  for (const code of ["BF3", "LEG"]) {
    const a = plain.lineItems.find((l) => l.moduleCode === code)!;
    const b = ply.lineItems.find((l) => l.moduleCode === code)!;
    assert.equal(b.lineSubtotal, a.lineSubtotal,
      `${code} 跟着箱体涨价了——它是一块板/一个塑料件，谈不上用什么板做盒子`);
    assert.equal(b.modifiers.some((m) => m.kind === "boxMaterial"), false,
      `${code} 上挂了箱体板材的修饰项`);
  }
});

test("基础档不往每一行上挂一条 $0 的修饰项", () => {
  const plain = priceWith(PARTICLE);
  assert.equal(
    plain.lineItems.some((l) => l.modifiers.some((m) => m.kind === "boxMaterial")), false,
    "颗粒板加价为 0，却逐行挂了修饰项——客户读到的是噪音");
});

test("升级档的加价挂在行上，看得见是为什么涨的", () => {
  const b30 = priceWith(PLYWOOD).lineItems.find((l) => l.moduleCode === "B30")!;
  const m = b30.modifiers.find((x) => x.kind === "boxMaterial");
  assert.ok(m, "B30 涨了价却没说是箱体升级涨的");
  assert.match(m.name, /夹板/);
  assert.ok(m.amount > 0);
});

// ── 默认档 ───────────────────────────────────────────────────────────────

test("客户没选时按商家的默认档，且报价上记的是那一档", () => {
  const none = priceWith(undefined);
  assert.equal(none.boxMaterial?.id, PARTICLE, "默认档没落到报价上");
  assert.equal(none.total, priceWith(PARTICLE).total,
    "「没选」与「选了基础档」应该是同一个价");
});

test("商家一档都没给时，报价与从前逐分一致", () => {
  const legacy = { ...ctx, boxMaterialOptions: [] };
  const now = computePrice(legacy, {
    selections, doorStyleId: pilotDoorStyles[0]!.id,
    accountType: "consumer", province: "ON", at,
  });
  assert.equal(now.boxMaterial, undefined);
  assert.equal(now.total, priceWith(PARTICLE).total,
    "没有箱体维度的旧规格版本，报价不该因为加了这个特性而变");
});

test("选了一档不存在的箱体：当场报错，不静默换成默认档", () => {
  // 静默回退等于按客户没要的规格出价，而那份价会被拿去下单
  assert.throws(() => priceWith("bm_不存在"), (err: unknown) => {
    assert.ok(err instanceof PricingError);
    assert.equal(err.code, "BOX_MATERIAL_NOT_FOUND");
    return true;
  });
});

test("FR-8 校验拦住不属于这家公司的箱体档", () => {
  const base = {
    specVersionId: PILOT_SPEC_VERSION_ID, companyId: PILOT_COMPANY_ID,
    modules: pilotModules, doorStyles: pilotDoorStyles, priceMatrix: pilotPriceMatrix,
    hardwareOptions: pilotHardware, accessoryOptions: pilotAccessories,
    boxMaterialOptions: pilotBoxMaterials, taxRules: SEED_TAX_RULES,
  };
  const bad = validateSelections(base, selections, pilotDoorStyles[0]!.id, "ON", at, "bm_别家的");
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.code === "BOX_MATERIAL_NOT_IN_SPEC"), JSON.stringify(bad.issues));

  const good = validateSelections(base, selections, pilotDoorStyles[0]!.id, "ON", at, PLYWOOD);
  assert.equal(good.ok, true, JSON.stringify(good.issues));
});

// ── 报价单上要写明 ───────────────────────────────────────────────────────

function quoteWith(boxMaterialId: string): Quote {
  const bd = priceWith(boxMaterialId);
  return {
    id: "q_x", designLayoutId: "dl_x", designRevisionNo: 1,
    companyId: PILOT_COMPANY_ID, conversationId: "c_x", customerAccountId: "ca_x",
    specVersionId: PILOT_SPEC_VERSION_ID, accountTypeAtQuote: "consumer",
    doorStyleId: pilotDoorStyles[0]!.id, priceGroupId: bd.priceGroupId,
    boxMaterialId: bd.boxMaterial!.id,
    currency: "CAD", province: "ON", taxRuleSnapshot: bd.taxRule,
    appliedDiscountRuleIds: [], lineItems: bd.lineItems, subtotal: bd.subtotal,
    discounts: bd.discounts, shipping: bd.shipping, taxes: bd.taxes, total: bd.total,
    createdAt: at, validUntil: at, status: "draft",
  };
}

test("报价清单写明箱体是哪一档——不写，两家的价看起来就是可比的", () => {
  const list = buildQuoteList({ language: "zh", 
    quote: quoteWith(PLYWOOD), modules: pilotModules,
    doorStyles: pilotDoorStyles, boxMaterials: pilotBoxMaterials,
  });
  assert.equal(list.boxMaterial?.name, "全夹板箱体");
  assert.equal(list.boxMaterial?.chosen, true);
  const text = renderQuoteListText(list, "zh");
  assert.match(text, /箱体板材/);
  assert.match(text, /全夹板箱体/);
});

test("客户没选而走了默认档时，清单上说明「你没选」", () => {
  // 「没选」和「选了基础档」在价上没区别，在解释上有：不说明的话，
  // 客户会以为自己选过全夹板
  const list = buildQuoteList({ language: "zh", 
    quote: quoteWith(PARTICLE), modules: pilotModules,
    doorStyles: pilotDoorStyles, boxMaterials: pilotBoxMaterials,
  });
  assert.equal(list.boxMaterial?.chosen, false);
  assert.match(renderQuoteListText(list, "zh"), /按该商家的基础档算的/);
});

// ── 与换花色比价的交互 ───────────────────────────────────────────────────

test("换花色比价按的是这份报价实际用的箱体档，不是默认档", () => {
  const args = {
    ctx, selections, currentDoorStyleId: pilotDoorStyles[0]!.id,
    accountType: "consumer" as const, province: "ON" as const, at,
  };
  const cmp = compareFinishes({ ...args, boxMaterialId: PLYWOOD });
  for (const o of cmp.options) {
    if (!o.total) continue;
    const real = computePrice(ctx, {
      selections, doorStyleId: o.doorStyleId, boxMaterialId: PLYWOOD,
      accountType: "consumer", province: "ON", at,
    });
    assert.equal(o.total, real.total,
      `${o.doorStyleName} 的换色价与「真选了它之后的报价」对不上`);
  }
  // 按默认档算出来的那一版必须不同——否则上面那条断言什么也没验证
  const asDefault = compareFinishes(args);
  assert.notEqual(cmp.current!.total, asDefault.current!.total,
    "全夹板与默认档算出了同一个总价，这组断言没有区分力");
});

// ── 小工具 ───────────────────────────────────────────────────────────────

test("档位按由便宜到贵排，客户从左到右就是从基础到高配", () => {
  const shuffled = [pilotBoxMaterials[2]!, pilotBoxMaterials[0]!, pilotBoxMaterials[1]!];
  assert.deepEqual(sortBoxMaterials(shuffled).map((m) => m.code),
    ["particleBoard", "plywood", "solidWood"]);
});

test("没给档时挑默认档；没有默认标记时挑第一个", () => {
  assert.equal(resolveBoxMaterial(pilotBoxMaterials, undefined)?.id, PARTICLE);
  const noDefault = pilotBoxMaterials.map((m) => ({ ...m, isDefault: false }));
  assert.equal(resolveBoxMaterial(noDefault, undefined)?.id, noDefault[0]!.id);
  assert.equal(resolveBoxMaterial([], undefined), undefined);
});

// ── 从 FR-2 模板导入进来 ─────────────────────────────────────────────────
//
// 接不进来，真实商家就没有任何办法声明「我家柜体可以升级全夹板」——
// 而那是 RTA 市场上最常见的一个升级项。

test("三家试点公司各自的箱体档都是从导入表进来的，档数与加价互不相同", () => {
  const second = buildSecondCompanyBundle().bundle;
  const third = buildThirdCompanyBundle().bundle;
  assert.equal(second.boxMaterialOptions.length, 2, "第二家该有两档");
  assert.equal(third.boxMaterialOptions.length, 3, "第三家该有三档");
  // 叫法各不相同，靠 code 归一化，不靠名字
  assert.equal(second.boxMaterialOptions.find((m) => m.code === "plywood")?.name,
    "Northwood All-Ply");
  assert.equal(third.boxMaterialOptions.find((m) => m.code === "plywood")?.name,
    "Baltic Birch Plywood");
  // 加价也不同——照商家给的样子建模，不统一成一个行业均值
  const pct = (b: typeof second) =>
    (b.boxMaterialOptions.find((m) => m.code === "plywood")!.priceModifier as
      { kind: "percent"; value: number }).value;
  assert.notEqual(pct(second), pct(third));
});

test("导入时不猜板材类别——认不出来就进待确认队列", () => {
  const r = importSpecTemplates("sv_x", "co_x", {
    ...blankTemplates(),
    boxMaterials: "code,name,upcharge\nmelamine,三聚氰胺箱体,10%\n",
  });
  assert.equal(r.bundle.boxMaterialOptions.length, 0, "猜了一个类别出来");
  assert.ok(r.unresolved.some((u) => u.sheet === "boxMaterials" && u.field === "code"),
    JSON.stringify(r.unresolved));
});

test("没人标默认档时，最便宜的那一档当默认——标价本来就是针对它给的", () => {
  const r = importSpecTemplates("sv_x", "co_x", {
    ...blankTemplates(),
    boxMaterials: "code,name,upcharge\nplywood,Ply Box,20%\nparticleBoard,Board Box,0%\n",
  });
  assert.equal(r.bundle.boxMaterialOptions.find((m) => m.isDefault)?.code, "particleBoard");
});

test("不给这张表的商家照旧只有一档——不因为加了这个特性就报不出价", () => {
  const { boxMaterials: _drop, ...noTable } = blankTemplates();
  const r = importSpecTemplates("sv_x", "co_x", noTable);
  assert.deepEqual(r.bundle.boxMaterialOptions, []);
  assert.equal(r.unresolved.some((u) => u.sheet === "boxMaterials"), false,
    "没填可选表却被记成了待确认项");
});

test("商家在备注里写英寸符号不会炸掉整张表", () => {
  // 「1/2" 夹板」在橱柜价目表里到处都是。之前解析器见到引号就进引号模式，
  // 整张表报「引号未闭合」，一行都导不进来。
  const r = importSpecTemplates("sv_x", "co_x", {
    ...blankTemplates(),
    boxMaterials: 'code,name,upcharge,note\nplywood,Ply Box,20%,1/2" 夹板箱体 + 3/4" 层板\n',
  });
  assert.equal(r.bundle.boxMaterialOptions.length, 1, JSON.stringify(r.unresolved));
  assert.equal(r.bundle.boxMaterialOptions[0]!.note, '1/2" 夹板箱体 + 3/4" 层板');
});
