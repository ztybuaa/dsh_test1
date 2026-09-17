# 票 #20 E —— 面板按一次的那 0.9 秒，究竟花在哪

**结论先说**：票面那条怀疑（*"外壳每次发布去列举调试目标 / 每个空间问一次 `cookies.get({})`"*）
**被实测否掉了**：在一次发布里，列举目标 0–2 ms、`cookies.get({})` 0–1 ms（**三个空间时也只要
0–1 ms**），整次发布 1–8 ms。真正吃掉 0.9 秒的是**会话在缩放之后等的那一帧**
（`src/session.ts` 的 `settle()`：`requestAnimationFrame`）。这一页在没有前台焦点/不被合成的时候
**几乎不出帧**（实测：500 ms 里 0–1 帧），于是"等一帧"变成"等最多一秒"。

原始输出全部是本次亲跑的，命令与文件见文末。

---

## 1. 量具与量法

一台真外壳（真 Electron 44）+ 真 `dsh` 宿主 + 真插件，临时 `--user-data-dir` 与临时 `DSH_HOME`。
面板那一按**不经过 DOM**，而是照 `tests/panel-toolbar.spec.ts` 已经验过的那种方式，
用**逐字段相同的信封**发到真宿主：`POST http://127.0.0.1:<port>/api/desktop-view-<action>`，
带 `?token=` 换来的会话 cookie 与同源 `Origin`。

四组动作各按 6 次（`auto` 3 次），取中位数：

| 动作 | 走的路 |
|---|---|
| `state` | 只有 HTTP 往返 + 宿主一次 `displayState()` —— **不写空间请求** |
| `zoom-in` / `zoom-reset` | 完整那条路（写 `request.json` → 外壳 150 ms 轮询 → 应用缩放 → 发布 → 插件 50 ms 轮询 → 回答） |
| `auto` | 同上，外加外壳那一轮自动适配 |

外壳那一侧加了临时计时（`DSH_SHELL TIMING {...}` 打在 stdout 上）：`listTargetsForPublish()`、
逐空间 `cookies.get({})`、`describeSpaces` 总时长、写 `state.json`、`emit`；
另外在轮询里记下"请求在文件里躺了多久才被捡起来"（`poll-pickup.satMs`，
拿 `request.json` 的 `mtime` 当写下的时刻）。

宿主那一侧也用临时计时（`T20-PROBE {...}`，打在 stderr 上，由外壳转成
`DSH_SHELL HOST_STDERR`）：`adopt()`、`stepZoom` 的 `refreshZoom`、`zoomTo` 里的
`setZoom` / `settle` / 读回、`SpaceManager.requestZoom` 的写与等待。

---

## 2. 顶层数字（窗口**可见**，`windowVisible: true`）

```
RAW T20 LATENCY {
  "state":       [20, 15, 15, 16, 15, 15],       // 中位数 15 ms
  "zoomIn":      [407, 403, 1017, 1017, 1017, 1016],  // 中位数 1017 ms
  "zoomReset":   [996, 1001, 1016, 1017, 1016, 1000], // 中位数 1011 ms
  "auto":        [1000, 1000, 1015],                  // 中位数 1017 ms
  "stateMedian": 15,
  "zoomInMedian": 1017,
  "zoomResetMedian": 1011,
  "autoMedian": 1017
}
```

**第一刀就把票面那条路的两个假设切开了**：纯读回（HTTP + 宿主 `displayState`）**15 ms**，
而带缩放的三个动作都是 **~1010 ms**。多出来的 ~1000 ms 不在 HTTP 上，也不在"读回"上，
只在"**做了一次缩放**"上。

> 窗口隐藏（`windowsHide: true`，本套件一直以来的跑法）时数字一样：
> `state` 中位数 10 ms、`zoomIn` 中位数 1017 ms。**所以这不是"隐藏窗口才有"的现象**，
> 见 §5 的进一步测量。

---

## 3. 外壳那一侧：发布很便宜（票面的怀疑在这里被否掉）

一次发布的全部拆解（原始行，`DSH_SHELL TIMING`）：

```
{"cause":"describeSpaces","listTargetsMs":2,"cookiesMs":1,"spaces":1,"totalMs":3}
{"cause":"publish:request","describeMs":3,"writeStateMs":5,"emitMs":0,"totalMs":8}
{"cause":"poll-pickup","id":2,"satMs":106}
```

同一个窗口里 17 次请求的统计（1 个空间）：

| 项 | 每次 |
|---|---|
| `listTargetsForPublish()`（回环 `GET /json/list`） | **0–2 ms** |
| 逐空间 `cookies.get({})`（1 个空间） | **0–1 ms** |
| `describeSpaces` 合计 | 0–3 ms |
| 写 `state.json` + 写 `zoom.json` | 3–6 ms |
| `emit`（把整张表打到 stdout） | 0–1 ms |
| **一次发布合计** | **4–8 ms** |
| 请求在 `request.json` 里躺到被捡起来 | **12–137 ms**（`SPACE_POLL_MS = 150`） |

**多开两个空间之后**（`RAW T20 SPACES ["default","t20-a","t20-b"]`）：

```
{"cause":"describeSpaces","listTargetsMs":0,"cookiesMs":0,"spaces":3,"totalMs":5}
{"cause":"describeSpaces","listTargetsMs":1,"cookiesMs":0,"spaces":3,"totalMs":1}
```

`RAW T20 LATENCY THREE SPACES {"three":[839,1016,1017,1016,1017,1002],"median":1016}` ——
**三个空间时按一次仍然是 1016 ms，而 `cookies.get({})` 三次合计仍是 0–1 ms。**

⇒ 票面那句"那个 cookie 数出现在发布路径上、发布承担了展示成本"**在数量上不成立**：
把 `cookieCount` 挪走能省下的是 **1 ms 量级**，不是 0.9 秒。按票面的规矩
（"只优化证实的大头"），**本次没有为它改任何东西**。

---

## 4. 宿主那一侧：请求本身也只花 ~150 ms

```
T20-PROBE adopt {"action":"zoom-in","ms":0}
T20-PROBE awaitRequest polls=4 ms=151          ← SpaceManager 等外壳处理完 requestId
T20-PROBE requestZoom {"id":1,"writeMs":3,"awaitMs":151,"totalMs":154,"pollMs":50}
T20-PROBE zoomTo {"setZoomMs":154,"settleMs":922,"readingMs":3}
T20-PROBE stepZoom {"refreshMs":0,"zoomToMs":1080}
```

- `refreshZoom()`（读 `zoom.json`，票 #19 加的）：**0–1 ms**；
- `zoomPort.setZoom()` 整段（写 `request.json` + 等外壳 + 读回）：**58–189 ms**；
- `settle()`：**570–952 ms** ← **就是它**；
- 缩放之后从页面读回：**0–6 ms**。

同一批里 `state` 的宿主侧是 1–3 ms、`adopt()` 0–1 ms。**除了 `settle()`，没有任何一段超过 200 ms。**

---

## 5. `settle()` 为什么慢：这一页不被合成时几乎不出帧

`settle()` 的实现是（票前）：

```ts
await this.page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
```

同一个窗口里，用**另一条** CDP 连接在**同一页**上直接量一次裸 rAF：

```
RAW T20 RAF before zooms {"rafMs":32,"visibility":"visible"}
RAW T20 RAF after zooms  {"rafMs":27,"visibility":"visible"}
RAW T20 RAF at the end   {"rafMs":23,"visibility":"visible"}
RAW T20 RAF on the window page {"rafMs":12,"visibility":"visible"}
```

**裸 rAF 是 12–32 ms**，而 `settle()` 里同样的 rAF 是 570–952 ms。差别不是"这一页的 rAF 被
恒定节流"，而是**它只有在"有东西要画"的时候才出帧**。用一个常驻 rAF 心跳量：

```
RAW T20 HEARTBEAT {"idleBeats":1,"idleWindow":1,"pressMs":347,
  "duringRaf":{"rafMs":19,"visibility":"visible"},
  "beatsDuring":1,"gaps":{"count":1,"maxGap":0},
  "focus":{"hasFocus":false,"visibility":"visible"}}
```

- **静息 500 ms 里只出了 0–1 帧**（而页面上有一个**一直在排队**的 rAF 回调）；
- 那一刻 `document.visibilityState` 是 `visible`，但 **`document.hasFocus()` 是 `false`**；
- 装了常驻心跳之后，同一次缩放只需要 **347 ms**（等到了那稀少的一帧），而不是 ~1000 ms。

也就是说：**这个 `WebContentsView` 的页面在没有前台焦点/不被合成时，帧的产出掉到 ~1–2 Hz**，
而 `settle()` 恰好把"一次动作的成败"压在了"下一帧"上 —— 于是它成了那条路上唯一的、
也是最大的一笔开销。

**这也解释了票 #17 记的那个 1005–1016 ms**：数字与本次实测的 1000–1017 ms 同量级、
同样"非常稳定地卡在 1 秒附近"，正是"等一个 ~1 Hz 的帧"的形状。

---

## 6. 因此本次的修法（只动证实的那一处）

`settle()` 要的从来不是"一帧"，而是"**布局已经按新的缩放算过**"。所以改成：

1. 用一次**同步强制布局**（读 `document.documentElement.scrollHeight`）把布局冲出来 ——
   它不经过合成器，因此**不受出帧节奏影响**；
2. 把这一次读到的三件事（`innerWidth` / `innerHeight` / `devicePixelRatio`）与
   **上一次从页面读回来的那一份**对照，看它有没有跟上外壳说的那个缩放；
3. 跟不上就在一个**有界窗口**内重试几次（`SETTLE_BUDGET_MS = 1000`，每 10 ms 一次）；
   窗口用完就**如实返回读到的东西**，不编一个数（与仓库一贯的规矩一致：读不到 ≠ 猜一个）。

**那个窗口不是延迟，是上界**：第一次读就对上了就立刻返回 —— 实测常态就是这样，
整个动作 **119–175 ms**（`tests/panel-toolbar.spec.ts` 的 `coldMs` / `warmMs`）。
给它 1 秒不是随手写的：**票前那个实现等的就是一帧，而这一页不被合成时一帧正好 ~1 秒**，
所以这个上界**等于**票前那次等待 —— 最坏情况一模一样，常态从 ~1 秒降到几十毫秒。

> 第一版给的是 200 ms。整包连跑三轮时，第二轮在 `tests/view-actions.spec.ts` 的
> "dpr 与截图尺寸都跟着 zoom 变"那一组上红过一次（其余两轮全绿，单独跑那一份也全绿、
> 数字逐项正确）。那个形状正是"这一轮机器被占满，渲染进程还没把那一次缩放应用上去" ——
> 也就是这个窗口给窄了的代价。所以放宽到"不会更差"的那个上界。

这条修法**没有**碰票面点名的四件禁止事项：没有调大任何超时、没有缩短任何轮询间隔、
没有破 `shell/preload.js` 的边界、没有让面板直接够到 Electron API。
（`SETTLE_BUDGET_MS` 是**等一个事实的上界**，不是任何通道的超时；超时那件事见 §7。）

---

## 7. 顺带回答：它同不同意"机器忙时空间通道偶发 30 秒超时"的根因？

**不同意，至少没有证据支持票面那条因果。**

- 那条路径上**与"每次发布"绑定的**两笔开销（列举目标、逐空间 `cookies.get({})`）实测是
  **0–2 ms 与 0–1 ms**，三个空间也一样。把它们挪走省不下任何可以解释 30 秒的东西。
- 路径上真正的"预算消耗者"按大小排是：
  1. `settle()` 的等帧 **570–952 ms**（机器越忙、窗口越不被合成，它越靠近 1 秒）；
  2. 外壳 `request.json` 轮询 **12–137 ms**（`SPACE_POLL_MS = 150`，这是刻意的设计，
     不是缺陷）；
  3. 插件 `state.json` 轮询 **≤50 ms**（`DEFAULT_POLL_MS = 50`）；
  4. HTTP + 宿主读回 **10–20 ms**；外壳一次发布 **4–8 ms**。
- 把 1 修掉之后，同一条路上每次动作会少掉那 ~0.9 秒 —— 那**确实**会减少"忙时超时"的概率
  （因为超时预算被别的东西吃掉的时间变少了），但这是**推断**，不是本次量到的事实：
  **那 3 次 30 秒超时本次没能复现**（要复现得把机器真的占满，本轮做不到）。
  所以这句话在报告里只能写成"**疑似相关、未证实**"，不能写成"同根因已确认"。
- 30 秒那个超时预算本身**本次没有动**（票面明令不许调大），也没有为它做任何测量上的结论。

---

## 8. 原始输出在哪、怎么重跑

本轮的量具是一个**临时**探针（`tests/t20-latency-probe.spec.ts`，收尾时已删除）加上
`shell/main.js` / `src/view-rpc.ts` / `src/view-host.ts` / `src/session.ts` / `src/spaces.ts`
里的临时计时（`T20-PROBE` / `DSH_SHELL TIMING`，收尾时已全部还原）。原始输出留档：

| 文件 | 是什么 |
|---|---|
| `.scratch/t20-latency-run1.txt` | 隐藏窗口，第一次拆解（`state` 10 ms vs `zoom` 1017 ms + 外壳计时） |
| `.scratch/t20-latency-visible.txt` | 同上，窗口**可见** |
| `.scratch/t20-probe4.txt` | 宿主侧计时接入之后（`settleMs` 现身） |
| `.scratch/t20-probe5-visible.txt` | 可见窗口 + 裸 rAF 对照（12–32 ms vs `settleMs` 570–952 ms） |
| `.scratch/t20-probe6.txt` | 心跳测量 + 三个空间（`cookiesMs` 仍为 0–1 ms） |

`.scratch/` 是 gitignore 的临时目录，不进版本库；本文摘录了其中的关键行。
重跑方式（临时探针已删，需要时按本文 §1 的量法重建）：

```pwsh
npx vitest run --config vitest.config.ts tests/t20-latency-probe.spec.ts          # 隐藏窗口
$env:T20_VISIBLE='1'; npx vitest run --config vitest.config.ts tests/t20-latency-probe.spec.ts  # 可见窗口
```

改完之后**整包连续三次全绿**（27 个文件 / 238 条用例，`exit=0`；原始输出在
`.scratch/t20-greens2.txt`），而面板那一按的实测值变成了
`coldMs=167 / warmMs=119`（`tests/panel-toolbar.spec.ts` 打印的那一行）。

---

## 9. 本文**没有**证明的事（诚实清单）

1. **没能复现**那 3 次"空间通道 30 秒超时"，因此 §7 的因果判断只是**否掉了票面那条怀疑**，
   并没有给出真正的根因。要做得把机器真的占满（微信/任务管理器/浏览器一起开），本轮做不到。
2. **没在"有前台焦点"的窗口里量过**：本轮可见窗口的 `document.hasFocus()` 是 `false`
   （测试窗口开在别的窗口后面）。所以"帧产出掉到 1–2 Hz"这句话的**前提条件**是
   "窗口不是前台/不被合成"——前台窗口下会不会同样慢，本轮**没有量到**，
   只能说修法（不依赖帧）在两种情况下都成立。
3. `listTargets` / `cookies.get({})` 的代价**只在这台机器、这个规模上量过**（1 个与 3 个空间、
   本机回环）。空间数很多、或 cookie 罐很大时会不会变贵，本轮没有量。
4. 那 0.9 秒与"机器忙"之间的关系只有 §7 的**推断**，没有负载实验支撑。
