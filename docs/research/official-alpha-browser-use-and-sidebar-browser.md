# 测量：官方 alpha 的「browser use」与「侧边栏浏览器」是不是同一件事

**问题**：DSH 官方最新 alpha 里据说有了第一版 browser use，而且是在 **web 端用侧边栏**实现的。
它到底怎么实现的？跟 `G:\dsh_test1` 这个项目（外壳 + 原生视图 + 插件领养）是什么关系？

**结论（先给结论，证据在下面每一节）**

1. **这是两个互相独立的东西，名字像，机制完全不相干。**
   - **browser use** = *模型*驱动浏览器。载体是 Playwright MCP（一个子进程），模型拿到的是一批
     `mcp__playwright-mcp__*` 工具。**它没有任何界面**，不进侧边栏，不画 iframe，不画画面。
   - **侧边栏浏览器**（Sidebar Browser）= *人*驱动浏览器。载体是**侧边栏里的一个 iframe**，
     有地址栏/前进后退/刷新/沙箱开关。**它不给模型任何工具**（官方原文：`Model Experience: None`）。
2. **两者进入 alpha 的时间不同**：browser use 在 **0.1.6-alpha.1** 就有；侧边栏浏览器
   **0.1.6-alpha.1 里根本不存在**，是 **0.1.6-alpha.2** 新加的（该版本发布于 2026-09-17 13:52 UTC）。
3. **这台机器上跑的（`dsh 0.1.5-rc.1`）两个都没有。** 所以"在侧边栏里见到浏览器"这件事，
   在你当前这份里是不会发生的 —— 需要升到 `0.1.6-alpha.2`。
4. 侧边栏浏览器的载体是 **iframe + sandbox 属性**，**不是** Electron `<webview>`、也不是原生视图。
   官方把 `<webview>` 载体写成了**明确推迟**的设计（设计笔记里叫 "Deferred Electron carrier"），
   理由是"没有打包应用证据，不敢开一个新的 Electron guest 面"。
5. 官方自己在同一份笔记里承认：**要让 Agent 驱动这一格，需要一个"authenticated broker"把某个 tab
   绑到它的 WebContents 上** —— 这是**未做**的工作。也就是说，`G:\dsh_test1` 做的正是官方
   列在 TODO 里的那件事，而官方第一版**故意只做了"人能看"的那一半**。

- 一手来源：**上游仓库是公开的** `deepseek-ai/deepseek-harness`（`master`，`pushed_at = 2026-09-17T13:30:15Z`；
  本轮源码以 zipball 快照为准，commit 短号 `ddefc45`）
- 日期：2026-09-17
- 说明：本文所有源文件路径都是**上游仓库路径**；本地只做了"读"，没有改过任何 DSH 安装或 profile。

---

## 1. 环境与版本（先证明尺子是对的）

本机安装的 CLI：

```powershell
PS> (Get-Content "F:\claude code\global\node_modules\@deepseek-ai\dsh\package.json" -Raw | ConvertFrom-Json) | Select-Object name,version
name           version
----           -------
@deepseek-ai/dsh 0.1.5-rc.1
```

官方 dist-tags（直连 registry，不用搜索接口）：

```powershell
PS> (Invoke-RestMethod "https://registry.npmmirror.com/@deepseek-ai/dsh").'dist-tags' | ConvertTo-Json
{
    "alpha":  "0.1.6-alpha.1",
    "latest": "0.1.5-rc.2",
    "next":   "0.1.5-rc.2"
}
```

⇒ **本机落后两个版本**（`0.1.5-rc.1` → `0.1.5-rc.2` → `0.1.6-alpha.1` → `0.1.6-alpha.2`）。

本机 `@deepseek-ai` 目录下只有一个包：

```powershell
PS> Get-ChildItem "F:\claude code\global\node_modules\@deepseek-ai" -Directory | Select-Object -ExpandProperty Name
dsh
PS> Test-Path "F:\claude code\global\node_modules\@deepseek-ai\dsh-client-ui-sidebar-browser"
False
```

**踩到的坑（记下来，免得下次又踩）**：`registry.npmmirror.com` 的**搜索接口索引是陈旧的** ——
它既列不出 `dsh-browser-use`，也列不出 `dsh-client-ui-sidebar-browser`；而且同一次会话里，
`dsh-browser-use` 的 `alpha` 标签先是 `0.1.6-alpha.1`、几分钟后变成 `0.1.6-alpha.2`（镜像缓存刷新）。
**所以本轮一律用"按包名直查"而不是搜索接口**：

```powershell
PS> (Invoke-RestMethod "https://registry.npmmirror.com/@deepseek-ai/dsh-browser-use").'dist-tags' | ConvertTo-Json
{ "alpha": "0.1.6-alpha.2", "latest": "0.1.6-alpha.1" }
PS> (Invoke-RestMethod "https://registry.npmmirror.com/@deepseek-ai/dsh-browser-use").time | ConvertTo-Json
{ "created": "2026-09-15T11:45:09Z", "0.1.6-alpha.1": "2026-09-15T03:23:21Z", "0.1.6-alpha.2": "2026-09-17T13:52:19Z" }
```

---

## 2. 穷尽排查：官方跟 browser 沾边的包，一共这几个

按包名逐个直查（`EXISTS` / `NOT FOUND`）：

| 包名 | 结果 |
|---|---|
| `@deepseek-ai/dsh-browser-use` | EXISTS — 只有 `0.1.6-alpha.1` / `0.1.6-alpha.2` |
| `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | EXISTS — 只有 `0.1.6-alpha.1` / `0.1.6-alpha.2` |
| `@deepseek-ai/dsh-experimental-browser-use-runtime` | EXISTS — 同上 |
| `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp` | **NOT FOUND**（仓库里有，npm 上没发） |
| `@deepseek-ai/dsh-experimental-browser-use-stagehand-native` | **NOT FOUND**（仓库里有，npm 上没发） |
| `@deepseek-ai/dsh-client-ui-sidebar-browser` | EXISTS — **只有 `0.1.6-alpha.2`，没有 alpha.1** |
| `@deepseek-ai/dsh-tool-browser` / `dsh-browser` / `dsh-client-ui-browser` | NOT FOUND |

**注意最后那张表里的分界线**：`dsh-browser-use` 那一族是**宿主侧**（服务器进程里跑的东西），
`dsh-client-ui-sidebar-browser` 是**浏览器侧**（web 前端里跑的东西）。**两族之间没有任何互相引用**
（这一点在第 10.1 节用"排除 `\client\` 后全仓库搜 `'browser'`"证实过）。

---

## 3. 决定性证据：alpha.1 与 alpha.2 的 web profile 插件名单对比

这是本轮最硬的一条。侧边栏插件是在 web profile 的 `cordis.patch.yml` 里按 `id` 挂载的，
所以把两个版本的同一段拉出来对比即可 —— 这是**阳性对照**（同一把尺子量两个样本）：

```powershell
PS> Select-String -Path "<dsh-web-app@0.1.6-alpha.1>\cordis.patch.yml" -Pattern "id: ui-sidebar"
  L219: - id: ui-sidebar
  L223: - id: ui-sidebar-right
  L229: - id: ui-sidebar-documentpreview
  L233: - id: ui-sidebar-terminal
  L235: - id: ui-sidebar-files

PS> Select-String -Path "<dsh-web-app@0.1.6-alpha.2>\cordis.patch.yml" -Pattern "id: ui-sidebar"
  L220: - id: ui-sidebar
  L224: - id: ui-sidebar-right
  L233: - id: ui-sidebar-documentpreview
  L237: - id: ui-sidebar-browser      <-- 新增
  L240: - id: ui-sidebar-terminal
  L243: - id: ui-sidebar-files
```

包依赖层面同一条结论（`dsh-web-app` 的 `dependencies`）：

```
alpha.1: dsh-client-ui-sidebar, -sidebar-files, -sidebar-right, -sidebar-documentpreview, -sidebar-terminal
alpha.2: 以上五个 + @deepseek-ai/dsh-client-ui-sidebar-browser = ^0.1.6-alpha.2
```

再补一刀，确认 alpha.1 里连字符串都不存在：

```powershell
PS> Select-String -Path "<alpha.1>\cordis.patch.yml" -Pattern 'sidebar-browser' -SimpleMatch
  (无任何匹配)
```

**反证方式**：如果把 `dsh-web-app` 降到 `0.1.6-alpha.1`，`ui-sidebar-browser` 这个 id 必须消失 ——
上表就是这个反证的结果。**所以"alpha.1 的侧边栏里有浏览器"这个说法是不成立的。**

---

## 4. 侧边栏浏览器是怎么接进侧边栏的（机制）

接入点是官方右侧边栏的**两段式 tab 注册**。

### 4.1 第一段：声明一个 tab「类型」

`packages/client/ui-sidebar-browser/src/client/definition.tsx` 全文核心：

```tsx
export const BROWSER_KIND = 'browser'
export const BROWSER_ID = '@deepseek-ai/dsh-client-ui-sidebar-browser'

export function browserDefinition(t: TranslateNS<'sidebarBrowser'>): SidebarRightTabDefinition {
  return {
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    multiple: true,          // 关键：允许多个独立实例（每个 tab 一个浏览器）
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'new', order: 30, title: () => t('guide.title'),
      description: () => t('guide.description'), icon: IconGlobeOutline14,
    }],
  }
}
```

- `multiple: true` = 每次打开都是一个**新实例**（跟终端一样），而不是复用同一个页签。
- `guide: [...]` = 在侧边栏那个"指南"页里放一个入口胶囊（`order: 30` 决定排序）。
  **这正是你在 UI 上看到的那个可以点的入口。**

### 4.2 第二段：注册「身体」和「标题」

`packages/client/ui-sidebar-browser/src/client/index.ts`（去掉 import 与类型导出）：

```ts
export const inject = ['slots', 'locale', 'sidebarRightTabs']

export function apply(ctx: Context): void {
  const namespace = 'sidebarBrowser'
  const t = ctx.locale.bind(namespace)
  const store = createBrowserStore()
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition(t)), 'ui-sidebar-browser.type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: namespace, store,
    inject: (_sessionId, actions) => createBrowserControllers(actions),
  }, BrowserBody)), 'ui-sidebar-browser.body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
```

**这三行 `ctx.effect(...)` 就是全部接入动作**，用的是官方公开插槽，没有任何私有后门：

| 调用 | 干什么 |
|---|---|
| `ctx.sidebarRightTabs.register(...)` | 登记 tab **类型**（`kind = 'browser'`） |
| `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: BROWSER_ID }, BrowserBody)` | 登记 tab **内容区** |
| `ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: BROWSER_ID }, BrowserTitle)` | 登记 tab **标题**（显示当前 host） |

`ctx.effect(...)` 的语义：插件卸载时这些登记**自动撤销**（所以热重载不会留垃圾）。

### 4.3 别人怎么"打开一个浏览器 tab"

同一个包导出给外部的唯一入口是**导航控制器**：

```ts
ctx.sidebarRight.openTab('browser', { params: { url } })
```

并在类型层声明了参数表（`index.ts`）：

```ts
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    browser: { readonly url?: string }
  }
}
```

⇒ 别的客户端插件（比如聊天区）只要调 `openTab('browser', {params:{url}})` 就能把浏览器开在侧边栏里，
**不需要 import 这个包的任何运行时值**（只 import 类型）。

**这条已经被逐行证实了。** 聊天里点一个 http(s) 链接，真正执行的就是这段
（`packages/client/ui-chat/src/client/apply.ts:146`，全仓库搜 `openExternalLink` 的唯一赋值处）：

```ts
openExternalLink: (url) => {
  if (ctx.get('sidebarRightTabs')?.get('browser') !== undefined) {
    ctx.sidebarRight.openTab('browser', { params: { url } })
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
},
```

三个细节值得记：

- 用的是 `ctx.get('sidebarRightTabs')`（**可选服务**），不是 `ctx.sidebarRightTabs`（**声明式注入**）。
  这是上游自己的规约（`packages/AGENTS.md`：optional services use `ctx.get(name)`）—— 目的是让
  **聊天插件不硬依赖浏览器插件**：没装浏览器插件时它照样能加载，退化成 `window.open`。
- 判据是**"有没有注册 `browser` 这个 kind"**，不是"有没有装某个包"。所以这是一个**能力探测**，
  不是依赖检查 —— 换一个实现了 `browser` kind 的插件，聊天区会自动改用它。
- 链接的 URL 是**原样**当 `params.url` 传过去的，然后由浏览器插件自己的地址解析器
  （第 5.1 节那份白名单）再校验一次。**聊天区不做 URL 校验。**

---

## 5. 载体：iframe + sandbox（不是 webview，不是原生视图）

`packages/client/ui-sidebar-browser/src/client/view/BrowserBody.tsx`：

```tsx
export const WEB_BROWSER_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'

<iframe
  key={`${document.target.url}:${String(document.revision)}`}
  className={css.frame}
  src={document.src}
  sandbox={sandboxed ? WEB_BROWSER_SANDBOX : undefined}
  referrerPolicy="no-referrer"
  title={document.target.title}
  onLoad={() => { reportLoaded(tab.id, document.revision) }}
  onError={() => { reportLoadFailed(tab.id, document.revision) }}
  data-sidebar-browser-frame
/>
```

要点：

- **载体就是一个 `<iframe>`**，塞在侧边栏那一格里。默认带 `sandbox="..."`。
- 工具栏最右那个盾牌按钮 = **给这个 tab 单独摘掉 sandbox**（不是全局开关，不持久化，开着的时候显示警告条）。
- `referrerPolicy="no-referrer"`：不向目标站发 referrer。
- `key` 里带 `revision`：换地址时**换一个新的 iframe 元素**（强制重挂），而不是改 `src` 复用。

### 5.1 地址白名单（谁被允许输入）

`packages/client/ui-sidebar-browser/src/client/browser/url.ts`：

```ts
if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
if (url.protocol === 'https:' || url.protocol === 'http:') {
  if (applicationOrigin !== undefined && applicationOrigin !== 'null') {
    if (url.origin === new URL(applicationOrigin).origin) return { ok: false, reason: 'application-origin' }
  }
  return { ok: true, target: { kind: ..., url: url.href, title: url.hostname } }
}
return { ok: false, reason: 'protocol' }
```

- 只放 **http / https**；**`file:` 被明确拒绝**（本地文件归"文档预览"那个 tab 管）。
- 拒绝带用户名密码的地址、拒绝**DSH 自己的 origin**（防自指）。
- **纯主机名自动补 `https://`**（`https://${trimmed}`）。

---

## 6. 它能不能被 Agent 驱动？——不能

这是本轮最该记住的一条。官方在包的 README 里写得很直白：

```
## Model Experience

None, as Browser tabs are user-facing presentation state and register no tool, prompt section, or Session event.

#### KV Cache effect

None; browsing does not enter a model request.
```

以及 `Known Limitations`：

```
- The proposed Electron <webview> carrier, per-tab cookie partitions, native history,
  and target-specific CDP connection are not implemented.
```

设计笔记（`.agents/notes/implemented/feature/2026-09-16-sidebar-browser.md`）里，把"Agent 驱动"
明确列为**没做**：

> Each guest is a distinct WebContents and CDP target. … Production keeps that endpoint disabled;
> **browser-use or computer-use requires an authenticated broker that binds one authorized tab to its
> WebContents** and uses `webContents.debugger` or an equivalently scoped transport without publishing
> every application target.

翻译成大白话：**"要让 browser-use 去驱动侧边栏里的那一格，需要一个经过鉴权的中间人，把某个被授权的
tab 和它的 WebContents 绑起来"** —— 官方说这话的时候，用的是**将来时**，并且是在
"Deferred Electron carrier"（被推迟的 Electron 载体）那一节里说的。

同一节还写清了为什么推迟：

> **Implement the Electron carrier in the initial Browser change.** Deferred so the first implementation
> does not enable a new Electron guest surface without packaged-app evidence for overlay stacking,
> target lifetime, cookie isolation, and every permission denial.

**换句话说**：官方第一版**故意**只做了 iframe 这一半（人能看、地址栏能用、沙箱能开关），
把"真载体 + 能被 Agent 驱动"整块推后了。

---

## 7. 那 "browser use"（模型驱动那半）长什么样

它跟侧边栏**没有交集**，是纯宿主侧的一条 MCP 链路。三件套：

| 包 | 角色 |
|---|---|
| `dsh-browser-use` | 只是一个**注册表**：`ctx.browserUse.register(name)`，全进程只允许一个 provider |
| `dsh-experimental-browser-use-runtime` | 共享运行时：按 Session 建 MCP 连接、串行化、清理 |
| `dsh-experimental-browser-use-playwright-mcp` | **唯一发到 npm 的 provider**：拉起 `@playwright/mcp` 子进程 |

`dsh-browser-use` 的全部实现（`lib/index.js`，35 行）里**没有任何浏览器对象、操作接口或资源生命周期**
（README 原话：`the source contains no browser object, operation interface, resource lifecycle, or provider selector`）。
它只提供 `ctx.browserUse.providerName` 和"第二个注册者会报错"。

provider 干的事（`packages/experimental/browser-use-playwright-mcp/src/index.ts`）：

```ts
const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
const args = [cli, '--browser', 'chromium']
if (config.mode === 'attach') args.push('--cdp-endpoint', config.endpoint)
else { args.push('--isolated'); if (config.headless) args.push('--headless') }
mountSessionMcp(ctx, { name: 'playwright-mcp', exclusive: config.mode === 'attach', command: process.execPath, args, env })
```

⇒ **在宿主进程里 fork 一个 `@playwright/mcp` 子进程，用 stdio 上的 MCP 协议说话**，
模型于是拿到一批 `mcp__playwright-mcp__<tool>` 工具。两种模式：

- `mode: launch`（默认 `headless: true`）：**自己起一个 Chromium**，默认**无窗口**。
- `mode: attach` + `endpoint`：**接管一个已经在跑的浏览器**（CDP endpoint，**这正是本项目走的那条路**）。

子系统文档 `docs/subsystems/browser-use.md` 明确：这是**实验性、必须显式挂载**的，
默认 profile 里**没有它**（我 grep 过 `dsh-web-app@0.1.6-alpha.1` 的 `cordis.patch.yml`，
没有任何 `browser-use` 条目）。

关于 `mode: attach`，官方 README 还写了两条对本项目有参考价值的边界：

```
- Attachment exclusivity is local to this provider instance. Other processes and browser users can still modify the same pages.
- Cancellation does not undo navigation, clicks, or other actions already delivered to the browser.
```

---

## 8. 官方自己的 e2e 里，它跑起来是什么样（行为级的旁证）

`apps/web/tests/sidebar-browser.e2e.ts` 用**真实 Chromium + 真实装配的 web composition** 跑了一条
端到端用例（节选）：

```ts
const column = page.locator('[data-rightbar-col]')
await page.locator('[data-sidebar-right-expand]').click()
await column.locator('[data-sidebar-right-guide-entry="browser"]').click()
const input = column.getByRole('textbox', { name: 'Enter an HTTP(S) address' })
await input.fill('https://browser.test/one')
...
await column.getByRole('button', { name: 'Disable sandbox restrictions' }).click()
await expect.poll(() => frame.getAttribute('sandbox')).toBeNull()
...
await page.frameLocator('[data-sidebar-browser-frame]').getByRole('link', { name: 'Inside navigation' }).click()
await column.getByText('URL changed', { exact: true }).waitFor()
expect(await column.getByRole('button', { name: 'Back', exact: true }).isDisabled()).toBe(true)
expect(await column.getByRole('button', { name: 'Forward', exact: true }).isDisabled()).toBe(true)
...
await input.fill('file:///work/index.html')
const blocked = await column.getByRole('alert').innerText()
expect(blocked).toBe('Only HTTP and HTTPS addresses are supported; use Document Preview for local files.')
```

这条用例把几件事钉死了：

1. 入口是 `[data-sidebar-right-guide-entry="browser"]` —— 侧边栏"指南"里的一个胶囊。
2. 地址栏是一个真实的输入框。
3. 沙箱开关**真的**改 `<iframe sandbox>` 属性（`toBeNull()` / 恢复成那串值）。
4. **在 iframe 里点站内链接之后**，地址被判定为 `unknown` → 显示 `URL changed`，
   **前进/后退/外部打开全部被禁用**，刷新回到"最后一次应用已知的地址"。
5. `file://` 被拒，并且报的是一句给用户看的人话。

第 4 条是这套设计里最值得学的一点，见下一节。

---

## 9. 它最关键的一个设计：承认「我读不到跨域的 URL」

父页面**在协议上就无法**读取一个跨域 iframe 内部的真实地址和它自己的历史。
官方没有假装自己知道，而是把这个事实**做成了显式状态机**
（`BrowserNavigation.ts`，四个状态）：

| 状态 | 什么时候 | 地址栏与按钮 |
|---|---|---|
| `empty` | 还没有受控目标 | 空；后退/前进/刷新/外部打开全禁用 |
| `loading` | 提交地址、前进后退、刷新 | 请求的 URL 仍然是**权威值**；刷新可用 |
| `known` | 当前 revision 的**第一次** `load` 到达 | 同上（即使这次 load 是 HTTP 重定向，也仍以请求值为准） |
| `unknown` | 同一 revision 的**第二次及以后** `load` | 地址标灰并标 `URL changed`；**后退/前进/外部打开禁用**；刷新回到最后受控地址 |

判定逻辑（`BrowserNavigation.frameLoaded`）：

```ts
frameLoaded(revision: number): void {
  const navigation = this.value.navigation
  if (navigation.status === 'empty' || navigation.revision !== revision) return
  if (navigation.status === 'loading') {
    this.value = { ...this.value, navigation: { status: 'known', revision } }
  } else if (navigation.status === 'known') {
    this.value = { ...this.value, navigation: { status: 'unknown', revision } }
  }
}
```

**大白话**：第一次 load 是"我让它去的那个地址"；之后再 load 一次，只能证明"页面变成别的了"，
但**读不出变成了什么** —— 那就老老实实标成"地址已变"，并且**把那些依赖地址的按钮关掉**，
而不是留一个会骗人的旧地址和一堆点了没用的按钮。

这跟本项目 `t18-history-truth`（历史真相）那张票是同一类问题，**官方的解法可以直接借鉴**：
**不确定就显式降级，并禁用不可信的动作。**

---

## 10. 验证状态（本节按规矩必须写）

### 10.1 本轮中途是缺口、后来补验掉的

1. **`openExternalLink` 在哪里接到"打开 browser tab"** —— **已逐行证实**。
   从"设计笔记这么说"升级成"我看到了那一行"：`packages/client/ui-chat/src/client/apply.ts:146`
   就是全仓库唯一的赋值处，代码见第 4.3 节。补验手段：下载上游 zipball（31.3MB）后在本地全仓库搜索。
2. **"Desktop 也挂了它"** —— **已查清**。全仓库所有 `*.yml` 里出现 `ui-sidebar-browser` 的**只有**
   `packages/bundle/web-app/cordis.patch.yml:237`（外加 lockfile 里的链接条目）。`apps/` 下有
   `cli / desktop / desktop-host / web`，其中 `apps/desktop` **自己没有 composition 文件**。
   ⇒ 准确说法是：**只有 `web-app` 这个 bundle 挂它；Desktop 是靠复用 web profile 才得到它的**，
   而不是 Desktop 另有一份装配。
3. **"Agent 碰不到侧边栏浏览器"** —— **已用全仓库搜索证实**。在 `packages/` 里排除 `\client\` 之后搜
   `'browser'`，命中的全是无关项（环境变量 `BROWSER`、测试夹具、`platform: 'browser'` 之类的构建条件），
   **没有任何宿主侧/工具侧代码引用 `browser` 这个 tab kind**。

### 10.2 仍然没能验证到的

1. **我没有真的把 `0.1.6-alpha.2` 跑起来看界面。** 本轮全部是**读源码 + 读一手文档 + 读真实 npm
   产物 + 读上游 zipball**。UI 的实际观感（间距、配色、窄屏下侧边栏怎么表现）我**没看**。
2. **官方 e2e 我没有复跑。** 那是上游仓库里需要完整 `pnpm` 工具链 + Playwright 的测试，
   本轮只读了它的断言，没有执行。所以第 8 节是"官方声称并断言的行为"，不是"我实测的行为"。
3. **`chrome-devtools-mcp` 与 `stagehand-native` 两个 provider 我没读实现。** 它们在仓库里存在，
   但**没发到 npm**，我确认的只是"npm 上查不到"，没有确认它们能不能用。
4. **上游仓库我只做了读取，没有按它的 `AGENTS.md` 跑过任何门禁**（`pnpm run test` 之类一律没跑），
   所以"这份源码是绿的"这件事我完全不知道，也不关心 —— 本轮的结论只依赖**源码文本与 doc 文本**，
   不依赖它能否通过测试。

### 10.3 顺手记一条可信度证据（两条独立通道互相对账）

zipball 解出来的 `definition.tsx` 与经 `api.github.com/.../contents` 取回的那一份
**SHA256 完全一致**：

```powershell
PS> (Get-FileHash $zipFile).Hash -eq (Get-FileHash $apiFile).Hash
True
```

也就是说：**正文里引用的源码，是经两条互不相干的通道拿到同一份文件**，不是某一次抓取被截断/污染的产物。
（顺带：zipball 解压时 `tar.exe` 对 `CLAUDE.md`、`.claude/skills` 这类**符号链接**报
`Invalid argument` —— Windows 上的老问题，不影响本次要读的源码文件。）

---

## 11. 对 `G:\dsh_test1` 的含义（判断，不是测量）

- 本项目解决的是**官方明确列在"推迟"里的那一格**：真载体（原生视图 / `<webview>`）+ 能被 Agent 驱动。
  官方第一版**只做了 iframe**，并且**自己承认**要做到本项目这样就得上"authenticated broker + CDP"。
  ⇒ **本项目不是在重复官方，是在填官方留的坑。** 这一点可以写进 PRD 的"为什么不是直接用官方的"。
- 官方的**沙箱/信任模型**（默认 sandbox、per-tab 临时摘除、明确警告）**值得抄**：
  本项目是原生视图，比 iframe 权限大得多，更应该有一个"用户可见的能力开关 + 明确的后果说明"。
- 官方的**`unknown` 状态**（承认读不到跨域 URL，然后禁用依赖地址的按钮）**值得抄**，
  跟 `t18-history-truth` 是同一类问题。
- **不要**把官方 browser use 当成"侧边栏浏览器"的证据：它是 headless MCP 子进程，没有界面。
  两者唯一的重合点是 `mode: attach` 的 `--cdp-endpoint` —— **那是本项目领养原生视图所用的同一条协议**。

---

## 附：本轮用到的原始命令与产物落点

```powershell
# 上游仓库是否公开（api.github.com 在本机是通的，github.com:443 会间歇性不通）
PS> Invoke-RestMethod "https://api.github.com/repos/deepseek-ai/deepseek-harness" -Headers @{'User-Agent'='probe'}
full_name      : deepseek-ai/deepseek-harness
private        : False
default_branch : master
pushed_at      : 2026-09-17T13:30:15Z

# 整棵文件树（13854 个 path），用来穷尽搜索 browser 相关文件
PS> Invoke-RestMethod "https://api.github.com/repos/deepseek-ai/deepseek-harness/git/trees/master?recursive=1"

# 整仓库 zipball（31.3MB，一次成功），用来做本地全仓库 grep（第 4.3 / 10.1 节的证据）
PS> Invoke-WebRequest -Uri "https://api.github.com/repos/deepseek-ai/deepseek-harness/zipball/master" `
      -OutFile "$s\harness-master.zip" -Headers @{'User-Agent'='probe'} -TimeoutSec 600
DOWNLOAD OK attempt 1  size=31.3MB
PS> & "$env:SystemRoot\System32\tar.exe" -xf "$s\harness-master.zip" -C "$s\repo"
```

**`raw.githubusercontent.com` 在本机超时（120s 无输出）；改用 `api.github.com/.../contents/<path>`
取 base64 内容全部成功，最后再补一个 zipball 做全仓库 grep。** 这是本轮唯一一处"换工具才拿到事实"
的地方，记下来备用（跟交接文档里"`github.com:443` 会间歇性不通、`api.github.com` 一直通"那条一致）。

一轮产物落在仓库外（不是交付物）：`G:\deepseek_ex\.scratch\browseruse\`
（tgz 原始产物 + `upstream\` 下按上游原路径存放的已读源文件 + `repo\` 下解压出的完整上游仓库，
commit 短号 `ddefc45`）。
