# 前端设计系统：@openai/apps-sdk-ui（FR-UI-1）

> 状态：**已落地（图标桥接 v1）**  
> 依据：[openai/apps-sdk-ui](https://github.com/openai/apps-sdk-ui)（MIT）  
> 包：`@openai/apps-sdk-ui` · 要求 **React 18/19** + **Tailwind 4**

---

## 1. 决策

系统 UI **图标与设计 token** 采用 OpenAI 开源 [@openai/apps-sdk-ui](https://github.com/openai/apps-sdk-ui)。

当前主业务仍在 `web/*.html`，因此用 **Vite 构建的图标桥接（React islands）**：

1. `web-ui` 依赖 `@openai/apps-sdk-ui` + Tailwind 4，导出 `bridge.js` / `bridge.css`
2. 页面用 `data-sdk-icon="Archive"` 等属性占位
3. `window.AppsSdkUI.mountIcons(root)` 挂载；列表重绘后再次调用

后续可将整页迁到 React；本阶段不重写会话业务逻辑。

---

## 2. 目录

```
web-ui/
  package.json
  vite.config.ts          # 产出 → web/vendor/apps-sdk-ui/
  src/main.css            # @import tailwind + apps-sdk-ui/css
  src/icons.tsx           # 壳用图标子集
  src/bridge-entry.tsx    # mountIcons + window.AppsSdkUI
web/vendor/apps-sdk-ui/   # 构建产物（bridge.js / assets/bridge.css）
```

服务端：`GET /vendor/apps-sdk-ui/*` 托管上述产物。

---

## 3. 图标映射（主壳）

| 位置 | `data-sdk-icon` |
|------|-----------------|
| 品牌标题 | `Cabinet` |
| 新建会话 | `ChatCompose` |
| 存档 | `Archive` |
| 恢复 | `RestoreUntrash` |
| 附件 + | `PlusComposer` |
| 发送 | `ArrowUp` |
| 非图片附件 | `FileDocument` |
| 移除附件 | `X` |
| 返回 | `ChevronLeft` |
| `/me` 标题 | `User` |

扩展：在 `web-ui/src/icons.tsx` 增加导出名后 `npm run build:ui`。

---

## 4. 命令

```bash
cd web-ui && npm install   # 首次
npm run build:ui           # 根目录 → 写入 web/vendor/apps-sdk-ui
npm run dev:ui             # Vite :5173 预览图标桥
```

---

## 5. 非目标（本阶段）

- 不把整页聊天逻辑迁入 React
- `/admin*` 运营页可稍后接同一桥接
