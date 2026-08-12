/**
 * 已确认字段的"锁" —— 聊天解析（正则，以后是LLM）不得静默覆盖已确认数据。
 *
 * 背景：历史上出现过多次"聊天新解析出的数字/文本，把已经核实过的墙长/家电
 * 尺寸悄悄改掉"的问题（最典型的一例见 `chat-history-contamination.test.ts`
 * 的根因说明）。除了修复具体的误触发源头之外，还需要一条更通用的规则：
 * **一个字段一旦不再有待确认项（即 provenance 为 "customer"），聊天解析就
 * 不能再自动改写它**——客户如果确实想改，应当走专门的编辑入口（已确认面板/
 * 结构化 API），而不是指望自由文本解析"猜对"这是一次修改而不是噪音。
 *
 * 这个文件只放"锁"触发后要上报什么"，具体判断某字段是否已确认，复用
 * `design-input.ts` 里已经写好的 provenance 推导（`wallRunProvenance` 等）。
 */

/** 一次被拦下的修改尝试——原值没变，但要让上层知道客户想改什么、改成了什么。 */
export interface BlockedEdit {
  kind: "wallLength" | "ceiling" | "appliance";
  /** 墙名 / 家电名，供人看的标签。 */
  label: string;
  /** 已确认的当前值。 */
  current: number;
  /** 聊天里解析出的、被拦下的新值。 */
  attempted: number;
}
