/**
 * 设计会话的阶段机 —— 什么时候该出什么图。
 *
 * ## 为什么要有阶段
 *
 * 原来的流程是：户型一齐全就直接出四视图 + 报价。这有两个问题：
 *
 * 1. **没问就画。** 客户可能还在纠结要不要做，或者想先补充点什么。
 *    生成设计图对系统是一次计算，对客户是一次"我要开始认真看方案了"的心理切换——
 *    不该由系统替他决定什么时候切换。
 * 2. **一上来就给四张图太多了。** 正视图、两张俯视图、侧视图一起摆出来，
 *    客户不知道该看哪张、该对哪张提意见。而他这个阶段真正要判断的是
 *    **「柜子大致这么排，行不行」**——那是一张全局俯视图就能回答的事。
 *
 * 所以改成：
 *
 * ```
 * collecting ──(资料齐)──> readyToDraw ──(客户点头)──> planReview ──(客户满意)──> fullDrawings ──> quoted
 *                                            ↑              │
 *                                            └──(要改)──────┘
 * ```
 *
 * `planReview` 阶段只给**全局俯视图**（地柜层 + 吊柜层），在这上面来回改；
 * 改到客户说行了，才出完整四视图 + 报价清单。
 *
 * ## 阶段推进必须由客户的动作驱动
 *
 * 从 `readyToDraw` 到 `planReview` 需要客户明确点头。系统不能因为
 * "资料齐了" 就自己往前走——那正是这次改造要消除的行为。
 */
import type { Timestamp } from "../domain/types.js";

export type DesignStage =
  /** 还在收集需求与户型。 */
  | "collecting"
  /** 资料齐了，**已经问过客户要不要出图**，等他回答。 */
  | "readyToDraw"
  /** 在全局俯视图上来回改。 */
  | "planReview"
  /** 客户认可了排布，出完整四视图。 */
  | "fullDrawings"
  /** 已出报价。 */
  | "quoted";

/**
 * 客户在全局俯视图上提的一次修改。
 *
 * `note` 是客户自己的话，`applied` 是**系统真正据此改了什么**——两者分开记，
 * 因为客户说的话不一定都落得下去（"看着大气一点" 改不了任何参数）。
 * 只记 `note` 会让人以为每一轮都生效了；只记 `applied` 又丢掉了客户的原话。
 */
export interface PlanRevisionRequest {
  at: Timestamp;
  /** 客户的原话。 */
  note?: string;
  /** 这一轮实际改到排布上的偏好项（键名与 CustomerPreferences 一致）。 */
  applied: string[];
  /** 客户提了但系统没法据此调整的部分，如实记下来。 */
  unapplied?: string;
}

export interface DesignSession {
  /** 与 conversationId 同值，一个会话一个设计进程。 */
  id: string;
  conversationId: string;
  companyId: string;
  stage: DesignStage;
  /** 在全局俯视图上改了几轮。 */
  planRevisions: number;
  /** 每一轮改了什么。`planRevisions` 是它的长度，保留是为了兼容旧记录。 */
  revisionRequests?: PlanRevisionRequest[];
  /** 客户是否已经明确同意出图。 */
  drawingConsent?: { at: Timestamp; note?: string };
  /** 客户是否已经认可排布。 */
  planApproval?: { at: Timestamp };
  updatedAt: Timestamp;
}

export const ALLOWED_STAGE_MOVES: Record<DesignStage, DesignStage[]> = {
  collecting: ["readyToDraw"],
  // 客户点头 → 出全局俯视图；也可能他说"再等等"，退回收集
  readyToDraw: ["planReview", "collecting"],
  // 改排布留在原地；认可了才往下
  planReview: ["fullDrawings", "collecting"],
  // 出完图仍可回去改排布——看到正视图才发现不对是常事
  fullDrawings: ["quoted", "planReview"],
  quoted: ["planReview"],
};

export class StageError extends Error {}

export function assertStageMove(from: DesignStage, to: DesignStage): void {
  if (!ALLOWED_STAGE_MOVES[from].includes(to)) {
    throw new StageError(`设计阶段不能从 ${from} 直接到 ${to}`);
  }
}

export function newSession(input: {
  conversationId: string; companyId: string; at: Timestamp;
}): DesignSession {
  return {
    id: input.conversationId,
    conversationId: input.conversationId,
    companyId: input.companyId,
    stage: "collecting",
    planRevisions: 0,
    updatedAt: input.at,
  };
}

// ── 该问什么、能做什么 ────────────────────────────────────────────────────

export interface StagePrompt {
  stage: DesignStage;
  /** 这一步该对客户说的话。 */
  message: string;
  /** 需要客户做什么动作才能往下走。 */
  awaiting: "moreInfo" | "drawingConsent" | "planFeedback" | "sendConsent" | "none";
  /** 客户现在能用的动作。 */
  actions: { id: string; label: string }[];
}

/**
 * 生成当前阶段该说的话。
 *
 * `readyToDraw` 那句是这次改造的核心：**先问，再画**。
 */
export function stagePrompt(session: DesignSession, ctx: {
  missingFields?: readonly string[];
  planAcceptable?: boolean;
}): StagePrompt {
  switch (session.stage) {
    case "collecting": {
      const missing = ctx.missingFields ?? [];
      return {
        stage: session.stage,
        message: missing.length
          ? `还需要补充：${missing.join("、")}。`
          : "资料看起来齐了。",
        awaiting: "moreInfo",
        actions: [],
      };
    }

    case "readyToDraw":
      return {
        stage: session.stage,
        message:
          "户型和偏好都齐了。**需要我帮你生成设计图吗？**\n" +
          "我会先出一张全局俯视图，让你看看柜子大致怎么排；" +
          "你觉得排布没问题了，我再出完整的四视图和报价清单。",
        awaiting: "drawingConsent",
        actions: [
          { id: "yes", label: "好，出图看看" },
          { id: "notYet", label: "先等等，我还想补充点东西" },
        ],
      };

    case "planReview":
      return {
        stage: session.stage,
        message: session.planRevisions === 0
          ? "这是全局俯视图，分地柜层和吊柜层。**先看排布**——哪个柜子该挪、" +
            "哪里想换成抽屉，直接说。觉得可以了我再出完整四视图。"
          : `已经调整 ${session.planRevisions} 轮。还有要改的吗？没有的话我出完整图纸。`,
        awaiting: "planFeedback",
        actions: [
          { id: "approve", label: "排布可以了，出完整图纸" },
          { id: "revise", label: "还要调整" },
        ],
      };

    case "fullDrawings":
      return {
        stage: session.stage,
        message: ctx.planAcceptable === false
          ? "完整图纸已出，但这一版没通过人体工程检查，需要先调整才能报价。"
          : "完整四视图与报价清单已出。要发给这家公司吗？发送前我会先列出" +
            "将要提供的全部信息给你确认。",
        awaiting: ctx.planAcceptable === false ? "planFeedback" : "sendConsent",
        actions: [
          { id: "quote", label: "看报价清单" },
          { id: "revise", label: "回去改排布" },
        ],
      };

    case "quoted":
      return {
        stage: session.stage,
        message: "报价已生成。可以发给这家公司，也可以再叫别家出一版比价。",
        awaiting: "sendConsent",
        actions: [
          { id: "disclose", label: "查看将发送的内容" },
          { id: "revise", label: "回去改排布" },
        ],
      };
  }
}

/** 当前阶段允许出哪种图——避免"还没点头就出四视图"。 */
export function allowedArtifacts(stage: DesignStage): {
  planView: boolean;
  fourViews: boolean;
  quoteList: boolean;
} {
  switch (stage) {
    case "collecting":
    case "readyToDraw":
      return { planView: false, fourViews: false, quoteList: false };
    case "planReview":
      return { planView: true, fourViews: false, quoteList: false };
    case "fullDrawings":
    case "quoted":
      return { planView: true, fourViews: true, quoteList: true };
  }
}

// ── 阶段推进 ──────────────────────────────────────────────────────────────

export function grantDrawingConsent(s: DesignSession, at: Timestamp, note?: string): DesignSession {
  assertStageMove(s.stage, "planReview");
  return {
    ...s, stage: "planReview",
    drawingConsent: { at, ...(note ? { note } : {}) },
    updatedAt: at,
  };
}

export function deferDrawing(s: DesignSession, at: Timestamp): DesignSession {
  assertStageMove(s.stage, "collecting");
  return { ...s, stage: "collecting", updatedAt: at };
}

/**
 * 在全局俯视图上改一轮——**停留在 planReview**，不往下走。
 *
 * 一轮修改必须带上「改了什么」。只把计数加一、不改任何输入，下一版会画出
 * 一模一样的图，而客户以为自己的意见被采纳了——那比不支持修改更糟。
 */
export function recordPlanRevision(
  s: DesignSession,
  at: Timestamp,
  request: Omit<PlanRevisionRequest, "at">,
): DesignSession {
  if (s.stage !== "planReview") {
    throw new StageError(`只有在全局俯视图评审阶段才能改排布，当前是 ${s.stage}`);
  }
  return {
    ...s,
    planRevisions: s.planRevisions + 1,
    revisionRequests: [...(s.revisionRequests ?? []), { at, ...request }],
    updatedAt: at,
  };
}

export function approvePlan(s: DesignSession, at: Timestamp): DesignSession {
  assertStageMove(s.stage, "fullDrawings");
  return { ...s, stage: "fullDrawings", planApproval: { at }, updatedAt: at };
}

export function markQuoted(s: DesignSession, at: Timestamp): DesignSession {
  assertStageMove(s.stage, "quoted");
  return { ...s, stage: "quoted", updatedAt: at };
}

/** 回到排布评审——出完图才发现不对是常事，不该让人重头再来。 */
export function backToPlan(s: DesignSession, at: Timestamp): DesignSession {
  assertStageMove(s.stage, "planReview");
  return { ...s, stage: "planReview", updatedAt: at };
}

/**
 * 资料齐了就推进到「该问客户了」。
 *
 * 注意它推进到的是 `readyToDraw` 而**不是** `planReview`——
 * 齐了只意味着「可以问了」，不意味着「可以画了」。
 */
export function markReadyToDraw(s: DesignSession, at: Timestamp): DesignSession {
  if (s.stage !== "collecting") return s;
  return { ...s, stage: "readyToDraw", updatedAt: at };
}
