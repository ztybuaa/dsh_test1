# 事实底稿：没有桌面外壳时，今天到底发生什么（票 #11）

**问题**：把本插件装进一个**没有桌面外壳**的 `dsh` 宿主里，三条验收各自今天是成立的还是不成立的？

- 没有桌面外壳时插件正常加载，不报错
- 面板明确说明"这一格需要桌面外壳才能显示浏览器"
- 仓库中不再存在截图流（screencast / MJPEG）相关代码路径

**结论（先给答案，下面每一条都有原始输出）**

| 验收 | 今天的现状 | 缺口 |
|---|---|---|
| 1 无外壳时正常加载、不报错 | **已成立** | 无（工具注册面在真宿主里读不回，见 §1.4） |
| 2 面板说明"这一格需要桌面外壳" | **字面已成立，但不完整** | 说了"是什么"，没说**"怎么办"**；且**没有任何测试读过渲染文本** ⇒ 静默失效 |
| 3 没有截图流代码路径 | **已成立** | 无（只剩术语表/文档/历史注释） |

日期 2026-09-16。宿主 `@deepseek-ai/dsh@0.1.5-rc.1`，仓库起点 `1115e59`。

---

## 0. 方法：怎么造出"没有外壳"的真宿主，而不碰用户的 `.dsh`

用户的 `%USERPROFILE%\.dsh\profiles\dshviewer` 是**只读**的（本票要求），所以这里另起一个
**临时 harness home**，用 `DSH_HOME` 指过去，profile 照 `dshviewer` 的形状现搭：

```pwsh
$tmp = Join-Path $env:TEMP ("dsh-t11-home-" + [guid]::NewGuid().ToString('N').Substring(0,8))
# <tmp>\profiles\t11\package.json      → dsh.profile.bundles = [dsh-base, dsh-web-app, dsh-desktop-view]
# <tmp>\profiles\t11\cordis.patch.yml  → []（空的用户层：插件配置只能来自外壳的环境变量）
# <tmp>\profiles\t11\node_modules\dsh-desktop-view → Junction G:\dsh_test1
$env:DSH_HOME = $tmp
```

`DSH_DESKTOP_VIEW_CDP` / `_TARGET` / `_URL` / `_SPACES` **一个都不设** —— 这就是"没有外壳"的定义。

合成出来的配置树里，本插件那一条是**零配置**的（`--dump-config` 原文，它是整棵树的最后一行）：

```
# == dsh-desktop-view
- id: desktop-view
  name: dsh-desktop-view
```

---

## 1. 验收一：真宿主、没有外壳 —— **今天已经成立**

### 1.1 宿主起得来，而且一句话都没抱怨

```pwsh
node "F:\claude code\global\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile t11 --no-open --port 0
```

stdout 全文（就一行）：

```
dsh web: http://127.0.0.1:52490/?token=Y2-ei0tO668g3-MNJXJXa422XgUrkXGiGywwC-gb2wM
```

stderr 全文：**空**。

起点要对照的那句失败长这样（`tests/client-half.spec.ts` 顶上引用的真实事故原文）：
`failed to apply loader entry … (dsh-desktop-view): invalid plugin, expect function or object with an apply method, received object`。
今天它**没有**出现——这也是新测试断言的那句话（见 §5）。

### 1.2 宿主自己把插件的客户端半边组合进了启动图

`GET /` （先 `?token=` 换 cookie：量到的回答是 `303` + `Set-Cookie`）的 HTML 里
`dsh-desktop-view` 出现 **5 次**，其中启动图那一条的原文是：

```json
{"id":"dsh-desktop-view","url":"/plugins/??dsh-desktop-view/client.js&rev=9cb1afcdf8b28a08-48","rev":"9cb1afcdf8b28a08-48","inject":[],"immediately":true}
```

这个地址真的端得出来，端出来的是本插件的 bundle：

```
RAW client bundle: {"url":"/plugins/??dsh-desktop-view/client.js&rev=e83a5f7433fec926-48","status":200}
```

### 1.3 宿主自己的插件列表说它"运行中"

真 GUI（Playwright，无外壳）：**设置 → 插件 → 插件列表 → 搜索框输入 `desktop`**：

```
插件列表
搜索插件
会话插件   标准模式（默认）  由 Agent 预设按会话组成 · 0 个
全局插件   系统与所有会话共用 · 1 个
desktop-view   已启用   desktop-view
```

点开那一行：

```
desktop-view
include:desktop-view
完整名称   dsh-desktop-view
配置状态   已启用
运行状态   运行中
```

`运行状态 = 运行中` 是宿主自己的判断，不是本底稿的推断。

### 1.4 工具注册面：真宿主里**读不回来**（诚实条目）

`ctx.tools.register` 的结果在宿主里没有对外的列表口：GUI 的"插件列表"列的是**插件行**
（`desktop-view`、`agent-presets:tool-pwsh`…），不是工具名；要拿工具名得跑一个 agent 轮次
（要有凭据、要联网、要花钱），本票不做。

所以"工具注册齐全"这条读回的是**插件自己那一段**：真的 `apply()`、真的 `ctx.tools.register`、
真的执行——`tests/no-shell.spec.ts` 读到 20 条：

```
RAW registered tools (20): ["browser_navigate","browser_snapshot","browser_click","browser_type",
"browser_type_keys","browser_press_key","browser_hover","browser_select","browser_drag","browser_scroll",
"browser_wait","browser_extract","browser_evaluate","browser_json","browser_screenshot","browser_diagnostics",
"browser_upload","browser_dialog","browser_download","browser_space"]
```

**没能验证到的是**："这 20 条真的出现在宿主的 `ctx.tools` 里"。它由 §1.1–1.3 的三条间接支撑
（`inject: ['tools','attachments']` 若不被满足，loader 会响亮失败；插件行"运行中"；客户端半边被组合），
但不是直接读回的。

---

## 2. 验收二：那一格渲染的是什么 —— **今天真正的缺口**

### 2.1 走用户唯一能走的那条路

无外壳的真宿主里：右栏（`pI_x6G_rightbarCol`，`收起右侧边栏` 展开后 720px）→
guide 列出两个 capsule，其中一个是本插件的（**英文/中文都来自真 artifact**）：

```
工作区文件   浏览会话工作区的文件
浏览器       把侧边栏这一格交给原生浏览器视图
```

点「浏览器」，把那一格的 DOM 原样读回：

```json
{
  "panelCount": 1,
  "panelState": "detached",
  "panelText": "这一格需要桌面外壳才能显示浏览器。在普通浏览器标签页里它是空的。",
  "panelRect": { "x": 880, "y": 38, "w": 720, "h": 912 },
  "hasShellChannel": false,
  "panelRectHasShell": false,
  "noShellMessage": "This pane needs the desktop shell to show the browser. It is empty in a plain browser tab: run the shell, which hosts the native view.",
  "paneText": ""
}
```

整页 `innerText` 里那一格就是这一句：

```
浏览器
这一格需要桌面外壳才能显示浏览器。在普通浏览器标签页里它是空的。
```

**所以票面第二条的字面要求今天已经满足**——那一格不是空白，它说了"需要桌面外壳"。

### 2.2 缺口一：它没说**怎么办**

同一份 JSON 里有一个刺眼的对照：`noShellMessage`（`shell/panel-rect.js` 导出的
`NO_SHELL_MESSAGE`）**说的正是"怎么办"**（`run the shell, which hosts the native view`），
而**渲染出来的那一句不是它**。两句话各活在一边：

| 出处 | 文本 | 谁渲染 |
|---|---|---|
| `shell/panel-rect.js` `NO_SHELL_MESSAGE` | "…It is empty in a plain browser tab: **run the shell, which hosts the native view.**" | **没有人**（`grep NO_SHELL_MESSAGE` 只有定义与导出，没有调用点） |
| `src/client-body.js` `COPY.zh/en.noShell` | "…在普通浏览器标签页里它是空的。" | 面板（§2.1 读到的就是它） |

也就是说：**"怎么办"那句是死代码，活着的那句不含"怎么办"**，而且两者的措辞已经漂移。
一条产品判断：一个只陈述事实、不给出口的提示，是**稍微响一点的静默失效**——
用户知道这一格坏了，但不知道坏在哪、更不知道下一步做什么。

### 2.3 缺口二：**没有任何测试读过那一格的渲染文本**（静默失效本身）

`tests/panel-placement.spec.ts` 里那条 `renders an explicit notice instead of failing when there is no shell`
断言的是：

```js
expect(result).toEqual({ delivered: false, reason: 'no-shell' })
```

那是**管线**的回答（矩形有没有送到），不是**那一格显示了什么**。把
`src/client-body.js` 里两个 `noShell` 都改成空串、重新 `build`、跑整套 118 条用例——
**一条都不会红**（反证见 §6）。这正是本票要挡的东西。

### 2.4 面板的"没有外壳"条件是什么（读回，不是推断）

量自真宿主页面：`typeof window.__dshDesktopView === 'undefined'`、`DshPanelRect.hasShell() === false`、
`data-dsh-desktop-view-panel="detached"`。外壳的 `shell/preload.js` 只把矩形通道装进**窗口**那一页
（它自己的注释说明：视图那页拿到 `setRect` 就等于让任意网站挪自己的框），所以外壳的**原生视图页**
就是一个天然的"没有通道"的页面——新测试用的正是它。

---

## 3. 工具调用说什么 —— **已经是够清楚的那句话，不改**

真的 `apply()` 在没有 `DSH_DESKTOP_VIEW_CDP` 时注册出来的 20 条工具，逐条执行（按各自必填参数喂入参）：

- 19 条形如（原文）：

```
no desktop view endpoint: set the `cdpUrl` config option or run under the desktop shell, which exports DSH_DESKTOP_VIEW_CDP
```

- `browser_space` 是唯一一条**不走端点就能说清自己为什么不能干活**的（空间通道也不在）：

```
browser-view: browser_space has no shell to manage spaces in — this plugin was mounted without a
task-space channel (no desktop shell published one, and no `spacesDir` was configured), so there is
exactly one browser view and no way to create another. Only the shell can create a view: Playwright
cannot (ADR-0002).
```

两句话都点名了原因、也点名了出路。**按派工书"若错误已经够清楚，就不要改"，这一条不动**——
只把它变成可反证的断言（§5）。顺带量到一条测试写法上的坑：`defineTool` **先校验参数**，
缺必填项会先抛 `invalid arguments: missing required property "url"`，所以"没有端点时工具说什么"
必须喂够参数才问得出来。

---

## 4. 截图流残留 —— **没有可执行残留**

全仓库（含 `lib/`、`client.js`，不含 `node_modules`/`.git`）不区分大小写搜 `screencast|mjpeg|mjpg`：

```
CONTEXT.md:15,16
README.md:5,227,278
docs\adr\0001-native-view-over-screencast.md:8
docs\adr\0007-element-bounds-source.md:40
docs\research\electron-native-view-cdp-probe.md:66,87,88
tests\no-shell.spec.ts:484,486      ← 本次新增的断言与它的注释
total=12
```

其中落在**可执行路径**（`src/`、`shell/`、`scripts/`、`tests/`、`lib/`、`client.js`）里的，
只有本次新增的那条断言自己。再搜具体 API 名（`startScreencast|screencastFrame|ackScreencast|image/jpeg|toDataURL|capturePage|webm|videoFrame`）：

```
CONTEXT.md:16                      ← 术语表里那条"【已废弃】"的记录
tests/no-shell.spec.ts:484         ← 本次新增断言里的注释
```

**逐处判断**：

| 命中 | 性质 |
|---|---|
| `CONTEXT.md:15-16` | 术语表里被标为【已废弃】的词条，按派工书**不改** |
| `README.md:5,227,278` | 说明文字（"不是截图流"、`browser_screenshot` 走 Playwright 截图 API **没有** screencast、"被淘汰的东西"） |
| `docs/adr/0001` | 决策记录：为什么**不**采用画面流 |
| `docs/adr/0007:40` | 决策记录：本决定**不**引入 MJPEG/screencast |
| `docs/research/electron-native-view-cdp-probe.md:66,87,88` | 探针结论：全程无 screencast、可以砍掉 MJPEG 帧流 |

⇒ **没有可执行残留**。不做"为凑验收去改术语表"的事，改为加一条**能被反证**的断言：
工具注册表里不存在任何截图流名字的工具（§5）。

---

## 5. 修了什么（只修真正缺的那块）

| 文件 | 改动 |
|---|---|
| `src/client-body.js` | 面板 `COPY.zh/en.noShell` 补上"怎么办"：外壳是什么 + `npm run shell`。首句保持票面原文"这一格需要桌面外壳才能显示浏览器" / "needs the desktop shell" |
| `shell/panel-rect.js` | **删掉**死掉的 `NO_SHELL_MESSAGE`（无人渲染、措辞已与真正显示的那句漂移）；`hasShell` 的注释写明"文案归面板" |
| `client.js` | `npm run build` 重新生成（它由 `client-body.js` + `panel-rect.js` 拼出来，由测试保证不漂移） |
| `tests/no-shell.spec.ts` | 新增 7 条用例（真宿主 2 + 面板 2 + 注册面 3） |

新增用例覆盖：

1. 真 `dsh` 宿主（临时 `DSH_HOME` + 临时 profile，无 `DSH_DESKTOP_VIEW_*`）起得来、loader 没报错；
2. 宿主把本插件组合进启动图，并在 `/plugins/…` 上端得出它的 bundle；
3. 面板那一页**确实没有矩形通道**（前提先断言，不许嘴上说）；
4. 那一格**渲染出说明文字**：真 `client.js` → 真 `apply(ctx)` → 真 body 组件 → 真 DOM →
   读 `innerText`，中英各一次，断言非空、含"这一格需要桌面外壳"/"needs the desktop shell"、
   含 `npm run shell`、两种语言不是同一串；
5. 无外壳时 20 条 `browser_*` 工具全部注册；
6. **注册表里没有任何截图流名字的工具**（`/(screencast|mjpg|mjpeg|screen_?stream|frame_?stream|video_?frame)/i` 命中为空）；
7. 每条工具都给出点名原因的错误（19 条 `no desktop view endpoint…`，`browser_space` 自己的那句）。

### 反证（把修复回退掉，那条必须变红）

把 `COPY.zh/en.noShell` 改成空串、`node scripts/build-client.mjs` 重新生成 `client.js`，只跑面板那条：

```
RAW rendered panel (zh): {"language":"zh-CN","text":"","state":"detached","delivered":{"delivered":false,"reason":"no-shell"}}
RAW rendered panel (en): {"language":"en-US","text":"","state":"detached","delivered":{"delivered":false,"reason":"no-shell"}}
× renders the notice — in both languages, never an empty pane
AssertionError: zh-CN: the pane must not be blank: expected 0 to be greater than 20
```

又把文案换回**票前那一句**（不带 `npm run shell`）时也是红的：

```
AssertionError: expected '这一格需要桌面外壳才能显示浏览器。在普通浏览器标签页里它是空的。' to contain 'npm run shell'
```

即：**空白 → 红；回到票前的措辞 → 红**。修复不是"加了一句话"，是"补上了那句必须在这里的话"。

### 整包测试（连续三次，改动冻结之后）

```
RUN 2  Test Files  12 passed (12)   Tests  125 passed (125)   Duration 191.58s
RUN 3  Test Files  12 passed (12)   Tests  125 passed (125)   Duration 193.24s
RUN 4  Test Files  12 passed (12)   Tests  125 passed (125)   Duration 195.48s
```

票前是 11 文件 / 118 用例；现在是 12 / 125（多出 `tests/no-shell.spec.ts` 的 7 条），
`npm run build` 之后 `client.js` 与两个源文件同步（`client-half.spec.ts` 的 `--check` 守着这件事）。

---

## 6. 没能验证到的（诚实清单）

1. **宿主 `ctx.tools` 里的工具清单**读不回来（§1.4）。"无外壳时工具注册齐全"读回的是插件自己的
   `apply()` + `ctx.tools.register`，不是宿主的注册表本体。要读后者需要一个 agent 轮次
   （凭据 + 网络 + 花费），本票不做。
2. **真宿主 GUI 的那一格截图证据是手工量的**（§2.1，Playwright 驱动 + 原始 JSON/文本已留档），
   自动化的那一条走的是同一个 artifact、同一个组件、真 DOM，但**不是**同一个宿主页面。
   `tests/no-shell.spec.ts` 里的真宿主那两条只读 HTTP 面（启动图 + bundle），没有驱动 GUI——
   驱动 GUI 要过"内测声明 → API Key → 选工作区 → 展开右栏"四道，且依赖 `dsh` 的 UI 文案，
   作为回归测试太脆。
3. **没有验证 React 的协调语义**：面板测试里 `require('react')` 是一个只回答
   `useRef/useState/useMemo/useEffect/createElement` 的最小替身（本仓库没有 React 依赖），
   `createElement` 直接建真 DOM 节点。被渲染的组件、`DshPanelRect`、DOM 都是真的，
   hook 的调度不是。真 React 下的渲染由 `tests/client-half.spec.ts`（宿主真的加载这个 artifact）
   与 §2.1 的真宿主观察共同兜。
4. **真宿主那两条用例要求 PATH 上有 `dsh`**（或 `DSH_BIN` 指向
   `@deepseek-ai/dsh/lib/bin.js`）。这是本仓库第一次引入对 `dsh` 启动器的测试依赖：
   没有它，验收一就只能靠读代码——那正是本票要消灭的东西。找不到时用例**明确失败**并说明原因，
   不静默跳过。
5. **`dsh` 的启动/授权细节是有版本的**：`?token=` 换 cookie 量到的是 `303` + `Set-Cookie`
   （Node 的 `fetch` 没有 cookie 罐，必须显式走两步）。宿主换授权方式时这条要跟着改。
6. **临时 profile 目录的清理**：`removeWhenFree` 是"尽力删"，被占住时会往 stderr 写一行警告
   而不是让用例变红（这是本仓库既有的约定）。启动失败时的目录外泄已补上（`bootRealHost` 的
   失败路径也 `removeWhenFree`），手工那几轮临时 home 与临时工作区已确认删净。
