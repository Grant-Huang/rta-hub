/**
 * 价格随不随花色变 —— REQUIREMENTS §3.5.5 的那一条，**唯一的一份实现**。
 *
 * ## 问题
 *
 * 价格矩阵的键是 `(型号 × 价格组)`，价格组来自门板样式。这个结构默认
 * **每个型号的价格都随花色变**。对绝大多数件这是对的：
 *
 * | 类别 | 随花色变 | 理由 |
 * |---|---|---|
 * | 柜体（含门） | ✅ | 门板就是花色本身 |
 * | 填缝条 / 收口板 / 踢脚板 / 顶线 | ✅ | 要与门同色，这正是它们存在的理由 |
 * | **塑料地脚** | ❌ | 藏在踢脚板后面，**没人看得见**。黑色塑料件，一个价 |
 *
 * 给一个看不见的塑料件编一个"高级花色版"的价格，是凭空加价。
 *
 * ## 为什么查价要收在一个函数里
 *
 * 「哪些型号只需要一行价格」这件事有**两处**要用：定价引擎查价、FR-8 校验
 * 判有没有价格空洞。两边各写一遍的话，必然出现「校验说缺一行、定价却查得到」
 * 或者反过来——而后者更糟：校验放行了，定价当场抛 `PRICE_MATRIX_HOLE`，
 * 客户看到的是一句"报价校验未通过"，根因在几百行之外。
 *
 * 所以两边都调 `priceEntryFor`。
 */
import type { ModuleSpec, PriceMatrixEntry } from "../domain/types.js";

/**
 * 这个型号的价格随不随花色变。
 *
 * 缺省 `true`——**没声明就按"随花色变"办**，那是安全的方向：多要求几行价格
 * 只会让商家补数据，而反过来（默认不随花色变）会让一个真的分花色定价的型号
 * 只按一行报价，客户拿到的是错价。
 */
export function isFinishDependent(module: ModuleSpec): boolean {
  return module.finishDependent !== false;
}

/**
 * 查这个型号在这个价格组下的价格条目。
 *
 * `finishDependent: false` 的型号**忽略价格组**：它在矩阵里只有一行，
 * 那一行对所有花色都适用。
 *
 * 返回 `undefined` 表示真的是价格空洞——**不回退到"某个默认价"**。
 * 一个查不到价的型号必须整单拒绝，猜一个价格比报错危险得多。
 */
export function priceEntryFor(
  module: ModuleSpec,
  priceGroupId: string,
  priceMatrix: readonly PriceMatrixEntry[],
): PriceMatrixEntry | undefined {
  const mine = priceMatrix.filter((e) => e.moduleId === module.id);
  if (mine.length === 0) return undefined;
  if (isFinishDependent(module)) {
    return mine.find((e) => e.priceGroupId === priceGroupId);
  }
  // 不随花色变：先认精确命中（商家真的填了这一行就用它），否则用唯一的那一行
  return mine.find((e) => e.priceGroupId === priceGroupId) ?? mine[0];
}
