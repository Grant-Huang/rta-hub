# 测试用户 Agent —— 设计说明

> 状态：已落地（可切割包 `src/testing/`）  
> 相关：FR-20 用户 agent、[SANITY_RULES.md](./SANITY_RULES.md)、[DESIGN_CRITIC_AGENT.md](./DESIGN_CRITIC_AGENT.md)

---

## 1. 目标

用独立测试 LLM 扮演真实客户：**人设 + 测试意图**（软目标）→ 在系统/厂商引导下即兴对话 →
真实 HTTP 落库（首条/`test-…` 前缀）→ 可选 DesignCritic。

原则：

- **尽量不写死对话剧本**；测试点只变成意图与私有世界，不逐步念台词。
- 小白不知道何时该问什么——因此总控/厂商 agent 必须主动引导（见 prompt）。
- 与生产切割：逻辑在 `src/testing/`；会话 `origin: "test"`；LLM 用 `*_TEST_*` / `*_CRITIC_*`。

---

## 2. 人设（persona）

按用例轮转：

| persona | 行为 |
|---------|------|
| `beginner` | 不懂术语；等被问；回答含糊；除非被教会否则不主动 `@` |
| `familiar` | 被问就答清；产品问题可自然 `@` |
| `trade_pro` | 行话、高效补尺寸；会主动上传户型 / `@` 厂商 |

实现：`scripts/user-agent.mts`（`personaForCaseIndex`）。

---

## 3. 测试意图 vs 脚本

`blueprintFromPoints` 产出：

- `mission.brief` + `softGoals`：自然语言意图（给用户 agent）
- `facts` / `walls`：私有世界（**只给用户 agent**；被问到才在聊天里说）
- `observe.*`：套件观察是否触及 @ / 出图 / 报价等（**不是**逐步强制脚本）

对话循环在 `run-case.ts`：用户 agent 每轮带上**完整会话历史**（客户 + 平台），
LLM messages 做角色翻转后续写；每轮可附 `ACTION:upload_floorplan|consent_design|…`。

**Harness 职责边界（重要）**：

| 动作 | harness 做什么 | harness **不**做什么 |
|------|----------------|----------------------|
| `upload_floorplan` | `POST` 空壳户型（仅文件元数据） | 用蓝图 `walls`/`appliances` 调 `/resolve` 写库 |
| 聊天回合 | 把用户 agent 原文 `POST` 给系统 | 替客户编尺寸、替系统填 Confirmed |
| `consent_design` 等 | 点真实 UI 按钮 | 在资料未齐时偷偷注入几何 |

几何与家电宽度必须由**系统 agent 问出来**，用户 agent 从 PRIVATE WORLD 作答，经生产路径（`applyChatSiteAnswers` 等）落库。否则会出现「聊天说识图失败、Confirmed 却已满」的假阳性。

蓝图里的 `walls` 仍存在，用途仅有：合成用户 agent 的私有事实、以及观察期望——**不是**直写数据库的脚本。

---

## 4. 入口

| 入口 | 说明 |
|------|------|
| `POST /api/admin/test-user/runs` | `{ count, pointIds? }` |
| `GET /api/admin/test-user/points` | 建议测试点 |
| `/admin/test-user` | 设置页 |
| `pnpm test:user [n]` | CLI |

---

## 5. LLM

| 角色 | 环境变量 |
|------|----------|
| 测试用户 | `OPENAI_*_TEST`, `LLM_MODEL_TEST_{CHAT,REASONING,VISION}` |
| 专家 Critic | `LLM_MODEL_CRITIC_REASONING`, `OPENAI_*_CRITIC_VISION`, `LLM_MODEL_CRITIC_VISION` |
