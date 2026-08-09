# 厂商协作子线程（Company Engagement）—— FR-23

> 状态：**已确认设计（v1.1）· API/UI 已落地；v1.1 开线交接复述与 Agent 注入已落地**  
> 编号：**FR-23**（与 FR-1 `@` Agent 路由分轨；非 FR-21/22）  
> 相关：`REQUIREMENTS.md` FR-1 / FR-7 / FR-13 / FR-18、`ACCESS_CONTROL.md`、`UI_SHELL_REDESIGN.md`

---

## 1. 问题

今日 `@厂商` 仅路由到 **Company Agent（LLM）**，消息落在同一 `Conversation` 的主轨与 `perCompanyThreads`。  
产品需要第二档能力：客户**确认**后，在当前项目下开一条可与厂商（含真人坐席）协作的**永久子线程**，并带入可共享的项目上下文；厂商在工作台看到线索并参与，且**永不可见主线程**。

| | 轻量 `@`（FR-1，保留） | 协作子线程（FR-23，本文件） |
|--|------------------------|------------------------------|
| 触发 | 消息含 `@` | 客户确认「创建与 XXX 的协作」 |
| 对手 | 仅 Company Agent | 四角色：用户 · 系统助手 · 厂商 Agent · 厂商员工 |
| 生命周期 | 随主轨消息 | **永久分支**（可 closed，不物理删除） |
| 厂商可见主轨 | 否（本来就没有厂商 inbox） | **否（硬约束）** |

**已确认信息断层（v1.0→v1.1 修复）**：右侧 Confirmed Tab 能投影 `byCompany.doorStyleId` 等，但子轨 Agent 只拿到规格目录 + 子线程近期消息，**未注入 handoff**，导致重问已确认门板。v1.1 起交接包含厂专用快照，开线强制复述，后续轮次强制读 handoff。

---

## 2. 架构决策

### 2.1 存储形态：**父 Conversation + 按厂子线程**（已定）

- ❌ 顶层再新建一条独立 `Conversation`（破坏项目/比价/左栏父子）  
- ❌ 扁平 `messages[]` + 过滤给厂商（越权与串台风险高）  
- ✅ **一个客户项目记录**上挂 `companyEngagements[]`；消息分栏；厂商 API **只投影本厂线程 + handoff**

```
Conversation (客户项目，左栏一级)
├── messages[]                 # 主轨：客户 ↔ 总控（可含轻量 @Agent）
├── perCompanyThreads[]        # 兼容：Agent 问答旁路（非协作 inbox）
├── preferences / floorPlan / layouts / quotes…
└── companyEngagements[]       # FR-23 永久分支
      ├── id, conversationId, companyId
      ├── status: active | closed
      ├── customerTitle: "@Oppein Canada"
      ├── handoff                 # 交接包（共享 + 本厂专用快照 + confirmedFacts）
      ├── sharedWorking           # 子轨共享工作副本（可与主 diff）
      ├── agentPaused?            # 员工接管后暂停自动 Agent
      └── messages[]              # user | assistant | company_human | system
                                  # （可选 speaker: user|platform|company_agent|company_human）
```

关联：`engagement.id` 稳定；`conversationId` + `companyId` 唯一活跃分支（同一厂再次确认则进入已有 active，不新建第二条 active）。

### 2.2 对其他厂商的可见性（已定）

| 信息 | 其他厂商 |
|------|----------|
| 主轨原文、他家子轨 | ❌ 永不 |
| 「客户还开了 Oppein」等具名信息 | ❌ 默认不广播 |
| 已 promote 进主项目的**共享事实** | ✅ 仅作为项目状态/新 handoff，**不标注来源厂** |

### 2.3 四角色与权威（v1.1）

| 角色 | role / speaker | 职责 | 权威 |
|------|----------------|------|------|
| 用户 | `user` | 提需求、确认/纠正交接复述 | 纠正后写回 prefs 才改结构化态 |
| 系统助手 | `system` / `platform` | 开线说明、promote/pull 结果、归档只读；**不答产品规格** | 流程态 |
| 厂商 Agent | `assistant` / `company_agent` | 读交接、开线复述、规格选型；**不报价格** | 低于员工 |
| 厂商员工 | `company_human` | 真人坐席；发言后默认 `agentPaused` | 最高（产品口径） |

**真相源**：右侧 Confirmed（结构化）权威高于聊天复述。复述是对齐仪式，不可静默覆盖字段。

**防抢话**：同一用户 turn 默认只让厂商 Agent 长答；系统最多一条短状态气泡。禁止系统助手与厂商 Agent 双复述。

---

## 3. 产品规则

### 3.1 开线仪式（Open Ritual）

1. 主轨消息 `@` 到已入驻公司 → 仍可立即 Agent 应答（FR-1）。  
2. 若该 `companyId` **尚无 active engagement** → 响应带 `engagementOffer`；UI 询问是否创建协作。  
3. 客户确认 → `POST .../engagements`：创建永久分支，写入 **handoff v2**（见 §3.1.1），`sharedWorking` 初始化为共享段；左栏出现 `@厂商名`。  
4. **同请求内**按序写入消息：  
   - `[system/platform]` 开线说明 + 已载入交接包 revision  
   - `[assistant/company_agent]` **复述已确认项并请用户确认**（无 LLM 时用确定性模板）  
5. 再次 `POST` 同一厂 active → 幂等返回已有分支，**不重做**整套仪式。  
6. 厂商 inbox 标题 = **父会话 `fullTitle`**（与客户二级标题不同，有意不对称）。

#### 3.1.1 交接包（Handoff）v2

| 字段 | 说明 |
|------|------|
| `revision` | 开线=1；每次 pull 共享态 +1 |
| `designRequirements` / `sharedPreferences` | 主项目共享快照 |
| `companyPreferences` | 开线时从 `preferences.byCompany[本厂]` **冻结**（含 `doorStyleId` 等） |
| `confirmedFacts[]` | 结构化清单：`key/scope/label/value/display/source`，供 Agent 注入与复述 |
| `sharedSummary` | 给人看的短摘要 |

Pull 时：覆盖共享段；**保留**原 `companyPreferences`；重建 `confirmedFacts`；revision+1；系统插一条 pull 说明，并可再触发一次 **diff 短复述**（只强调变更的共享项）。

### 3.2 消息与回流

- 子轨消息**默认不**进入主轨 transcript，也**不**自动进入其他厂线程。  
- **显式 promote（子→主）**：仅同步「已确认主部分」共享字段；主轨插一条系统摘要。  
- **按需 pull（主→子）**：子轨提示「项目有更新」→ 客户确认「采用项目最新」；只覆盖共享工作副本，不动厂商专用小结。  
- **禁止**静默双向镜像同步。  
- 客户子轨发言：若 `agentPaused` → 只落库，不调 Agent；否则 Agent 回复且 **system 必含 handoff 上下文**（不得重问 `confirmedFacts` 已列字段）。  
- 厂商员工发言 → `company_human`，默认 `agentPaused=true`。

### 3.3 子轨「已确认」Tab（与主轨对齐）

子轨 Confirmed **复用主轨 Design Basis（`designBrief.sections`）同一套卡片结构**，便于 promote / pull 对照；厂专用选型单独一段（门板等）。

```
┌─ Design Basis（与主轨同款 brief 卡片）──────────┐
│  空间 / 上下水洞口 / 家电 / 风格预算省份 / 厂商   │
│  [与主项目不一致 → 同步到主项目] [Pull latest]   │
└────────────────────────────────────────────────┘
┌─ 厂商专用确认小结 ──────────────────────────────┐
│  doorStyle / 箱体 / 五金…                         │
└────────────────────────────────────────────────┘
```

| 区块 | 内容 | 同步 |
|------|------|------|
| Design Basis | 与主轨 `evaluateDesignReadiness` 同源；用子轨 `sharedWorking` 投影 | ✅ promote/pull 只动共享段 |
| 厂商专用 | `byCompany` + handoff 冻结副本 | ❌ 永不进 shared |

**交接摘要（handoff）**：开线/pull 时从 brief 的 locked/provisional 节提炼 `requirementsDigest` + `confirmedFacts`，**禁止**把主轨 `designRequirements` 聊天堆积原文整段塞进摘要或 Agent 复述。`designRequirements` 字段仍保留供 diff/同步比较。

覆盖冲突：promote/pull 时对共享字段做 diff；冲突项需客户选择（用子 / 用主 / 跳过）。v1 可简化为「整包覆盖共享段 + 确认文案」，冲突字段列表在响应中返回供 UI 展示。

### 3.4 父会话 archived

父 `status=archived` ⇒ 全部 engagement **只读**（与主轨写禁一致）。

### 3.5 复述与确认状态（v1.1）

```
OPENED → AWAITING_HANDOFF_ACK → ACTIVE
              ↓ 用户纠正某字段
         写回 sharedWorking / byCompany → 刷新 Confirmed → ACTIVE
```

- 「对 / 确认」→ 可记 `handoffAckAt`（可选）。  
- 用户直接问规格 → soft-ack：仍按 handoff 当已确认，不重问清单字段。  
- **结构化 Confirmed 仍是权威**；聊天纠正须写回 prefs 才生效。

---

## 4. API（v1 / v1.1）

### 客户（`requireAccount`，须拥有父会话）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/conversations/:id/engagements` | body: `{ companyId }` 开线/返回已有 active；**首次开线含 Agent 复述消息** |
| GET | `/api/conversations/:id/engagements` | 列表（含 customerTitle、status） |
| GET | `/api/conversations/:id/engagements/:eid` | 详情：messages + confirmed 两段 + diff 标志 |
| POST | `/api/conversations/:id/engagements/:eid/messages` | body: `{ text }` 客户发言（可触发 Agent；注入 handoff） |
| POST | `/api/conversations/:id/engagements/:eid/promote` | 共享工作副本 → 父 `designRequirements` + `preferences.shared` |
| POST | `/api/conversations/:id/engagements/:eid/pull` | 父共享态 → 子 `sharedWorking` + handoff revision+1；可附带短复述 |

`POST /api/conversations/:id/messages` 在首次 `@` 且无 active engagement 时增加：

```json
"engagementOffer": { "companyId": "co_oppein", "companyName": "Oppein Canada" }
```

`GET /api/conversations` 列表项增加嵌套：

```json
"engagements": [{ "id", "companyId", "customerTitle", "status" }]
```

### 厂商（`requireCompany`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/company/:companyId/engagements` | inbox：父 fullTitle、engagementId、updatedAt；**无主轨** |
| GET | `/api/company/:companyId/engagements/:eid` | handoff + 本线程 messages + 两段确认投影 |
| POST | `/api/company/:companyId/engagements/:eid/messages` | body: `{ text, pauseAgent? }` → `company_human`；默认暂停 Agent |

厂商 DTO **禁止**包含父 `messages`、其他 `companyEngagements`、其他厂 `byCompany`。

---

## 5. UI

### 客户主壳（`web/index.html`）

- 左栏：父会话下缩进二级行，标题 `customerTitle`（`@厂商名`）。  
- `@` 后若有 `engagementOffer`：确认条「是否创建与 XXX 的协作会话？」。  
- 打开子轨：中栏为子轨消息（系统 / Agent / 员工 / 用户可区分角标）；右栏 Confirmed 为两段式；主部分显示同步按钮。  
- 首次开线后应立刻看到系统开线说明 + 厂商 Agent 复述，而非空白再被重问门板。  
- 标题 hover 仍用父/子各自 title。

### 厂商工作台（`web/company.html`）

- 与客户主壳同构三栏：左协作列表 / 中线程 / 右 Confirmed（交接 + 共享 + 本厂偏好）与 Workspace。  
- 「客户协作」列表标题 = 父会话 fullTitle；令牌在设置层填写，保存成功后关闭设置进入三栏。  
- 点开：中栏消息 + 回复框；右栏 handoff / confirmed（需 Company/Admin Token）。

---

## 6. 非目标（v1 / v1.1）

- 开线即计线索费 / 自动披露客户邮箱电话（仍走报价发送闸门 FR-7）  
- 向其他厂广播「比价中」或具名协作列表  
- 静默双向同步已确认  
- 删除子线程；公司多用户账号体系  
- 系统助手做成第二套闲聊 LLM（v1.1 用模板/规则消息即可）  
- P2 完整 ack 状态机 UI、员工「交还 Agent」按钮打磨可后续迭代  

---

## 7. 验收

1. 确认开线后左栏出现 `@厂商名` 二级项；厂商 inbox 可见且标题为父 fullTitle。  
2. 厂商 API 无法读到父 `messages`（测试断言）。  
3. 子轨消息不出现在主轨；promote 后主 `shared`/需求更新且主轨仅多一条系统摘要。  
4. 已确认 Tab：上共享、下厂专用；同步按钮仅作用于上段。  
5. 其他厂 engagement 响应中不含本厂以外协作的 companyId 列表（除项目共享事实外）。  
6. 父 archived 后子轨发消息 409。  
7. **（v1.1）** 首次开线 messages 含 `system` 开线说明 + `assistant` 复述；若父会话已有 `doorStyleId`，复述文案须出现对应门板名或 id。  
8. **（v1.1）** 子轨 Agent 的 system/上下文含 handoff `confirmedFacts`（或等价清单）；不得在有门板确认时声称「看不到 doorStyleId」。  
9. **（v1.1）** handoff 含 `revision` 与 `companyPreferences`（开线时有则写入）。

---

## 8. 代码落点

| 区域 | 路径 |
|------|------|
| 类型 | `src/domain/types.ts` |
| 领域逻辑 | `src/session/company-engagement.ts` |
| Agent 注入 / 复述 | `src/agents/orchestrator.ts`、`src/agents/types.ts` |
| HTTP | `src/server.ts` |
| 客户 UI | `web/index.html`、`web/ui-i18n.js` |
| 厂商 UI | `web/company.html` |
| 测试 | `test/company-engagement.test.ts`、`test/agents-estimate.test.ts` |

---

## 9. 分期

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P0** | handoff 含 `companyPreferences` + `confirmedFacts` + `revision`；Agent 注入；开线自动复述 | ✅ |
| **P1** | ack 写回、纠正字段、pull 后 diff 复述强化 | 部分（pull 升 revision + 系统注；短复述已接） |
| **P2** | `agentPaused` UX、交还 Agent、speaker 气泡样式打磨 | 字段与默认 pause 已接；UI 可后续 |
