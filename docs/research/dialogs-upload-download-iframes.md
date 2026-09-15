# 长尾能力实测：对话框 / 上传 / 下载 / iframe（票 #10 / T9）

四条验收各有**真未知**，这一份是先把它们量出来的原始记录，代码是照着它写的。所有测量都在
**真外壳 + 真 `WebContentsView` + 真 `connectOverCDP`** 上做（`tests/shell-harness.ts` 起
Electron 进程），不是 Playwright 自带浏览器。

命令一律是：

```
npx vitest run tests/<探针>.spec.ts --reporter=verbose
```

探针文件是临时的（量完删掉），原始输出保存在 `.scratch/t9-probe*.txt`；**收尾时 `.scratch/`
整个删掉**，所以本文把关键行逐字抄在这里。

---

## 0. 一条贯穿全程的方法约束：**测对话框时只能有一个 Playwright 客户端**

`coreBundle.js:12975` 的 `dialogDidOpen`：

```js
let hasHandlers = false;
for (const handler of this._dialogHandlers) {
  if (handler(dialog)) hasHandlers = true;
}
if (!hasHandlers) dialog._close().then(() => {});
```

两件事由此确定：

1. **同步处理器等于没有处理器**。`page.on('dialog', (d) => { seen.push(d.message()) })` 返回
   `undefined`，于是 `hasHandlers` 是假，Playwright 自己把对话框关掉。只有**返回 promise**
   的处理器才算"有人负责"。
2. **任何第二个客户端都会替我们把对话框答掉**。测试里常见的"再连一个 Playwright 客户端去独
   立读页面"，恰好就是"另一个没有 `dialog` 监听器的客户端"，它会自动 dismiss。所以对话框与
   `beforeunload` 那两条只能用**会话自己那一个客户端**测（生产里也只有一个）；其余三条才用
   独立连接读回。这条在 `tests/longtail.spec.ts` 里用**按需建立**的探针连接实现。

---

## 1. 对话框：注册了处理器却不回答，页面真的会卡住

### 1.1 单客户端下的三种形状（探针六，`tests/t9-probe6.spec.ts`）

```
RAW S1 bare evaluate before open an alert: {"ms":2,"outcome":{"ok":true,"value":1,"ms":1}}
RAW S1 click open an alert: {"ms":2024,"outcome":{"ok":true,"ms":2024}}
RAW S1 log after open an alert: {"ok":true,"value":"alert-before @1789498455721\nalert-after @1789498455722","ms":1}
RAW S1 records after open an alert: [{"type":"alert","message":"the alert said: hello from the fixture","defaultPrompt":"","accept":false,...}]
RAW S1 bare evaluate after open an alert: {"ms":1,"outcome":{"ok":true,"value":1,"ms":1}}
RAW S1 click open a confirm: {"ms":2036,...}
RAW S1 log after open a confirm: {"value":"...confirm-before @1789498457787\nconfirm-returned=false @1789498457788\nconfirm-after @1789498457788"}
RAW S1 click open a prompt: {"ms":1976,...}
RAW S1 log after open a prompt: {"value":"...prompt-before @1789498459803"}
RAW S1 diagnostics after open a prompt: {"console":[...,{"type":"pageerror","text":"prompt() is not supported.","location":"<uncaught>"}],"failedRequests":[]}
RAW S2 a direct prompt() call: {"ok":true,"value":"{\"out\":\"threw: Error: prompt() is not supported.\",\"ms\":0}","ms":1}
RAW S2 a direct alert() call: {"ok":true,"value":"1","ms":2}
```

读出来的四件事：

- **`alert` / `confirm` 在这台宿主上会被立刻答复**：页面自己的时钟显示"弹之前"与"拿到返回值"
  相差 **1 毫秒**（`confirm-returned=false` 与 `confirm-before` 同一毫秒），页面从不阻塞。
- **`prompt()` 在这台宿主上不存在**：Electron 的嵌入层直接抛 `prompt() is not supported.`
  （`pageerror`，`browser_diagnostics` 看得见），于是 `prompt()` 之后那一行永远不执行、也没有
  任何对话框事件。这是**宿主事实**，不是策略问题 —— 我们的 prompt 策略有纯逻辑覆盖，但这台
  宿主上永远走不到那里（见诚实清单）。
- **一次"会弹对话框"的点击本身要 ~2 秒**（2024 / 2036 / 1976ms）。页面时钟证明这 2 秒**不是**
  页面被挡住（对话框 1ms 就答完了）：它是 Chromium 在这次输入事件的回执上等了那么久。它有界、
  远小于 30s 的动作超时，所以是可接受代价，但它确实是"点一下带对话框的按钮"的真实开销。
- `dialog.defaultValue` 拿得到（prompt 的默认输入），`dialog.message()` 就是对话框上的文本。

### 1.2 "注册了处理器却不回答"的**反证**（探针一 M5a / 探针二的对照）

探针二 P2（单客户端、同步处理器，**等于没有处理器**）：

```
RAW P2 alert with no listener: {"ok":true,"value":"evaluate returned","ms":5}
RAW P2 alert with a non-answering listener: {"ok":true,"ms":25}
RAW P2 dialog payload: ["alert|probe alert with a listener that never answers|"]
RAW P2 dismiss failed: Error: dialog.dismiss: Protocol error (Page.handleJavaScriptDialog): No dialog is showing
```

同步处理器**不**阻塞 —— 因为 Playwright 把它当成"没人管"。换成 **async 处理器并让它悬着**
（探针四 Q2）：

```
RAW Q2 the evaluate while the handler is held: {"ok":false,"error":"TIMED-OUT","ms":4006}
RAW Q2 is the evaluate still pending: true
RAW Q2 the page is blocked (a fresh evaluate cannot land): {"ok":false,"error":"TIMED-OUT","ms":3005}
RAW Q2 after the handler answered: {"late":"evaluate returned",...}
RAW Q2 the page answers again: {"ok":true,"value":"landed","ms":1}
```

**页面真的被卡住**：处理器悬着的时候，连一个新的 `page.evaluate` 都落不下去；处理器一答复，
挂起的那个立刻返回。这正是派工书警告的那件事，而且它只在 async 处理器上成立。

于是**默认策略只能是"立即答复"**：能答复对话框的那个人（模型）此刻正卡在那个动作里，
把对话框留给它稍后答复在设计上就是死锁。

### 1.3 `beforeunload` 是特例，而且**接受它反而更糟**

（探针三 P5、探针五 R1/R2/R3、探针六）

```
RAW P5 clicking the link away (no dialog listener): {"ok":false,"error":"locator.click: Timeout 30000ms exceeded...
      - click action done
      - waiting for scheduled navigations to finish","ms":30004}
RAW P5 the page is now at: http://127.0.0.1:57852/dialogs

RAW R1 clicking the guarded link with an accepting handler: {...,"error":"locator.click: Timeout 10000ms exceeded ...
      - waiting for scheduled navigations to finish","ms":10006}
RAW R1 dialog events: ["beforeunload|"]
RAW R1 the page is now at: http://127.0.0.1:54321/dialogs

RAW R2 clicking the guarded link with a dismissing handler: {"ok":true,"ms":53}
RAW R2 dialog events: ["beforeunload|"]
RAW R2 the page is now at: http://127.0.0.1:52300/dialogs

RAW P3 goto with a guard armed and no listener: {"ok":false,"error":"page.goto: net::ERR_ABORTED ...","ms":5}
RAW R3 goto with an accepting handler: {"ok":false,"error":"page.goto: net::ERR_ABORTED ...","ms":4}
```

- `beforeunload` 走的是**同一个** `dialog` 事件，`type === 'beforeunload'`，而 **`message` 是空的**
  （Chromium 不把它的文案交出来）。
- **没有任何处理器时**，点一条受保护的链接会让这次点击**挂满 30s 超时**（P5）——这就是"对话框
  卡住 Agent"的真实一例，而且是今天就在发生的一例。
- **接受它并不让导航通过**：`goto` 无论接受还是拒绝都是 `net::ERR_ABORTED` 且页面留在原地；
  点击在"接受"下挂满超时（R1），在"拒绝"下 **53ms** 就返回（R2）。
- 所以固定规则是：**`beforeunload` 恒 dismiss**，并把这条对话框记下来，让动作/导航的失败有话说
  （`ViewActionError('page-guard')`），而不是留一句 `net::ERR_ABORTED`。

### 1.4 反证：把处理器摘掉，两条对话框用例变红（原始症状）

```
# DSH_T9_REVERT=dialogs（处理器注册了但立即 return，等于"不回答"）
→ Test timed out in 120000ms.          （点 confirm 的那次点击再也没有回来）
→ page.goto: Timeout 30000ms exceeded. （受 beforeunload 保护页面上的 goto）
 Test Files  1 failed (1)
      Tests  2 failed | 20 skipped (22)
```

注意这里比 P5 更狠：**注册了处理器却让它悬着，比完全不注册还糟** —— 完全不注册时 Playwright
会自己 dismiss（`goto` 5ms 内 `ERR_ABORTED`），注册了不回答则把 `goto` 拖满 30s。

---

## 2. 上传：文件输入通常藏起来，而快照只列可见元素

### 2.1 今天快照里看得见什么（探针一 M1）

```
RAW M1 snapshot elements: [{"ref":1,"role":"textbox","name":"","bounds":{"x":8,"y":122.17,"width":252.67,"height":25.33}}]
RAW M1 SNAPSHOT_SELECTOR matches: 1
RAW M1 page-side inputs and labels: [
  {"tag":"input","id":"up-hidden","box":"0x0","computedDisplay":"none","forTarget":""},
  {"tag":"label","id":"up-label","box":"163.51x30","computedDisplay":"inline-block","forTarget":"up-hidden"},
  {"tag":"input","id":"up-visible","box":"252.67x25.33","computedDisplay":"block","forTarget":""}]
```

- 藏起来的 `<input type=file style="display:none">` **不在快照里**（继承的"隐藏元素不进快照"，
  ADR-0005），这是对的。
- 但它那个**可见**的 `<label for>` 也不在 —— 因为 `<label>` 不匹配 `SNAPSHOT_SELECTOR`。于是
  这个页面上**没有任何 ref 碰得到这次上传**。

### 2.2 `filechooser` 在我们的领养路径上会触发（探针四 Q1 的时间线）

```
RAW Q1 click result: {"ok":true,"ms":61}
RAW Q1 page log: "name=upload-me.txt size=57 content=t9-upload-fixture: the file the agent hands to the page.\n"
RAW Q1 the hidden input holds: {"files":1,"name":"upload-me.txt"}
RAW Q1 timeline: ["click returned@+63ms","filechooser event@+64ms","setFiles returned@+72ms","page log read@+119ms"]
```

- **`filechooser` 事件在点击返回后约 1ms 到达**，`setFiles` 真的把文件交进了页面：页面自己
  把 name / size / **内容**都写了出来（这一条是独立读回的基准）。
- 对照组：对**藏起来的** input 直接 `setInputFiles` 也成功（7ms）。两条路都通，而"点可见 ref
  → 接住 file chooser"这条路不必打破 ADR-0001，所以它是首选。
- 一个副产品：**没有 `filechooser` 监听器时，点击会走原生文件对话框**（Playwright 只有在有
  监听器时才启用拦截）。所以上传一律走 `browser_upload`，不要用 `browser_click` 去点文件输入。

### 2.3 结论：需要把"可见 label、且它标注的控件没被列出"这一类列进快照（ADR-0012）

规则保持**通用**（不写死成 file input）：真实站点里"隐藏真控件 + 可见 label"最常见的是自定
义样式的复选框/单选框，那类控件今天同样"看得见却动不了"。验收方式见 §5 与 ADR-0012。

---

## 3. 下载：`download` 事件会来，**但文件不落盘**

### 3.1 今天（只有 Playwright）的形状（探针四 Q4 之前的对照，探针二 P4）

```
RAW P4 clicking the download link: {"ok":true,"ms":62}
RAW P4 waitForEvent(download): {"ok":true,"value":"report.txt","ms":0}
RAW P4 download listeners: ["report.txt|http://127.0.0.1:55248/download/report.txt"]
RAW P4 the page is still responsive: {"ok":true,"value":"download-page","ms":2}
RAW P4 download.path(): {"ok":false,"error":"TIMED-OUT","ms":8005}
RAW P4 download.failure(): {"ok":false,"error":"TIMED-OUT","ms":8009}
RAW P4 download.saveAs(): {"ok":false,"error":"TIMED-OUT","ms":8012}
RAW P4 saved file exists: false
RAW P4 Downloads entries mentioning report after: []
```

- **`download` 事件会来**（listener 与 `waitForEvent` 都收到 `report.txt`），页面不受影响。
- 但 **`download.path()` / `failure()` / `saveAs()` 全部挂死**，文件既不进 `Downloads` 也不进
  `playwright-artifacts-*`（把那些目录逐个打开找过，没有任何一个含夹具那串字节）。
- 原因由 Electron 自己的 typings 坐实（`electron.d.ts:8350`）：

  > *The API is only available in session's `will-download` callback function. If `path` doesn't
  > exist, Electron will try to make the directory recursively. If user doesn't set the save path
  > via the API, Electron will use the original routine to determine the save path; **this usually
  > prompts a save dialog**.*

  也就是说：一个没人回答的原生"另存为"对话框把下载挂在那儿了 —— Agent 驱动下**没有第二个人
  去点它**，于是下载永远不完成。

### 3.2 加上外壳的 `will-download`（临时插桩，探针四 Q4）

```
RAW Q4 waitForEvent(download): {"ok":true,"value":"report.txt","ms":1}
RAW Q4 download.path(): {"ok":true,"value":"C:\\...\\playwright-artifacts-xapp7h\\3789a842-a669-46bc-a868-7c110f8d4030","ms":210}
RAW Q4 download.failure(): {"ok":true,"value":null,"ms":1}
RAW Q4 download.saveAs(): {"ok":false,"error":"download.saveAs: ENOENT: no such file or directory, copyfile
      'C:\\...\\playwright-artifacts-xapp7h\\3789a842-...' -> 'C:\\...\\saved-report.txt'","ms":1}
RAW Q4 shell DOWNLOAD record: {"url":".../download/report.txt","filename":"report.txt","before":""}
RAW Q4 shell DOWNLOAD_DONE record: {"state":"completed","savePath":"C:\\...\\dsh-desktop-shell-test-aprpsJ\\downloads\\report.txt"}
RAW Q4 shell download dir: ["report.txt"]
RAW Q4 file on disk: "t9-download-fixture: the report body, written by the fixture server.\nline two.\n"
```

**这是本节最重要的一条**：外壳一设 `setSavePath`，下载立刻完成（210ms），文件内容与夹具逐字
一致；而 **`download.path()` 解析出来的 `playwright-artifacts-*/<GUID>` 里根本没有文件**，
`saveAs()` 直接 `ENOENT`。

⇒ 结论（写进 ADR-0011）：**插件侧绝不使用 `download.path()` / `saveAs()` 报落盘位置**；落盘
位置只有一个来源 —— 外壳在 `will-download` 里真正设过的那个路径，而且插件要先 `stat` 再读。

### 3.3 反证：把外壳的 `will-download` 摘掉

```
# DSH_T9_REVERT=downloads
→ browser-view: the shell has published no download journal at ...\spaces\downloads.json (ENOENT ...)
 Test Files  1 failed (1)
      Tests  3 failed | 19 skipped (22)
```

没有处理器 ⇒ 没有日志、没有文件、内容预览无从谈起 —— 三条下载用例全红。

---

## 4. iframe：快照今天看不到框架里的元素

### 4.1 今天（探针一 M4）

```
RAW M4 snapshot elements: [{"ref":1,"role":"button","name":"top button","bounds":{...}}]
RAW M4 page.frames(): [{"name":"","url":".../frames?cross=..."},
                       {"name":"frames-same","url":"http://127.0.0.1:58755/frame-inner"},
                       {"name":"frames-cross","url":"http://127.0.0.1:55412/frame-inner"}]
RAW M4 #fi-button via page.locator: 0
RAW M4 #fi-button via the same-origin frame: 0
RAW M4 #xo-button via the cross-origin frame: 1
RAW M4 elementHandle from the same-origin frame: {"ok":true,"value":"handle ok","ms":20}
RAW M4 elementHandle from the cross-origin frame: {"ok":true,"value":"handle ok","ms":19}
RAW M4 overlay in the top document: top:true
RAW M4 overlay in frame http://127.0.0.1:58755/frame-inner: {"ok":true,"value":false,"ms":1}
RAW M4 overlay in frame http://127.0.0.1:55412/frame-inner: {"ok":true,"value":false,"ms":1}
```

- 快照今天只列主框架：同源与跨源框架里的控件**一个都不列**。
- `page.frames()` 两种框架都拿得到；`frame.locator(...).elementHandle()` 两种都成功 ⇒ **跨源
  框架照样能拿到句柄**（CDP 的 DOM 域按 frame 走，不受同源策略限制）。
- **T8 的覆盖层守卫在每个框架上都仍然成立**：同源与跨源框架里都没有覆盖层容器
  （`mountOverlay` 的 `window.top !== window` 早退）。iframe 支持必须保住这一条，见 §5。

（`#fi-button via the same-origin frame` 打了个 0，是因为那次用的 `frame({url: /frame-inner/})`
匹配到了**先出现的那个**框架 —— 一个探针写法问题，不是能力问题；后面用 `frames().find(...)`
逐项读回就都对了。）

### 4.2 bounds 必须是**这一块视图**的坐标

框架内元素的 `getBoundingClientRect()` 是相对**框架自己视口**的。快照的 bounds 与覆盖层、
命中测试共用一套视口坐标（ADR-0007），所以必须把框架链的偏移加上去。独立读回的判据是引擎
自己的 box model（探针/测例里 `locator.boundingBox()` 给的就是主视口坐标）：

```
RAW 两侧的矩形: {"sameInSnapshot":{"x":14.666667,"y":110.166667,...},
                 "sameBox":{"x":14.666666984558105,"y":110.16667175292969,...},
                 "crossInSnapshot":{"x":14.666667,"y":257.50001050585934,...},
                 "crossBox":{"x":14.666666984558105,"y":257.5,...}}
RAW 框架内的局部坐标: {"x":6,"y":6}
```

两条独立的路给出同一个矩形（差 < 0.5px），而框架内的局部坐标（6,6）与它不是一回事 ——
反证就是把偏移那一步去掉：`expected 8.666666984558105 to be less than 0.5`。

---

## 5. 反证（把每一处修复回退掉，对应的用例必须变红）

| # | 回退的地方 | 原始症状 |
|---|---|---|
| 1 | 对话框处理器（注册但不回答） | `Test timed out in 120000ms`（点击再也回不来）＋ `page.goto: Timeout 30000ms exceeded` |
| 2 | 快照收集里的"覆盖层节点不进快照" | 注入的 `a ghost label inside the overlay` **出现在快照里** → `expected [...] to deeply equal [...]` |
| 3 | 框架元素的 bounds 偏移 | `expected 8.666666984558105 to be less than 0.5` |
| 4 | 第二类元素（可见 label） | 上传页快照只剩 1 个元素（那个可见 file input），label 没有 ref → `expected [ {ref:1,...} ] to have a length of 2 but got 1` |
| 5 | 外壳的 `will-download` | `no download journal ... (ENOENT)`：没有日志、没有文件、预览无从谈起（3 条全红） |

T8 那条"鬼元素"守卫**没有被放松**：`选择器匹配 + 新类里该进的那些 − 落在覆盖层里的 == 快照列出的数`
是**精算**，而"覆盖层里的节点一个都不许被列出来"两类选择器都查（回退 #2 时它变红）。

---

## 6. 诚实清单（这一轮没能验证到的）

1. **`prompt()` 在这台宿主上不存在**：Electron 抛 `prompt() is not supported.`（§1.1）。我们
   的 prompt 策略只有纯逻辑覆盖，**从未在真宿主上走通一次**；`defaultPrompt` 也只在探针里见过
   一次（探针一 M5c 里读到 `default-name`，那一次是探针自己接的对话框，不是我们的处理器）。
2. **一次"会弹对话框"的点击有 ~2 秒开销**（Chromium 在输入事件回执上的等待）。有界、已量，
   但没有消除；没有把它的机制定位到具体某一行 Chromium 代码。
3. **`browser_upload` 的第三类失败（chooser 来了但 `setFiles` 失败）没有被确定性触发过**：
   分支与文案都在，但要让它发生得让文件在 `stat` 与 `setFiles` 之间消失，那不是一个确定性夹具。
4. **框架内元素不做父文档方向的滚动**：`scrollIntoViewIfNeeded` 对框架内元素是否会把父文档
   一起滚进视口，没有测（夹具里框架一直在视口内），也没有为它写代码。
5. **`browser_extract` 仍然只读主文档的 `innerText`**：框架里的**文本**（不是元素）今天读不到；
   验收第 4 条要的"读 iframe 内的元素"由快照（角色/名字/坐标）与动作（点/填）承担。
6. **每个框架的滚动与缩放**：框架内部自己的滚动只影响框架内坐标，本次没有做"框架内滚动 +
   父文档偏移"叠加的极端用例。
7. **下载的 `interrupted` / `cancelled` 两条状态**只有纯逻辑覆盖（构造的日志），没有在真宿主上
   真的中断过一次下载。
8. **多个空间同时下载**没有测：处理器装在**每个空间**的 session 上（代码如此），但只用默认空间
   跑过。
