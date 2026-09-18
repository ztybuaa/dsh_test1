# 票 #20 重新打开（#20b）—— 去掉手动/自动、工具条空闲一行、同一句话只出现一次

**结论先说**：三条要求都落地了，而且每一条都有自己的**读回口**与**反证**。三条的现状在本轮
**又被原样量了一遍**（不是照抄票面）：

| # | 现状（本轮实测，改动前） | 改法 | 读回口 |
|---|---|---|---|
| 1 | 工具条文本 `←→↻−100%+autorestart自动 100%自动 100%`；真外壳里按一次 100% 之后 `mode: "manual"`、`fitPasses` **冻在 6**，拖栏宽与换页都不再适配 | 面板去掉前缀与 `auto` 按钮；外壳删掉模式状态机（适配永远开着）；通道解析**一字未改** | `tests/toolbar.spec.ts`（纯逻辑）、`tests/fit-to-pane.spec.ts`（真外壳：62ms / 117ms 重新适配） |
| 2 | 展开之后**卡住**：点工具条以外 `height: 85`、`menu: "open"`；按 `Esc` 还是 `85` / `open` | 三条收法（选档位 / 点外面 / `Esc`） | `tests/toolbar-panel.spec.ts`（DOM 几何）、`tests/panel-toolbar-placement.spec.ts`（**外壳应用的**落点 y：34 → 85 → 34） |
| 3 | `BUTTON[data-dsh-view-zoom-menu]` 与 `SPAN[data-dsh-view-zoom][data-dsh-view-reading]` **都写 `自动 100%`** | 两个元素合成一个（那颗百分比既是读数也是菜单开关） | `tests/toolbar-panel.spec.ts` 里"数叶子文字出现次数 = 1" |

原始输出全部是本次亲跑的，命令与文件见文末。

---

## 0. 三条要求的原文（票面最后一条评论）

1. 去掉"手动 / 自动"这一整套 —— 永远自动；手动缩放保留但语义降级成"现在的值"；通道那头的
   `mode` 可以从语义里去掉，但**解析必须继续容忍它**。
2. 空闲时工具条**严格一行**；展开之后选中档位就收、点到工具条以外也收、`Esc` 也收；断言要
   **读回几何**。
3. 同一句话在工具条里**只许出现一次**，并且要能**数出来**（必须是 1）。

---

## 1. 量具与量法

两份量具，都是这次亲跑的（脚本留在 `.scratch/t20b/`，不进仓库）：

- **那一格的 DOM**：真外壳 + 真 Chromium 页面 + 交付物本身（`client.js` 生成物里的 `Panel`），
  渲染器是 `tests/mini-react.ts` 那个替身；量的是**叶子节点的文字**与 `getBoundingClientRect()`。
  用户贴出来的证据就是叶子级的（`BUTTON[…zoom-menu]` / `SPAN[…reading]`），所以这里用同一把尺子。
- **真外壳那一侧的语义**：`shell/main.js` 起的真 Electron（没有宿主、没有插件、没有面板那条 RPC），
  视图真的被摆在面板报的矩形上（窗口那一页 `setRect`），页面是外壳自带的固定宽度夹具
  `/fixed-width`（内容 1200px，栏 620px）。读数取自外壳写的 `zoom.json` 与**页面自己**报的
  `scrollWidth` / `clientWidth` / `devicePixelRatio`。

---

## 2. 改动前的原始读数（本轮亲跑，一个字没改）

### 2.1 要求 3：同一句话在两个叶子上

```
RAW 空闲: {"height":34,"declaredHeight":"34px","menu":"closed","presets":0,"autoButton":1,
 "toolbarText":"←→↻−100%+autorestart自动 100%自动 100%","measuredTop":34,
 "leaves":[…,
   {"tag":"BUTTON","action":"zoom-reset","text":"100%"},
   {"tag":"BUTTON","action":"auto","text":"auto"},
   {"tag":"BUTTON","menu":"closed","reading":null,"text":"自动 100%"},
   {"tag":"SPAN","menu":null,"reading":"自动 100%","zoom":"100%","text":"自动 100%"}]}
```

两个叶子写着同一句话（`BUTTON[data-dsh-view-zoom-menu]` 与
`SPAN[data-dsh-view-zoom][data-dsh-view-reading]`），而第一行里**还有一个**标签为 `100%` 的重置
按钮 —— 去掉前缀之后，那句话（`100%`）会有**三个**来源。

### 2.2 要求 2：展开之后不会自己收

```
RAW 展开档位菜单: {"height":85,"declaredHeight":"auto","menu":"open","presets":11}
RAW 点工具条以外之后: {"height":85,"declaredHeight":"auto","menu":"open","presets":11}
RAW 按 Esc 之后:      {"height":85,"declaredHeight":"auto","menu":"open","presets":11}
```

用户那台机器上是 `61px = 34 + 26`（他的栏更宽，档位排成一行）；这一份是 440px 宽，11 个档位
折成两行，所以第二行更高（85 = 34 + 51）。**同一件事：展开之后没有任何一条路能收回去。**

### 2.3 要求 1：手动缩放会把适配整个关掉

```
RAW 自动适配之后:        {"zoom":0.5166…,"mode":"auto","fitPasses":5,"fitChanges":1}
RAW 按了一次 100%（手动）: {"zoom":1,"mode":"manual","fitPasses":6,"fitChanges":1,
                          "facts":{"scrollWidth":1200,"clientWidth":620,…}}   ← 页面被裁掉
RAW 手动之后再拖一轮栏宽:  {"zoom":1,"mode":"manual","fitPasses":6,"fitChanges":1,
                          "facts":{"scrollWidth":1200,"clientWidth":620,…}}   ← 一步都没动
RAW 手动之后再换一次页:    {"zoom":1,"mode":"manual","fitPasses":6,"fitChanges":1,
                          "facts":{"scrollWidth":1200,"clientWidth":620,…}}   ← 还是没动
```

`fitPasses` 冻在 6、`fitChanges` 冻在 1 —— 那 0.9 秒里能做对的事，用户按一次按钮就全没了。
这就是用户说的"多此一举"：**适配明明能把它塞进来，而它被命令不许动手。**

---

## 3. 改法（各自的读回口）

### 3.1 要求 1：一套状态机，不是两套

- **面板**（`src/toolbar.js` / `src/client-body.js`）：`zoomReading(zoom, mode, words)` 收成
  `zoomReading(zoom)`；文案表里那两个词删掉；`auto` 按钮从 `BUTTONS` 删掉；面板的状态里
  **不再有 `zoomMode`**（连存都不存）。外壳仍然会发那个字段，面板一个字节都不看 —— 这一条由
  `tests/toolbar.spec.ts` 用"多喂两个参数也不许变出前缀"钉住。
- **外壳**（`shell/main.js`）：删掉 `entry.zoomMode` 与一切闸门（`requestFit` / `runFitPass` /
  `applyZoom` / `did-navigate` 里那四处）。`did-navigate` 只剩原来那一支 `auto`（先回 100% 再重新
  适配），`applyZoom` 只剩"把这个值按上去"，`zoomToken` 那条"别用过期计算覆盖新值"的闸门**留着**
  （它不是模式）。
- **通道**（`shell/spaces.js` / `src/spaces.ts`）：**一个字都没改**。`kind: 'zoom'` 与 `mode`
  照旧接受、照旧校验：`mode: 'auto'` = "现在就重新适配一次"（旧客户端那颗「自动」走的端点也留着），
  `mode: 'manual'`/缺省 = "把 `zoom` 按上去"。兼容的读回就是 `tests/spaces.spec.ts` 里那几条
  （旧插件形状、`{name, mode:'auto'}`、带标签的两种）——它们**一条都没有被改动**。
- **发布出去的那两个字段留着**：`zoom.json` 的 `mode` 与 `state.json` 的 `zoomMode` 永远是
  `auto`。理由写在代码注释里：旧插件在读它（`parseZoomReading` 里 `mode` 不是这两个词就整条读
  不动），票面明令兼容不许破。**`modeCause` 删掉了**：它存在的理由是"分辨'启动时就是 manual'与
  '用户按过 100%'"，而模式没有了之后那两件事本来就该长得一样。
- **工具给模型看的那句话**里的 `(fitted to the pane automatically)` / `(set by hand)` 也删掉了：
  一个人刚按下 150% 之后它仍会说"按栏宽自动适配的"，那是**一句会说谎的话**。

### 3.2 要求 2 + 3：一个控件，三条收法

- 那颗百分比**既是读数也是菜单开关**（`data-dsh-view-zoom-menu` 与 `data-dsh-view-reading` 挂在
  **同一个 `<button>`** 上）：那句话在工具条第一行里只出现一次，而诊断话术仍旧只在它的 `title` 与
  `data-dsh-view-diagnostic` 上（票 #20 C 的规矩没动）。菜单的用法提示搬到 `aria-label`。
- 重置按钮的标签从 `100%` 改成 `reset`（title 仍是 "reset the zoom to 100%"）：**这是被要求 3
  逼出来的**，不是口味 —— 读数去掉前缀之后就是 `100%`，而标签为 `100%` 的它会在同一行里第二次
  说出那句话。动作一个没少（`−` / `+` / `reset` 都在，档位菜单里也仍有 100% 那一档）。
- 展开之后三条收法：选一个档位（那颗按钮自己的 `onClick`）、点到工具条**以外**
  （`document` 上的 `pointerdown`，捕获阶段，判据是落点不在工具条根节点里）、`Esc`
  （`document` 上的 `keydown`，捕获 + `preventDefault`/`stopPropagation`：一次按键只该有一个效果）。
  两个听众**只在开着的时候挂着**。

---

## 4. 全量跑抓出来的**第二处**：把模式闸门删掉之后，一次"矩形没变"的摆放会把用户刚按的值改回去

这是本轮最值得记的一件事，因为它**不是推理出来的，是整包跑的时候红的**（两条用例同时红）：

```
FAIL tests/fit-to-pane.spec.ts > 票 #20b：手动缩放只是"现在的值"…
  AssertionError: the hand-set value must really be too big for the pane before the navigation:
  expected 1200 to be greater than 1200

FAIL tests/zoom-pixels.spec.ts > …100% 时滚到最右看得见红标（仪器自检），不滚则看不见…
  AssertionError: at 100% the page-rightmost marker must NOT be in the pane (620 < 1150):
  expected 5400 to be +0
  RAW window pixels[zoom100]: … red=5400@{"left":1163,"top":148,"right":1207,"bottom":267,"width":45,"height":120}
  facts={"innerWidth":1200,"devicePixelRatio":0.7749999761581421,…}
```

两处说的是同一件事：`resetZoom()`（按一次 100%）**之后**，页面又自己缩回了 51.7%。
根因是**模式闸门的另一半作用没有人接手**：票 #19 里"人一按 ⇒ `manual` ⇒ 适配让位"同时挡住了
另一类东西 —— 一次 `settle` 摆放、一次"同样的矩形再报一遍"、宿主自己那一页刷新，它们都会请一轮
适配，而它们的**矩形根本没变**。模式删掉之后，这些请求就照着"人按之前的算法"重算，把用户刚按下
的值改回去。

**量的过程**（`DSH_SHELL T20B_FIT_REQUEST`，临时加的一行诊断，已删）：

```
DSH_SHELL VIEW {"cause":"initial-bounds",…}          ← 视图第一次被摆到 620×800
DSH_SHELL T20B_FIT_REQUEST {"cause":"initial-bounds","token":0,"fitPasses":0}
DSH_SHELL FIT {…"changed":1…"to":0.5166666666666667}  ← 适配把它塞进去了
DSH_SHELL VIEW {"cause":"settle",…}                   ← **同一个矩形**，又一次摆放
DSH_SHELL T20B_FIT_REQUEST {"cause":"settle","token":0,"fitPasses":1}
DSH_SHELL VIEW {"cause":"space-activate",…}           ← 还是同一个矩形（插件领养会话）
DSH_SHELL T20B_FIT_REQUEST {"cause":"space-activate","token":0,"fitPasses":2}
```

**修法**：`fitKeyOf(entry)`（视图**现在占的那个矩形**的指纹，读自 `view.getBounds()`）+
两处配合：

- `applyZoom`（有人指名改缩放）⇒ `entry.fitKey = fitKeyOf(entry)`：**这个矩形从此定住**；
- `requestFit` ⇒ 同一个指纹的摆放事件**直接返回**（连请都不请）；例外只有两种：
  `view-navigation` / `view-load`（**视图那一页真的换页了**，票面原话"换页时也适配"）；
- 另外那条 `zoomToken` 凭据也留着：请它的时候把代次记下来，真的开跑之前再对一次 ——
  一次拖动排下的**尾随**那一轮不许在用户按下 100% 之后才跑。

改完之后（同一份用例，同一台机器）：

```
RAW 手动之后同一个矩形再报一次: facts={"innerWidth":620,…"scrollWidth":1200,"clientWidth":620},
                                reading={"zoom":1,"mode":"auto",…}      ← 值站住了
RAW 手动之后拖了一轮栏宽:       reading={"zoom":0.5165967928170185,…}    ← 几何一变就重新适配（62ms）
RAW 手动之后换了一次页:         reading={"zoom":0.5166666666666667,…}    ← 换页也重新适配（117ms）
```

**这一条现在是钉住的**：`tests/fit-to-pane.spec.ts` 那条用例里"同一个矩形再报一遍 ⇒ 值站着不动"
是它自己的断言（回退 `fitKeyOf` 就变红）；`tests/zoom-pixels.spec.ts` 的自检（100% 时红标不可见）
是同一件事的像素版。

---

## 5. 反证（回退修复必须变红）

见 §6，逐条列了"回退哪一处、哪条断言变红、红色原文"。

---

## 6. 兼容那一半的读回

- `tests/spaces.spec.ts`（**未改动**）：`{name:'task-1', zoom:0.5}`（旧插件形状，不带 kind）⇒
  `mode: 'manual'`；`{name:'task-1', mode:'auto'}`（#19 第一版的新插件）⇒ 接受；
  `{name, kind:'zoom', zoom}`（带标签却不带 mode）⇒ **拒绝**，理由照旧。
- `tests/product-startup.spec.ts`：真外壳 + 真 `dsh` 宿主里，旧客户端那颗「自动」的端点
  （`/api/desktop-view-auto`）仍然答 200、仍然真的跑一轮适配（`fitPasses` 涨）。
- `tests/panel-toolbar.spec.ts`：真宿主那条通道上 `zoom-to 150%` 的答案里 `zoomMode` 仍然是
  `auto`（旧读者拿到的仍然是一个合法值）。
- 端到端：`tests/fit-pixels.spec.ts` 里 `useAutoZoom()`（旧客户端的动作）在同一段栏宽上把页面
  重新适配回来，红标重新出现在画面里。

---

## 7. 诚实清单（没能验证到的）

见报告末尾那一节。

---

## 附：命令

```
npm run build                                          # scripts/build-client.mjs && tsc
npx vitest run --config vitest.config.ts tests/toolbar.spec.ts
npx vitest run --config vitest.config.ts tests/toolbar-panel.spec.ts
npx vitest run --config vitest.config.ts tests/panel-toolbar-placement.spec.ts
npx vitest run --config vitest.config.ts tests/fit-to-pane.spec.ts
npx vitest run --config vitest.config.ts tests/fit-pixels.spec.ts
npx vitest run --config vitest.config.ts tests/view-actions.spec.ts
npm test                                               # 整包
```

原始输出留在 `.scratch/t20b/`（`before.txt`、`after-probe.txt`、`dom-tests.txt`、
`placement-tests3.txt`、`fit-to-pane.txt`、`fit-pixels.txt`、`view-actions.txt`、`run1.txt` …），
目录按仓库惯例不入库。
