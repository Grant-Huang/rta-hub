# RTA-Hub

多租户橱柜设计与报价市场平台。

这个项目原来是 [let-it-flow](https://github.com/Grant-Huang/let-it-flow) 里的一个 demo
（`examples/cabinet-quotes-scraper`），现在独立成主项目：**以 npm 包的方式依赖
`@meso.ai/let-it-flow`，不再内置在 let-it-flow 仓库里。**

## 这是什么

客户在一个对话框里跟系统讨论厨房橱柜设计，可以 `@` 任意一家已入驻的橱柜公司——每家公司背后是
绑定自己产品规格库的独立 Agent。客户上传户型图后，系统自动排布方案、生成正视/俯视（地柜层、
顶柜层）/侧视四张视图，客户在会话里改到满意后确认，系统把报价单发到该公司登记的报价邮箱。

平台是两维多租户的：

- **供给侧**：橱柜公司租户，`companyId` 严格隔离，各自维护产品规格与定价规则。
- **需求侧**：消费者账号（`consumer`）与专业/建商账号（`trade`），后者支持多项目并行与贸易价可见性。

冷启动阶段，尚无公司入驻时客户仍能基于平台共享的 `GenericCatalog` 拿到一份通用预估
（`EstimateDraft`）——它没有 `companyId`，因此在结构上就不可能被发送给任何公司。

## 文档

需求与场景是当前阶段的主交付物，开发按这两份文档推进：

- [docs/REQUIREMENTS.md](./docs/REQUIREMENTS.md) —— 需求说明书 v0.3（架构、数据模型、FR、商业模式）
- [docs/SCENARIOS.md](./docs/SCENARIOS.md) —— 场景走查 A–H（公司入驻、冷启动、@ 路由、四视图、比价发送、贸易账号、销售信号）

## 运行

```bash
pnpm install
cp .env.example .env   # 至少填 OPENAI_API_KEY
pnpm dev
# 打开 http://localhost:8790
```

## 当前代码状态

`src/` 目前是从 let-it-flow demo 迁移过来的起步实现（线索检索 + 对话收集需求 + 询价邮件），
对应 REQUIREMENTS.md 里的一小部分。多租户、四视图渲染、报价闸门等按文档逐步补齐。

平台能力从 `@meso.ai/let-it-flow/runtime` 引入（`LlmService`、`loadConfig`、
`createTavilyProvider`/`createNativeProvider`）；`extractHtml` 目前为本地实现
（`src/html-extract.ts`），待上游导出后可改为从 runtime 引入。

## 关于发送邮件（请先读这段）

- **默认是 dry run。** `.env` 里 `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` 任一为空，
  `/api/emails/send` 就只把草稿标记为 `skipped`，不发起任何网络请求。
- 真正发送需要填好自己邮箱账号的 SMTP 信息，并且前端二次确认 + 请求体显式带 `confirm: true`。
- 逐封发送之间有节流延迟。
- **这不是营销邮件群发工具。** 生成的邮件是"向已公开报价业务邮箱的公司发送一次性询价"，内容
  应只包含用户自己的真实项目需求。加拿大 CASL 对商业电子消息有严格的同意与身份披露要求；批量
  群发推广邮件到抓取来的地址通常不合规。不要把这个工具改造成面向消费者的营销群发器。
