/**
 * 换花色比价 —— FR-6.3。
 *
 * 报价清单末尾给出**同一套方案换其他门板花色**的重算价：
 *
 * ```
 * 【换一种门板花色】
 *   当前：Shaker White（价格组 A）        $1,358.50
 *   ────────────────────────────────────────────────
 *   Shaker Grey  （价格组 A）  同价      $1,358.50    ±$0
 *   Maple Glaze  （价格组 B）  贵 62%    $2,105.20    +$746.70
 *   Navy Shaker  （价格组 B）  —— 该商家的 SB36 不供应此花色，换色需调整水槽柜型号
 * ```
 *
 * ## 为什么必须逐行重算，不能给总价乘一个系数
 *
 * 价格矩阵是**逐格给的**：`(型号 × 价格组)`。同一个价格组里，B30 可能贵 62%，
 * SB36 贵 55%，填缝条贵 80%。乘一个系数得出的数**没有任何一行支持它**，
 * 而客户会拿这个数去跟别家比、去签合同。
 *
 * 更要命的是折扣、运费、税：满额折扣有门槛，换个花色可能正好跨过去。
 * 乘系数的做法连门槛都跨不对。
 *
 * 所以这里的做法是**把整条定价链路重跑一遍**（`priceQuote`），只换 `doorStyleId`。
 * 逐行、折扣、运费、税全部重算，因为它们本来就是同一个函数算的。
 *
 * ## 跟着换色的和不跟着换色的
 *
 * 填缝条、收口板、踢脚板、顶线**跟着换**——要与门同色，那正是它们存在的理由。
 * **塑料地脚不换**：藏在踢脚板后面没人看得见，一个价。这条不在这里判，
 * 在 `spec/finish.ts` 的 `finishDependent` 上，定价引擎自然就照做了。
 *
 * ## 价格空洞要标出来，不能悄悄跳过
 *
 * 某个花色在某个型号上没有价（商家不供应该组合），**整个花色就报不出价**——
 * 这时候要说清楚是**哪个型号**卡住了，客户才知道"换色需要调整水槽柜型号"。
 * 悄悄跳过这个花色，客户会以为它不存在；给它编一个价，那是假数据。
 */
import { ZERO, fromCents, sub, type Money } from "../domain/money.js";
import { computePrice, PricingError, type PricingContext, type PricingInput } from "../pricing/engine.js";
import { priceEntryFor } from "../spec/finish.js";
import type { DoorStyle, ModuleSelection } from "../domain/types.js";

export interface FinishOption {
  doorStyleId: string;
  doorStyleName: string;
  priceGroupId: string;
  /** 就是客户当前选的那一个。 */
  current: boolean;
  /** 换成这个花色之后的总价（含折扣、运费、税）。算不出来时为空。 */
  total?: Money;
  /** 相对当前花色的差额。正数表示更贵。 */
  delta?: Money;
  /** 差额百分比，四舍五入到整数。总价为 0 时为空。 */
  deltaPercent?: number;
  /**
   * 算不出价的原因。
   *
   * **有值就必须显示给客户**——不显示的话，这个花色会像不存在一样从清单里
   * 消失，而客户可能正想选它。
   */
  unavailable?: {
    reason: string;
    /** 卡住的型号码。客户要知道换色需要调整哪一个。 */
    moduleCodes: string[];
  };
}

export interface FinishComparison {
  /** 当前花色那一项（也在 `options` 里，这里是快捷引用）。 */
  current?: FinishOption;
  /** 全部花色，当前的排在最前，其余按总价升序；算不出价的排最后。 */
  options: FinishOption[];
  /** 至少有一个花色因价格空洞报不出价。 */
  hasHoles: boolean;
}

export interface FinishComparisonInput {
  ctx: PricingContext;
  /** 与当前报价**完全相同**的选择。换的只有门板样式。 */
  selections: readonly ModuleSelection[];
  currentDoorStyleId: string;
  /**
   * 这份报价用的箱体板材。**必须传**，否则比价会按默认档定价，
   * 而客户实际选的是全夹板——比价表上的数就不是他真选了那个花色会拿到的数，
   * 而"比价与实际报价对不上"是最难解释的一种不一致（本文件的核心约定）。
   */
  boxMaterialId?: string;
  accountType: PricingInput["accountType"];
  province: PricingInput["province"];
  at: string;
}

export function compareFinishes(input: FinishComparisonInput): FinishComparison {
  const options: FinishOption[] = [];

  for (const style of input.ctx.doorStyles) {
    options.push(evaluate(style, input));
  }

  const current = options.find((o) => o.current);
  // 差额要等当前花色算出来之后才填得上
  if (current?.total) {
    for (const o of options) {
      if (!o.total || o.current) continue;
      o.delta = sub(o.total, current.total);
      if (current.total !== 0) {
        o.deltaPercent = Math.round((o.delta / current.total) * 100);
      }
    }
  }

  options.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    // 算不出价的排最后——但**不删掉**，客户要知道它为什么不能选
    if ((a.total === undefined) !== (b.total === undefined)) return a.total === undefined ? 1 : -1;
    return (a.total ?? 0) - (b.total ?? 0);
  });

  return {
    ...(current ? { current } : {}),
    options,
    hasHoles: options.some((o) => o.unavailable),
  };
}

/**
 * 算一个花色。
 *
 * 走的是**与正式报价完全相同的 `computePrice`**——不是另写一份"比价用的算法"。
 * 另写一份的话，比价表上的数和客户真选了那个花色之后拿到的报价会对不上，
 * 而那是最难解释的一种不一致。
 */
function evaluate(style: DoorStyle, input: FinishComparisonInput): FinishOption {
  const base: FinishOption = {
    doorStyleId: style.id,
    doorStyleName: style.name,
    priceGroupId: style.priceGroupId,
    current: style.id === input.currentDoorStyleId,
  };

  // 先把空洞找齐再定价：`priceQuote` 遇到第一个空洞就抛，只报得出一个型号，
  // 而客户想知道的是"要调整哪几个"
  const holes = holesFor(style, input);
  if (holes.length > 0) {
    return {
      ...base,
      unavailable: {
        reason: `该商家的 ${holes.join("、")} 不供应此花色所属的价格组，` +
          `换色需要先调整${holes.length > 1 ? "这几个" : "这个"}型号`,
        moduleCodes: holes,
      },
    };
  }

  try {
    const priced = computePrice(input.ctx, {
      selections: [...input.selections],
      doorStyleId: style.id,
      ...(input.boxMaterialId ? { boxMaterialId: input.boxMaterialId } : {}),
      accountType: input.accountType,
      province: input.province,
      at: input.at,
    });
    return { ...base, total: priced.total, delta: ZERO };
  } catch (err) {
    // 定价链路上任何一处拒绝都如实说出来，不给一个假价
    return {
      ...base,
      unavailable: {
        reason: err instanceof PricingError
          ? err.message
          : "这个花色算不出价，请联系该商家确认",
        moduleCodes: [],
      },
    };
  }
}

/** 这个花色在哪些型号上没有价。返回型号码，不是 id——客户看的是码。 */
function holesFor(style: DoorStyle, input: FinishComparisonInput): string[] {
  const codes = new Set<string>();
  for (const sel of input.selections) {
    const mod = input.ctx.modules.find((m) => m.id === sel.moduleId);
    if (!mod) continue;
    if (!priceEntryFor(mod, style.priceGroupId, input.ctx.priceMatrix)) {
      codes.add(mod.code);
    }
  }
  return [...codes].sort();
}

/** 报价清单末尾那一段文字。邮件与 PDF 都用它，措辞只有一份。 */
export function renderFinishComparison(
  cmp: FinishComparison,
  format: (m: Money) => string,
): string {
  if (cmp.options.length <= 1) return "";
  const out: string[] = ["【换一种门板花色】"];
  if (cmp.current?.total !== undefined) {
    out.push(`  当前：${cmp.current.doorStyleName}　${format(cmp.current.total)}`);
    out.push(`  ${"─".repeat(52)}`);
  }
  for (const o of cmp.options) {
    if (o.current) continue;
    if (o.unavailable) {
      out.push(`  ${o.doorStyleName}　—— ${o.unavailable.reason}`);
      continue;
    }
    const pct = o.deltaPercent === undefined ? ""
      : o.deltaPercent === 0 ? "同价"
        : o.deltaPercent > 0 ? `贵 ${o.deltaPercent}%` : `便宜 ${-o.deltaPercent}%`;
    const delta = o.delta === undefined || o.delta === 0
      ? "±$0" : `${o.delta > 0 ? "+" : "−"}${format(fromCents(Math.abs(o.delta)))}`;
    out.push(`  ${o.doorStyleName}　${pct}　${format(o.total!)}　${delta}`);
  }
  out.push("");
  out.push("  说明：以上是同一套方案换门板后的**重算价**，柜体数量与排布完全不变。");
  out.push("  填缝条、收口板、踢脚板跟着换色；塑料地脚不换——它藏在踢脚板后面，一个价。");
  return out.join("\n");
}
