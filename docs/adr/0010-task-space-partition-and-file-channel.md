# 0010 — 任务空间 = 一个 partition，不是浏览器上下文；开关走外壳侧的文件通道

**状态**：已接受
**日期**：2026-09-15
**依据**：`docs/research/task-space-isolation.md`（全部原始测量）、票 #8、ADR-0002、ADR-0009

## 决定

### 0. 先记一条独立的事实：Electron 里没有 CDP browser context

票 #8 的原话是"每任务一个**独立浏览器上下文**"。开工第一步就是量它，结果是**按字面做不到**：

| 命令 | Electron 44.3.0 的回答 |
|---|---|
| `Target.getBrowserContexts` | `{"browserContextIds":[],"defaultBrowserContextId":"…"}` |
| `Target.createBrowserContext` | `Failed to create browser context.` |
| `Target.createTarget` | `Not supported`（复现 ADR-0002 的另一半） |

⇒ `browser.newContext()` 与 `browser.newPage()` **都不可用**；**Electron 的所有 partition 都挤在同一个
CDP browser context 里**。Chromium 的 "browser context" 在这个宿主上不是一个可创建的隔离单位 ——
可创建的隔离单位是 **partition（session）**。

这不是"绕过票面"：票 #8 的票面评论已经先授权了这条等价物（"不能伪造，改用 Electron 侧的等价物 ——
每个空间一个独立 partition；外壳为每个空间准备一块视图并在握手里发布各自的 targetId"），
本条只是把**为什么必须这样**钉成一条可引用的事实。**不得**在任何地方声称本实现提供了
"独立的浏览器上下文"。

### 1. 空间 = 一个 partition + 一块自己的视图

- 一个任务空间 = **一个 `persist:` partition** + **一块 `WebContentsView`**（这块视图就是它的页面）。
- **默认空间原样保留 T6 的 `persist:dsh-view`**，一个字都不改、**不做任何迁移**：
  用户可能已经在那个档案里登录过了，为命名整齐而重命名 = 把用户的登录态弄丢。
- 新空间用同一命名家族：`persist:dsh-view-space-<名字>`。
- 所有空间的视图**同时存在**（各自持有自己的页面与 partition），**只有当前空间那块可见**
  （其余 `setVisible(false)`，T2 已有的模式）。切换空间 = **换掉占据那一格矩形的那块视图**，
  **不做标签条**（票面 Out of Scope：一格 = 一个页面）。
- 视图**必须真的导航过**才交给插件：实测一个从未 `loadURL` 的 webContents 会对
  `Page.getFrameTree` 永不回答，Playwright 的 `connectOverCDP` 会整个挂住。

### 2. 开关走外壳侧的文件通道（声明式、带请求 id）

`Target.createTarget` 不可用 ⇒ 视图只能由外壳创建 ⇒ "创建/关闭空间"必须有一条**插件 → 外壳**的通路。
ADR-0003 明令外壳**不开任何监听端口**，而 `--placement-file` 已经是"文件作为缝"的同向先例，
所以这条通路是**两个文件**：

- `<userDataDir>/spaces/request.json` —— 插件写的**期望状态**：`{id, active, spaces:[名字…]}`；
- `<userDataDir>/spaces/state.json` —— 外壳写的**实际状态**：`{requestId, spaces:[…], active}`。

三条硬要求（都是为了让工具调用**确定**，而不是"写完了等运气"）：

1. **单调递增的请求 id**：插件写 request（带 `id`），外壳处理到哪个 id 就把哪个 id 写进 state；
   工具调用**阻塞等待 state 报告该 id 已处理**，超时即**明确的错误**（而不是模糊的"等不到"）。
2. **原子写**：临时文件 + rename，任何一侧都不会读到半个 JSON。
3. **state 里的每个值都从 Electron 读回**（`partition` / `storagePath` / `targetId` / `url` / `visible`），
   照 T6 握手 `browserIdentity` 的先例；**目录从握手里的 `userDataDir` 推导**，不另立位置。
   写"我们打算创建什么"不算证据。

页面那半边（`preload.js`）**不参与**这件事：它的边界写着"除了矩形什么都不从这里过，
驱动视图留在插件侧（ADR-0002/0003）"，而且它只在 `--rect-channel` 打开时注入。
命令以**文件**形式过境，页面那半边永远只搬矩形。

### 3. 继承登录态：cookie 全量复制，localStorage 只覆盖"新空间真的访问到的 origin"

| 形态 | 能不能继承 | 代价 |
|---|---|---|
| **cookie**（会话 + 持久，任意 origin） | **能**，全量 | `cookies.get({})` + `cookies.set({...,url})`；**`set` 必须带 `url`**，只给 domain 会抛 `Missing required option 'url'` |
| **localStorage / sessionStorage** | **只能**继承新空间**真的访问到的那个 origin** | 必须让新空间的视图导航到那个 origin，再逐条写 |
| **其它 origin 的 localStorage** | **不能** | 没有任何 API 能枚举"哪些 origin 有 localStorage"（session 侧无 API；CDP 的 `DOMStorage` 必须先有那个 origin 的 frame，给 foreign origin 写会被 `Frame not found for the given storage id` 拒绝） |

**不去造"按 origin 枚举 + 逐个搬运"的英雄方案**：枚举手段不存在，硬造就是把不可靠的东西
伪装成可靠。**能力边界写在上面这张表里，也写进事实文档**；读这份 ADR 的人不该以为
"新空间继承登录态"是无限的。

### 4. 关闭空间：页面立即释放；存储数据抹掉；**目录下次启动清理**（真的实现，不是承诺）

三条事实分开记，因为它们**不是同一件事**（实测见事实文档第 4 节）：

| 问题 | 答案 |
|---|---|
| 页面释放了吗？ | **是**，立即：`removeChildView` + `webContents.close()` 后目标从 `/json/list` 消失 |
| 存储数据抹掉了吗？ | **是**：`clearStorageData()` 后同 partition 的新页面读不到任何旧 cookie/localStorage |
| 磁盘目录立即消失了吗？ | **否**：进程存活期间 `rmSync` 一律 EPERM（Windows 文件锁，15 个子项里 11 个被锁），`clearCache()` 也解不开 |

所以关闭空间 = 关视图 + `clearStorageData()` + 把该 partition 记进
`<userDataDir>/spaces/pending-deletion.json`；**外壳下次启动时、在任何 `session.fromPartition`
之前**真的把它们删掉。（默认空间的 partition **永不**进这张表。）

**不许**在任何界面或文档里把这一条写成"关闭即释放存储"而不加限定：能立即释放的是**页面**，
存储的**数据**被抹掉，**目录**要等下次启动。

### 5. 工具面：一个工具带 action；作用域靠 `adopt()` 解析

- 空间用一个工具（`browser_space`，`action: list|create|use|close`），**不铺成一堆工具**。
- "所有工具只作用于当前空间"**不加新参数**：`src/index.ts` 里那个 `adopt()` 是本插件**唯一**
  拿到会话的缝（每个工具的第一行都是 `const session = await adopt()`），所以把它从
  "领养那一个会话"改成"**按当前空间解析会话**"，作用域就自动落到**每一个**工具上，
  一层都不用改签名，也不存在"某个工具忘了加 space 参数"这种漏法。
- 空间被关闭时它缓存的会话随之释放（连接断掉），**不是**把别人的会话悄悄指过去。

## 考虑过的替代

- **`browser.newContext()`** —— 实测不可用（第 0 节），弃。
- **改 `preload.js` 加一条空间命令 bridge** —— 会把"页面那半边只搬矩形"这条边界改掉，
  而且 bridge 只在 `--rect-channel` 打开时注入（是可选的）。弃。
- **外壳再开一个本地监听端口做控制面** —— ADR-0003 明令零端口，弃。
- **`DOMStorage` 逐 origin 搬 localStorage（含枚举）** —— 枚举不存在、foreign origin 被拒，弃。
- **为命名整齐把默认空间改成 `persist:dsh-view-space-default`** —— 会丢掉用户已经登录的档案。弃。
- **关闭时删目录** —— 做不到（EPERM）。改成"抹数据 + 下次启动删目录"，并把这件事测出来。

## 后果

- 空间的**隔离强度**是 partition 级：cookie/localStorage/sessionStorage/缓存都隔离（实测：同一个
  origin 上，`space-a` 的会话读得到自己的 localStorage，`window` 与 `space-b` 的会话读到 `[]`）。
- 空间的**页面**数量 = 空间数量：每个空间一块视图、一个渲染进程。空间多了内存会涨；
  本票按 2~3 个空间的场景设计与测试，**没有**量上限。
- `docs/research/task-space-isolation.md` 第 5 节是这份 ADR 的诚实清单：跨源 cookie 保真度、
  httpOnly 位的往返、真实登录站点、并发访问同站点、partition 上限、非 Windows 平台**都没验证**。
