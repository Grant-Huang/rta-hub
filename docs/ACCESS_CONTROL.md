# 访问控制与数据/知识隔离

> 状态：**实现基线（v1.2）** — Trade / Consumer **分 ACL**；admin L1 按 **ACCESS_STAGE** 分 design / production  
> 依据：`REQUIREMENTS` §3.4 / **FR-9** / **FR-11** / **FR-16** / **FR-22** / **FR-23**、`KNOWLEDGE_LAYERS.md`、`SYSTEM_TRAINER_AGENT.md`、`COMPANY_ENGAGEMENT.md`  
> 代码：`src/auth/*`（含 `access-stage.ts`）、`src/tenancy/*`、`src/knowledge/access.ts`  
> **编号说明**：本文件是横切能力，不占用独立 FR。**FR-21** 专指 DesignCritic + 会话持久化；知识训练为 **FR-22**；账号/租户为 **FR-9**；贸易账号产品为 **FR-11**；知识分层为 **FR-16**。

---

## 0. L0 / L1 定义对齐（对照 `KNOWLEDGE_LAYERS.md`）

| 层 | 含义（权威） | 代码落点 | **不是** |
|----|--------------|----------|----------|
| **L0** 平台 / 系统知识 | 全平台一致的售卖单元语义（SellUnit、`-BOX`/`-DOOR`）、独立件判定、能力标签、绘图/语言策略、GenericCatalog、**可训练** PlatformHandbook + config overlays + review.rule | `src/spec/sku-semantics.ts`、`src/knowledge/*`（`PlatformKnowledgeCard`）、总控注入 | 某厂柜型前缀表、价目、CodingRules |
| **L1** 厂商知识 | 按 `companyId` 隔离的 Spec / CodingRules / CompanyHandbook / 公司偏好与公司 Agent 上下文 | `ProductSpecVersion`、公司 Agent 注入包、`assertL1Read` / `assertL1Write` | PlatformKnowledgeCard；训练 Agent 禁止写入 L1（FR-22） |

**读路径区分（重要）**：

1. **L0 卡实体**（`PlatformKnowledgeCard` 正文 / 列表 / 导出）→ 仅 `platform_admin`（`knowledge.l0.manage`）。客户**不得**经 `/api/knowledge` 枚举/管理 L0 卡正文。
2. **L0 运行时投影**（已 publish 的 handbook 文本 + config overlays）→ **会话框**回答经 `cardsForRuntimeInjection` / `platformKnowledgeRuntime` **间接注入**，不开放卡管理 API。
3. **L1** → 公司令牌读写本厂；需求侧在 **`@` 厂商** 后，会话作用域绑定该 `companyId`，由公司 Agent 注入该厂 published；未 @ 时不注入厂商 L1。跨厂对外「不存在」（对公司令牌 / 需求侧探测）。

---

## 1. 用户分层与画像（分身份域）

| 主体 | 身份域 `Principal.kind` | 身份证明（MVP） | 数据边界 |
|------|-------------------------|-----------------|----------|
| 消费者 | `consumer` | `X-Account-Id` → `CustomerAccount`（`accountType=consumer`） | 仅本账号 Conversation / Quote / FloorPlan / Preference；**无** `account.multi_project` / `pricing.trade` |
| 贸易账号 | `trade` | 同上（`accountType=trade`） | 本账号数据 + **多项目**能力声明；贸易价能力声明（到手仍受 `effectiveAccountType` / 核实门闸） |
| 橱柜公司 | `company` | `X-Company-Token`（URL `companyId` 须匹配） | 仅本 `companyId` 规格/计费/入驻；线索只读已发送 Quote |
| 平台运营 | `platform_admin` | `X-Admin-Token` | 跨租户运营只读会话、L0 训练；跨厂 L1 见 §3.2（按 ACCESS_STAGE） |
| 运营代公司 | `company` + `via: "admin"` | 公司路由上 admin 令牌 | URL 绑定 `companyId` 进 Principal；**L1** 跨厂策略见 §3.2 |

> **禁止**：把 trade 与 consumer 写成「同一套 ACL，仅问法/定价不同」。  
> FR-11 的「报价闸门与校验同构」仍然成立；那是**业务闸门**，不是 ACL 身份域合并。

---

## 2. Principal 与 Capability

实现：`src/auth/principal.ts`、`src/auth/permissions.ts`。

```
Principal.kind ∈ { anonymous | consumer | trade | company | platform_admin }
```

强制点：

1. **HTTP 中间件** —— 先解析 Principal，再进业务（`requireAccount` / `requireCompany` / `requireAdmin`）。
2. **数据访问层** —— `TenantScope`（公司）、`AccountScope`（客户账号）第二道过滤。
3. **知识访问** —— `src/knowledge/access.ts`：按角色过滤卡状态 / settleTarget；禁止需求侧经 API 读 L0 卡实体 / 写 L0；公司令牌不得读别厂 L1；admin L1 见 §3.2。
4. **Agent 注入** —— 会话总控拿 L0 published 投影；客户 `@` 厂商后，公司 Agent 只拿该 `companyId` 的 L1 published。

跨租户 / 跨账号读对外统一「不存在」（不泄露存在性）。公司令牌读别厂 L1 同此。

---

## 3. 已确认策略（会话知识 + admin L1）

### 3.1 客户如何使用 L0 / L1（会话 vs API）

| 路径 | consumer / trade | 说明 |
|------|------------------|------|
| `GET /api/knowledge`、admin 知识 CRUD | ✗（空列表 / 401） | **不**开放 L0 卡实体管理面 |
| **会话框**问答 | ✓（间接） | 基于 **L0** 运行时注入（`knowledge.l0.consume_published` → `cardsForRuntimeInjection`） |
| 会话中 **`@` 厂商** | ✓（该厂 L1） | 作用域绑定被 @ 的 `companyId`；注入该厂 published Spec / CodingRules / Handbook |

**可调点**：若产品要做「公开 FAQ / 帮助中心」，可新增只读投影 API（仍不返回 draft、不返回 settleTarget=review.rule 未 settled 内容），不必开放卡实体管理面。

### 3.2 admin 代公司 / 运营面：L1 按阶段（design vs production）

**开关**：`ACCESS_STAGE`（别名 `RTA_STAGE`），取值 `design` | `production`。  
未设置时：`NODE_ENV=production` → `production`，否则默认 **`design`**（本地 / 测试宽松）。  
实现：`src/auth/access-stage.ts` → `assertL1Read` / `assertL1Write`。

| 主体形态 | design（默认） | production |
|----------|----------------|------------|
| `company` + `via: "company"` | L1 读/写 **仅本厂** | 同左 |
| `company` + `via: "admin"`（代公司） | L1 **读/写任意公司** | L1 **可读任意公司**；**禁止写** |
| `platform_admin` | L1 **读/写任意公司** | L1 **可读任意公司**；**禁止写** |

理由：设计期运营需要代任意租户改规格 / 巡检；生产部署后 admin 仍可跨厂只读排查，但不得代写或跨厂改 L1。厂商自身令牌在生产仍可写本厂。

**非 L1 的公司路由**（计费、争议等）仍可经 URL + admin 令牌代操；本表仅约束 `assertL1*`。

---

## 4. Trade vs Consumer ACL 差异

| 维度 | Consumer | Trade |
|------|----------|-------|
| 身份域 | `kind: "consumer"` | `kind: "trade"` |
| 角色 | 零售需求侧用户 | 专业采购需求侧用户 |
| `account.self` | ✓ | ✓ |
| `account.multi_project` | ✗ | ✓ |
| `pricing.trade` | ✗ | ✓（核实门闸另计） |
| `knowledge.l0.consume_published` | ✓ | ✓（各自矩阵声明，非共享数组） |
| `knowledge.l0.manage` | ✗ | ✗ |
| `knowledge.l1.read` | ✓（@ 后会话注入 published） | ✓（同上） |
| `knowledge.l1.write` | ✗ | ✗ |
| 账号数据 Scope | `AccountScope(accountId)` | 同左（仍按账号隔离；多项目是能力而非跨账号） |
| 交互 / 定价产品差异 | 零售问法、零售价 | 直给问法、贸易价（FR-11）；**不**绕过发送闸门 |

公司 / 运营矩阵见实现 `capabilitiesFor(kind)`，不与需求侧混用。

---

## 5. 能力矩阵（全角色摘要）

| Capability | consumer | trade | company | platform_admin |
|------------|----------|-------|---------|----------------|
| `account.self` | ✓ | ✓ | — | ✓ |
| `account.multi_project` | ✗ | ✓ | — | ✓ |
| `pricing.trade` | ✗ | ✓ | — | ✓ |
| `company.tenant` | — | — | ✓ | ✓ |
| `knowledge.l0.consume_published` | ✓ | ✓ | ✓ | ✓ |
| `knowledge.l0.manage` | ✗ | ✗ | ✗ | ✓ |
| `knowledge.l1.read` | ✓（@ 后会话） | ✓（@ 后会话） | ✓（本厂；via=admin 任意） | ✓（任意） |
| `knowledge.l1.write` | ✗ | ✗ | ✓（本厂；via=admin 仅 design） | ✓（仅 design；production 拒绝） |
| `admin.cross_session` | ✗ | ✗ | ✗ | ✓ |
| `admin.ops` | ✗ | ✗ | ✗ | ✓ |

---

## 6. 鉴权方案决策

| 阶段 | 方案 | 理由 |
|------|------|------|
| **MVP（当前）** | Header：`X-Account-Id` / `X-Company-Token` / `X-Admin-Token` | 无浏览器登录依赖；脚本与 `tsx --test` 可复现；平面文件时代足够证明「先身份后过滤」 |
| **预留** | `AuthScheme = "header_mvp" \| "session" \| "jwt"` + `AuthContext` | 登录态（检查清单 E1）只替换凭证解析；**不**改 Capability / Scope / 知识过滤 |
| **明确不做（MVP）** | 在业务路由里散落 if (accountType) 当 ACL | 一律走 `assertCapability` / 分矩阵 |

未实现的 `session` / `jwt` 若被传入 `resolvePrincipal({ scheme })`，当前回落 `anonymous`（拒绝静默提权）。

---

## 7. 与现有模块的关系

| 模块 | 职责 |
|------|------|
| `tenancy/scoped-repo.ts` | 公司维度第二道过滤 |
| `tenancy/company-auth.ts` | 公司令牌 + admin 代操作（via） |
| `tenancy/account-scope.ts` | 客户账号维度第二道过滤 |
| `auth/*` | 分身份域 Principal / Capability；`access-stage.ts` 解析 design/production |
| `knowledge/access.ts` | L0 卡实体 vs 运行时投影；写卡仅 admin |
| `knowledge/validate.ts` | 训练内容禁 L1 泄漏 |
| `session/admin-access.ts` | 运营跨 run 只读（须 admin） |
| `trade/verification.ts` | 贸易价门闸（与 `pricing.trade` 能力正交） |

---

## 8. 非目标（MVP）

- 完整登录态 / OAuth（E1；模型已预留 `AuthScheme`）。
- 公司内多用户 RBAC。
- 行级数据库 RLS（平面文件时代用 Scope 类兜底）。
- 对 consumer 硬限制「只能有一个 Conversation」的 HTTP 闸（能力已声明；产品强制执行标为可调，避免与现有多会话测试/冷启动路径冲突）。
