# 界面改版需求汇总（会话壳 / 用户页 / 上传）

> 状态：**已交付（v0.3）**  
> 范围：主聊天壳 `web/index.html` + 必要 API；同一期交付下列三项。  
> 相关：`REQUIREMENTS.md` §3.7 / FR-17、`ACCESS_CONTROL.md`、`SYSTEM_TRAINER_AGENT.md`（FR-22）、  
> 厂商协作子线程：[`COMPANY_ENGAGEMENT.md`](./COMPANY_ENGAGEMENT.md)（**FR-23**）  
> 图标 / 设计系统：[`UI_APPS_SDK.md`](./UI_APPS_SDK.md)（**FR-UI-1**，[@openai/apps-sdk-ui](https://github.com/openai/apps-sdk-ui)）  
> v0.2：去掉「进行中 | 已存档」Tab；左栏同一列表展示全部会话，存档态靠行内标识 + 打开后底栏恢复。

---

## 1. 目标

在不改动设计演算内核的前提下，补齐三块产品壳能力：

1. **会话存档 / 恢复**（不做删除）
2. **左下角用户入口 → `/me` 用户页**，并按账号角色显隐运营入口
3. **户型附件两步提交**：附件区展开后可打字，文字 + 多文件一次请求进会话

---

## 2. 已确认决策

| 主题 | 决策 |
|------|------|
| 会话删除 | **不做**；仅存档 / 恢复 |
| 存档后 | 不能继续聊；隐藏 composer；底部显示「恢复会话」 |
| 恢复后 | 回到可聊状态，composer 恢复 |
| 用户页 | **新路由页**（建议 `GET /me` → `web/me.html`） |
| 系统管理 | 链到现有 `/admin` |
| 训练 | 链到现有 `/admin/trainer` |
| 顶栏演示账号下拉 | **移除**；账号切换改到用户页（或等价账号区） |
| 权限显隐 | **按登录账号角色**在主 UI / `/me` 显隐链接（非仅手填 Admin Token） |
| 上传交互 | 点 `+` → 展开附件区（预览 + 可打字 + 提交） |
| 提交语义 | **一次请求**同时带文字 + 文件 |
| 文件约束 | 多文件；类型仍限 `image/*`、`.pdf`（户型图） |
| 交付节奏 | **同一期**完成；先确认本文再改代码 |

---

## 3. 功能说明

### 3.1 左栏历史：存档 / 恢复 + 标题 tooltip

**列表**

- 左栏**同一列表**展示本账号全部会话（active + archived，按 `updatedAt` 排序）；**不做**「进行中 | 已存档」切换。
- archived 行有视觉标识（如「已存档」），并可从行内操作恢复；active 行可存档。
- 会话行悬停：`title` 属性展示**完整标题**（服务端提供 `fullTitle`，展示仍可截断）。

**操作**

| 状态 | 允许操作 | 输入框 |
|------|----------|--------|
| active | 打开、存档 | 有 |
| archived | 打开（只读回顾）、恢复（行内或底栏） | **无**；聊天区底部固定「恢复会话」按钮 |

**行为**

- 存档：`status → archived`；若当前打开的正是该会话，立即切到只读壳（隐藏 composer，显示恢复条）。
- 恢复：`status → active`；恢复后可继续发消息 / 上传。
- **禁止**对 archived 会话调用发消息、偏好、floorplan、design advance 等写路径（API 返回 409）。

**数据**

- `Conversation` 增加：`status?: "active" | "archived"`（缺省 = `active`，兼容旧数据）。
- 可选：`archivedAt?: Timestamp`。
- API：
  - `POST /api/conversations/:id/archive`
  - `POST /api/conversations/:id/unarchive`
  - `GET /api/conversations` 返回全部，列表项含 `status`、`fullTitle`、截断 `title`

---

### 3.2 用户图标与 `/me` 页

**主壳布局**

- 整页**左下角**固定用户身份图标（头像字标或图标 + 显示名缩写）。
- 点击 → 导航到 `/me`（同窗口路由页，非模态）。
- **移除**顶栏演示账号 `<select>`；当前账号仍由既有 `X-Account-Id`（localStorage）驱动。

**`/me` 页面内容**

1. **用户信息**：displayName、email、accountType、effectiveAccountType、省份、贸易门槛摘要等（复用 `/api/me/profile`）。
2. **账号切换（演示/多账号）**：原顶栏下拉迁到此页（避免丢失切换能力）。
3. **有权限时**额外入口：
   - 系统管理 → `/admin`
   - 训练相关 → `/admin/trainer`
4. Trade 相关入口可保留/迁移：「我的项目」等既有能力链到现有面板或本页区块（本期内以不丢功能为准，UI 可简）。
5. **厂商入口**：列出已入驻 active 厂商（如 Oppein Canada），链到 `/company/:companyId` 工作台；页内填 Company/Admin Token（与 admin 页同模式）。

**权限显隐（相对现状的缺口）**

- 现状：`CustomerAccount.accountType ∈ { consumer, trade }`；`platform_admin` 仅靠 `X-Admin-Token`，主 UI 无角色链接。
- 本期约定：
  - 账号增加可选平台角色，例如 `platformRoles?: ("platform_admin")[]`（或等价布尔字段）。
  - `GET /api/me/profile` 增加 `capabilities: { adminConsole: boolean; trainer: boolean }`（二者本期均要求 `platform_admin`）。
  - Seed 至少一个带 `platform_admin` 的演示账号，便于主 UI 验证显隐。
  - **链接显隐**只看账号角色；`/admin*` 页内 API 仍可沿用现有 Admin Token 门闸（本期内不强制把 Token 与账号会话合并）。若运营从 `/me` 点入 `/admin`，行为与今日直开一致（页内填 Token）。后续若要「点进去即已鉴权」另开任务。

---

### 3.3 上传两步流：文字 + 多文件一次提交

**交互**

1. Composer 点 `+` → **不立刻弹系统文件框并直传**；改为展开**附件区**。
2. 附件区：选文件（可多选）、缩略图/文件名预览、可移除单文件；主输入框仍可打字。
3. 点 Send（或附件区提交）→ **一次请求**提交：`text` + `files[]`。
4. 无文件且仅有文字 → 仍走原消息路径；有文件（无论是否有文字）→ 走合并上传路径。
5. MIME：`image/*`、`application/pdf`；超限/类型错误前端拦截并提示。

**API（建议）**

- 扩展或新增：`POST /api/conversations/:id/floorplan` 支持：
  - `text?: string`
  - `files: { fileName, mimeType, sizeBytes, image }[]`（至少 1 个）
- 或新路由 `POST /api/conversations/:id/messages-with-attachments`，内部复用现有 floorplan 创建 + 消息写入，避免双路径分叉过大。
- 会话回显：用户气泡同时展示文字（若有）与各附件名/缩略；助手侧仍按 FR-17 解读（多图时逐份或合并解读策略：**优先逐份解读后拼一条助手回复**，实现时选改动最小的一种并在测试中固定）。

**存档会话**：附件区与 Send 一律不可用（同 §3.1）。

---

## 4. 非目标（本期不做）

- 会话硬删除 / 回收站
- 将 `/admin` API 鉴权改为纯账号 Cookie/Session（仍保留 Admin Token）
- 独立「系统配置」新页面（配置仍在 Trainer / 现有 admin 能力内）
- 改设计渲染内核、`src/render/*`
- 任意文件类型上传、非户型文档知识库入库

---

## 5. 验收标准

1. Active 会话可存档；左栏同一列表仍可见已存档（带标识）；已存档可恢复；archived 打开时无输入框，有「恢复会话」。
2. 会话标题悬停可见全文。
3. 左下角用户图标进入 `/me`；顶栏无演示账号下拉。
4. 仅 `platform_admin` 角色账号在 `/me`（及必要时主壳）看到 `/admin`、`/admin/trainer` 链接；consumer/trade 看不到。
5. 点 `+` 展开附件区；可多选 image/pdf；可打字；一次请求同时提交文字与文件；会话中可见合并后的用户消息与 FR-17 解读。
6. 对 archived 会话的写 API 返回错误且前端不提供入口。

---

## 6. 涉及文件（预估）

| 区域 | 文件 |
|------|------|
| 类型 / 仓库 | `src/domain/types.ts`、`src/app/seed.ts` |
| API | `src/server.ts`（conversations list/archive、floorplan 多文件+text、`/api/me/profile`、`GET /me`） |
| 主壳 | `web/index.html`、`web/ui-i18n.js` |
| 用户页 | 新建 `web/me.html`（或等价） |
| 测试 | `test/*` 增补会话 status、合并上传、profile capabilities |

---

## 7. 同一期开发步骤（待你确认后执行）

| 步 | 内容 | 状态 |
|----|------|------|
| S0 | 确认本文（含列表交互与 Token 分工） | ✅ |
| S1 | Conversation.`status` + archive/unarchive API；列表带 status/fullTitle；写路径拒 archived | ✅ |
| S2 | 主壳左栏：存档/恢复 UI、只读底栏、标题 `title` tooltip | ✅ |
| S3 | 账号 `platformRoles` + profile.`capabilities` + seed 演示管理员 | ✅ |
| S4 | `GET /me` 用户页；主壳左下角入口；移除顶栏账号下拉 | ✅ |
| S5 | 附件区 UI + 一次请求 text+files；适配 FR-17 回显 | ✅ |
| S6 | 测试 + 手工验收清单勾过 | ✅ |

---

## 8. 确认记录（2026-08-08）

1. 本文可作为开工基线 → **是**  
2. 顶部 `进行中 | 已存档` 切换 → **不接受**；左栏同一列表 + 行内标识/操作 + 打开后底栏恢复  
3. `/admin` 点入后仍手填 Admin Token（本期）→ **是**  
4. 多图解读：逐份解读拼一条助手回复 → **是**  

开发从 **S1** 起按步实现，每步完成后同步 §7 进度表。
