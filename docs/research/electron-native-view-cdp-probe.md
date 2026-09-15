# 探针结论：Electron 原生视图能否被 Playwright 经 CDP 驱动

**问题**：停在 Electron 窗口里的原生浏览器视图（`WebContentsView`），能不能被 Playwright 通过 CDP 认出来并真正操作（navigate / 读 DOM / 点击）？

**结论：能。** 直接可用，不需要任何逃生开关。

- 探针代码：`G:\dsh-electron-probe\`（仓库外的一次性原型，用完即弃，不是交付物）
- 日期：2026-09-15

---

## 1. 环境

| 项 | 值 |
|---|---|
| Electron | **44.3.0**（`/json/version` 报 `Chrome/152.0.7977.78`） |
| Playwright | **1.62.1**（`connectOverCDP`） |
| Node | v24.19.0 |
| 站点 | 探针内置 `127.0.0.1:9344`（`/shell`、`/sidebar`、`/two`），全程离线 |
| CDP | `app.commandLine.appendSwitch('remote-debugging-port','9333')` 在 app ready 之前调用 —— **生效** |

二进制来源与校验：`https://mirrors.huaweicloud.com/electron/44.3.0/electron-v44.3.0-win32-x64.zip`，150.82 MB，SHA256 `26bf9a617d58d81772b3d68305d59ee48272969c15083c06db634a77358a8d9d`，与 `electron@44.3.0` 包内 `checksums.json` 一致。

> 环境事实（对后续实现同样成立）：本机直连 GitHub Releases **超时**，`npmmirror.com` 实测仅 ~0.4 KB/s，**华为镜像是 ~10 MB/s**。任何 Electron 相关的下载都应走 `https://mirrors.huaweicloud.com/electron/`。

## 2. 决定性证据：目标的 CDP 类型

`GET /json/list` 原始输出（节选）：

```json
[ { "id": "598C753E4DC14212310B81B156EC0FD5", "title": "sidebar-page",
    "type": "page", "url": "http://127.0.0.1:9344/sidebar" },
  { "id": "CED6955930474B10EAE30F0B3C33035F", "title": "shell-page",
    "type": "page", "url": "http://127.0.0.1:9344/shell" } ]
```

`Target.attachedToTarget` 原始载荷（节选，与 Playwright 自己发的 `setAutoAttach` 同参数）：

```json
{ "sessionId": "BD7F9AF67D99F4DCD234D8C76A6C3201",
  "targetInfo": { "targetId": "598C753E4DC14212310B81B156EC0FD5",
                  "type": "page", "url": "http://127.0.0.1:9344/sidebar",
                  "browserContextId": "ADB823BF4FF996A7E843BA6B6ED74C06" },
  "waitingForDebugger": false }
```

**为什么这两条就够定性**：Playwright 1.62.1 里唯一的闸门是 `playwright-core/lib/coreBundle.js:38166-38201` 的 `CRBrowser._onAttachedToTarget`：

- `type === 'page'` → 建 `CRPage`，可用（`:38187`）
- `type === 'other'` → 默认丢弃，需要 `PW_CHROMIUM_ATTACH_TO_OTHER` 才救得回（`:38180`）
- `type === 'webview'` / 其它 → 落到 `:38199` 被 detach，**无开关可救**
- 缺 `browserContextId` → `:38170` 的 `assert` 抛错

本探针的视图目标是 **`page` 且带 `browserContextId`** → 走第一条路，两项风险都不存在。

## 3. 三项验收（全部通过）

`chromium.connectOverCDP('http://127.0.0.1:9333')` 之后：`contexts().length = 1`，`pages()` 里两个页面都在（`/sidebar` + `/shell`）。

| 验收 | 结果 |
|---|---|
| navigate | ✅ `goto('/two')` → HTTP 200，`page.url()` = `http://127.0.0.1:9344/two` |
| 读 DOM | ✅ `page.title()` = `"two-page"`；`document.querySelector('#out').textContent` 读到 |
| **locator 点击**（`page.locator('#hit').click()`，即插件工具真正走的路径） | ✅ `initial-sidebar` → `clicked-sidebar` |
| 原始 CDP 输入（`Input.dispatchMouseEvent`，经 `ctx.newCDPSession`） | ✅ 同样生效 |
| 需要 screencast 吗 | **不需要**，全程无 screencast |

> 修正记录：首轮点击验收假失败，原因是探针页面的 `<button>` 当时**没有 onclick 处理**，与 Electron/CDP 无关。补上处理器后两条路径均通过。这类"验收脚本自己的缺陷"必须在得出结论前排除。

## 4. 同时量到的约束（都影响设计）

1. **`context.newPage()` 在 Electron 上不可用**：抛 `Error: browserContext.newPage: Protocol error (Target.createTarget): Not supported`。
   → 插件必须**领养已存在的视图**，不能新建页面。这直接否掉 `dsh-browser-use` 现有 `cdpUrl` 分支的写法（它在 `connectOverCDP` 之后立刻 `context.newPage()`）。
2. **必须辨认目标**：壳页面与视图都是 `type: page`，探针里同时存在 2 个。按 URL 认领最省事；更稳的做法是由宿主把视图的 `targetId` 告诉插件。
3. **`browser.close()` 不会杀掉 Electron 应用**：实测调用后应用仍在（进程还在、CDP 仍活）。→ 插件可安全断开/重连，不会带走用户的桌面应用。
4. **两套词汇别混**：Electron 的 `webContents.getType()` 对 `WebContentsView` 报 **`window`**，而 CDP 报 **`page`**。只有后者决定 Playwright 的行为。

## 5. 本探针**没有**验证的

- 视图的定位与跟随（缩放 / 滚动 / 分栏 / 浮动 / 侧边栏折叠）
- 真实站点、登录态持久化、跨站导航
- 多标签
- 与官方桌面版 fork 后的集成（本探针是一个**独立的最小 Electron 应用**，不是官方 `apps/desktop`）

## 6. 对设计的直接含义

- 「面板不再是画面、而是浏览器本身」这条**在技术上成立**，且不需要 screencast 管线。
- 可以砍掉：focus emulation、合成输入的坐标换算、viewport 贴合、MJPEG 帧流。
- 但**宿主必须提供那块视图**：官方桌面版未经改动做不到（见 `desktop-embedded-browser-view.zh.md`），因此需要 fork 宿主或自建外壳。

## 7. 追加实测：目标的身份可以由两端各自独立取得

上面第 4 节第 2 条说"必须辨认目标"。为了确认"按身份领养"这条路真的可行，又量了一次：对每个页面执行 `context.newCDPSession(page)`，再 `send('Target.getTargetInfo')`，把它返回的 `targetInfo.targetId` 与 `/json/list` 里的 `id` 逐一比对。

原始输出（`/json/list` 是地面真相）：

```
/json/list:
  F71E9839A9949727AFD031F1CF9EB11F  type=page  http://127.0.0.1:9344/sidebar
  65179BDAFE0387EF2C09A0DF53BFD939  type=page  http://127.0.0.1:9344/shell

per page -> Target.getTargetInfo:
  shell   -> 65179BDAFE0387EF2C09A0DF53BFD939  type=page  matchesJsonList=true
  sidebar -> F71E9839A9949727AFD031F1CF9EB11F  type=page  matchesJsonList=true
```

**结论**：`Target.getTargetInfo` 可用，返回的 `targetId` 与 `/json/list` 的 `id` **完全一致**。因此：

- 宿主可以用 `webContents.fromDevToolsTargetId(targetId)` 反查回 `webContents`、与视图的 `webContents` 比对，从而**确定地**得到视图的 targetId；
- 插件可以独立地用 `Target.getTargetInfo` 取得每个页面的 targetId；
- **两端取到的是同一个 id** —— 所以握手可以建立在身份上，不需要靠 URL 猜，也不需要哨兵地址兜底。

（URL 仍可作为兜底，但**不应作为首选**：页面一导航它就失效。）
