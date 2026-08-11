# 厂商会话（Vendor Sessions）

> 状态：**Type1 已实现；Type2 A（对话式初始化）已实现；Type2 B/C/D（Agent 人设策略 /
> 知识库 / 确认动作 UI）待设计**

厂商侧有两类会话，服务对象不同，不要混为一谈：

| | Type1：厂商客户会话 | Type2：厂商员工会话 |
|--|---------------------|----------------------|
| 谁在用 | 平台上的消费者/建商客户 | 该厂商自己的员工 |
| 载体 | `CompanyEngagement`（协作子线程，FR-23） | `CompanyStaffThread`（一家一条常驻线程） |
| 目的 | 用厂商自己的规格库报价，落地到店/上门 | 登记门店信息、标准折扣、产品目录；（后续）配置 Agent 人设、喂知识库 |

---

## 1. Type1：报价 + 到店/上门落地

### 1.1 报价规则（v1.2）

不是"厂商 Agent 不报价"，而是按 Agent 类型分工：

- **总控助手**（贯穿主线程，不认厂）：主线程里**永远不报任何价格数字或区间**——连
  "行业典型区间"也不给，只描述产品/清单信息。客户一问到钱就提示 `@厂商名`。
  见 `agents/orchestrator.ts` `orchestratorSystem`。
- **厂商 Agent**（`@厂商名` 或协作子线程）：**可以报价**，基准是 MSRP（规格库
  `PriceMatrixEntry.listPrice`）；如果厂商发布了标准折扣（`DiscountRule.autoQuotable`），
  就报折后价。价格必须在系统里算好（`pricing/informal-quote.ts`），Agent 只转述数字，
  不允许自己加减乘除或承诺清单外的优惠。厂商员工接管（`agentPaused`）后，更大的优惠
  是员工自己决定的事，不是 Agent 能承诺的。

标准折扣的约束：**只支持全店统一一档 `percentOffList`，不支持按品类/价格组细分**——
细分的折扣只在正式 Quote 流程里参与计算（原有的 `DiscountRule` 机制不变），厂商 Agent
的口头参考价不会引用那些。每家公司至多一条 `autoQuotable: true` 的规则；写入新的一条
会替换旧的（见 `agents/company-staff-agent.ts` `applyStandardDiscountPatch`）。

### 1.2 到店/上门落地

刻意做得很轻——不建 Store/ServiceArea 地理模型，不做排班/容量管理，**系统只促成两次
邮件**，双方线下联系：

```
客户确认报价并已发出(status=sent)
  → 选到店/上门 + 留联系方式
  → POST /api/quotes/:id/service-request
    → 邮件 1：发给厂商 quoteEmail（附报价单+联系方式）
    → Quote.serviceRequest = { serviceType, customerContact, requestedAt }
  → 厂商员工线下/在员工会话里确认
  → POST /api/company/:companyId/quotes/:id/confirm-service
    → 邮件 2：发给客户（附报价单/方案，到店给门店地址）
    → Quote.serviceRequest.confirmedAt 写入
```

状态机细节、审计事件（`serviceRequested`/`serviceConfirmed` 等）见 `app/quote-service.ts`
`recordServiceRequest`/`recordServiceConfirmation`；邮件正文见 `email/sender.ts`
`buildServiceRequestEmail`/`buildServiceConfirmationEmail`。

**未做**（刻意）：预约时段/日历、地理覆盖校验、`Appointment` 状态机。这些如果以后要做，
不动 `QuoteServiceRequest` 这个字段本身，是在它之上加一层调度。

**待设计**：预约提醒放在会话列表里（跨对话工作列表的语义），倒序、点开跳转到对应协作
子线程；不放右侧输出面板（那个面板是单对话语义）。UI 尚未实现。

---

## 2. Type2 A：对话式初始化

厂商注册后没有单独的表单页面——门店地址、标准折扣、产品目录都是员工在
`CompanyStaffThread` 里跟后台 Agent 聊出来的。这不是在造一套新的规格录入逻辑，是给
`spec/onboarding.ts` 那套早就写好的状态机（导入 → 追问队列 → 发布）换一个聊天入口。

### 2.1 三类可对话式登记的信息

| 信息 | 落地方式 |
|------|----------|
| 门店地址 / 标准折扣 | `agents/company-staff-agent.ts` 做意图抽取（有 LLM 用 `completeJson`，无 LLM 退化为要求精确句式），直接写 `CabinetCompany.storeAddress` / `DiscountRule` |
| 产品目录 + 价目表（几百~上千 SKU） | 文件上传（见下），走现成的 `ingestTemplates` 追问队列 |
| 入驻追问（脸型/能力标签） | 员工自然语言答案 → LLM 抽成 `QuestionAnswer` → `answerQuestion`（零静默失败：答不上来就还留在队列里，不会被"已处理"假象糊弄过去） |

地址/折扣类信息直接落库、不设二次确认步骤——错了员工再说一次就会覆盖，Agent 每次都会
把记下的值念一遍，错误在下一轮就可见。

### 2.2 批量上传格式

| 格式 | 状态 | 说明 |
|------|------|------|
| Excel (.xlsx) | 一等公民 | 多标签页，页名对应 `modules`/`priceGroups`/`doorStyles`/`priceMatrix`/`boxMaterials`（大小写/空格不敏感），`spec/catalog-upload.ts` `parseXlsxCatalog` |
| JSON | 一等公民 | 同样五个 key，每个是行对象数组，`parseJsonCatalog` |
| PDF | 兜底，置信度明显更低 | 需要 LLM 配置；文本抽取常把表格列错位，预期复核量大得多；`spec/pdf-catalog-extract.ts` |
| Word / Txt | 不支持 | 没有可依赖的表格结构，宁可让商家转存成 Excel |

Excel/JSON 转成的都是与手填 CSV 完全等价的 `ImportSources`——下游 `ingestTemplates`/
`assertPublishable`/发布/追问循环一行不改，上传只是给现成管线换了个前门。

### 2.3 端点

```
GET  /api/company/:companyId/staff-chat                 取常驻线程
POST /api/company/:companyId/staff-chat/messages         发一句话，Agent 答复并按意图写库
POST /api/company/:companyId/staff-chat/catalog          上传目录（multipart file 或 JSON body）
```

均走 `requireCompany`（`X-Company-Token`）。

### 2.4 已知的规模问题（未解决）

几百到上千条待确认项，逐条聊天问答在这个量级下体验会很差。目前就是纯粹的单条循环
（`renderNextQuestionPrompt` 一次只报一条）。**按 reason 分组、一句话批量确认整组**的
交互设计已经讨论过，尚未实现——留在这里提醒自己别忘了。

---

## 3. Type2 B/C/D：留给下一轮设计

- **B：Agent 人设/策略配置**——语气颗粒度、强制转人工规则、策略生效范围/权限、
  与 C 的边界，均待用户确认（讨论要点见对话记录，未落成文档）。
- **C：店内知识**——按用户要求走**文本文件**，不进数据库；具体结构/怎么被检索进
  对话/是否需要过期机制，未设计。
- **D：待确认预约的处理动作**——已确定"发邮件确认+带附件"这一步的后端（见 §1.2），
  但员工会话里怎么展示"有几条待确认"、UI 放哪，未设计。
