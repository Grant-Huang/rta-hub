# DesignCritic（设计专家挑刺）—— 设计说明

> 状态：**已按 FR-21 落地（MVP）**  
> 相关：REQUIREMENTS **FR-21**、[SYSTEM_TRAINER_AGENT.md](./SYSTEM_TRAINER_AGENT.md)（分轨）、
> [SANITY_RULES.md](./SANITY_RULES.md) / FR-14（硬闸门）、`src/agents/design-critic.ts`

---

## 1. 要解决什么问题

交付前审核（FR-14）回答「这一份现在能不能给客户」。它不回答：

- 会话过程是否啰嗦、重复追问、未 `@` 却谈厂商价；
- 解释是否说清假设；
- 在硬约束之外，专家会怎么挑刺设计产出。

**DesignCritic** 是运营侧自动专家：跨会话只读，自动在里程碑后产出改善建议，
写进**运营评审会话框**，客户 UI 默认不可见（决策 **1A**）。

---

## 2. 与 Platform Trainer 分轨（决策 2A）

| | DesignCritic（本文件） | Platform Trainer |
|--|------------------------|------------------|
| 对话对象 | 运营评审某次客户会话 | 运营教 L0 知识 |
| 写入 | `CritiqueReview` only | `PlatformKnowledgeCard` draft |
| 读 | 全部会话（含 simulate/test） | 已发布 L0 + 训练会话 |
| 自动？ | 是（里程碑触发） | 否（人工训练） |
| 进客户 prompt？ | **禁止** | 仅 published 知识卡 |

挑刺结果可人工 `promoted_to_trainer`，**禁止**自动从客户会话写入 L0。

---

## 3. 触发

| trigger | 时机 |
|---------|------|
| `planView` | 俯视图 + FR-14 audit 落盘后 |
| `fourViews` | 四视图 + audit 后 |
| `quote` | 报价 + audit 后（含拦下） |
| `stageAdvance` | `design/advance` 成功 |
| `sessionEnd` | `POST /api/admin/session-runs/:id/end`（simulate 结束会调） |
| `manual` | 运营在 `/admin` 点「手动再评审」 |

无 LLM：确定性启发式（重复尺寸追问、未 @ 谈价、就绪缺口、audit blockers）。

CallSite：`designCritique` → reasoning 层。

---

## 4. 会话持久化（与 Critic 配套）

| 来源 | dataDir | origin |
|------|---------|--------|
| 生产 | `DATA_DIR` | `production`（runId=`prod`） |
| simulate | `sim-out/<runId>/data/` | `simulate` |
| 集成测试 | `.tmp/test-sessions/<runId>/` | `test` |
| 纯单元（无会话） | 仍可 `ephemeral` | 不进 Critic 索引 |

`Conversation.origin` / `runId` / `tags` + `session-runs.json` 索引。
Admin 可发现外仓 run（扫 `sim-out/*`、`.tmp/test-sessions/*`）。

---

## 5. API（均需 `X-Admin-Token`）

| 方法 | 路径 |
|------|------|
| GET | `/api/admin/session-runs` |
| POST | `/api/admin/session-runs/:id/end` |
| GET | `/api/admin/conversations` |
| GET | `/api/admin/conversations/:id` |
| GET/POST | `/api/admin/conversations/:id/critiques` |
| POST | `/api/admin/critiques/:id/messages` |
| PATCH | `/api/admin/critiques/:id` |

UI：[`web/admin-review.html`](../web/admin-review.html) → `/admin`  
左列表 / 中客户 transcript 只读 / 右专家会话框。

---

## 6. 硬边界

1. 不改布局、报价、客户 `messages`。  
2. 不注入客户侧 Agent prompt。  
3. FR-14 硬阻断仍以 `auditDeliverable` 为准。  
4. 跨会话 prompt 只可带同 run 统计，不塞其他客户全文。
