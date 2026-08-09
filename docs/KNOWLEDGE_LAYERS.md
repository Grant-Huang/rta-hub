# 知识与编码分层 —— 系统通用 / 厂商专属 / 独立件

> 状态：**已确认待确认项（v1.2.1）**，按此实现。  
> 相关：`product-codes.md`、`CATALOG_MODEL.md`、REQUIREMENTS FR-2.2 / FR-6 / **FR-16**；  
> 谁能读/写各层见 [`ACCESS_CONTROL.md`](./ACCESS_CONTROL.md)
> （L0=平台知识；L1=按 companyId 厂商知识；需求侧不可经 API 读 L0 卡正文，
> 会话可消费 L0 投影，`@` 厂商后消费该厂 L1；admin 对 L1 的写受 ACCESS_STAGE 约束）。

---

## 0. 为什么要分层

三件容易混在一起的事：

1. **厂商记忆与规格** —— 这家有哪些型号、价、门板、能不能叠装；柜型前缀在这家是什么意思  
   （例如有的厂用 `B12` 表示「1 抽屉 + 门」地柜，有的用 `DB12` / `1DB12`，**绝不能跨厂共用一张前缀表**）。
2. **系统级 SKU 后缀语义** —— 不论哪家，`-BOX` / `-DOOR` /「材质+花色且无拆分后缀」的写法，表达的是**卖什么单元**。
3. **独立件（trim / standalone）** —— filler、踢脚、收口板等：不跟「柜体+门」组合逻辑走，也不该被猜成带门的组合件。

混在一起的后果：Agent 用试点厂的 `B12` 规则解释另一家的码；报价把填缝条当成可拆 BOX/DOOR；  
Oppein 式「把 BOX/DOOR 塞进 PriceGroup」扭曲定价轴。

---

## 1. 三层模型（结论）

```
┌─────────────────────────────────────────────────────────────┐
│  L0  系统知识（platform / system）                            │
│  · SKU 售卖单元语义：box | door | combo | standalone         │
│  · 后缀约定：-BOX / -DOOR（及大小写变体）                    │
│  · 组合件判定：同时带柜体材质标识 + 门板花色、且无拆分后缀   │
│  · 独立件判定：ModuleType ∈ filler|panel|toeKick|crown|leg  │
│  · 能力标签枚举、脸型文法、绘图内核、语言策略、FR-15 检查表  │
│  · GenericCatalog（仅冷启动预估，永不正式报价）              │
│  · PlatformHandbook + config overlays（FR-22，可训练沉淀）   │
│    handbook → 总控/解释 prompt；config.* → 家电/排布/对话；  │
│    review.rule → sanity-rules + 实现 + audit（代码权威）     │
└─────────────────────────────────────────────────────────────┘
              ▲ 能力可对齐；编码不可映射
┌─────────────────────────────────────────────────────────────┐
│  L1  厂商知识（per companyId / ProductSpecVersion）          │
│  · 完整规格：ModuleSpec / DoorStyle / PriceMatrix / 五金配件 │
│  · CodingRules：前缀→柜型语义（B / DB / 3DB / NW-B …）       │
│  · 可选 CompanyHandbook：口语说明、例外、历史纠错（Agent 用）│
│  · 会话记忆：Conversation + CompanyPreferences（按公司隔离） │
│  · 公司 Agent system：只注入「本公司 published 规格 + 手册」 │
└─────────────────────────────────────────────────────────────┘
```

| 放哪 | 例子 | 禁止 |
|------|------|------|
| L0 | 「码里明确 `-BOX` → 只卖柜体」 | 写死「B12 = 一抽一门」（那是某厂规则） |
| L1 | 「本公司 `B12` = 地柜 12"、一抽一门」 | 把别厂手册拼进本公司 Agent |
| L0+类型 | `WF3` / `BF3` 类型是 `filler` → standalone | 给 filler 强行拆 BOX/DOOR 变体 |

**仍坚持 CATALOG_MODEL 的总原则：编码不映射，能力才映射。**  
L0 管的是「售卖单元怎么读」，不是「把各厂码统一成一个通用柜型号」。

---

## 2. L0 —— 系统售卖单元（Sell Unit）

### 2.1 枚举

```ts
type SellUnit =
  | "box"         // 仅柜体（carcass），不含门
  | "door"        // 仅门板/抽屉面
  | "combo"       // 柜体 + 门（或含在价里的门）一体销售
  | "standalone"; // 独立件：填缝/踢脚/收口/顶线/地脚等，不参与 BOX/DOOR 拆分
```

### 2.2 后缀与组合件（系统约定，全平台一致）

权威细则见 [`product-codes.md`](./product-codes.md)。摘要：

| 形态 | SellUnit | 说明 |
|------|----------|------|
| 明确 `-BOX`（或厂商声明的等价后缀） | `box` | 只有柜体；可有柜体材质段（如 `PLY`） |
| 明确 `-DOOR` / `-door` | `door` | 只有门板；通常带花色段 |
| **无**拆分后缀，且同时出现**柜体材质标识**与**门板花色标识** | `combo` | 组合件 |
| `ModuleType` 为 trim 类，或厂商声明 `sellUnit: standalone` | `standalone` | 见 §3 |

解析顺序（实现必须遵守，避免误伤）：

1. 若型号在规格里声明了 `sellUnit` → **以声明为准**（厂商可覆盖启发式）。  
2. 否则若 `type ∈ { filler, panel, toeKick, crown, leg }` → `standalone`。  
3. 否则若码匹配拆分后缀 → `box` / `door`。  
4. 否则若同时识别到材质段 + 花色段 → `combo`。  
5. 否则 → 默认 `combo`（兼容今天「型号 × 门板价格组、门含在柜体价内」的主流 RTA 做法），  
   并在导入校验里标 `sellUnitInferred`，供人工确认。

### 2.3 与现行定价轴的关系（推荐默认）

| 厂商怎么卖 | 报价行怎么出 |
|------------|--------------|
| 主流：模块码是逻辑柜型（`B12`），价 = 型号 × 门板价格组 | 行上 `sellUnit=combo`；门作从属明细「含在柜体价内」（现 FR-6.1） |
| 可拆卖：目录里真有 `B12-PLY-BOX`、`B12-MNW-DOOR` | 可出两行（或客户选购方式）；**禁止**把 BOX/DOOR 伪装成 PriceGroup |
| 组合码 `B12-PLY-MNW` 与拆分 SKU 并存 | 组合码是另一条可售 SKU；矩阵按**真实 moduleId** 定价，不做后缀魔法变价 |

**明确废弃**：把 `PLY-BOX` / `MNW-DOOR` 做成 `PriceGroup` 再挂到「门板样式」上的做法（见 Oppein seed 现状）——那把「卖什么」和「什么颜色」揉在一个轴上。

箱体板材加价（§3.5.5.1）仍然是 **combo/box 上的修饰项**，对 `standalone` 中不随板材变价的件（如塑料地脚）不加。

---

## 3. 独立件（standalone）—— 必须与柜体/门拆开

### 3.1 哪些算独立件

| ModuleType | 角色 | 典型码（仅举例，各厂不同） | 跟门色？ |
|------------|------|---------------------------|----------|
| `filler` | 填缝条 | WF3, BF3, NW-F03 | 通常是（`finishDependent`） |
| `panel` | 收口/端板 | BEP, WEP, REP24 | 通常是 |
| `toeKick` | 踢脚板 | TK8, TKC8 | 通常是 |
| `crown` | 顶线 | （若有） | 通常是 |
| `leg` | 塑料地脚等 | （若有） | **否** |

### 3.2 硬规则

1. **独立件没有 BOX/DOOR 变体语义。** 即使码里偶然出现 `-BOX`，规格声明 `standalone` 优先。  
2. **BOM / 报价单独成区**（已有 FR-6.1/6.2）：不属于某一个柜体行下的「门」。  
3. **选型靠 `ModuleType` + 能力 `roles:["trim"]` + 尺寸启发式**，不靠把 filler 前缀写进系统通用「柜型前缀表」。  
4. 公司规格缺 filler/踢脚/收口时 **如实报缺料**，不静默跳过（FR-6.2 / SR-M1）。

---

## 4. L1 —— 厂商专属：规格、编码规则、记忆

### 4.1 ProductSpecVersion（已有，权威价目）

- 型号、尺寸档、价格矩阵、门板、五金、配件、箱体板材选项、踢脚做法。  
- 发布后不可变；公司 Agent **只读 published 版本**。

### 4.2 CodingRules（新增，挂在规格版本上）

结构化、可校验，**禁止**只写在某份全局 markdown 里当唯一真相：

```ts
interface CompanyCodingRules {
  /** 人类可读：本公司柜型前缀怎么读 */
  prefixGuide: {
    pattern: string;          // 如 "^B\\d" / "^\\dDB" / "^DB" / "^NW-B"
    meaning: string;          // 如 "base, 1 drawer over door" / "3-drawer base"
    mapsToRoles?: ModuleRole[]; // 可选：导入时建议的能力，仍须确认
  }[];
  /** 本公司是否使用系统后缀拆分；若否，忽略码上的 -BOX 启发式或改为声明为准 */
  usesBoxDoorSuffixes: boolean;
  /** 材质段 / 花色段 token 表（本公司字典，可与系统常用表有交集） */
  materialTokens?: Record<string, string>;
  finishTokens?: Record<string, string>;
}
```

例（示意，非真实导入）：

- 厂 A：`B12` → 地柜、一抽一门；`3DB12` → 三抽地柜。  
- 厂 B：`DB12` → 一抽地柜；**没有**无前缀数字的 `B12`。  
- 厂 C：`NW-B12` → 自有前缀命名空间。

系统 **不得** 用厂 A 的 guide 去解析厂 B 的对话或报价。

### 4.3 CompanyHandbook（可选，给对话）

- 短文：例外、安装注意、历史纠错、客户常问。  
- 仅注入**该公司** Agent；总控 Agent **永不**注入任一家手册或价目。  
- 手册 **不能** 覆盖价格矩阵数字（FR-8）。

### 4.4 「记忆」指什么

| 种类 | 存放 | 隔离 |
|------|------|------|
| 会话上下文 | `Conversation.messages` / `designRequirements` | 账号会话 |
| 跨公司偏好 | `preferences.shared`（预算带、语言等） | 可跨公司 |
| 公司专属偏好 | `preferences.byCompany[companyId]`（门板、箱体、五金） | **按公司** |
| 厂商规格与编码规则 | `ProductSpecVersion` (+ CodingRules / Handbook) | **按公司** |
| 平台可训练知识（FR-22） | `PlatformKnowledgeCard` + overlays；按 `settleTarget` 沉淀 | **全平台 L0**；禁 L1 |
| 厂商 L1 学习队列（FR-22.2） | `CompanyLearningItem` → 确认后落本公司 **draft** handbook / CodingRules | **按公司**；禁写 L0 / 禁自动改 published 价 |
| 平台不设跨厂「柜型前缀记忆」 | — | — |

没有「全局产品编码记忆库」；总控拥有 L0 硬规则 + 已发布 PlatformHandbook / config overlays。  
训练通道与沉淀细则见 [`SYSTEM_TRAINER_AGENT.md`](./SYSTEM_TRAINER_AGENT.md)。

### 4.5 L1 学习队列 vs L0 训练（FR-22.2）

- **L0**：运营教全平台常识 → `PlatformKnowledgeCard`；禁止含厂商前缀/价。
- **L1 队列**：从**该公司**规格/会话信号提议 draft → 店长或 admin 确认后写入**该公司 draft**
  规格版本的 handbook / CodingRules 候选；矩阵洞只记「待人工补价」说明，**永不自动写价格**。
- 两套 API / 仓储分离；确认 L1 条目**不得**调用 L0 `createDraftCard` / `publishCard`。

---

## 5. Agent 装配规则

| Agent | 注入内容 |
|-------|----------|
| 总控（orchestrator） | L0 摘要 + 通用流程 + **已发布 handbook**；**禁止**具体公司 SKU/价/前缀表 |
| 公司 Agent | 本公司 SpecBundle + CodingRules + Handbook；回答编码含义时**只准用本公司规则** |
| 系统训练 Agent（admin） | 编辑 L0 知识卡；**禁止**写入 L1（FR-22） |
| @ 切换公司 | 换注入包；不得把上一家的前缀解释带到下一家 |

客户问「B12 是什么」→ 必须落在**当前 @ 的公司**规则上；未 @ 时总控只解释 L0（例如「若码带 -BOX 表示柜体」），并引导 @ 某家看具体柜型。

---

## 6. 导入与校验（FR-2 延伸）

1. 导入/发布时计算或读取 `sellUnit`；推断结果进待确认队列（与能力标签同源）。  
2. `usesBoxDoorSuffixes=true` 的公司：矩阵行必须能对上真实 BOX/DOOR/combo moduleId，  
   **禁止**用 PriceGroup 名冒充后缀。  
3. trim 类型不得进入「门板从属明细」生成路径。  
4. CodingRules.prefixGuide 与 ModuleSpec.code 抽样对拍（发布门槛，具体阈值实现阶段定）。

---

## 7. 待确认（已拍板 2026-08-08）

1. **报价默认**：无拆分后缀的逻辑柜型（`B12`）一律视为 `combo` — **是**。  
2. **可拆卖厂商**：MVP 先按目录已有 SKU 报价，暂不做「只要柜体/只要门」第三套 UI — **是**。  
3. **CompanyHandbook**：MVP 先 CodingRules，手册可后做 — **是**。  
4. **Oppein seed**：改为真实 BOX/DOOR/combo 模块行，去掉 PriceGroup 冒充后缀 — **是**。

---

## 8. 实现落点

| 区域 | 路径（预期） |
|------|----------------|
| 类型 | `src/domain/types.ts` — `SellUnit`, `CompanyCodingRules` |
| 解析 | `src/spec/sku-semantics.ts`（新建）— L0 解析；公司规则覆盖 |
| 校验 | `src/spec/validation.ts` / import |
| 报价 | `src/quote/line-items.ts` — 按 sellUnit 分行；trim 仍独立成区 |
| 定价 | `src/pricing/engine.ts` — 禁止 PriceGroup 扮演 BOX/DOOR |
| Agent | `src/agents/orchestrator.ts` — L0 vs 公司注入拆分 |
| 训练沉淀 | `src/knowledge/*`、`src/agents/trainer.ts` — FR-22 settleTarget / overlays |
| L1 学习队列 | `src/knowledge/l1-learn.ts`、`l1-learning-queue.json` — FR-22.2；禁写 L0 |
| 回归看板 | `src/knowledge/regression-dashboard.ts`、`/admin/regression` |
| 种子 | `src/app/seed*.ts` — 每家自有 CodingRules；修正 seed-fourth |
| 文档 | 本文 + `product-codes.md` + `SYSTEM_TRAINER_AGENT.md` + REQUIREMENTS FR-16 / FR-22 |
| 无厂商路径 | 未 `@` 时走 L0 + GenericCatalog（FR-18）；禁止 boot 默认第一家厂商 |

测试要点：同码前缀在两家含义不同不串台；`-BOX`/`-DOOR`/组合件判定；filler 永不进门板从属行；总控不泄漏公司前缀表；未选厂商时 seller 检查项为 missing 且不阻断出图确认（非关键）。
