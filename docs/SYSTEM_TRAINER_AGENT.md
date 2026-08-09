# 系统训练 Agent（Platform Trainer）—— 按 sink 沉淀

> 状态：**已确认（v1.0）**  
> 相关：`KNOWLEDGE_LAYERS.md`（L0）、REQUIREMENTS **FR-22**、`src/knowledge/`、`src/agents/trainer.ts`；  
> 鉴权与隔离：[`ACCESS_CONTROL.md`](./ACCESS_CONTROL.md)
> （仅 `X-Admin-Token` / `platform_admin` 可管理 L0 卡实体；编号 FR-22，非 FR-21）  
> 角色：平台运营 ↔ **系统训练助手**（不是客户侧总控，也不是公司 Agent）  
> 编号说明：SessionRun / DesignCritic 占用 FR-21；本能力为 **FR-22**。

---

## 1. 问题

L0「通用橱柜常识 + 流程策略」过去散落在 prompt 与代码启发式里。运营要用自然语言补充，例如：

> 「通常不需要灶台柜；北美 stove 常与烤箱一体，且有标准尺寸。」

必须：**可审计地记下** → **按类型沉淀到正确 sink** → **在合适路径被使用**；且绝不污染 L1。

---

## 2. 角色与边界

| 角色 | 对话对象 | 写入 | 读 |
|------|----------|------|-----|
| 客户 | 总控 / `@公司` | 客户会话 | L0 已发布 +（若 @）L1 |
| **平台运营** | **系统训练 Agent** | L0 知识卡（草案→发布→沉淀） | 已发布 L0 + 训练会话 |

硬边界：

1. 禁止写入公司 SKU / 价 / 前缀 / CompanyHandbook。
2. 禁止用记忆覆盖硬约束（人体工程、价格矩阵、sellUnit 解析序、阶段机）。
3. 未 publish 的卡不得影响客户路径；`review.rule` 在代码 settle 前不改变 audit 行为。

---

## 3. 架构

```
训练会话 → Knowledge Card（强制 settleTarget）
                │
    ┌───────────┼───────────┬────────────────┐
    ▼           ▼           ▼                ▼
 handbook   config.*    review.rule       reject
 注入 LLM   overlay     promote 清单      拒绝落卡
            即生效      → SR+实现+audit
```

[`audit.ts`](../src/delivery/audit.ts) **不重新实现检查**。评审规则沉淀含义：

1. [`sanity-rules.ts`](../src/delivery/sanity-rules.ts) 登记 `SR-*`
2. 在判据模块实现
3. `auditDeliverable` 接线

---

## 4. `settleTarget`（沉淀目标）

| Target | 何时 | 运行时权威 | 示例 |
|--------|------|------------|------|
| `handbook` | 话术、流程、解释 | published body → prompt | 「先回应再追问」 |
| `config.appliance` | 家电默认/宽度 | overlay → `appliances.ts` | range 常 30" |
| `config.layoutHeuristic` | 白名单启发式 | overlay → `generate.ts` | `preferNoCooktopBase` |
| `config.dialogue` | 追问参数 | overlay → orchestrator / readiness | maxQuestions |
| `review.rule` | 交付闸门 | **代码** settle 后；卡仅溯源 | 披露类新 SR |
| `reject` | L1 或削弱硬约束 | 不落卡 | 「B12=…」「取消落台区」 |

状态：

```ts
status: "draft" | "confirmed" | "published" | "deprecated";
settleStatus?:
  | "memory_only"           // handbook
  | "config_active"         // config.* 已 publish
  | "awaiting_code_settle"  // review.rule 已确认待改代码
  | "settled_in_code";      // 已接线 SR+audit
```

---

## 5. 知识卡模型

见 `src/knowledge/types.ts`。会话只是采集通道；权威是卡 + overlay / 代码。

stove 示例 → 通常拆成：

- `config.appliance`：`rangeKind: freestanding`, `standardWidthsIn: [30]`
- `config.layoutHeuristic`：`preferNoCooktopBase: true`
- `handbook`：客户侧解释口径（可选同会话第二条）

---

## 6. API（`X-Admin-Token`）

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/api/admin/trainer/conversations` | 开训练会话 |
| GET | `/api/admin/trainer/conversations/:id` | 读会话 |
| POST | `/api/admin/trainer/conversations/:id/messages` | 发一句 → 助理 + draft cards |
| GET | `/api/admin/knowledge` | 列表 |
| PATCH | `/api/admin/knowledge/:id` | 编辑 / confirm |
| POST | `/api/admin/knowledge/:id/publish` | 发布 |
| POST | `/api/admin/knowledge/:id/deprecate` | 废弃 |
| POST | `/api/admin/knowledge/:id/mark-settled` | review.rule → `settled_in_code` |
| GET | `/api/admin/knowledge/:id/promote` | review.rule promote 清单 |
| GET | `/api/admin/knowledge/overlays` | 当前生效 overlay |
| GET | `/api/admin/knowledge/export` | markdown 导出 |

UI：[`web/admin-trainer.html`](../web/admin-trainer.html)（`/admin/trainer`）。

---

## 7. Sink 清单

**A 交付评审**：`sanity-rules.ts` → 执行模块 → `audit.ts`  
**B 家电/排布**：`appliances.ts`、`appliance-plan.ts`、`generate.ts`、`preferences/questions.ts`  
**C 对话**：`orchestrator.ts`、`quick-replies.ts`、`readiness.ts`、`site-questions.ts`、`trade/interaction.ts`  
**D 解释**：`explain.ts`、`rta-disclosure.ts`、SR-D*  
**E 禁止**：L1、sku-semantics 解析序、pack/stacking 骨架、model-tiers  

---

## 8. 验收

1. 训练「北美 stove 一体 + 30" + 通常不要灶台柜」→ ≥1 draft，含 structured + 正确 settleTarget。  
2. 未 publish → 客户路径无变化。  
3. publish config.* → overlay 生效（默认不排 cooktop 柜，除非客户声明 cooktop）。  
4. 含厂商前缀/价或削弱落台 → `reject`。  
5. `review.rule` 在 `settled_in_code` 前 audit 行为不变。  
6. deprecate 后不再注入 / 不再进 overlay。  
7. 现有 SR / ergonomics 测试不因 overlay 被放宽。

---

## 9. 已拍板（相对 v0.1）

1. 谁能训：仅 `X-Admin-Token`。  
2. 发布：必须人工 confirm/publish。  
3. 默认作用域：抽卡时按内容选 settleTarget；口语常识优先拆 `config.*` + 可选 handbook。  
4. 结构化：能进白名单字段的必须抽 structured。  
5. 中英：`body.en` 必填；`zh` 可选。  
6. 公司手册：MVP 仅 L0。  
7. FR：**FR-22**。

---

## 10. 与 DesignCritic 分轨（FR-21）

**Platform Trainer** 与 **DesignCritic** 是两条线，不要合并：

| | Trainer（本文） | DesignCritic |
|--|-----------------|--------------|
| 目的 | 人工教 L0 知识卡 | 自动挑刺会话过程与设计产出 |
| 读客户会话？ | **否**（隐私 / 防串台） | **是**（只读，运营鉴权） |
| 写客户会话？ | 否 | 否（只写 `CritiqueReview`） |
| 自动写 L0？ | 否（须 publish） | **禁止**；仅可人工 `promoted_to_trainer` |

详见 [DESIGN_CRITIC_AGENT.md](./DESIGN_CRITIC_AGENT.md)。运营评审 UI：`/admin`；训练 UI：`/admin/trainer`。

---

## 11. 与 FR-14 出图闸门

- FR-14 `auditDeliverable` 是**唯一**能拦住客户交付物的硬闸门。
- Trainer 的 `review.rule` 卡在 `settled_in_code` 前**不改变** audit 行为。
- 客户路径：audit 未过 → `deliverableReady: false` +「发现 SR-* 正在调整」叙事，不泄半成品图。
- 学习闭环：阻断可自动落 **draft** 候选（`src/knowledge/learn.ts`），仍须人工 confirm/publish。

---

## 12. 剩余缺口

- ~~厂商 L1 学习队列（CompanyHandbook / CodingRules 训练通道）~~ → **FR-22.2 已落地**（见 §13）
- ~~完整回归看板 UI（目前仅 JSONL 指标）~~ → **FR-22.2 已落地**（`/admin/regression`）
- ~~布局专用自动修复钩子~~ → **已落地**（`src/layout/audit-repair.ts`：按阻断 SR-E*/G* 定向策略 + 有限次重试；仍失败则 adjusting 叙事、不泄半成品）
- ~~客户会话纠错自动入 L1~~ → **已落地**（消息/修订可识别纠错 → 该公司 draft；scan 含 `sessionCorrections`）

仍属后续 / 准确缺口：

- L1 `apply` 不直接改 module 能力标签与矩阵价（矩阵洞仍须人工补价）
- 官方 NKBA 付费原书页码级对照（当前按公开 Kitchen Planning Guidelines PDF 核实，见 LAUNCH_BLOCKERS A6）

---

## 13. 厂商 L1 学习队列 vs 平台 L0（FR-22.2）

| | L0 Platform Trainer（本文主路径） | L1 厂商学习队列 |
|--|----------------------------------|----------------|
| 隔离 | 全平台 | **按 companyId** |
| 实体 | `PlatformKnowledgeCard` | `CompanyLearningItem`（`l1-learning-queue.json`） |
| 信号 | 运营口述；audit → draft（P1） | 会话纠错 / 导入待确认 / 能力待确认 / 矩阵洞 / assembled 不可用 |
| 确认后落入 | handbook / config.* / review.rule | 本公司 **draft** `ProductSpecVersion.handbook` / `codingRules` / 候选说明 |
| 禁止 | 写 L1 价/SKU/前缀 | 写 L0；**自动改 published 价目**；提案夹带 listPrice |
| API | `/api/admin/trainer/*`、`/api/admin/knowledge/*` | Admin：`/api/admin/l1-learn*`；公司：`/api/company/:id/l1-learn*` |
| UI | `/admin/trainer` | `/admin/l1-learn`；看板 `/admin/regression` |

实现：`src/knowledge/l1-learn.ts`、`src/knowledge/regression-dashboard.ts`。
