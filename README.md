# dsh-desktop-view

DSH 插件 + 一枚薄 Electron 外壳,让侧边栏那一格**是一个真正的原生浏览器视图**,而且 **Agent 能操作它**。

不是截图流,不是嵌套 iframe,不需要 screencast —— 见 `docs/adr/`。本文只讲怎么跑。

```
┌─────────────── shell/ (Electron, 自建薄壳) ───────────────┐
│  BrowserWindow  ── DSH Web 界面 / 夹具页                   │
│  WebContentsView ── 目标网页(原生渲染,能登录)            │
│  CDP 端点 127.0.0.1:<系统挑的端口>  (仅回环)               │
└───────────────────────────┬───────────────────────────────┘
                            │ 握手:{cdpUrl, targetId}
                            │ stdout 一行 / 子进程环境变量
┌───────────────────────────▼───────────────────────────────┐
│  src/ (DSH 插件)                                          │
│  领养那块视图,用 Playwright 驱动它;绝不 newPage()          │
└───────────────────────────────────────────────────────────┘
```

## 安装

```pwsh
$env:ELECTRON_MIRROR = 'https://mirrors.huaweicloud.com/electron/'   # 本机直连 GitHub Releases 会超时
npm install
```

`.npmrc` 已固化了华为镜像与 `playwright_skip_browser_download`(这条链路上唯一的 Playwright 入口是
`connectOverCDP`,不需要下载任何浏览器)。npm 10 会把 `.npmrc` 里的未知键透传成
`npm_config_<key>` 环境变量,但会打 warn;若将来 npm 不再透传,请直接在环境里设
`ELECTRON_MIRROR`。

## 跑接缝测试(一条命令)

```pwsh
npm test
```

它会真的拉起 `shell/main.js`(真 Electron、真窗口、真 `WebContentsView`),用插件的
`AdoptedViewSession` 领养那块视图,然后断言:navigate 成功、能读到 DOM、click 生效(DOM 变更)。

## 直接用外壳

```pwsh
# 默认:窗口装内置夹具 /shell,视图装内置夹具 /view
npx electron shell/main.js

# 窗口装任意地址
npx electron shell/main.js --url https://example.com --view-url https://example.org

# 真的拉起 DSH:装配好的地址,并通过环境变量把视图身份交给它
npx electron shell/main.js --dsh
```

`--dsh` 默认拉起 **`dshviewer`** 这个 profile(本插件装在那里),即
`dsh --profile dshviewer --no-open --port 0`。**不要**用 `dsh web`:它是 `--profile web` 的
硬编码别名(`dsh --help` 原文 *"alias of --profile web"*),而本插件不在 `web` 里 —— 那样启动出来的
界面看起来完全正常,但**没有标签页、没有原生视图、也不报错**。换 profile 用 `--dsh-profile <name>`,
不必改代码。

启动成功后,外壳在 stdout 上打印一行握手:

```
DSH_DESKTOP_VIEW_HANDSHAKE {"cdpUrl":"http://127.0.0.1:63668","targetId":"FB9F…","identification":"webContents.fromDevToolsTargetId","targetType":"page","targetUrl":"…/view","viewUrl":"…/view","viewWebContentsId":2,"windowWebContentsId":1,"windowTargetId":"70C5…","pageTargetCount":2,"userDataDir":"…","fixtureOrigin":"http://127.0.0.1:63669"}
```

### 在侧边栏里打开那一格(T2 验收)

`--dsh` 起来之后:

1. 窗口里是 DSH 的 Web 界面。右侧边栏标签条上的 **「+」(`新标签页`)** → 打开 guide 页;
2. guide 页里有胶囊:**「浏览器」**(副标题「把侧边栏这一格交给原生浏览器视图」,英文环境是
   *Browser*),旁边是内置的「工作区文件」;
3. **点「浏览器」** → 那一格出现的是**原生浏览器视图本身**(真渲染、能登录的那个浏览器),
   不是截图、不是 iframe;
4. 折叠侧边栏 / 切走那个标签 → 视图**隐藏**(不是被缩成 0 像素);再打开 → 它回到同一个矩形。

外壳每摆一次视图都会在 stdout 打一行,可以直接用它验证:

```
DSH_SHELL VIEW {"cause":"panel-report","visible":true,"bounds":{"x":680,"y":38,"width":506,"height":700},
                "applied":{"x":680,"y":38,"width":506,"height":700},"appliedVisible":true,
                "clamped":false,"reason":"reported", …}
DSH_SHELL VIEW {"cause":"panel-none","visible":false,"bounds":null,"appliedVisible":false, …}
```

`bounds` 是面板上报的矩形,`applied` 是 `view.getBounds()` 读回来的实际几何,`appliedVisible` 是
`view.getVisible()` 读回来的实际可见性 —— 三者一致才叫"那一格真的就是这个浏览器"。
`--placement-file <file>` 可以把最新一次摆放镜像到 JSON 文件里,方便脚本化观察。

`--dsh` 时,同一份身份还会通过子进程环境变量交给载体无关的 DSH 进程:

| 变量 | 含义 |
|---|---|
| `DSH_DESKTOP_VIEW_CDP` | 外壳的可编程端点,例如 `http://127.0.0.1:63668` |
| `DSH_DESKTOP_VIEW_TARGET` | 视图的 CDP `targetId`(身份,不是地址) |
| `DSH_DESKTOP_VIEW_URL` | 视图当时的地址(仅兜底识别用) |

`--help` 有全部开关。

## 身份握手为什么这么做

同一个 Electron 应用里,**窗口页面和视图都是 CDP 的 `type: "page"`**,所以类型和 URL 都不能用来
认视图(URL 还会随导航失效)。外壳用 `webContents.fromDevToolsTargetId(target.id)` 把每个 CDP 目标
反查回 `WebContents`,与 `view.webContents.id` 比对,得到**唯一确定**的 `targetId`;插件侧用
`context.newCDPSession(page)` + `Target.getTargetInfo` 拿回同一个 id 再比对。两侧自洽,已实测一致。

> `webContents.getType()` 对 `WebContentsView` 报 `window`,而 CDP 报 `page` —— 两套词汇,别混。

## 目录

| 路径 | 职责 |
|---|---|
| `shell/main.js` | Electron 主进程:窗口、视图摆放、CDP 端点、握手、子进程与环境变量交接、退出清理 |
| `shell/args.js` | 命令行开关解析 |
| `shell/geometry.js` | 摆放决定:面板矩形 ↔ 窗口裁剪,以及"没有矩形"与"没有地方"的区别 |
| `shell/panel-rect.js` | 面板测量的**唯一事实源**:`getBoundingClientRect()` → 上报,null = 没有矩形 |
| `shell/preload.js` | 矩形通道的页面半边:`contextBridge` 暴露 `window.__dshDesktopView`(只给窗口) |
| `shell/fixture.js` | 内置离线夹具站点(回环、系统挑端口):`/shell`、`/view`、`/other`、`/panel` |
| `shell/cdp.js` | 端点等待、`/json/list`、`webContents` ↔ `targetId` 身份映射 |
| `src/client-body.js` | 客户端半边:右栏 tab 类型(含 guide 入口)+ body + 面板组件,由构建脚本拼进 `client.js` |
| `src/session.ts` | 领养模式会话:`goto` / `title` / `url` / `textOf` / `click` / `close` |
| `src/tools.ts` | 唯一工具 `browser_navigate` |
| `src/index.ts` | 插件入口:`name` / `inject` / `Config` / `apply` |
| `scripts/build-client.mjs` | 把 `shell/panel-rect.js` + `src/client-body.js` 拼成 `client.js`(带 `--check`) |
| `client.js` | **生成文件**:宿主 `/plugins/…` 拉取的那一份,别手改 |
| `tests/adopt-view.spec.ts` | T1 接缝测试 + `--dsh` 环境变量与 profile 交接测试 |
| `tests/panel-placement.spec.ts` | T2 接缝测试:面板报矩形 → 外壳摆放视图 → 视图自己被读回 |
| `tests/client-half.spec.ts` | 客户端半边:宿主加载契约、tab 类型 + guide 入口、body、生成物是否陈旧 |
| `tests/shell-harness.ts` | 测试用外壳进程夹具 |
| `tests/fixtures/fake-dsh-web.mjs` | 假的 DSH,用来验证环境变量与 argv 交接 |

## 本仓库**不**包含

screencast、MJPEG、`webServer`、mirror、`dsh-better-sidebar`、任务空间、快照、工具全集 ——
都是被淘汰或属于后续票的东西。
