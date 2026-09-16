# 票 #15：一条 `destroyed` 记录会不会让整份空间状态不可读 —— 实测

本文回答一个问题，而且**只回答这个问题**：`shell/main.js` 的 `describeSpaces()` 里那个
"视图已被销毁"的分支，能不能被**确定性地**造出来？造出来之后，真正的失效长什么样？

结论先行（两条都与票面的假设**不一致**，原始输出在下面）：

1. **那条分支构造不出来** —— `webContents.isDestroyed()` 在本机这条时间线上**从没为真过**。
   一块被销毁的视图，`view.webContents` 直接变成 **undefined**。于是那句
   `contents.isDestroyed()` 不是"走了另一条分支"，而是**抛**：
   `TypeError: Cannot read properties of undefined (reading 'isDestroyed')`。
2. **真正的失效比票面写的更重**：`describeSpaces` 一抛，`publishSpaces` 整份不写、
   `state.json` 里的 `requestId` **永不前进**，插件一直等到超时——它报的错是"外壳没在规定时间内
   处理请求"，跟真实原因（某个空间的视图被销毁了）毫无关系。这正是本票要消灭的那类错误，
   只是入口不同。

所以票面第二条（插件侧"一条坏记录不许让整份状态不可读"）**照做**，第一条（外壳侧补字段）
也**照做**——后者现在的意义从"让那种记录少出现"变成"视图没了也照样发布一张完整的表"。

---

## 0. 环境与复现

| 项 | 值 |
|---|---|
| 宿主 | Windows 10.0.26200 |
| Electron | 44.3.0（`node_modules/electron/dist/electron.exe`） |
| Node（跑探针与测试的） | v24.19.0 |
| 起点 | `34f993c`（= `origin/main`），工作树干净 |

四条探针都是临时文件，**测完已删除**（仓库里不留临时文件）。它们当时的命令：

```powershell
# 探针 1/2/4：起 Electron 跑一段 main 脚本，用临时 --user-data-dir
$electron = node -e "process.stdout.write(require('electron'))"
& $electron probe-destroyed-path.cjs  --user-data-dir <临时目录>
& $electron probe-close-window.cjs    --user-data-dir <临时目录>
& $electron probe-after-close.cjs     --user-data-dir <临时目录>
# 探针 3b：驱动真外壳（用仓库自己的 tests/shell-harness.ts）
node --experimental-strip-types probe-real-shell2.ts
```

---

## 1. 哪些"销毁"途径会让一块**仍在表里**的视图变成销毁态

探针：四块自己的 `WebContentsView`（形状照 `shell/main.js` 的 entry），四种销毁途径各试一块。
原始输出（逐字）：

```
PROBE {"tag":"A before crash","name":"crash-a","readable":true,"id":2,"destroyed":false}
PROBE {"tag":"A after crash","name":"crash-a","readable":true,"id":2,"destroyed":false}
PROBE {"tag":"A render-process-gone","details":{"reason":"crashed","exitCode":2}}
PROBE {"tag":"A url after crash","url":"data:text/html,<title>a</title>a"}
PROBE {"tag":"B before close","name":"close-b","readable":true,"id":3,"destroyed":false}
PROBE {"tag":"B immediately after close()","name":"close-b","readable":true,"id":3,"destroyed":false}
PROBE {"tag":"B 1500ms after close()","name":"close-b","readable":true,"webContents":"undefined"}
PROBE {"tag":"B destroyed event fired","destroyedEvent":true}
PROBE {"tag":"C before destroy","name":"destroy-c","readable":true,"id":4,"destroyed":false}
PROBE {"tag":"C typeof destroy","type":"function"}
PROBE {"tag":"C immediately after destroy()","name":"destroy-c","readable":true,"id":4,"destroyed":false}
PROBE {"tag":"D before window destroy","name":"window-d","readable":true,"id":5,"destroyed":false}
PROBE {"tag":"D after window.destroy()","name":"window-d","readable":true,"id":5,"destroyed":false}
```

逐条读：

- **A 渲染进程崩溃**（`forcefullyCrashRenderer()`，`render-process-gone` 真的到了、
  `reason: "crashed"`）：`isDestroyed()` **false**，`getURL()` 还读得回来。
  崩溃**不是**销毁——一块崩溃的视图仍然是一个活着的 `WebContents`，只是没有渲染进程。
- **B `webContents.close()`**（`closeSpace` 走的就是这一条）：close 之后 `isDestroyed()`
  仍然 **false**，`destroyed` 事件真的发了；**下一次读 `view.webContents` 就是 `undefined`**。
  也就是说：销毁是**同步发生**的，但可观察到的结果是"引用没了"，不是"对象说它自己销毁了"。
- **C/D** 同理：`window.destroy()` 之后视图的 webContents 还是 false。

窗口期有多长？探针 2 每 1ms 读一次：

```
PROBE {"tag":"before close","atMs":0,"readable":true,"id":2,"destroyed":false,"crashed":false,"url":"data:text/html,<title>timed</title>timed","storagePath":"C:\\Users\\zhangtianyi\\AppData\\Roaming\\Electron\\Partitions\\probe-timed"}
PROBE {"tag":"window measured","firstUndefinedAtMs":2,"firstDestroyedAtMs":-1,"lastAliveAtMs":0}
PROBE {"tag":"right after the loop","atMs":2,"readable":true,"webContents":"undefined","destroyed":"n/a"}
PROBE {"tag":"one second later","atMs":1002,"readable":true,"webContents":"undefined","destroyed":"n/a"}
PROBE {"tag":"clearStorageData after close","cleared":"resolved"}
PROBE {"tag":"after clearStorageData","atMs":0,"readable":true,"webContents":"undefined","destroyed":"n/a"}
```

`firstDestroyedAtMs: -1` 的意思很直白：**整整两千次采样里，没有任何一次读到 `isDestroyed() === true`**；
第 2 毫秒引用就变成 `undefined` 了。

### 1.1 一块视图没了之后，外壳还读得回哪些事实

探针 4（`window.close()` 之后逐项试）：

```
PROBE {"webContentsAfter":"undefined","storagePath":"C:\\Users\\zhangtianyi\\AppData\\Roaming\\Electron\\Partitions\\probe-after-close","persistent":true,"cookieCount":0,"clearStorageData":"resolved","setVisible":"returned","removeChildView":"returned","getVisible":false,"partitionFromSession":"<Session has no getPartition>"}
```

`entry.session` 完全不受影响：`getStoragePath()` / `isPersistent()` / `cookies.get({})` /
`clearStorageData()` 都照常；`setVisible` / `removeChildView` 也照常。
**所以"视图没了"完全没有理由让发布的记录少掉 `storagePath`/`url`** —— 这两样都读得出来。
（顺带确认：`Session` 上确实没有 `getPartition()`，与 T6 的结论一致。）

---

## 2. 真外壳：这条路径怎么走到崩

探针 3b（驱动真外壳，用仓库自己的 harness）。步骤：起外壳 → 创建一个空间 `doomed` →
在那块视图里 `window.close()` → 再让外壳发布一次表。原始输出（节选，逐字）：

```
PROBE handshake spaces: ["default"]
PROBE doomed targetId: "394FE09D092D4621FEB3484B5295CA5B"
PROBE table right after create: [{"name":"default",...,"webContentsId":2,...},{"name":"doomed","partition":"persist:dsh-view-space-doomed","storagePath":"C:\\Users\\ZHANGT~1\\AppData\\Local\\Temp\\dsh-desktop-shell-test-60VWcS\\Partitions\\dsh-view-space-doomed","persistent":true,"targetId":"394FE09D092D4621FEB3484B5295CA5B","targetIdSource":"resolved","url":"http://127.0.0.1:52308/view","visible":false,"webContentsId":3,...}]
PROBE in-page: {"evaluated":"window.close() called","closed":"page closed"}
PROBE close: window.close() sent
```

然后，第二次请求（`{"id":2,"active":"default","spaces":["default","doomed"]}`）**永远等不到答案**，
外壳的 stderr 上是：

```
(node:37504) UnhandledPromiseRejectionWarning: TypeError: Cannot read properties of undefined (reading 'isDestroyed')
    at describeSpaces (G:\dsh_test1\shell\main.js:842:18)
    at async publishSpaces (G:\dsh_test1\shell\main.js:888:19)
    at async applySpaceRequest (G:\dsh_test1\shell\main.js:948:5)
    at async pollSpaceRequest (G:\dsh_test1\shell\main.js:972:5)
```

harness 那一侧看到的是：

```
Error: timed out waiting for requestId 2 published
```

而 `state.json` 停在上一次成功发布的那一版（`requestId: 1`）。
**这三行合起来就是失效的完整形状**：异常 → 不写文件 → 请求 id 不前进 → 插件超时 →
插件报的错是"外壳没在规定时间内处理请求"。

### 2.1 这条路径**在生产里也能走到**（不是只有探针能造）

`shell/main.js` 里只有 `closeSpace()` 会调 `contents.close()`，而它**先**
`state.spaces.delete(name)`，所以正常关一个空间走不到这里。但 `entry.view.webContents`
变成 undefined 并不需要外壳动手：**空间里那个页面自己 `window.close()` 就够了**
（探针 3b 用的就是这个动作，它是一个普通网页有权做的事）。那时：

- entry 还在 `state.spaces` 里（没人摘它）；
- 下一次空间请求触发发布 → `describeSpaces` 抛 → 表整份不更新。

所以这不是理论路径，是"某个空间里的页面关掉了自己"——一次用户或站点脚本的行为。

---

## 3. 修法（两条都做了，理由如下）

### 3.1 外壳侧：`describeSpaces` 不许抛，记录不许少字段

**为什么这条现在仍然要做**：即使"销毁分支构造不出来"，"视图的 webContents 没了"是**真的会
发生**的，而它原来是**抛**。修完之后：

- 生死判断统一走一个新函数 `liveContents(view)`：`undefined`/`null` 与 `isDestroyed()`
  合成**同一个判据**（"能读到的、还活着的"才算活着），三条调用点
  （`applyPlacement`、`closeSpace`、`describeSpaces`）都改用它 ——
  `applyPlacement` 里那句 `entry.view.webContents.isDestroyed()` 是同一个坑，只是还没踩到；
- 记录的组装统一走一个新函数 `spaceRecord(...)`，**两条路发布同一组字段**：
  `storagePath`/`persistent` 从 `entry.session` 读（实测视图没了照样读得回来），
  `url` 从 entry 上最后一次真的读到的值来（新增 `entry.url`），
  `webContentsId` 用 `-1`（与插件侧"外壳没说"的默认值同一个数）；
- "视图没了"这件事**显式写明**（`destroyed: true` + `contentsGoneAt`），不静默省略。

这仍然是 ADR-0010 那条规矩：**发布的表不许比它知道的更少**。知道的（档案在哪、地址是什么）
读得回来，就必须发布出去。

### 3.2 插件侧：一条不可用的记录**只跳过它自己**（票面要求的那一条，无论如何都做）

`src/spaces.ts` 的 `parseSpaceState` 原来是这样：

```ts
if (typeof space.storagePath !== 'string' || typeof space.url !== 'string') return undefined
```

`return undefined` 是**整份状态级**的：默认空间一起消失、所有工具报"压根没有状态"。
现在分成两层：

- **文件级**（`requestId` / `active` / `protocol` / `spaces` 是不是数组、数组里每一项是不是对象）
  读不出来 → 仍然整份 `undefined`。这不是"一条记录坏了"，是"这压根不是一份状态"；
- **记录级**（`name` / `partition` / `storagePath` / `url` 有一个不是字符串）→ **跳过那一条**，
  原因逐字记进新的 `SpaceState.skipped`，其余空间照常可用。

跳过的原因会一路走到工具输出：`describeSpaceTable()` 与 `browser_space` 都带上了
`skipped`（schema 里是新的必填字段），并且**当前空间正好是被跳过的那一条**时，
`adopt()` 的报错会点名它并带上原因，而不是笼统地说"外壳没有描述当前空间"。

这与 `mergeTargetIds` 是同一条思路：**一张表不能因为一个字段读不回来就整个变成"没有表"**
（ADR-0010、`docs/research/space-table-target-id-gap.md`）。

---

## 4. 复现与反证

### 4.1 端到端（真外壳，确定性）

`tests/spaces.spec.ts` → `票 #15 — 一个空间的视图被销毁之后，外壳照常发布表，默认空间照常可用`
的第一条用例，用的就是探针 3b 那条真机制（页面自己 `window.close()`），
而且**先断言故障真的发生了**（`close` 事件到了、那个 `targetId` 之后真的不在端点上了），
否则"绿"可能只是这条用例什么也没验到。原始输出（节选，逐字）：

```
RAW doomed before it closes itself: {"targetId":"BFB2D9F0B5D455ED11BA89A40CD7BFAC","url":"http://127.0.0.1:50368/view"}
RAW the doomed view closed itself: {"closed":"page closed"}
RAW published after the view was gone: {"requestId":2,"spaces":[{"name":"default",...,"webContentsId":2,...,"isDefault":true,"cookieCount":0},{"name":"doomed","partition":"persist:dsh-view-space-doomed","storagePath":"C:\\Users\\ZHANGT~1\\AppData\\Local\\Temp\\dsh-desktop-shell-test-nthH5k\\Partitions\\dsh-view-space-doomed","persistent":true,"targetIdSource":"unavailable","targetIdReason":"this space's view has no webContents any more (it was destroyed), so it has no target","url":"http://127.0.0.1:50368/view","visible":false,"webContentsId":-1,"active":false,"isDefault":false,"cookieCount":0,"destroyed":true,"contentsGoneAt":1789519258255,"inherited":{...}}]}
RAW what the plugin read back: {"spaces":["default","doomed"],"skipped":[]}
```

读法：`requestId` 前进到 **2**（修复前它停在 1、这条请求永远等不到答案）；
`doomed` 那条记录**字段齐全**（`storagePath`/`url`/`partition` 都在）并且显式写着 `destroyed: true`；
插件侧读回来的 `skipped` 是**空**的（外壳没有发布坏记录）；默认空间照常被领养、读出
`view-page`。

### 4.2 插件侧（不起外壳、纯解析 + 真工具）

同组的第二条用例把**票面那条记录逐字**写进 `state.json`：

```json
{ "name": "ghost", "partition": "persist:dsh-view-space-ghost", "destroyed": true }
```

原始输出（节选，逐字）：

```
RAW parsed a state with one unusable record: {"spaces":["default"],"skipped":[{"index":1,"name":"ghost","reason":"this space record is unusable: storagePath, url are not a string (the shell published it for a view that has been destroyed, and a destroyed view publishes no storage path or address — the shell now fills both in, so this record means an older shell)"}]}
RAW the table the model would read:
Active space: default
  default (active, default) — http://127.0.0.1:1/view partition=persist:dsh-view storage=...\Partitions\dsh-view
  ghost — NOT USABLE, skipped: this space record is unusable: storagePath, url are not a string (...) (the other spaces are unaffected)
RAW adopting a space whose record was skipped: "the desktop shell reports \"ghost\" as the active space but does not describe it (it describes: default); that space's own record was published but is not usable: this space record is unusable: storagePath, url are not a string (...)"
```

**默认空间在这条路径上完全没受影响**：`state.json` 里有一个读不动的记录，插件照样
读到 `default`、照样能领养、`browser_space`（**真的工具**，不是这个函数）的输出里
既有完整的 `default`，也有那条被跳过的记录与原因。

### 4.3 反证（把修复回退掉，必须变红）

见 §5：两处回退各自打红了哪一条，原始输出逐字在下面。

| 回退什么 | 谁变红 | 症状 |
|---|---|---|
| 外壳侧：`describeSpaces` 恢复成 `const contents = entry.view.webContents; if (contents.isDestroyed())` | `一个空间自己关掉自己的视图…` | 插件等 30 秒超时，`state.json` 停在 `requestId=1` |
| 插件侧：`parseSpaceState` 恢复成"缺字段就 `return undefined`" | `一条 destroyed 记录缺 storagePath/url…` | `parseSpaceState` 返回 `undefined`（整份状态没了） |

---

## 5. 反证实测（回退 → 跑 → 恢复）

两次回退都是**真的做过、再原样恢复**的：恢复后两个文件的 SHA256 与回退前**逐字节相同**
（`shell/main.js` = `AC232EAF…3997`、`src/spaces.ts` = `DE607C1F…2C76`）。

### 5.1 回退外壳侧

把 `describeSpaces` 的判断改回原样（`const contents = entry.view.webContents` +
`if (contents.isDestroyed())`），只跑那一条用例：

```
RAW doomed before it closes itself: {"targetId":"DBD50940A1FF58A8399FA45BEB8E66EF","url":"http://127.0.0.1:61787/view"}
RAW the doomed view closed itself: {"closed":"page closed"}

 FAIL  tests/spaces.spec.ts > 票 #15 … > 一个空间自己关掉自己的视图：state.json 照常更新、那条记录字段齐全、默认空间仍能领养
Error: the desktop shell did not handle space request 2 within 30000ms (the request is in C:\Users\ZHANGT~1\AppData\Local\Temp\dsh-desktop-shell-test-8N0Zdt\spaces\request.json, the state it publishes is in C:\Users\ZHANGT~1\AppData\Local\Temp\dsh-desktop-shell-test-8N0Zdt\spaces\state.json; the last state it published reported requestId=1)
 ❯ SpaceManager.awaitRequest src/spaces.ts:604:15
 ❯ SpaceManager.command src/spaces.ts:531:19
 ❯ tests/spaces.spec.ts:1092:5

 Test Files  1 failed (1)
      Tests  1 failed | 20 skipped (21)
```

这条报错**本身就是结论**：插件报的是"外壳没在规定时间内处理请求"、而 `requestId` 停在 1 ——
跟真实原因（某个空间的视图被销毁了）**毫无关系**。外壳那侧同时打的是
`TypeError: Cannot read properties of undefined (reading 'isDestroyed')`（§2）。

### 5.2 回退插件侧

把 `parseSpaceState` 的记录级校验改回 `if (typeof space.storagePath !== 'string' || typeof space.url !== 'string') return undefined`，
只跑那一条用例：

```
RAW parsed a state with one unusable record: {}

 FAIL  tests/spaces.spec.ts > 票 #15 … > 一条 destroyed 记录缺 storagePath/url：跳过它并说明原因，默认空间照常可用（纯解析 + 真工具）
AssertionError: expected undefined to be defined
 ❯ tests/spaces.spec.ts:1168:21
    1168|       expect(state).toBeDefined()

 Test Files  1 failed (1)
      Tests  1 failed | 20 skipped (21)
```

`RAW parsed a state with one unusable record: {}` 里的 `{}` 就是 `undefined` 被
`JSON.stringify` 掉之后的空对象 —— **默认空间跟着那条坏记录一起消失了**，
这正是票面说的"整份状态都不可读"。

---

## 7. 零回归：整包连续三次

三次都在**同一棵冻结的树**上跑（第一次 08:45:05、第二次 08:48:43、第三次 08:52:23），
`npx vitest run --config vitest.config.ts`，摘要逐字：

| 次序 | 文件 | 用例 | 用时 |
|---|---|---|---|
| 1 | `Test Files  14 passed (14)` | `Tests  144 passed (144)` | `216.50s`（tests 210.60s） |
| 2 | `Test Files  14 passed (14)` | `Tests  144 passed (144)` | `219.21s`（tests 213.27s） |
| 3 | `Test Files  14 passed (14)` | `Tests  144 passed (144)` | `217.17s`（tests 211.28s） |

起点是 **141** 个用例，现在是 **144**：新增的是本票的三条（外壳侧一条端到端 + 插件侧一条
纯解析/真工具，加上 `tests/cleanup.spec.ts` 里那条裸 `rmSync` 守门用例）。没有删过任何用例，
只改了 `读不动的 state 是"还没有状态"…` 里**那一条断言**的期望值（见 §3.2 的理由）。

三次跑完 `Get-CimInstance Win32_Process -Filter "Name='electron.exe'"` 里带
`dsh-desktop-shell-test-*` 的进程数是 **0**；用户自己那个外壳进程（`shell/main.js --dsh`）
自始至终没被碰过。

---

## 6. 没能验证到的（诚实清单）

1. **"`destroyed: true` 且缺 `storagePath`/`url` 的记录"不是外壳能发布出来的**：
   探针把三条销毁途径都量了，`isDestroyed()` **一次也没为真**（§1）。现在外壳发布的
   `destroyed: true` 记录**字段是齐的**（§4.1 的原始输出）。所以插件侧那条用例的输入
   是**手工写的 state.json**（形状就是票面逐字那条），不是外壳真的写出来的东西。
   "外壳会写出那种记录"这件事我没有证实，只证实了"一条那样的记录会让整份状态不可读"。
2. **只量了 Windows 10.0.26200 + Electron 44.3.0**：`isDestroyed()` 的行为、
   `view.webContents` 变 undefined 的时机都是这个宿主的实测。别的 Electron 版本上
   "销毁态对象"是不是真的存在，**没有量**——所以 `liveContents()` 把两种形状都当"没了"处理，
   而不是假设只有一种。
3. **崩溃路径没有走完整条链路**：渲染进程崩溃（探针 A）之后 `webContents` 仍然活着
   （`isDestroyed()` false、`getURL()` 可读），所以那条路上外壳发布的是一张**正常**的表，
   里面那个空间的 targetId 已经不在端点上（`mergeTargetIds` 会把它标成 `unavailable`）。
   "崩溃之后那张表对插件够不够用"没有单独写用例。
4. **`window.close()` 之外的自然触发没复现**：本机没有观察到"用户正常使用中某个空间自己关掉"
   这件事真的发生。本文证明的是这条代码路径**能**被走到（而且走到了就崩），
   **没有**证明它在真实使用中出现过。
5. **`contentsGoneAt` 是加字段，`SPACE_PROTOCOL` 仍然是 `1`**：旧插件读新外壳会忽略它，
   新插件读旧外壳时它不存在 —— 兼容性**只由代码阅读保证**，没有做跨版本联跑。
6. **`skipped` 也是加字段**（`browser_space` 的输出 schema）：旧插件读新外壳没有这个字段，
   行为与以前一致；这次改动没有跑过"新插件 + 旧外壳"的组合。
7. **测试缝的历史行为没有回归**：`--fault-cdp-list` 那两条用例照常绿（§7 的整包摘要），
   但"启动那一次列举失败会怎样"仍然没有被覆盖（T7 诚实清单第 7 条，本次没动）。
