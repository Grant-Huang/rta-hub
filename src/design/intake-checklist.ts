/**
 * 必备信息门禁 —— 风格/预算/省份在必备信息收完前不得进入候选问题池。
 *
 * ## 为什么不是一份手写的 id 清单
 *
 * 最初设想是单独维护一份 `REQUIRED_FIELDS = ["kitchenShape", "walls", ...]`，
 * 但 `readiness.ts` 的 `evaluateDesignReadiness` 已经是「必备信息 → 状态」
 * 的唯一权威计算逻辑，每一项都带着 `category`。再维护一份平行的 id 清单，
 * 两边迟早会因为忘记同步而漂移（新加一个必备项，改了 readiness.ts 却忘了
 * 改这里，门禁形同虚设）。
 *
 * 所以门禁改成**按 category 判断**：`category` 属于 `REQUIRED_BEFORE_INTENT`
 * 的 critical 项，只要状态还没到 ok/deferred/assumed，就还没收完；风格/
 * 预算/省份（`category: "intent"`）在这之前不得出现在候选问题池里——不是
 * 排在后面问，是**不出现**。以后 Phase 3 加气/电/岛台这类新必备项，只要
 * 归到 `"site"`/`"geometry"` 分类下，自动被这道门禁覆盖，不用回来改这个文件。
 */
import type { CheckCategory, ReadinessItem } from "./readiness.js";

/** 这几个分类的 critical 项，必须先收完，才允许问风格/预算/省份。 */
export const REQUIRED_BEFORE_INTENT_CATEGORIES: readonly CheckCategory[] =
  ["geometry", "site", "appliances"];

/**
 * 必备信息是否已经收完（不含风格/预算/省份/厂商）。
 *
 * `deferred`/`assumed` 算数——客户明确说了"暂无"/接受推定数，不等于没问过。
 */
export function requiredIntakeComplete(items: readonly ReadinessItem[]): boolean {
  return items
    .filter((i) => i.critical && REQUIRED_BEFORE_INTENT_CATEGORIES.includes(i.category))
    .every((i) => i.status === "ok" || i.status === "deferred" || i.status === "assumed");
}

/** 门禁关闭时，把 style/budget/province 从候选字段列表里摘掉。 */
export function stripIntentFields(fields: readonly string[]): string[] {
  return fields.filter((f) => f !== "style" && f !== "budget" && f !== "province");
}
