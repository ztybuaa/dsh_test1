# 测量：外壳发布的空间表里，`targetId` 会在"这一次读不回来"时消失

**问题**：T7 之后整包偶发红的一种签名 —— `tests/spaces.spec.ts` 读空间表时抛
`the shell published no target id for the space "…"`，而报告上写的是 `Tests 77 passed (77)` /
`Test Files 1 failed`（两条用例红、文件红，红的**原因**却与断言无关）。要回答的不是"哪一行抛的"，
而是**外壳凭什么会发布一张缺 `targetId` 的表**，以及**读到它的人**（测试侧与插件侧）该怎么办。

**结论（先给结论，证据在下面每一节）**

1. **代码路径是确定的**：`describeSpaces()` 原来第一行是
   `const targets = await cdp.listTargets(state.cdpPort).catch(() => [])`
   （本文件改动前在 `shell/main.js:622`）。`/json/list` 是一个回环 HTTP 请求（5s 超时），**任何一次
   瞬时失败**都会让这张表里**每一个**空间的 `targetId` 变成 `undefined`，而外壳照样把它发布出去
   （`state.json` + `DSH_SHELL SPACES`）。
2. **"刚创建、目标还没登记"这条线索被探针否掉了**：一个刚 `addChildView` 的 `WebContentsView`
   **立刻**就在 `/json/list` 里（§2 的原始输出）。所以"自然发生的那一刻"更可能是**列举读不回来**。
   两个窗口都在修复里关掉了：前者靠合并规则（记住已知的 id），后者靠**有界等待**（发布前等目标可解析）。
3. **确定性复现**：给外壳加一条测试缝 `--fault-cdp-list <n>`（只在**处理空间请求期间**让
   `GET /json/list` 失败 n 次，且**每次注入都打印一行** `DSH_SHELL CDP_LIST_FAULT`）。
   修复前，它跑出来的是**一条没有 `targetId` 的记录**（§4 原文）；修复后同一处是
   `targetIdSource: "remembered"`（已经知道的 id 保留）+ `targetIdSource: "unavailable"`（确实没有的
   显式说明）。
4. **读它的人两边都不安全，两边都修了**：
   - **测试侧**：`withSpacePage` 只抛一句"没有 target id"，看不出原因 —— 现在它会把外壳给的原因与
     **整张表**一起打出来（这正是那次红没法判读的原因）；
   - **插件侧**：`src/spaces.ts` 的 `parseSpaceState` 把缺失的 `targetId` **默默丢掉**，于是模型看到的
     错误跟真实原因无关 —— 现在解析保留外壳的说明，`adopt()` 点名**是哪个空间、为什么还没准备好**，
     `browser_space` 的表与 `describeSpaceTable` 也不再静默省略。

- 环境：Windows 10.0.26200 / Node v24.19.0 / Electron 44.3.0（Chromium 152） / Playwright 1.62.1
- 起点：`HEAD = 89ed3a9`；修复后：9 文件 / 82 用例
- 日期：2026-09-16
- 相关：`docs/research/suite-flake-two-signatures.md`（签名一与复跑账本）、ADR-0010 §2

---

## 1. 那两行代码（修复前）

```js
// shell/main.js（改动前）
const targets = await cdp.listTargets(state.cdpPort).catch(() => [])   // 622 行：瞬时失败 → 空表
...
targetId: cdp.targetIdForWebContents({ webContents, targets: pageTargets, webContentsId: contents.id }),  // → undefined
```

`listTargets` 失败（超时、非 200、socket 错）与"端点上一个 page 目标都没有"在这一行里**长得一模一样**，
于是"这一次没读到"被写成了"没有"。表照样发布：

```js
emit(`DSH_SHELL SPACES ${JSON.stringify(record)}`)   // record.spaces[i].targetId === undefined
```

读它的人：

| 读者 | 修复前的行为 |
|---|---|
| `tests/spaces.spec.ts` 的 `withSpacePage` | 抛 `the shell published no target id for the space "…"` —— **不说为什么** |
| `src/spaces.ts` `parseSpaceState` | 把 `targetId` 这一项**默默丢掉**（`targetId?: string`） |
| `src/spaces.ts` `adopt()` | 只说"外壳没有发布 target id"，把原因留给了读者猜 |

---

## 2. 探针：一个没导航过的 `WebContentsView` 有没有 CDP 目标？

**这是为了判掉一条线索**："刚创建的视图还没登记成目标，所以表里没有它"。

探针（一次性，源码见本节末）用**产品代码本身**（`shell/cdp.js` 的 `listTargets` +
`targetIdForWebContents`）在真 Electron 里逐步问同一件事，档案是它自己的临时 `--user-data-dir`：

```text
node_modules\electron\dist\electron.exe .scratch\probe-target-registration.cjs <out.json>
（跑完 taskkill /pid <pid> /T /F；不碰用户自己那个外壳进程）
```

原始输出（节选，逐字）：

```text
{"label":"WebContentsView added, never navigated","listedPages":[{"id":"BCA7C834D3786B29693A9F3C9F5B109B","type":"page","url":""},{"id":"081BA174C08A83CA802DE5745923590C","type":"page","url":"http://127.0.0.1:63892/shell"}],"viewWebContentsId":2,"viewTargetId":"BCA7C834D3786B29693A9F3C9F5B109B"}
{"label":"view navigated to about:blank","listedPages":[{"id":"BCA7C834D3786B29693A9F3C9F5B109B","type":"page","url":"about:blank"},…],"viewWebContentsId":2,"viewTargetId":"BCA7C834D3786B29693A9F3C9F5B109B"}
{"label":"view navigated to an http page","listedPages":[{"id":"BCA7C834D3786B29693A9F3C9F5B109B","type":"page","url":"http://127.0.0.1:63892/view"},…],"viewWebContentsId":2,"viewTargetId":"BCA7C834D3786B29693A9F3C9F5B109B"}
{"label":"view webContents closed","listedPages":[{"id":"081BA174C08A83CA802DE5745923590C","type":"page","url":"http://127.0.0.1:63892/shell"}]}
```

判读（三条，都直接进了修复）：

1. **刚 `addChildView`、一次都没导航过，目标就已经在表里了**（`url: ""`）。
   ⇒ "创建后、登记前"这个窗口在这台机器上**量不出来**；它是"通常极小"，不是"不存在"，
   所以修复仍然**有界地等**它（等不到不报错，改成显式说明）。
2. **target id 跨导航不变**：同一个 `BCA7…` 从 `url:""` → `about:blank` → `http://…/view` 一直是它。
   ⇒ 这就是"允许保留上一次已知的 id"这条合并规则的**事实依据**（活着的视图，id 不会变）。
3. **视图一 `close()`，目标立刻从表里消失**。
   ⇒ 所以"保留"只对**活着的**视图成立：`describeSpaces` 对 `isDestroyed()` 的视图走另一条分支，
   那里不保留任何 id，而是显式写 `targetIdSource: 'unavailable'` + 原因。

探针脚本要点（`probe-target-registration.cjs`，跑完已移出仓库）：

```js
const { app, BrowserWindow, WebContentsView, webContents } = require('electron')
const cdp = require('../shell/cdp.js')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-target-registration-'))
app.setPath('userData', userDataDir)
app.commandLine.appendSwitch('remote-debugging-port', '0')
// 每一步都问同一件事：/json/list 列了什么、这个 webContents 能不能被映射回一个 target id
async function snapshot(label, port, window, view) { /* listTargets + targetIdForWebContents */ }
```

---

## 3. 修复

### 3.1 纯逻辑：`mergeTargetIds(previous, listing)`（`shell/spaces.js`）

发布的表**永远不比它知道的更少**。三态，取代原来那个 `undefined`：

| 这一次列举 | 上一版已知 | 发布出去 |
|---|---|---|
| 解析到 `NEW` | 任意 | `targetId: "NEW"`, `targetIdSource: "resolved"` |
| 读不回来 / 里面没有这块视图 | `OLD` | `targetId: "OLD"`, `targetIdSource: "remembered"` + 原因 |
| 读不回来 / 里面没有这块视图 | 没有 | **不写 `targetId`**，写 `targetIdSource: "unavailable"` + 原因 |

它放在 `spaces.js` 是因为那个文件是**纯逻辑**（不 require electron、不碰文件系统），
所以每一条判断都能不起外壳被单读（`tests/spaces.spec.ts` 的纯逻辑组）。

### 3.2 有界等待：新建的视图，在发布之前等它的目标可解析（`awaitCreatedTargets`）

`createSpace` → `inheritLogin` → **等（≤5s，每 100ms 问一次）** → 关 → 切 → 发布。
等到的 id 记进 `entry.targetId`，发布用的就是它。等不到**不报错**：照常发布，记录里写明
`targetIdSource: 'unavailable'`。每次等待都打印
`DSH_SHELL SPACE_TARGET_WAIT {"waitedMs":…,"resolved":[…],"unresolved":[…]}`。

### 3.3 插件侧：把"还没准备好"当成一个**说得清的状态**

- `src/spaces.ts` 的 `SpaceRecord` 多两个字段：`targetIdSource`（三态）与 `targetIdReason`；
  `parseSpaceState` **原样带过来**（旧外壳不发布它们时是 `undefined`，按"外壳没说"处理，
  不假装是 `resolved`）；
- `adopt()`：没有可用的 target 时**点名那个空间**、并带上外壳给的原因，明确说"这个空间还没准备好"，
  **绝不**"领养一个没有目标的会话"；
- `browser_space` 的表与 `describeSpaceTable`：没有 target 的行会写 `no CDP target yet: <原因>`，
  不再静默省略。

### 3.4 测试缝：`--fault-cdp-list <n>`（`shell/args.js` + `shell/main.js`）

只在**处理一条空间请求期间**（`state.spaceRequestRunning`）让接下来 n 次 `GET /json/list` 失败，
**每一次注入都打印一行** `DSH_SHELL CDP_LIST_FAULT {"injected":true,"remaining":…}`。
启动那一次列举**永远不注入**（注入了外壳压根起不来，那测的就不是这件事了）。

---

## 4. 原始输出：修复前 / 修复后

两条端到端用例在 `tests/spaces.spec.ts` 的
`T7 — 端点那一刻读不回来：发布的表不许比它知道的更少（故障注入，确定性）` 里。

### 4.1 修复前（把修复的两处回退掉，同一个用例、同一个注入）

```text
RAW record after the injected fault: {"record":{"name":"flaky-once","partition":"persist:dsh-view-space-flaky-once","storagePath":"C:\\Users\\ZHANGT~1\\AppData\\Local\\Temp\\dsh-desktop-shell-test-u0b9WO\\Partitions\\dsh-view-space-flaky-once","persistent":true,"url":"http://127.0.0.1:60861/view","visible":false,"webContentsId":3,"active":true,"isDefault":false,"cookieCount":0,"inherited":{"sourceUrl":"http://127.0.0.1:60861/view","cookiesOffered":0,"cookiesInSpace":0,"localStorageOrigin":"http://127.0.0.1:60861","localStorageKeys":0}}}
```

**这一条记录里没有 `targetId`** —— 它就是"外壳发布了缺 `targetId` 的空间表"的原文。
同一个注入下两条用例双双变红：

```text
 ❯ tests/spaces.spec.ts (19 tests | 2 failed | 17 skipped) 2041ms
     × 故障只发生一次：外壳等到目标可解析才发布，新空间拿到的是真的、能被领养的 id 1012ms
     × 故障一直发生：已知的 id 不许被抹掉，确实没有的要显式说明，插件点名那个空间报错 588ms
 Test Files  1 failed (1)
      Tests  2 failed | 17 skipped (19)
```

### 4.2 修复后

故障只发生一次（外壳等到目标可解析才发布，新空间拿到的是**真的** id）：

```text
RAW record after the injected fault: {"record":{"name":"flaky-once",…,"persistent":true,"targetId":"7E2723236D68DFF8174D33354C80EF72","targetIdSource":"resolved","url":"http://127.0.0.1:53272/view",…},"wait":{"waitedMs":117,"resolved":["flaky-once"],"unresolved":[]}}
```

故障一直发生（这一版表是在"端点一次也没读回来"的时候发布的）：

```text
RAW the table published while the endpoint could not be listed: {"default":{…,"targetId":"22E05109C82A871A530D3431E2038DE6","targetIdSource":"remembered","targetIdReason":"the CDP endpoint could not be listed (injected fault (--fault-cdp-list): this GET /json/list was made to fail); keeping the id this view already had, because a live view's target id does not change",…},"flaky-always":{…,"targetIdSource":"unavailable","targetIdReason":"the CDP endpoint could not be listed (injected fault (--fault-cdp-list): this GET /json/list was made to fail), and no target id was ever read for this view, so there is nothing to remember",…},"faults":47}
```

插件侧同一时刻的拒绝（点名空间 + 外壳给的原因，**不是**"领养了一个没有目标的会话"）：

```text
RAW the plugin refused to adopt: "the desktop shell has no usable CDP target for the active space \"flaky-always\" yet: the CDP endpoint could not be listed (injected fault (--fault-cdp-list): this GET /json/list was made to fail), and no target id was ever read for this view, so there is nothing to remember. The space is not ready to be driven — its view exists, but nothing can be adopted through it until the shell can name its target; retry in a moment, or call browser_space with action \"list\" to see what the shell says about it."
```

### 4.3 反证（把修复回退掉，对应用例必须变红）

| 回退什么 | 谁变红 | 原文 |
|---|---|---|
| 去掉有界等待（只留合并规则） | `故障只发生一次` | `AssertionError: the given combination of arguments (undefined and string) is invalid` —— 故障被那次**发布**吃掉，`targetIdSource` 成了 `undefined` |
| 去掉合并规则（只留等待） | `故障一直发生` | `AssertionError: expected undefined to be 'resolved'` —— 连启动那一版表都没有 `targetIdSource`，也就是原来的行为 |
| 两处都回退 | 两条都红 | §4.1 |

回退是**真的做过、再原样恢复**的：`shell/main.js` 恢复后的 SHA256 与跑验收那棵树**逐字节相同**
（`10D8E6D2…24B4`，见 §3 的验收表与 `docs/research/suite-flake-two-signatures.md`）。

---

## 5. 没能验证到的（诚实清单）

1. **自然发生没有复现出来**：T7 之后 17 次整包复跑（9 次无负载 + 8 次带 CPU 负载）里，
   这个签名**一次都没出现**。本文证明的是"这条代码路径**能**发布一张缺 `targetId` 的表"，
   **没有**证明"观察到的那一次红就是它" —— 那一步只有父任务手里的那一次失败输出，本机没有再现。
2. **5 秒的有界等待是拍的**：没有量过"目标最晚多久出现"（探针只量到它**立刻**就在表里）。
   等不到的代价被限制成"表里出现 `unavailable` + 插件报一个说得清的错误"，但**这个上界没有实测依据**。
3. **`remembered` 的正确性依赖"活着的视图 target id 不变"这条实测**：本文件量了 3 个状态点
   （`""` / `about:blank` / http 页面），`docs/research/task-space-isolation.md` §2 量了两块视图互不相同。
   **渲染进程崩溃 / 恢复**之后 id 是否还会变**没有量**（那种情况下 `webContents` 会重建，
   而重建后的 id 若不同，本条规则会发布一个**旧 id**；风险写在 `mergeTargetIds` 的注释里）。
4. **`targetIdSource` 是加字段，`SPACE_PROTOCOL` 仍然是 `1`**：旧插件读新外壳会忽略新字段（行为与以前
   一致），新插件读旧外壳时 `targetIdSource` 是 `undefined`、按"外壳没说"处理。
   这条兼容性**只由代码阅读保证**，没有做跨版本联跑。
5. **顺带发现、但本次没有修**：`describeSpaces` 的 `destroyed: true` 分支发布的记录**没有**
   `storagePath`/`url`，而 `src/spaces.ts` 的 `parseSpaceState` 对缺这两个字段的记录会**整份状态都不要**
   （返回 `undefined` → `requireState()` 报"压根没有状态"）。它与本次两种签名无关，所以没有动它 ——
   但它是一个真的洞，值得单独一条票。
6. **只量了 Windows 10.0.26200 + Electron 44.3.0**：`/json/list` 的失败率、`fromDevToolsTargetId`
   的可用性、目标登记时机都是这个宿主的实测。
7. **测试缝只在"处理空间请求期间"注入**：启动那一次列举失败会怎样（外壳 `FATAL` 退出）
   **没有**被这两条用例覆盖。
