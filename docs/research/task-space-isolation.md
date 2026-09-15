# 测量：任务空间的物理基础（独立上下文 / 每空间分区 / 继承登录 / 关闭即释放）

**问题**：票 #8 要求"每任务一个**独立浏览器上下文**"。但本项目已有一条实测边界（ADR-0002）：
Electron 上 Playwright 的 `context.newPage()` 抛 `Target.createTarget: Not supported`。本票踩在它附近，
所以开工第一件事不是写代码，而是**把下面四件事量出来**：

1. `browser.newContext()` 在 Electron 上到底能不能用？
2. 两块 `WebContentsView` + 两个 `persist:` partition 能不能并存，各自是不是 CDP `type:"page"`、
   `targetId` 互不相同、能被 Playwright **分别领养**？
3. "新空间继承默认档案的登录态"要付什么代价（cookie 能复制吗？localStorage 呢？）
4. "关闭空间即释放其页面与存储"在 Windows 上到底能做到哪一步？

**结论（先给结论，证据在下面每一节）**

1. **`browser.newContext()` 在 Electron 上不可用**，不是"大概不行"：
   `Target.createBrowserContext` 回 `Failed to create browser context.`，
   `Target.createTarget` 回 `Not supported`，而 `Target.getBrowserContexts` 回
   `{browserContextIds: [], defaultBrowserContextId:"…"}` —— **Electron 里所有 partition 都挤在同一个
   CDP browser context 里**。⇒ 票面"独立浏览器上下文"四个字在本宿主上**无法按字面实现**；
   等价物是**每个空间一个独立 partition**（票面评论已授权这条路），**不伪造**。
2. **两块视图并存成立**：两块 `WebContentsView` + 两个 partition，各自是 `type:"page"`、
   `targetId` 互不相同、**能各自被 Playwright 领养**（各自连一次，各自读到标题）。
   但 `browser.contexts()` 仍然只有 **1** 个 —— 这正是第 1 条的推论，不是矛盾。
3. **cookie 能复制**（`cookies.get({})` → `cookies.set({...})`，**`set` 必须带 `url`**）；
   **localStorage 不能批量搬**，而且**连"给一个本 partition 没有 frame 的 origin 写 localStorage"都被 CDP 拒绝**
   （`Frame not found for the given storage id`）⇒ localStorage 只能"在目标 partition 里真的访问那个 origin，
   再写进去"，且**没有任何 API 能枚举哪些 origin 有 localStorage**。
4. **关闭空间：页面能真释放，存储目录不能马上释放**。`removeChildView` + `webContents.close()` 后
   目标**从 `/json/list` 消失**；`clearStorageData()` 之后同一 partition 上的新页面**读不到旧 cookie/localStorage**
   （数据确实被抹掉）；但 partition 目录在进程存活期间 `rmSync` **连续 5 次 EPERM**，
   `clearStorageData()` + `clearCache()` 之后**仍然 EPERM**（15 个子项里 11 个被锁），
   **进程退出后删同一目录第 1 次就成功**。

- 探针：`%TEMP%\t8-probe\`（`probe.cjs` + `driver.mjs` + `connect-real.mjs` + `smoke-shell.mjs`，**一次性原型，
  不是交付物**；本票期间它们在仓库的 `.scratch/` 下跑——那目录已被 gitignore——**写完这份文档后已移出仓库**，
  以免仓库里留下临时文件。下面的原始输出都是它们当时打出来的。)
- 日期：2026-09-15
- 起点：`HEAD = b4d15e3`（= `origin/main`，工作树干净，`npm test` = 7 文件 / 62 用例全绿）

---

## 0. 环境

| 项 | 值 |
|---|---|
| Electron | **44.3.0**（Chromium `152.0.7977.78`） |
| Playwright | **1.62.1** |
| Node | v24.19.0 |
| 系统 | Windows 10.0.26200 |

探针的形状：`probe.cjs` 是一个**自己的 Electron 应用**（不改仓库源码），`driver.mjs` 是它的驱动进程
（起探针、连 CDP、发原始命令、收 `PROBE`/`DRIVER` 行）。每个 scenario 用**自己的临时 `--user-data-dir`**，
**从不碰用户自己那个外壳的 `%APPDATA%\dsh-desktop-shell`**。

---

## 1. `browser.newContext()` 不可用（决定性，两种途径各量一遍）

### 1.1 对**真实外壳**（`shell/main.js`）量：`node .scratch\t8-probe\connect-real.mjs`

```
REAL handshake: {"cdpUrl":"http://127.0.0.1:57953","targetId":"5164603D7422AC289215326D686448F0","pageTargetCount":2}
REAL connectOverCDP ok after 24ms; contexts=1
REAL pages: [["http://127.0.0.1:57954/shell","http://127.0.0.1:57954/view"]]
REAL playwright attempts: {"newContext":{"ok":false,"message":"browser.newContext: Protocol error (Target.createBrowserContext): Failed to create browser context."}}
REAL raw cdp: {"Target.getBrowserContexts":{"ok":true,"result":{"browserContextIds":[],"defaultBrowserContextId":"89FF880C5BA7648F945F5F48B027C3AC"}},"Target.createBrowserContext":{"ok":false,"message":"cdpSession.send: Protocol error (Target.createBrowserContext): Failed to create browser context."},"Target.createTarget":{"ok":false,"message":"cdpSession.send: Protocol error (Target.createTarget): Not supported"}}
```

### 1.2 对**自建探针应用**量：`node .scratch\t8-probe\driver.mjs alive`

```
DRIVER {"kind":"connect","value":{"contexts":1,"pages":[["http://127.0.0.1:49412/window","http://127.0.0.1:49412/space-a"]],"browserType":"chromium","version":"152.0.7977.78"}}
DRIVER {"kind":"playwright-attempts","value":{"newContext":{"ok":false,"message":"browser.newContext: Protocol error (Target.createBrowserContext): Failed to create browser context."},"newPage":{"ok":false,"message":"browser.newPage: Protocol error (Target.createBrowserContext): Failed to create browser context."}}}
DRIVER {"kind":"raw-cdp","value":{"Target.createBrowserContext":{"ok":false,"message":"cdpSession.send: Protocol error (Target.createBrowserContext): Failed to create browser context."},"Target.createTarget":{"ok":false,"message":"cdpSession.send: Protocol error (Target.createTarget): Not supported"},"Target.getBrowserContexts":{"ok":true,"result":{"browserContextIds":[],"defaultBrowserContextId":"6EC241F0C04D34ED7C75A9F8F9ED8FC8"}},"Target.setDiscoverTargets":{"ok":true,"result":{}}}}
```

### 1.3 判读

| 命令 | Electron 的回答 | 含义 |
|---|---|---|
| `Target.getBrowserContexts` | `{"browserContextIds":[], "defaultBrowserContextId":"…"}` | **一个默认 browser context**，没有别的 |
| `Target.createBrowserContext` | `Failed to create browser context.` | **建不出新的** |
| `Target.createTarget` | `Not supported` | 复现 ADR-0002 |

⇒ `browser.newContext()` 与 `browser.newPage()` **都不能用**（后者内部先建 browser context）。
Chromium 的 "browser context" 在 Electron 的会话模型里**不存在**：Electron 的隔离单位是
**partition（session）**，而 **partition 不是 CDP 的 browser context** —— 所有 partition 都落在
那一个默认 browser context 里（第 2 节的 `browserContextId` 只证明"每个页面各有各的 id"，
但 `getBrowserContexts` 一个都不列，Playwright 也把它们全放进**同一个** context）。

**因此本票不实现"独立浏览器上下文"，实现"每个空间一个独立 partition"。**
票 #8 的票面评论已经先授权了这条等价物（"不能伪造，改用 Electron 侧的等价物"），
派工书亦同。**这一条事实独立成文，见 `docs/adr/0010`。**

---

## 2. 两块视图 + 两个 partition：身份与可领养性

`node .scratch\t8-probe\driver.mjs twoviews`

```
DRIVER {"kind":"probe-ready","value":{"cdpUrl":"http://127.0.0.1:57508","targetA":["12226BDA39EF1247978E81335F88E066"],"targetB":["C9E5B2466AE4A61D84994B23ABF6C6FC"]}}
DRIVER {"kind":"playwright-view","value":{"contextCount":1,"perContext":[["http://127.0.0.1:57509/space-a","http://127.0.0.1:57509/space-b","http://127.0.0.1:57509/window"]]}}
DRIVER {"kind":"target-info","value":[{"url":"http://127.0.0.1:57509/space-a","targetId":"12226BDA39EF1247978E81335F88E066","type":"page","browserContextId":"FBCF29B7BF2BCB5C754BB4293DB328FC"},{"url":"http://127.0.0.1:57509/space-b","targetId":"C9E5B2466AE4A61D84994B23ABF6C6FC","type":"page","browserContextId":"1A369B8620FD2417F45511A46B7843A6"},{"url":"http://127.0.0.1:57509/window","targetId":"DE588FB4CF0EDE4ED70BAA09FB59A318","type":"page","browserContextId":"BD99E7E5FDA1A855E4A7F97930BC236F"}]}
DRIVER {"kind":"adopt","value":{"label":"a","targetId":"12226BDA39EF1247978E81335F88E066","ok":true,"url":"http://127.0.0.1:57509/space-a","title":"t8-spacea"}}
DRIVER {"kind":"adopt","value":{"label":"b","targetId":"C9E5B2466AE4A61D84994B23ABF6C6FC","ok":true,"url":"http://127.0.0.1:57509/space-b","title":"t8-spaceb"}}
```

判读：

- 两块视图**都是** `type:"page"`，`targetId` **互不相同**，各自**能被单独领养**（每块各连一次 CDP，
  各自读到自己的 URL 与标题）。⇒ 空间的物理基础成立，插件的 `findView()` **按 targetId 找页面**这条路
  在多视图下照样成立（它本来就遍历所有 context 的所有 page）。
- `browser.contexts()` 仍然只有 **1** 个 ⇒ 第 1 节的推论。
- 侧栏第 4 条只要求"两空间互不影响"，**不要求** Playwright 层面的 context 隔离——cookie/localStorage
  的隔离由 partition 提供，这一条实测已足够。

### 2.1 顺带量到的一条：**没有导航过的页面会让 `connectOverCDP` 整个挂住**

第一次跑 probe 时 `connectOverCDP` 30s 超时，逐条协议日志显示：探针的 `BrowserWindow` 从未 `loadURL`，
它的 webContents 是一个 `url:""` 的 page target，Playwright 对它发 `Page.getFrameTree` **永不回答**，
于是连接初始化卡死。给窗口 `loadURL` 之后同一条路径 **24ms** 就通了。
⇒ **每个空间的视图都必须真的导航过**，否则插件的领养路径会挂；这条对实现有直接约束。

---

## 3. 继承登录态：cookie 能搬，localStorage 不能批量搬

`node .scratch\t8-probe\driver.mjs cookies`

### 3.1 原始输出（节选，逐字）

```
DRIVER {"kind":"probe:written-in-a","value":{"cookie":"t8persist=alpha; t8session=beta","local":"gamma","origin":"http://127.0.0.1:51985"}}
DRIVER {"kind":"probe:cookies-get","value":{"a":[{"name":"t8persist","value":"alpha","domain":"127.0.0.1","path":"/","session":false,"expirationDate":1789574050.983763},{"name":"t8session","value":"beta","domain":"127.0.0.1","path":"/","session":true}],"bBefore":[]}}
DRIVER {"kind":"probe:cookies-set","value":[{"cookie":"t8persist","attempt":"with-url","ok":true},{"cookie":"t8persist","attempt":"domain-only","ok":false,"error":"Missing required option 'url'"},{"cookie":"t8session","attempt":"with-url","ok":true},{"cookie":"t8session","attempt":"domain-only","ok":false,"error":"Missing required option 'url'"}]}
DRIVER {"kind":"probe:cookies-get-after","value":[{"name":"t8persist","value":"alpha","session":false},{"name":"t8session","value":"beta","session":true}]}
DRIVER {"kind":"probe:b-sees","value":{"cookie":"t8persist=alpha; t8session=beta","local":null,"session":null,"origin":"http://127.0.0.1:51985"}}
DRIVER {"kind":"probe:a-localstorage-entries","value":{"t8local":"gamma"}}
DRIVER {"kind":"probe:b-after-localstorage-write","value":{"cookie":"t8persist=alpha; t8session=beta","local":"gamma","session":null,"origin":"http://127.0.0.1:51985"}}
```

### 3.2 cookie：**能复制**，且有一个必须记住的坑

- `session.cookies.get({})` 把**持久 cookie 与会话 cookie** 都列出来（带 `domain`/`path`/`session`/`expirationDate`）。
- `session.cookies.set({...})` **必须带 `url`**：只给 `domain`/`path` 会抛 `Missing required option 'url'`。
  带上 `url` 之后，持久与会话 cookie **都成功落进目标 partition**，目标页面 `document.cookie` 里**两条都在**。
- ⇒ 复制公式：`url = (secure ? 'https' : 'http') + '://' + domain.replace(/^\./,'') + path`。

### 3.3 localStorage：**不能批量搬**，而且比想象的还紧

- `session` 的原型方法里**根本没有** localStorage 相关 API（把 `Object.getOwnPropertyNames` 全打出来核对过：
  `cookies` / `clearStorageData` / `flushStorageData` / `getStoragePath` / `setProxy` … 没有一条是 local/session storage）。
- 用 CDP 试过（`node .scratch\t8-probe\driver.mjs enum`）：

```
DRIVER {"kind":"origin-enumeration","value":{"DOMStorage_enable":"threw: cdpSession.send: Protocol error (DOMStorage.enable): 'DOMStorage.enable' wasn't found", …}}
DRIVER {"kind":"domstorage-per-page","value":[
 {"url":".../space-a","enable":"ok","itemsForSpaceA":{"entries":[["t8local","gamma"]]},"setItem":"ok","itemsAfterSet":{"entries":[["t8injected","written-by-cdp"],["t8local","gamma"]]},"foreignSet":"threw: cdpSession.send: Protocol error (DOMStorage.setDOMStorageItem): Frame not found for the given storage id"},
 {"url":".../window","enable":"ok","itemsForSpaceA":{"entries":[]},"setItem":"ok","itemsAfterSet":{"entries":[["t8injected","written-by-cdp"]]},"foreignSet":"threw: … Frame not found for the given storage id"},
 {"url":".../space-b","enable":"ok","itemsForSpaceA":{"entries":[]},"setItem":"ok","itemsAfterSet":{"entries":[["t8injected","written-by-cdp"]]},"foreignSet":"threw: … Frame not found for the given storage id"}]}
```

判读（三条，都是决定实现形态的）：

1. `DOMStorage` 是**页面级**域，不是浏览器级域（浏览器级会话发 `DOMStorage.enable` → `wasn't found`）。
2. 一个页面会话**能读/写别的 partition 读不到的、自己 partition 里某个 origin 的 localStorage**：
   `space-a` 的会话读到 `t8local=gamma`，而 `window` / `space-b` 的会话对同一个 origin 读到 `[]`
   —— **storage 是按 partition 隔离的**（这同时是第 2 条验收的又一处独立证据）。
3. **给一个本 partition 没有 frame 的 origin 写 localStorage 会被拒绝**：
   `DOMStorage.setDOMStorageItem({storageId:{securityOrigin:'https://example.com'}})` →
   `Frame not found for the given storage id`（三个页面各试一次，三次同样）。
   ⇒ localStorage 的搬运**只能**"在目标 partition 里真的访问那个 origin，再写进去"。

### 3.4 没有任何 API 能枚举"哪些 origin 有 localStorage"

cookie 靠 `cookies.get({})` 就能**全量盘点**（含 domain/expiration），localStorage **没有对应物**：
session 侧没有 API，CDP 侧 `Storage` 域在本宿主上 `Storage.getUsageAndQuota` 直接 `Internal error`，
`DOMStorage` 又必须**先有一个那个 origin 的 frame**。⇒ **枚举不可行**，这一条是本票"能做到/做不到"的分界。

**本票据此确定的能力边界（写进 ADR-0010）**：

| 登录态的形态 | 新空间能不能继承 | 代价 |
|---|---|---|
| **cookie**（会话 + 持久，任意 origin） | **能**，全量 | `cookies.get` + `cookies.set`（带 `url`），一次往返 |
| **localStorage / sessionStorage** | **只能继承"新空间真的访问到的那个 origin"** | 必须让新空间的视图**导航到那个 origin**，然后逐条写 |
| **其它 origin 的 localStorage** | **不能**（除非逐个导航过去） | 没有枚举手段；浏览器也没有"导出全部 origin storage"的 API |

---

## 4. 关闭空间：页面立即释放；存储目录在进程存活期间删不掉

### 4.1 页面确实被释放

`node .scratch\t8-probe\driver.mjs release`：

```
DRIVER {"kind":"probe:after-close","value":{"webContentsDestroyed":true,"pageTargets":["http://127.0.0.1:59520/window"]}}
```

`removeChildView(view)` + `webContents.close()` 之后：`webContents.isDestroyed() === true`，
而且**该空间的页面从 `/json/list` 里消失了**（只剩窗口那一页）。顺带记一条 API 事实：
`view.webContents` 在 close 之后**变成 `undefined`**，所以要留一份 `webContents` 引用再问它。

### 4.2 存储数据能被抹掉

```
DRIVER {"kind":"probe:after-clear-new-view","value":{"cookie":"","local":null,"session":null,"origin":"http://127.0.0.1:59520"}}
```

`clearStorageData()` 之后，在**同一个 partition** 上再开一块视图、访问同一 origin：
cookie 空、localStorage `null`、sessionStorage `null`。⇒ **数据确实被抹掉**（不是只删了目录项）。

### 4.3 目录删不掉（Windows 文件锁，逐个量化）

```
DRIVER {"kind":"probe:per-entry-removal","value":{"locked":[
 {"name":"blob_storage","removed":true},{"name":"Cache","removed":false,"code":"EPERM"},
 {"name":"Code Cache","removed":true},{"name":"DawnGraphiteCache","removed":false,"code":"EPERM"},
 {"name":"DawnWebGPUCache","removed":false,"code":"EPERM"},{"name":"declarative_performance_observer.db","removed":true},
 {"name":"declarative_performance_observer.db-journal","removed":true},{"name":"DIPS","removed":false,"code":"EPERM"},
 {"name":"DIPS-wal","removed":false,"code":"EPERM"},{"name":"GPUCache","removed":false,"code":"EPERM"},
 {"name":"Local Storage","removed":false,"code":"EPERM"},{"name":"Network","removed":false,"code":"EPERM"},
 {"name":"Session Storage","removed":false,"code":"EPERM"},{"name":"Shared Dictionary","removed":false,"code":"EPERM"},
 {"name":"WebStorage","removed":false,"code":"EPERM"}],
 "remaining":["Cache","DawnGraphiteCache","DawnWebGPUCache","DIPS","DIPS-wal","GPUCache","Local Storage","Network","Session Storage","Shared Dictionary","WebStorage"],
 "wholeDirRemovable":"no: EPERM"}}
```

另一条路径也量了（`driver.mjs delete`）：关视图后连续 5 次 `rmSync` **全 EPERM**，
`clearStorageData()` + `clearCache()` **之后**再连 5 次**仍全 EPERM**。

### 4.4 进程退出之后就能删

```
DRIVER {"kind":"rmdir-after-process-exit","value":{"target":"…\\Partitions\\t8-space-rel","attempts":[{"attempt":1,"ok":true}],"stillExists":false}}
```

**如实结论**：

| 关闭空间时问的事 | 答案 |
|---|---|
| 它的**页面**被释放了吗？ | **是**，立即（CDP 目标消失，`webContents.isDestroyed()` 为真） |
| 它的**存储数据**被抹掉了吗？ | **是**（`clearStorageData()` 之后同 partition 新页面读不到任何旧 cookie/localStorage） |
| 它的**磁盘目录**立即消失了吗？ | **否**。进程存活期间删不掉（EPERM，15 个子项里 11 个被锁），只能**下次启动时清理** |

⇒ 实现必须**真的**做"下次启动清理"，并且**分开测**这三件事（见测试与 ADR-0010）。

---

## 5. 没验证到的（诚实清单）

1. **跨源 cookie 的保全度**只在回环同源夹具上量过（`127.0.0.1` 上的 http）。带 `Secure` 的 https
   cookie、带 `SameSite=None` 的第三方 cookie、带 `__Host-` 前缀的 cookie **没有量**——
   `cookies.set` 的 `url` 由 `domain+path+secure` 拼出，这些形状的往返保真度**未经验证**。
2. **httpOnly cookie 的读写**：`cookies.get`/`set` 走的是主进程，不受页面 JS 限制；但**没有单独断言**
   复制过去的 httpOnly 位是否原样保留（只断言了目标页面 `document.cookie` 里看得到非 httpOnly 的那两条）。
3. **没有访问任何真实登录站点**。"继承后到底还登不登录"由测试夹具（一个 cookie 站 + 一个
   localStorage 站）回答，不是真实站点。
4. **localStorage 的枚举/搬运边界**只量到"没有 API + foreign origin 被拒"这两条；**没有**去试
   "直接读 profile 目录里的 LevelDB"这条野路子（判为不可接受的实现）。
5. **两个空间同时访问同一站点**（并发的网络层互相影响、DNS/连接池）**没有量**——本票只量了存储隔离。
6. **partition 数量的上限**没有量（本票场景是 2~3 个空间）。
7. 探针只量了 **Windows 10.0.26200**；第 4 节的 EPERM 是 Windows 文件锁的行为，其它平台**没量**。
