/**
 * LLM 模型分层 —— 主力 / 轻量 / 视觉。
 *
 * ## 为什么要分层
 *
 * 对话轮次是这个系统里最主要的模型成本项：客户跟总控助手来回聊十几轮，最后才出一次方案。
 * 这十几轮里绝大部分是「收集需求、答一句常识、澄清一个字段」——用最强的模型去做，
 * 贵，而且慢（客户在等着看回复）。
 *
 * 但**有些时刻确实需要强模型**：把一段自然语言的修改要求翻译成对多个约束的调整
 * （"把水槽挪到窗下，但洗碗机别动"），或者从一份格式混乱的价目表里抽出结构化规格。
 * 这些做错了，后果是错的方案和错的报价。
 *
 * 所以分三层：
 *
 * | 层 | 干什么 | 特点 |
 * |---|---|---|
 * | `chat` 轻量 | 日常问答、需求收集、澄清、术语解释 | 高频、延迟敏感、单轮价值密度低 |
 * | `reasoning` 主力 | 需求→设计意图、复杂修改、规格模板解析 | 低频、错了代价大 |
 * | `vision` 视觉 | 户型图抽取（FR-3） | 多模态，文本模型做不了 |
 *
 * ## 关于视觉模型：需要，而且已经在架构里了
 *
 * 户型图是图片/PDF，要从中读出墙段长度、门窗位置、上下水、层高——这是纯多模态任务，
 * 文本模型无从下手。所以问题不是「要不要第三个模型」，而是**怎么定位它**。
 *
 * 定位是：**读取 + 标注不确定，不做决定**。视觉模型的输出一律进
 * `FloorPlanUnresolved`，`suggestion` 字段**永不自动采用**（见 floorplan/parse.ts）。
 * 理由很实在：尺寸读错 3 英寸，出来的是一份装不上墙的方案和一份错的报价，
 * 而这个错误要到安装当天才会暴露。
 *
 * ## 三条不因分层而放松的约束
 *
 * 1. **FR-8 照旧**：哪一层都不产出价格，价格只由 `PricingEngine` 算。
 * 2. **@ 路由永远是确定性的**，不经过任何模型（FR-1）。
 * 3. **升级判断必须有确定性兜底**，不能全靠轻量模型自己说"我需要升级"——
 *    它判断力不足的时候，恰恰就是最需要升级的时候。
 *
 * ## 为什么不用 let-it-flow 的 CallSite 体系
 *
 * `@meso.ai/let-it-flow` 的 `CALL_SITES` 是一个**固定枚举**（planner / rewrite /
 * podcast_skill_agent 之类），面向他们自己的内容产品。我们的调用点（户型抽取、
 * 规格模板解析、公司 Agent 问答）一个都不在里面，硬塞进去只会让语义对不上。
 * 所以这里维护自己的层级映射，用 `modelById()` 拿模型——那是个不带语义假设的入口。
 */

export type ModelTier = "chat" | "reasoning" | "vision";

/** 系统里所有会调用模型的地方。新增调用点必须在这里登记，不散落字符串。 */
export type CallSite =
  | "orchestratorChat"      // 总控助手日常问答（FR-1）
  | "companySpecQa"         // 公司 Agent 答自家规格问题（FR-1）
  | "designIntent"          // 需求 → 设计意图（FR-4 的入口）
  | "layoutRevision"        // 自然语言修改要求 → 对排布的调整
  | "specTemplateParse"     // 非结构化价目表兜底解析（FR-2 降级路径）
  | "floorPlanExtract"      // 户型图抽取（FR-3）
  | "geometryExtract"       // 聊天里的墙长/层高/家电结构化抽取——正则解析引擎的 LLM 主路径
  | "designCritique"        // 运营侧 DesignCritic 挑刺（FR-21）
  | "companyStaffOnboardingAnswer" // 厂商员工会话：追问答案 → faceTemplateId/roles（Type2 A）
  | "companyStaffProfileIntent"    // 厂商员工会话：门店地址/标准折扣意图抽取（Type2 A）
  | "replyTonePolish";      // 写死模板文案的语气润色（见 agents/reply-tone.ts）——只改措辞不改事实

/**
 * 调用点 → 层级。
 *
 * 分配依据是**错了的代价**，不是「看起来难不难」：
 * 答错一句常识，客户再问一遍就好；把修改要求理解错，出来的是一版错的方案。
 */
export const CALL_SITE_TIER: Record<CallSite, ModelTier> = {
  orchestratorChat: "chat",
  companySpecQa: "chat",
  designIntent: "reasoning",
  layoutRevision: "reasoning",
  specTemplateParse: "reasoning",
  floorPlanExtract: "vision",
  // 解析错了直接进几何数据（墙长/家电尺寸），代价与 designIntent/layoutRevision
  // 是同一等级——排不下家电、装不上墙，客户要等出图才发现。
  geometryExtract: "reasoning",
  designCritique: "reasoning",
  // 答错脸型/能力标签会让排布算法每一版都错，与 geometryExtract 同一等级
  companyStaffOnboardingAnswer: "reasoning",
  // 标准折扣一旦记错，厂商 Agent 会直接把错的折后价说给真实客户——同样是
  // 「错了不报错，只是一直错」的那类代价，不能按闲聊对待
  companyStaffProfileIntent: "reasoning",
  // 润色错了顶多是话说得别扭（还有锚点校验兜底、失败即原样退回模板），
  // 跟"答错一句常识，客户再问一遍就好"是同一档代价，走轻量层。
  replyTonePolish: "chat",
};

export interface TierConfig {
  /** 该层用的模型 id；未配置为 undefined。 */
  modelId?: string;
  /** 实际生效的模型 id（可能来自回退）。 */
  effectiveModelId?: string;
  /** 是否由回退得来——回退了要能看出来，不然排查问题时找不到北。 */
  fellBackTo?: ModelTier;
}

export interface ModelTierConfig {
  chat: TierConfig;
  reasoning: TierConfig;
  vision: TierConfig;
  /** 一个模型都没配 —— 对话降级为确定性问答，核心链路照常。 */
  anyConfigured: boolean;
}

const ENV_KEY: Record<ModelTier, string> = {
  chat: "LLM_MODEL_CHAT",
  reasoning: "LLM_MODEL_REASONING",
  vision: "LLM_MODEL_VISION",
};

/** 测试用户 / simulate 专用分层（不影响生产 LLM_MODEL_*）。 */
const TEST_ENV_KEY: Record<ModelTier, string> = {
  chat: "LLM_MODEL_TEST_CHAT",
  reasoning: "LLM_MODEL_TEST_REASONING",
  vision: "LLM_MODEL_TEST_VISION",
};

function resolveTierKeys(
  env: NodeJS.ProcessEnv,
  keys: Record<ModelTier, string>,
  opts: { legacyOpenAiModel?: boolean } = {},
): ModelTierConfig {
  const raw = {
    chat: env[keys.chat]?.trim() || undefined,
    reasoning: env[keys.reasoning]?.trim() || undefined,
    vision: env[keys.vision]?.trim() || undefined,
  };
  // 生产单模型部署的向后兼容：只配了 OPENAI_MODEL 就两层文本都用它（vision 除外）
  const legacy = opts.legacyOpenAiModel
    ? (env["OPENAI_MODEL"]?.trim() || undefined)
    : undefined;

  const chat = raw.chat ?? raw.reasoning ?? legacy;
  const reasoning = raw.reasoning ?? raw.chat ?? legacy;

  return {
    chat: {
      ...(raw.chat ? { modelId: raw.chat } : {}),
      ...(chat ? { effectiveModelId: chat } : {}),
      ...(!raw.chat && raw.reasoning ? { fellBackTo: "reasoning" as const } : {}),
    },
    reasoning: {
      ...(raw.reasoning ? { modelId: raw.reasoning } : {}),
      ...(reasoning ? { effectiveModelId: reasoning } : {}),
      ...(!raw.reasoning && raw.chat ? { fellBackTo: "chat" as const } : {}),
    },
    // 视觉不回退：没有多模态模型就是没有，装作有会读出一堆瞎猜的尺寸
    vision: {
      ...(raw.vision ? { modelId: raw.vision, effectiveModelId: raw.vision } : {}),
    },
    anyConfigured: Boolean(chat || reasoning || raw.vision),
  };
}

/**
 * 解析生产分层配置。
 *
 * 回退规则（刻意不对称）：
 *   - `chat` 没配 → 回退到 `reasoning`。用强模型做闲聊只是贵，不会出错。
 *   - `reasoning` 没配 → 回退到 `chat`，但**这是有风险的降级**，要能被看见。
 *   - `vision` 没配 → **不回退**。文本模型看不了图，回退过去只会得到一堆瞎猜的
 *     尺寸；不如老实降级为手动录入（FR-3 已经支持）。
 */
export function resolveModelTiers(env: NodeJS.ProcessEnv = process.env): ModelTierConfig {
  return resolveTierKeys(env, ENV_KEY, { legacyOpenAiModel: true });
}

/**
 * 测试用户 / `pnpm simulate` 专用分层。
 * 读 `LLM_MODEL_TEST_*`，**绝不**回落到生产 `LLM_MODEL_*` / `OPENAI_MODEL`。
 */
export function resolveTestModelTiers(env: NodeJS.ProcessEnv = process.env): ModelTierConfig {
  return resolveTierKeys(env, TEST_ENV_KEY, { legacyOpenAiModel: false });
}

/** 模拟启动日志：测试分层（与生产 tierReport 分开）。 */
export function testTierReport(cfg: ModelTierConfig): string[] {
  if (!cfg.anyConfigured) {
    return ["测试 LLM 分层：未配置 LLM_MODEL_TEST_* —— 用户 agent / 场景生成走确定性回退"];
  }
  const lines: string[] = ["测试 LLM 分层（仅 simulate / 用户 agent；不影响生产）："];
  for (const tier of ["chat", "reasoning", "vision"] as const) {
    const t = cfg[tier];
    const label = { chat: "轻量(对话)", reasoning: "主力(推理)", vision: "视觉(户型图)" }[tier];
    const key = TEST_ENV_KEY[tier];
    if (!t.effectiveModelId) {
      lines.push(
        tier === "vision"
          ? `  · ${label}：未配置 —— simulate 户型视觉降级`
          : `  · ${label}：未配置`,
      );
      continue;
    }
    const via = t.fellBackTo ? `（回退自 ${TEST_ENV_KEY[t.fellBackTo]}）` : "";
    lines.push(`  · ${label}：${t.effectiveModelId}${via} ← ${key}`);
  }
  return lines;
}

export function modelFor(cfg: ModelTierConfig, site: CallSite): string | undefined {
  return cfg[CALL_SITE_TIER[site]].effectiveModelId;
}

/** 启动时的分层说明——降级与回退都要能一眼看见。 */
export function tierReport(cfg: ModelTierConfig): string[] {
  if (!cfg.anyConfigured) {
    return ["LLM 分层：未配置任何模型 —— 对话降级为确定性问答；报价/闸门/计费不受影响"];
  }
  const lines: string[] = ["LLM 分层："];
  for (const tier of ["chat", "reasoning", "vision"] as const) {
    const t = cfg[tier];
    const label = { chat: "轻量(对话)", reasoning: "主力(推理)", vision: "视觉(户型图)" }[tier];
    if (!t.effectiveModelId) {
      lines.push(
        tier === "vision"
          ? `  · ${label}：未配置 —— 户型图录入降级为手动逐项确认（FR-3）`
          : `  · ${label}：未配置`,
      );
      continue;
    }
    const via = t.fellBackTo ? `（回退自 ${ENV_KEY[t.fellBackTo]}）` : "";
    lines.push(`  · ${label}：${t.effectiveModelId}${via}`);
  }
  if (cfg.reasoning.fellBackTo === "chat") {
    lines.push("  ⚠️  主力层回退到了轻量模型：复杂修改与规格解析的准确度会下降，建议配置 LLM_MODEL_REASONING");
  }
  return lines;
}

// ── 什么时候从轻量升到主力 ────────────────────────────────────────────────

export type EscalationReason =
  | "designRequest"        // 客户要出方案/报价
  | "multiConstraintEdit"  // 修改要求涉及多个约束
  | "floorPlanReview"      // 户型刚解析完，要核对
  | "specImport"           // 规格模板解析
  | "modelRequested"       // 轻量模型自己判断需要
  | "noProgress";          // 兜底：连续几轮没进展

export interface EscalationDecision {
  escalate: boolean;
  reason?: EscalationReason;
  detail?: string;
}

/** 连续这么多轮没有新字段被填，就强制升级——轻量模型可能正在原地打转。 */
export const NO_PROGRESS_TURNS = 3;

/** 出方案/报价的意图。这类请求确定性升级，不看模型脸色。 */
const DESIGN_REQUEST = /出(一?版|个)?(方案|设计|图|报价)|帮我(设计|排|出)|报个价|做个方案|generate|quote me/i;

/**
 * 修改要求里同时提到多个位置/约束。
 *
 * "把水槽挪到窗下" 是单约束；"把水槽挪到窗下，但洗碗机别动" 涉及两个，
 * 轻量模型容易顾此失彼——漏掉后半句，客户拿到一版洗碗机被挪走的方案。
 */
const CONSTRAINT_WORDS = /水槽|灶台|灶具|冰箱|洗碗机|烤箱|微波炉|吊柜|地柜|抽屉|转角|窗|门/g;
const CONTRAST_WORDS = /但是?|同时|另外|不过|保留|别动|不要动|除了|however|but|keep/i;

export interface EscalationInput {
  /** 客户这一轮说了什么。 */
  userText: string;
  /** 已经连续几轮没有新字段被填。 */
  turnsWithoutProgress: number;
  /** 轻量模型是否自己举手说搞不定。 */
  modelRequestedEscalation?: boolean;
  /** 是否刚解析完户型图（需要主力模型带客户逐项核对）。 */
  justParsedFloorPlan?: boolean;
  /** 是否在做规格模板导入。 */
  importingSpec?: boolean;
}

/**
 * 决定这一轮是否升级到主力模型。
 *
 * 顺序有讲究：**确定性条件排在模型自述之前**。让模型来判断"我该不该升级"是不可靠的，
 * 它判断力不足时恰恰就是最需要升级的时候——所以确定性条件是主，模型信号是辅，
 * 「连续没进展」是兜底。
 */
export function escalationDecision(input: EscalationInput): EscalationDecision {
  if (input.importingSpec) {
    return { escalate: true, reason: "specImport", detail: "规格模板解析，错了整批型号都是错的" };
  }
  if (input.justParsedFloorPlan) {
    return { escalate: true, reason: "floorPlanReview", detail: "户型抽取结果需要逐项核对" };
  }

  const text = input.userText;
  if (DESIGN_REQUEST.test(text)) {
    return { escalate: true, reason: "designRequest", detail: "客户要求出方案或报价" };
  }

  const constraints = new Set(text.match(CONSTRAINT_WORDS) ?? []);
  if (constraints.size >= 2 && CONTRAST_WORDS.test(text)) {
    return {
      escalate: true,
      reason: "multiConstraintEdit",
      detail: `修改要求涉及 ${constraints.size} 个部位（${[...constraints].join("、")}）且含转折`,
    };
  }

  if (input.modelRequestedEscalation) {
    return { escalate: true, reason: "modelRequested", detail: "轻量模型判断需要更强的推理" };
  }

  // 兜底：轻量模型可能在原地打转，客户已经说了三轮却什么都没推进
  if (input.turnsWithoutProgress >= NO_PROGRESS_TURNS) {
    return {
      escalate: true,
      reason: "noProgress",
      detail: `连续 ${input.turnsWithoutProgress} 轮没有新信息被收集，换主力模型再试`,
    };
  }

  return { escalate: false };
}

/** 本轮该用哪一层。 */
export function tierForTurn(decision: EscalationDecision): ModelTier {
  return decision.escalate ? "reasoning" : "chat";
}
