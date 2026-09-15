# 事实底稿：插件在 web / Desktop 两种宿主下该怎么接

**问题**：一个新插件要同时能在 `dsh web` 和官方 Electron 桌面版里工作，它的「面板 ↔ 宿主服务端」通信和「面板落点」分别应该建在哪？

**结论**

1. **通信必须走 `ctx.connection.rpc`**（载体无关），**不能用 `webServer` 的 HTTP 路由**。
2. **面板落点用第一方右栏 tab 系统**（seat `sidebar.right.pane.tab`），不要挂第三方 `dsh-better-sidebar`。

两条都有第一方源码出处。日期 2026-09-15。

---

## 1. 通信：唯一与载体无关的通道是 `ctx.connection.rpc`

`@deepseek-ai/dsh-client-connection` 的 Host 侧说明（本机已发布包 `@deepseek-ai/dsh@0.1.5-rc.1`）：

> `lib/types/index.d.ts:33-40` — "Provides **carrier-neutral RPC and Fetch registries**. **When `webServer` is present**, the plugin also mounts the `/api` browser transport with Host/Origin checks and persistent browser authentication."

也就是说：**RPC 注册表是无条件提供的；只有 HTTP `/api` 那段才依赖 `webServer`。**

两端接口：

| 侧 | 接口 | 出处 |
|---|---|---|
| Host | `ctx.connection.rpc.handle(channel, handler)` / `.intercept('/api', matches, handler)` | `lib/types/rpc.d.ts:104-119` |
| Host | `ctx.connection.fetch.register({path, methods, requestBody, fetch})`（非 JSON 响应/流式用） | `lib/types/rpc.d.ts:84-101` |
| Client | `ctx.connection.rpc.call(channel, endpoint, payload, signal)` | `lib/types/rpc.d.ts:173-182` |
| Client | `ctx.connection.rpc.open?`（可选；浏览器载体没有它，shell 载体有） | `lib/types/rpc.d.ts:183-192` |

**载体是怎么选的**：客户端在插件启动前读页面全局钩子。

> `lib/types/client/index.d.ts:37-63` — `ClientTransportHooks`："Carrier override installed on the page global **before plugin boot**. The served web app leaves it unset and gets HTTP + WebSocket; a shell that owns a different physical transport … provides both halves here **instead of forking this plugin**."

服务型 web 应用不设它 → 走 HTTP + WebSocket；外壳自己设它 → 插件代码一行都不用分叉。

**Desktop 就是这么做的**（对官方仓库 master `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` 的调研，见 `desktop-embedded-browser-view.zh.md`）：

| | Web | Desktop |
|---|---|---|
| 一元 Remote | `POST http://host:port/api/<ep>` | `POST dsh-app://app/api/<ep>` |
| Remote 流 | WS `/api/remote.mux` | `POST dsh-app://app/.dsh/remote-stream`（NDJSON） |
| 插件自带 HTTP route | `ctx.webServer.register(...)` | **不存在**（`webserver` 行在 `apps/desktop-host/config/desktop.cordis.patch.yml` 里被禁用） |

出处：`apps/desktop-host/src/index.ts:100-123`（注入 `globalThis.__DSH_TRANSPORT__`）、`:204`（注入进 index.html）、`:320-327`、`:359-363`（按 pathname 分派到 `connection.createSharedFetchHandler('/api')` 与 `typertGateway.wireStream.open`）。

## 2. 面板落点：第一方右栏 tab 系统

`@deepseek-ai/dsh-client-ui-sidebar-right`：

- **注册一个 tab 类型**：`SidebarRightTabDefinition`，字段 `id`（实现身份，全局唯一）、`kind`（类型判别，`openTab` 用的名字）、可选 `patterns`（资源地址 glob，页面类型可不给）、`priority`（`extension` / `builtin` / `fallback`；**外部类型默认 `extension`，优先级最高**）、可选 `canOpen`、`title(address)`、可选 `guide[]`。出处 `lib/types/client/tab-registry.d.ts:68-109`。
- **注册 body**：seat **`sidebar.right.pane.tab`**（`kind: 'keyed'`，session 域），**按上面那个 `id` 注册**，"receives every tab of that kind, in every pane, docked or floating"。可选 `sidebar.right.pane.tab.title` 提供活标题。出处 `lib/types/client/contract/slots.d.ts:12-45`。
- **body 拿到的运行时信息**里有 `SidebarRightTabInfo.sidebar.expanded` —— 面板自己就知道侧边栏是否展开。出处 `lib/types/client/contract/slots.d.ts:116-120`。
- 导航面另有 `openTab(kind, options)` / `float(tabId, rect)` / `dock(paneId)`。出处 `lib/types/client/service.d.ts:105-168`。

**第一方现成的成对示例**（可直接照抄形状）：`@deepseek-ai/dsh-api-workspace-files` ⇄ `@deepseek-ai/dsh-client-ui-sidebar-files`。服务端是 `TypertRemoteService` 子类 + `@Remote` 方法；客户端 `inject = ['slots','locale','sidebarRightTabs','remote','remote.workspaceFiles']`，然后 `ctx.sidebarRightTabs.register(...)` 加 `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({...}))`。

> 注：`float(tabId, rect)` 里的 `FloatRect` 是**网页浮动面板**的矩形，不是为原生视图预留的 API；第一方全部 `.d.ts` 里 `webview` / `nativeView` / `BrowserView` / `WebContentsView` **0 命中**。

## 3. 对照：`dsh-browser-use` 为什么在 Desktop 里跑不起来

| 它怎么做的 | 出处 | 为什么不行 |
|---|---|---|
| `ctx.inject(['webServer'], scope => registerMirrorRoutes(manager, webServer))` | `G:\dsh_test\src\index.ts:84-86` | Desktop 没有 `webServer` 服务，`inject` 不成立，路由根本不注册 |
| 注册 7 条 `/browser-use/*` 路由 | `G:\dsh_test\src\mirror.ts:98-149` | 同上 |
| 客户端用相对路径 `fetch('/browser-use/...')` | `G:\dsh_test\client.js:17-24, 44, 73, 87, 97` | Desktop 的页面源是 `dsh-app://app`，且没有那个 HTTP 服务 |
| 面板挂第三方 `dsh-better-sidebar`（`ctx.inject(['betterSidebar'])` → `registerTab`），并用 `shell.overlay` 兜底 | `G:\dsh_test\client.js:3-8, 730-764` | 与第一方右栏 tab 系统无关；第三方依赖不是本项目的落点 |

→ **把通信搬到 `ctx.connection.rpc`、把面板挂到 `sidebar.right.pane.tab`，这两条与"原生视图"无关，是任何宿主下都要做的。**

## 4. `dsh-browser-use` 现有工具面（17 个，作为 MVP 取舍的输入）

`G:\dsh_test\src\tools.ts`，全部经 `defineTool` + `ctx.tools.register`：

`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_press_key`、`browser_wait`、`browser_hover`、`browser_evaluate`、`browser_json`、`browser_download`、`browser_scroll`、`browser_screenshot`、`browser_extract`、`browser_tabs`、`browser_switch_tab`、`browser_go_back`、`browser_go_forward`、`browser_close`。

其中工具定位元素的方式是 **`ref`（快照里的数字索引）→ Playwright locator**（`this.refs.get(ref)` → `locator.click()` 等），所以**点击类能力必须验证 Playwright 的 locator 路径**，而不只是原始 CDP 输入 —— 探针已按此验证并通过。

## 5. 本底稿未验证的

- 上述 Desktop 侧的 `dsh-app://` 通道结论来自源码走读，**未在真实 Desktop 上端到端跑过**。
- 第一方右栏 tab 系统在**第三方插件**里的实际装载路径未实测（注册契约是公开的，注释也明确"a tab type may ship from outside this repository"，但没跑过）。
- 面板 body 自报 `getBoundingClientRect()` 给宿主来摆放原生视图的做法，是本项目的设计设想，**未验证**。
