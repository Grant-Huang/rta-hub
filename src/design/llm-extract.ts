/**
 * 聊天里的墙长/层高/家电——LLM 结构化抽取，逐步取代正则作为主解析引擎。
 *
 * ## 为什么不能只是"把 combined 文本喂给 LLM"
 *
 * 历史上这类 bug（见 `chat-history-contamination.test.ts` 的根因说明）都出在同一
 * 件事上：把最近的历史消息（含**助手自己说的话**）拼成一段文本喂给解析器，解析器
 * 分不清"这是客户刚报的数据"还是"这是助手举的例子/发的警告"。正则天生做不到这种
 * 区分——它只认字面模式。换成 LLM 本该是**解决**这个问题的机会，而不是把同一个坑
 * 换个解析器再踩一次：所以这里**不用 `combined` 那种拼接文本**，而是把每一轮
 * 聊天显式标成 CUSTOMER / ASSISTANT，并在提示词里明确教会模型"助手的举例/警告
 * 不算数据，但助手复述客户已经说过的话、客户确认了，那些数字仍然算数据"。
 *
 * ## 这一步只做抽取，不做写入
 *
 * 抽取结果（`ExtractedGeometry`）交给 `chat-site-answers.ts` /
 * `chat-appliance-answers.ts` 里的 `applyExtracted*` 函数去写入 FloorPlan——
 * 那两个函数复用的是 Phase 1 已经焊好的"确认锁"（`confirm-lock.ts`），
 * 已确认的字段一样不会被 LLM 的抽取结果静默覆盖。
 *
 * ## 没配 LLM / 抽取失败时怎么办
 *
 * `extractGeometryFromChat` 在任何失败情况（没配置、没有这个能力、调用报错、
 * 返回不合法）下都返回 `undefined`，调用方（`server.ts`）在 `undefined` 时
 * 原样继续走已有的正则解析（`applyChatSiteAnswers` / `applyChatApplianceAnswers`）
 * ——测试环境不配 LLM key，因此这条新路径在现有测试里从不触发，954 个既有测试
 * 不受影响。
 */
import { z } from "zod";
import type { CompletionClient } from "../agents/types.js";
import { APPLIANCE_DEFAULTS, type ApplianceKind } from "../floorplan/appliances.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ExtractedWallRun {
  label: string;
  lengthInches: number;
}

export interface ExtractedAppliance {
  kind: ApplianceKind;
  widthInches?: number;
}

export interface ExtractedGeometry {
  wallRuns: ExtractedWallRun[];
  ceilingHeightInches?: number;
  appliances: ExtractedAppliance[];
  confirmAssumedAppliances: boolean;
}

const APPLIANCE_KIND_VALUES = Object.keys(APPLIANCE_DEFAULTS) as [ApplianceKind, ...ApplianceKind[]];

/** 与 chat-site-answers.ts / floorplan/appliances.ts 里现有正则解析用的是同一套合理范围。 */
const WALL_LENGTH_RANGE = { min: 24, max: 360 };
const CEILING_HEIGHT_RANGE = { min: 84, max: 144 };
const APPLIANCE_WIDTH_RANGE = { min: 12, max: 60 };

const ExtractionSchema = z.object({
  wallRuns: z.array(z.object({
    label: z.string(),
    lengthInches: z.number(),
  })).default([]),
  ceilingHeightInches: z.number().optional(),
  appliances: z.array(z.object({
    kind: z.enum(APPLIANCE_KIND_VALUES),
    widthInches: z.number().optional(),
  })).default([]),
  confirmAssumedAppliances: z.boolean().default(false),
});

const SYSTEM_PROMPT = `You extract structured kitchen-design facts from a chat transcript between a customer and a design assistant.

Each transcript line is labeled CUSTOMER or ASSISTANT. Extract data ONLY from what the CUSTOMER actually stated as fact about their own kitchen. Follow these rules exactly:

1. Never extract numbers or facts that appear ONLY in an ASSISTANT line as an example, format hint, suggestion, or warning — even if the wording looks like real data. An assistant line like 'e.g. "North 84\\", East 108\\", ceiling 96\\""' is a FORMAT HINT, not customer data — ignore those numbers entirely, in every language.
2. Exception: if an ASSISTANT line recaps/restates numbers the CUSTOMER already gave earlier in this same transcript, and the CUSTOMER's next line is a short confirmation ("yes", "correct", "对", "是的", "没错", "对的"), you MAY extract those numbers — but only the ones that trace back to an earlier CUSTOMER statement, never a number the assistant introduced for the first time.
3. If you are not sure whether a number came from the customer, leave it out entirely. Do not guess, round, or infer a number the customer never stated.
4. All lengths must be output in inches. Convert feet (x12) or centimeters (/2.54) yourself.
5. Wall labels: reuse whatever short label the customer used for that wall (e.g. "North", "Left", "Wall A", or the English name for a Chinese compass direction like 北→North, 左→Left).
6. Appliance kind must be one of exactly: refrigerator, range, cooktop, wallOven, rangeHood, microwave, dishwasher. Only include an appliance the customer actually mentioned. Only include widthInches if the customer stated a measured width for it — do not invent a "typical" width.
7. Set confirmAssumedAppliances to true only if the customer explicitly accepted assumed/default appliance widths (e.g. "assumed widths are fine", "推定可以", "按推定", "就按常见尺寸").
8. Output only the JSON object matching the schema — no extra commentary.

Example — DO extract (customer stated it directly):
CUSTOMER: North wall is 168 inches, East wall 120 inches
-> wallRuns: [{"label":"North","lengthInches":168},{"label":"East","lengthInches":120}]

Example — do NOT extract (assistant's own format example):
ASSISTANT: You can report wall lengths like this — e.g. "North 84\\", East 108\\", ceiling 96\\"".
CUSTOMER: ok got it
-> wallRuns: [] (84/108/96 belong to the assistant's example, not the customer)

Example — DO extract (customer confirms assistant's recap of the customer's own earlier statement):
CUSTOMER: North wall 168, East wall 120
ASSISTANT: Got it — North 168", East 120". Ceiling height?
CUSTOMER: yes that's right, ceiling is 96
-> wallRuns: [{"label":"North","lengthInches":168},{"label":"East","lengthInches":120}], ceilingHeightInches: 96
(168/120 trace back to the customer's own earlier line, merely restated and confirmed — not a fresh assistant example)`;

/**
 * 把聊天记录喂给 LLM，抽取结构化的墙长/层高/家电事实。
 *
 * 任何失败情况——没配 LLM、这个客户端不支持结构化抽取、调用报错/超时、
 * 返回值校验不过——都返回 `undefined`，调用方据此原样退回正则解析。
 * 不在这里抛异常，因为"抽取失败"本身是正常路径的一部分，不是异常状况。
 */
export async function extractGeometryFromChat(
  client: CompletionClient | undefined,
  turns: readonly ChatTurn[],
): Promise<ExtractedGeometry | undefined> {
  if (!client?.extractStructured) return undefined;
  if (turns.length === 0) return undefined;

  // 显式按角色打行标——不用真的多轮 messages，是为了让"这句是客户/助手说的"
  // 这件事写在文本里、模型看得见，不依赖底层 provider 对 role 的处理方式
  // （`llm-client.ts` 的 compatMode 端点甚至会把多轮折叠进一条 user 消息）。
  const transcript = turns
    .map((t) => `${t.role === "user" ? "CUSTOMER" : "ASSISTANT"}: ${t.content}`)
    .join("\n");

  let raw: z.infer<typeof ExtractionSchema> | undefined;
  try {
    raw = await client.extractStructured({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: transcript }],
      schema: ExtractionSchema,
      temperature: 0.1,
      callSite: "geometryExtract",
    });
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  const inRange = (n: number, r: { min: number; max: number }) =>
    Number.isFinite(n) && n >= r.min && n <= r.max;

  const wallRuns = raw.wallRuns
    .filter((w) => w.label.trim().length > 0 && inRange(w.lengthInches, WALL_LENGTH_RANGE))
    .map((w) => ({ label: w.label.trim(), lengthInches: Math.round(w.lengthInches) }));

  const ceilingHeightInches = raw.ceilingHeightInches !== undefined
    && inRange(raw.ceilingHeightInches, CEILING_HEIGHT_RANGE)
    ? Math.round(raw.ceilingHeightInches)
    : undefined;

  const appliances: ExtractedAppliance[] = raw.appliances.map((a) => ({
    kind: a.kind,
    ...(a.widthInches !== undefined && inRange(a.widthInches, APPLIANCE_WIDTH_RANGE)
      ? { widthInches: a.widthInches }
      : {}),
  }));

  return {
    wallRuns,
    ...(ceilingHeightInches !== undefined ? { ceilingHeightInches } : {}),
    appliances,
    confirmAssumedAppliances: raw.confirmAssumedAppliances,
  };
}
