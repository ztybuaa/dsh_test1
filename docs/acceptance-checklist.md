# 验收清单 —— 桌面外壳里的「浏览器」标签页

这份清单是给**你**（用户）用的：每一条都写清「**做什么 → 应该看到什么**」，并且标出**是谁验的**。
它对应 PRD（票 #1）里的用户故事，以及票 #12 的三条验收。

**记号**

| 记号 | 含义 |
|---|---|
| ✅ | **已经自动化验过**：`npm test` 里有一条用例真的读回了这件事（给出文件与用例名） |
| 🔬 | **实现者亲手实测过**：原始输出留档在 `docs/research/`，给出哪一份、哪一节 |
| 👤 | **必须你本人验**：要真人看屏幕 / 要和 Agent 对话 / 要用你自己的登录账号 |
| ⛔ | **本期不做**：别去找它，找不到是设计如此 |

> **没验过的不会写成"已验证"。** 下面凡是只有 👤 的条目，就是**今天还没有证据**的条目；
> §9 那三条是"本项目至今一次真实证据都没有"的，请务必自己走一遍。

**跑之前需要什么**

- Windows + 已 `npm install`（含 Electron），`dsh` 启动器在 PATH 上（或用 `DSH_BIN` 指到
  `@deepseek-ai/dsh/lib/bin.js`）。
- 本插件装在 **`dshviewer`** 这个 profile 里（`npm run shell` 默认就用它）。
  **不要**用 `dsh web` —— 那是 `--profile web` 的硬编码别名，插件不在那里：
  界面看起来完全正常，但没有那一格、也不报错。
- 这份清单里的 `npm run shell` 会用到你**自己的** `~/.dsh`（这是产品路径，登录态就在那里）。
  想拿一份干净的档案试，先 `$env:DSH_HOME = <临时目录>` 再起。

---

## 1. 起外壳：一条命令（票 #12 验收 1）

```pwsh
npm run shell
```

| 做什么 | 应该看到什么 | 谁验的 |
|---|---|---|
| 在仓库根敲 `npm run shell` | 一个窗口打开，里面是 **DSH 的界面**（不是内置夹具页）；右侧边栏有「+」 | ✅ `tests/acceptance.spec.ts` › *外壳自己拉起了 DSH：界面读得回，插件在启动图里，bundle 端得出来*（`?token=` 换 cookie → `GET /` = 200，启动图里有 `dsh-desktop-view`，`/plugins/??dsh-desktop-view/client.js` 端得出 200）**以及** › *外壳的窗口里装的确实是 DSH 的界面，不是内置夹具页*（连到外壳窗口自己那一页读回 `location.href`/`document.title` = `DeepSeek Harness`，且 origin 是 DSH 的）<br>🔬 `docs/research/t12-…md` §3 |
| 看敲命令的那个终端 | 出现 `DSH_SHELL DSH_ARGV {"command":"dsh","argv":["--profile","dshviewer","--no-open","--port","0"]}`，随后 `DSH_SHELL DSH_URL {"url":"http://127.0.0.1:<端口>/?token=…"}` | ✅ 同上（`argv` 与真进程表两条独立读回） |
| **不抢端口**：把这条命令**再敲一次**（两个外壳同时在跑） | 两个窗口都是 DSH 界面、都能用；两个终端里的端口**不一样**；先起的那个不会被挤掉 | ✅ `tests/acceptance.spec.ts` › *两个 DSH 同时活着，各自的界面都读得回，端口一个都不撞*（六个端口两两不同：两个 DSH、两个 CDP、两个夹具站点）<br>🔬 原始端口表见 §4.1；**共用同一个档案目录**的那一轮（连敲两次的真实形状）见 §4.3：两个都能用，但第二个外壳的 stderr 会刷 `Unable to move the cache: 拒绝访问` / `Unable to create cache` —— 所以**要同时开两个，给每个外壳一个自己的 `--user-data-dir`**（见下） |
| **不打开系统默认浏览器** | 你的浏览器**没有**自己弹出新窗口/新标签；DSH 的地址是给"你自己想看的时候手动开"的 | ✅ 部分：真 argv 里有 `--no-open`（DSH 的定义是 *do not open the Web UI in the default browser*），DSH 那句"要开浏览器了"（`dsh web: opening the default browser; pass --no-open to disable`）在外壳输出里**一次都没出现**，进程树里也没有任何浏览器进程<br>👤 **但"我这儿没蹦出窗口"只有你看得见** —— 这一步请你自己确认（这是本条唯一的真实证据） |

> 只想看内置夹具页（不起 DSH、不碰你的档案）时用 `npm run shell:fixture`。
> **要同时开两个外壳**时，给第二个一个自己的档案目录：
> `npm run shell -- --user-data-dir $env:TEMP\dsh-shell-2`（共用默认目录"能用"，但第二个的磁盘缓存会报错，见 §4.3）。

---

## 2. 视图跟随：那一格就是浏览器，而且只占这一格（PRD 故事 1–5）

前置：外壳起着，在右侧边栏 **「+」（新标签页）** → guide 页里点 **「浏览器」** 胶囊
（副标题「把侧边栏这一格交给原生浏览器视图」）。

| 做什么 | 应该看到什么 | 谁验的 |
|---|---|---|
| 点「浏览器」之后看那一格 | 那一格里是**真正的浏览器页面**（能选中文字、能右键、能用输入法），**不是截图、不是 iframe** | ✅ 部分：那一格是原生 `WebContentsView`，按 CDP **身份**（不是 URL、不是类型）被领养，且它的布局尺寸 = 面板矩形 —— `tests/adopt-view.spec.ts` › *publishes the view by identity…* / *adopts exactly the published view and nothing else*；`tests/panel-placement.spec.ts` › *cross-checks the shell rectangle against the view's own layout size*<br>👤 **"能选中/右键/输入法"要你自己试**（故事 30，见 §7） |
| **拖动分栏**（把侧边栏拖宽/拖窄） | 那一格跟着变宽/变窄，页面按新宽度重排 | ✅ `tests/panel-placement.spec.ts` › *reports the panel rectangle and moves the view onto it*、*tracks a panel that changes size, and keeps the view inside the window* |
| **缩放窗口**（拖窗口边角，甚至缩到比面板还窄） | 视图跟着变，**绝不画到窗口外面去** | ✅ 同上（*keeps the view inside the window*：外壳逐个摆放读回，越界的可见摆放为空） |
| **折叠侧边栏**（或切到别的标签页） | 那一格里的浏览器**消失**；不留一个看不见却还在跑的东西 | ✅ `tests/panel-placement.spec.ts` › *hides the view when the panel reports no rectangle, and shows it again*（`appliedVisible` 是 Electron 读回的实际可见性，不是外壳的意图） |
| 再**展开**侧边栏 | 那块浏览器**回到同一个矩形**，没有被挪走、也没被销毁 | ✅ 同上（隐藏是**可见性变化**，不是缩成 0：`applied` 读回的矩形原样保留） |
| 同上，再确认**页面还是原来那一页**（不是被重开成空白页） | 地址栏/页面内容与折叠前一致 | 👤 这条只有"矩形与可见性"被自动化；**"内容还是原来那一页"请你自己看一眼**。顺带说明：今天**没有**"把这一格重置回初始页"的动作 —— 那是 [#13](https://github.com/ztybuaa/dsh_test1/issues/13) 里的"重新开始"按钮 |
| 把标签**浮动/停靠**（侧边栏自己的布局能力） | 那一格跟着浮动面板走，不越界 | 👤 **没有自动化**（真 DSH 的浮动/停靠没测过） |

---

## 3. Agent 全功能驱动（PRD 故事 6–21）

对 Agent 说一句能触发对应动作的话，然后看**页面真的变了**（不是"Agent 说它点了"）：

| 能力 | 对 Agent 说什么 → 应该看到什么 | 谁验的 |
|---|---|---|
| 导航 | 「打开 https://example.com」→ 那一格真的到了那个站点，Agent 拿到标题与最终地址 | ✅ `tests/adopt-view.spec.ts` › *navigates the native view*、*drives the same view through the browser_navigate tool* |
| 快照 | 「看看这一页有哪些能点的东西」→ 拿到标题、地址、带编号（`ref`）的可交互元素列表 | ✅ `tests/snapshot.spec.ts` › *lists the interactive elements, each with a ref and real bounds* |
| 元素带位置尺寸 | 快照里每个元素有 `bounds`（x/y/宽/高，视口 CSS 像素） | ✅ `tests/snapshot.spec.ts` › *reports bounds that match the page's own geometry, and that hit-test to the element*（与页面自己的 `getBoundingClientRect()` 逐项相同，且中心点命中该元素） |
| 点击 / 输入 / 填表 / 按键 / 悬停 / 下拉 / 拖拽 / 滚动 | 「点那个按钮」「在搜索框里输入 X 并回车」「把 A 拖到 B」→ 页面按它自己的逻辑变化 | ✅ `tests/interaction.spec.ts` 的 8 条（点击改 DOM、填表后 `value` 真是那个值、Enter 真提交、悬停后才出现的东西真出现、下拉选中值、拖拽后顺序与几何都变、滚动到元素用页面自己的几何验证） |
| 等待 | 「等那个转圈的东西消失」→ 固定时长 / 等选择器 / 等文字三种都能用 | ✅ `tests/interaction.spec.ts` › *waits a fixed duration…*、*waits for a selector that appears later, and for text that appears later* |
| 对话框 | 触发 `alert` / `confirm` / `prompt` → **不卡死**，按策略回答，答复内容读得到 | ✅ `tests/longtail.spec.ts` › *验收一：对话框不卡住 Agent，拒绝/接受都生效，文本读得到*（含 `beforeunload` 那个坑） |
| 上传 | 「把 D:\x.pdf 交给页面上的上传按钮」→ 文件真的进了 file input | ✅ `tests/longtail.spec.ts` › *验收二：藏起来的 file input 由可见 label 走 ref 点击 + file chooser 交进去* |
| 下载 | 「点那个下载链接」→ 文件真的落盘，Agent 拿到**落盘位置**与内容预览 | ✅ `tests/longtail.spec.ts` › *验收三：下载真的落盘，落盘位置与内容预览都是真的* |
| iframe | 「点框架里那个按钮」→ 框架内元素也在快照里（带"它在哪个框架"），动作真的落在框架里 | ✅ `tests/longtail.spec.ts` › *验收四：同源与跨源框架里的元素都在快照里…*、*动作真的落在框架里的元素上…* |
| 失败原因可诊断 | 让它点一个不存在/被挡住/看不见的元素 → 错误分得清四类（超时 / 被遮挡 / 不可见 / 不存在），并说清是什么挡住了 | ✅ `tests/interaction.spec.ts` › *keeps the four failure reasons apart* 及三条单独的拒绝用例 |
| **后退 / 前进 / 刷新** | —— | ❌ **今天没有这三个能力**：`browser_navigate` 只有 `url` 一个参数（见 §11）。要"刷新"就让它再打开同一个网址 |

---

## 4. Agent 读懂那一格（PRD 故事 10–14、19）

| 能力 | 对 Agent 说什么 → 应该看到什么 | 谁验的 |
|---|---|---|
| 读正文 | 「把这一页的文字读出来」→ 与页面渲染出来的 `innerText` **逐字一致**；超上限会截断并明说 | ✅ `tests/observation.spec.ts` › *reads the page's text exactly as the page renders it, and cuts it at the cap* |
| 只读表达式 | 「页面上那个计数器的值是多少」→ 拿得到只有 JS 知道的值 | ✅ `tests/observation.spec.ts` › *evaluates an expression in the page and reads a value only the page knows* |
| 接口数据 | 「这个列表的数据来自哪个接口，内容是什么」→ 拿到页面**实收**的那份 JSON（4xx/5xx 不算数据） | ✅ `tests/observation.spec.ts` › *reads the JSON the page fetched, and it is the payload the page itself received* |
| 控制台与失败请求 | 「这一页为什么是空的」→ 拿到页面自己的报错与失败请求（方法、URL、状态码、响应摘要） | ✅ `tests/observation.spec.ts` › *reads the console errors and the failed requests the page really produced* |
| 截图作为附件 | 「截个图给我看看」→ **对话里出现一张图片**（不是一行路径） | ✅ 到"送进附件 store"为止：`tests/observation.spec.ts` › *delivers the screenshot as an image attachment of this view, at the viewport size*；**并且**在真宿主里用**部署自己的**附件 store 存进又读回（13999 字节、PNG 魔数、内容寻址引用）—— `tests/acceptance.spec.ts` › *截图交给的是真实附件 store…*<br>👤 **"模型真的看见了这张图"必须你和 Agent 对话来验**（§9.2） |
| 截图**落在哪**（Agent 不给路径时） | 不给路径就截图 → 文件落在外壳**档案目录下的 `screenshots\`**，**不是**你敲命令的那个目录（以前是仓库根，会混进 `git status`） | ✅ `tests/screenshot-dir.spec.ts` › *前提：宿主自己的 cwd 就是那个临时目录，而它整轮一个文件都没多*、*截图落在外壳档案目录下的 screenshots，而不是 cwd，也不是本仓库*（把外壳的 cwd 指到一个临时目录起真外壳 + 真宿主，调一次**不带 `path`** 的 `browser_screenshot`，再分行读回）<br>🔬 原始输出、兜底与反证见 [`docs/research/t16-screenshot-default-dir.md`](research/t16-screenshot-default-dir.md) |

---

## 5. 登录态与浏览器身份（PRD 故事 22–25）

| 做什么 | 应该看到什么 | 谁验的 |
|---|---|---|
| 在那一格里**手动登录**一个站点（用你自己的账号），然后**关掉窗口**再 `npm run shell` | 还是登录状态 | ✅ 自动化那半条：`tests/identity.spec.ts` › *持久 cookie 与 localStorage 活过重启，会话 cookie 与 sessionStorage 不活*（用真档案目录、优雅关窗）<br>👤 用**你自己的账号**真的登一次 —— 这条只有你能验 |
| 看那一格的档案目录 | 是它**自己的**持久档案（`persist:dsh-view`），与外壳界面那个罐子互不可见 | ✅ `tests/identity.spec.ts` › *这一格的档案与 DSH 界面的不是同一个：同源前提下互相看不见* |
| 让 Agent 或你自己查页面身份 | UA 里没有 Electron 的产品标记；`navigator.webdriver` 为 `false`；没有 `--enable-automation` | ✅ `tests/identity.spec.ts` › *UA 里没有 Electron 的产品标记…*、*navigator.webdriver 为假…*、*没有 --enable-automation…* |
| 登录一个对自动化敏感的站点 | 不被"你是自动化浏览器"挡在门外、不要求额外验证 | 👤 这条**只有真账号能验**（上面三条是它的必要条件，不是充分条件） |
| 回环地址与代理 | 本地 `127.0.0.1` / `localhost` / `[::1]` **不走代理**；外网站点继承你的系统代理 | ✅ `tests/identity.spec.ts` › *外壳读回：外网走这个代理，三个回环写法一律 DIRECT*、*回环页面照常打开，外网请求真的到了代理，而代理没收到任何回环请求* |

---

## 6. 任务空间隔离（PRD 故事 26–29）

任务空间 = 一块自己的原生视图 + 自己的持久 partition。用 `browser_space` 这**一个**工具管：
`action: "list" | "create"（带 name）| "use" | "close"`。

| 对 Agent 说什么 | 应该看到什么 | 谁验的 |
|---|---|---|
| 「开一个新的任务空间，叫 task-1」 | 真的多出一块视图（自己的 partition、自己的 CDP 目标），当前空间切到它 | ✅ `tests/spaces.spec.ts` › *创建：真的多出一块视图，它有自己的 partition、自己的目标，而且能被单独领养* |
| 在两个空间里**各自登录同一个站点** | 两边登录态互不影响（cookie 与 localStorage 都隔离） | ✅ `tests/spaces.spec.ts` › *验收 2：两个空间在同一站点各自登录，互相看不见（先证明同源）* |
| 新建空间后直接打开站点 | 新空间**继承默认档案的登录态**（不必重新登录） | ✅ `tests/spaces.spec.ts` › *验收 3：新空间继承默认档案的登录态…*<br>⚠️ 已知边界：**localStorage 只继承新空间落脚的那个 origin**（cookie 全量），事实与原因见 ADR-0010 §3 |
| 「切到 task-1 / 切回默认空间」 | 那一格换成对应空间的视图，同一时刻**只有一个空间是当前的** | ✅ `tests/spaces.spec.ts` › *使用：切换空间换掉的是填那一格矩形的那块视图…* |
| 「关掉 task-1」 | 页面**立刻**消失（按 targetId 再也领养不到）、存储数据**立刻**被抹掉；磁盘目录下次启动才删（Windows 文件锁），重启后真的没了 | ✅ `tests/spaces.spec.ts` › *关闭：页面从端点消失…*、*重启同一个档案目录：被记下的目录真的被删掉，默认空间的档案原封不动* |
| 在一个空间里让 Agent 操作 | **另一个空间一步都没动**（所有 `browser_*` 只作用于当前空间） | ✅ `tests/spaces.spec.ts` › *验收 4：所有工具只作用于当前空间（另一个空间一步都没动）* |
| 外壳没起来时问空间 | 工具给一个**说得清的超时错误**，而不是含糊地等 | ✅ `tests/spaces.spec.ts` › *外壳不在时，工具拿到的是一个说得清的超时错误…* |

---

## 7. 人机共驾：你做你的，它做它的（PRD 故事 30–33）

| 做什么 | 应该看到什么 | 谁验的 |
|---|---|---|
| 你自己在那一格里直接用鼠标键盘：选中、复制、右键、输入法 | 就是一个普通浏览器的行为（因为它就是浏览器，不是画面） | 👤 **没有自动化**。构造上它是原生 `WebContentsView`（✅ 见 §2 第一行），但输入法没人真的试过 |
| **缩放**（Ctrl+滚轮 / 缩放按钮） | —— | ❌ 今天**没有任何缩放手段**（PRD 故事 30 要求），跟踪在 [#13](https://github.com/ztybuaa/dsh_test1/issues/13) |
| Agent 操作时你**同时**操作那一格 | 两边**都能动**，不需要任何开关 | ⛔ **人机仲裁不在本期范围内**：PRD 明确不做"接管/交还"、不做"Agent 正在执行请勿操作"。**界面上没有这类开关，这是设计如此，不是你漏看了**（原 PRD 已否决） |
| 让 Agent 点一下某个按钮，**盯着那一格看** | 页面上出现可见的**光标与涟漪**，你能看到它点了哪 | ✅ `tests/overlay.spec.ts` › *验收一：点击时页面上出现可见光标与涟漪*（像素差也是真的：332 个像素变了） |
| 让 Agent 读一次页面 | 出现一圈**读取提示** | ✅ `tests/overlay.spec.ts` › *验收二：读页面时有可见提示* |
| 让 Agent 导航到别的页面，再看 | 提示层**自动重新挂上**，不会因为换页就没了 | ✅ `tests/overlay.spec.ts` › *验收三：真实导航之后覆盖层自动重挂…* |
| 看 Agent 自己截的图 | 图里**没有**那些提示（提示层不能污染证据） | ✅ `tests/overlay.spec.ts` › *坑四：静止时对像素是零，T5 的三条断言原样成立，Agent 自己截的图里没有覆盖层* |

---

## 8. 配置与可用性（PRD 故事 34–37）

| 做什么 | 应该看到什么 | 谁验的 |
|---|---|---|
| 什么都不配，直接 `npm run shell` | 能起来、能登录、Agent 能用（默认值就够） | ✅ `tests/acceptance.spec.ts` › *外壳自己拉起了 DSH…*（全程零配置，只用了临时 `DSH_HOME`/`--user-data-dir` 做隔离） |
| 在**普通浏览器**里用 `dsh web`（没有桌面外壳） | 插件**照常装载、不报错**；那一格显示说明文字（"这一格需要桌面外壳才能显示浏览器" + 怎么办：`npm run shell`），而不是空白或崩掉 | ✅ `tests/no-shell.spec.ts` › *boots a real host with no loader error…*、*renders the notice — in both languages, never an empty pane*（真 `dsh` 宿主、真 `client.js`、真 DOM、读 `innerText`） |
| 同一个插件在两种宿主下 | 只有**一处载体差异**，不是两套代码 | ✅ `tests/client-half.spec.ts`（宿主加载的就是那份 `client.js`）+ ADR-0003；本票又证了桌面外壳这一侧的启动图里挂的是**同一份** artifact |
| 测试不依赖图形界面 | —— | ❌ **没有验证过**：本套件起的是真 Electron 真窗口，没有任何 headless 跑法被试过（诚实缺口） |

---

## 9. 三条"从来没有真实证据"的，请你本人验 ⚠️

这三条是本项目**至今一次真实证据都没有**的。能自动化的部分本次已经自动化（下面写清了到哪一步），
**剩下的那一步只有你能做**。

### 9.1 插件在**有外壳的**真宿主里挂得上 —— 已经被自动化了，请你再看一眼 GUI

- ✅ **已自动化**：外壳起着的时候，真宿主的启动图里有本插件、`/plugins/??dsh-desktop-view/client.js`
  端得出 200；**宿主 `ctx.tools` 注册表本体里确实有那 20 条 `browser_*`**（从一个只读探针插件里
  用 `ctx.tools.schemas()` 读回，不是"插件自己说它注册了"）。
  证据：`tests/acceptance.spec.ts` › *探针拿到的是外壳交给载体的那份身份，而且壳里的工具注册表本体有这些工具*；
  原始输出见 `docs/research/t12-…md` §6.1。
- 👤 **请你再看一眼**（自动化读的是 HTTP 与注册表，不是 GUI）：
  1. `npm run shell`；
  2. 右侧边栏「+」→ guide 页 → 点「浏览器」；
  3. **设置 → 插件** 里搜 `desktop`，那一行应该是**已启用 / 运行中**；
  4. 那一格里应该出现真的浏览器视图（能选中文字）。

### 9.2 截图真的送到了模型面前 —— 到 store 为止已自动化，最后一步要你和 Agent 对话

- ✅ **已自动化**：在真宿主里经注册表执行 `browser_screenshot`，模型面 `content` 里出现
  `{"type":"image","attachment":{…}}`；再用 `ctx.attachments.readImage()` 把图片**读回来**
  （13999 字节、PNG 魔数、内容寻址引用一致）。**这是真实 `LocalAttachmentStore` 的第一次运行**——
  T5 那次用的是一枚测试替身。证据：`tests/acceptance.spec.ts` › *截图交给的是真实附件 store…*。
- 👤 **请你自己验最后一步**（模型是否真的"看见"，要一次真的 agent 轮次）：
  1. `npm run shell`，打开「浏览器」那一格，让它停在一个**看得见内容**的页面（比如打开一个新闻站）；
  2. 对 Agent 说：**「用 browser_screenshot 截一张这个页面的图，然后告诉我图里最显眼的是什么」**；
  3. **应该看到**：对话里出现**一张图片**（不是一行路径），而且 Agent 对图里内容的描述**与页面实际内容相符**
     （它要是只复述路径、或者描述得像没看过图，就是没送到）。

### 9.3 真实 Agent 真的能调工具驱动那一格 —— 到"同一条管线"已自动化，最后一步要你和 Agent 对话

- ✅ **已自动化**：在真宿主里走 `ctx.tools.execute()`（注册表自己的完整管线：参数快照 → policy →
  dispatch → 结果归一化，与模型调用同一条路），快照 → 点击 → 再读正文，页面真的从
  `initial-view` 变成 `clicked-view`。证据：`tests/acceptance.spec.ts` › *经宿主注册表执行：快照、点击真的改了那一格的页面*。
  **差的那一步只有一个模型。**
- 👤 **请你自己验**：
  1. `npm run shell`，打开「浏览器」那一格，对 Agent 说：
     **「把这一格导航到 https://example.com，然后截个图，再告诉我页面上那个 More information 链接的编号是多少」**；
  2. **应该看到**：那一格**真的**跳到了那个站点；Agent **先**用 `browser_navigate`、**再**用 `browser_screenshot`
     与 `browser_snapshot`（工具调用会显示在对话里）；它报出的 `ref` 编号来自它自己那次快照，
     并且能用 `browser_click` 点中那个链接；
  3. 反证：如果你在页面上手点一下、Agent 却毫无反应地继续用旧 `ref`，那说明真实会话里
     快照/ref 的时序有问题 —— **这种情况请直接报出来**。

---

## 10. 本期不做（别去找它们，找不到是设计如此）

| 不做的 | 说明 |
|---|---|
| **人机仲裁**：接管/交还、"Agent 正在执行请勿操作" | 原 PRD 已否决。设计与理由：面板那一格就是浏览器本身，人和 Agent 可以同时操作，**不需要状态机**（PRD「人机共驾」故事 31 的原文就是"不需要接管/交还这种开关"） |
| **多标签** | 本期"一格 = 一个页面"。`browser_space` 是**任务空间**（各自隔离的登录态），不是标签条 |
| **旧截图流** | screencast / MJPEG / 输入转发 / 视口同步 / 面板内坐标换算，整条管线已废弃（ADR-0001）；注册表里也没有任何截图流名字的工具（`tests/no-shell.spec.ts` 断言） |
| fork 官方桌面版 / 同源反向代理 iframe / 视频后端（FFmpeg） | PRD 明列为 Out of Scope |

---

## 11. PRD 已要求、但**本期尚未实现**的能力（跟踪在 [#13](https://github.com/ztybuaa/dsh_test1/issues/13)）

这一节**不是"本期不做"**，也不是要你去找一个意外缺口：它们是 PRD 里写明的故事，本期只做到一部分，
**已经有票跟着**（#13「导航与缩放：PRD 故事 6/30 明确要求却漏做的能力」）。

| 能力 | 今天 | PRD 依据 |
|---|---|---|
| **后退 / 前进 / 刷新** | 没有：`browser_navigate` 只有 `url` 一个参数，`src/session.ts` 里也没有 `goBack` / `goForward` / `reload` | 故事 6「导航：打开网址、**后退、前进、刷新**」 |
| **缩放** | 没有：没有任何设定缩放（含重置）的手段 | 故事 30「像用任何浏览器一样……**缩放**」 |
| 那一格上的**工具条**（后退/前进/刷新/缩放按钮）与"重新开始" | 没有 | #13 的面板那一半（按钮要驱动同一套会话能力，所以与上面两条同一张票） |

**能绕的地方**：想让 Agent"刷新"就让它再打开同一个网址；想回上一页就直接导航到那个网址。
**但这三行不能在清单里打勾** —— 今天真的不存在。想跟进就 `gh issue view 13 --repo ztybuaa/dsh_test1`。

---

## 12. 自动化证据在哪、怎么重跑

```pwsh
npm test                                   # 全部 13 个 spec 文件、135 条用例
npm test -- tests/acceptance.spec.ts       # 只看本票新增的 10 条（约 40 秒，会起 4 个真 dsh 宿主）
npm test -- tests/panel-placement.spec.ts  # 只看"视图跟随"
```

| 想要什么证据 | 看哪个文件 |
|---|---|
| 一条命令 / 端口 / 宿主注册表 / 附件 store | `tests/acceptance.spec.ts` |
| 视图跟随（面板矩形 → 视图摆放） | `tests/panel-placement.spec.ts` |
| 领养那块视图（身份，不是 URL） | `tests/adopt-view.spec.ts` |
| 快照、ref、bounds | `tests/snapshot.spec.ts` |
| 动作与四类失败原因 | `tests/interaction.spec.ts` |
| 读页面（正文/表达式/接口/截图/控制台） | `tests/observation.spec.ts` |
| 登录态、UA、webdriver、代理 | `tests/identity.spec.ts` |
| 任务空间隔离 | `tests/spaces.spec.ts` |
| 对话框、上传、下载、iframe | `tests/longtail.spec.ts` |
| 光标覆盖层 | `tests/overlay.spec.ts` |
| 截图默认落在哪（不给路径时） | `tests/screenshot-dir.spec.ts` |
| 没有外壳时的行为（面板文案、工具回答） | `tests/no-shell.spec.ts` |
| 客户端半边（tab 类型、guide 入口） | `tests/client-half.spec.ts` |
| 本清单背后的原始测量 | `docs/research/t12-one-command-and-the-three-first-evidence.md` |
