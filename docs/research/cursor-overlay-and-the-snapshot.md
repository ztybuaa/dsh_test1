# 测量：光标覆盖层会不会毁掉快照 / 动作 / 观测 / 截图（票 #9）

**问题**：T8 要把 Agent 的动作画在**被驱动的那个页面**里。而那个页面同时是快照（T3）、动作（T4）、观测（T5）三类能力的对象，覆盖层是**注入到它里面**的东西。四个必须先量清楚的问题：

1. 覆盖层会不会匹配快照选择器 `SNAPSHOT_SELECTOR`，变成"可操作元素"混进快照？
2. 覆盖层会不会挡住真元素，把 T4 的 `obscured` 分类污染掉？
3. 覆盖层会不会往页面里塞文本，废掉 `browser_extract` 的"与 `innerText` 逐字一致"？
4. 覆盖层会不会改变 T5 截图的像素，破坏那条自己解析 PNG 的断言？

**结论（一句话一条，原始证据在下面）**：

1. **不会**。覆盖层是一堆**无 role 的 `<div>`**，`SNAPSHOT_SELECTOR` 一个都不匹配：引擎自己的选择器在覆盖层挂着时仍然只匹配 15 个，其中落在覆盖层里的 **0** 个；快照逐项比对**完全一致**（15 个元素，ref/role/name/state/bounds 全同）。
2. **不会**。`pointer-events: none` 让 `document.elementFromPoint` 直接忽略它：光标**正好画在按钮中心**时命中仍是 `button#act-alpha`，点击仍然落在真按钮上（页面自己的 `#act-effect` 变成 `alpha-clicked`），T4 的 `obscured` 仍然精确指向 `div#act-blocker`。
3. **不会**。容器挂在 `document.documentElement` 上、**不在 `document.body` 里**，里面**一个文本节点都没有**：`body.innerText` 前后都是 2774 字符且逐字一致，`browser_extract` 仍与它逐字一致（2774/2774）。
4. **静止时不会**，但**它教会了两条时序事实**（见第 4、5 节）：容器刚挂上、还没画标记时，截图与"完全没有覆盖层"**逐像素相同**（changed = 0），T5 的三条形状断言（660×1200、颜色数 862、夹具色 `47,111,176` 在）全部成立。**但瞬时标记能不能被拍下来，取决于"产出那一帧"的时刻**——这是本次最重要的发现，见第 5 节。

- 探针：`tests/overlay-probe.spec.ts`（一次性，量完删除；原始输出在下面）
- 日期：2026-09-16
- 环境：Electron **44.3.0** / Playwright **1.62.1**（`connectOverCDP`）/ 视图 440×800，`devicePixelRatio = 1.5`（系统 150% 缩放）→ 截图 660×1200

---

## 0. 注入机制：哪一种能管到"下一个文档"

候选覆盖层是一个容器 `<div>` + 一张 `<style>`（都是纯 `<div>`，无 role、无文本）。

```
RAW P0 初始文档，没注入过：{"present":false}
RAW P0 只 evaluate 之后，当前文档：{"present":true,"parentIsRoot":true,"insideBody":false,"children":[],"textNodes":0,"subtreeTextNodes":0,"pointerEvents":"none","ariaHidden":"true","styleSibling":"style"}
RAW P0 只 evaluate 之后，真实导航到 /other：{"present":false}
RAW P0 新文档里脚本跑过几次：null
RAW P0 addInitScript 之后，真实导航到 /snapshot：{"present":true,...同上一行...}
RAW P0 新文档里脚本跑过几次（含 readyState 与 documentElement 是否已存在）：[{"ranAt":"loading","hadRoot":false}]
RAW P0 framenavigated 在主框架上触发次数：1
RAW P0 同一文档重复执行后容器个数：1
```

**读出来的四条**：

- **`evaluate` 只管当前文档**：真实导航（`page.goto`）之后容器**不在**了，脚本也没在新文档里跑过。
- **`page.addInitScript` 管下一个文档**：真实导航之后容器在，且**只跑了一次**（`[{"ranAt":"loading","hadRoot":false}]`）。
- **`addInitScript` 跑在 `readyState === "loading"`、`document.documentElement` 还是 `null` 的时刻**（`hadRoot:false`）。所以"挂载"这段代码**必须**带一个 `DOMContentLoaded` 兜底——探测时正是这条兜底路径把它挂上去的。这一点不实测是猜不到的。
- **重复执行是幂等的**：同一文档里再跑一次，容器个数仍然是 **1**。

`framenavigated` 在主框架上确实触发了（次数 1）。

## 1. 坑一：覆盖层会不会进快照

夹具页 `/snapshot`（15 个可见可交互元素）。

```
RAW P1 覆盖层在不在：{"present":{...children:[]...},"absent":{"present":false}}
RAW P1 两次快照逐项一致：true elements=15
RAW P1 引擎自己的选择器：有覆盖层时匹配 15 个，其中落在覆盖层里的 0 个；快照列出 15 个
```

两份快照（有覆盖层 / 把覆盖层连 `<style>` 一起摘掉）逐项完全一致（上面原始输出里两份 JSON 完全相同，此处不重复粘贴）。另用**引擎自己的选择器**独立数了一遍：15 对 15，且在覆盖层内部的匹配数是 **0**。

## 2. 坑二：覆盖层会不会挡住真元素 / 污染 `obscured`

```
RAW P2 覆盖层刚挂上、还没画：alpha 中心命中 "button#act-alpha"，blocked 中心命中 "div#act-blocker"
RAW P2 光标正好画在 alpha 中心，命中 "button#act-alpha"
RAW P2 覆盖层此时的 children：{"present":true,...,"children":["div.dsh-cursor","div.dsh-ripple"],"textNodes":0,"subtreeTextNodes":0,"pointerEvents":"none",...}
RAW P2 光标盖着的时候点 alpha，页面自己的效果："alpha-clicked"
RAW P2 覆盖层在时点被遮挡的元素：{"reason":"obscured","message":"browser-view: ref 2 (button#act-blocked \"blocked control\") is obscured, so it cannot be clicked — the element at its centre point (x=300, y=36) is div#act-blocker \"blocker panel\", ..."}
RAW P2 blocked 中心此刻命中 "div#act-blocker"
```

光标**正好落在按钮中心**（14×20 的箭头 + 涟漪，同一坐标）时，`elementFromPoint` 仍然回答 `button#act-alpha`，`clickRef` 仍然真的点到了它（效果由页面自己写出）。`obscured` 那条的文案、坐标、遮挡者名字**一字未变**——覆盖层没有插进这条分诊里。

## 3. 坑三：覆盖层会不会往页面里塞文本

```
RAW P3 覆盖层容器：{"present":true,...,"children":["div.dsh-cursor","div.dsh-ripple"],"textNodes":0,"subtreeTextNodes":0,...}
RAW P3 body.innerText：无标记 {"chars":2774}，有标记 {"chars":2774}，逐字一致=true
RAW P3 browser_extract 与页面 innerText 逐字一致=true {"chars":2774,"truncated":false,"totalChars":2774}
RAW P3 documentElement.innerText 变化：{"clean":2774,"painted":2774}
```

关键是两条结构性事实：容器 `parentIsRoot: true` / `insideBody: false`（**挂在 `documentElement` 上，根本不在 `body` 里**），容器子树里的文本节点数 **0**（`textNodes` 与 `subtreeTextNodes` 都是 0，因为标记全是无文本的 `<div>`）。所以画不画标记，`body.innerText` 都不动。

## 4. 坑四（一）：静止时，覆盖层对像素是"零"

```
RAW P4 截图 base-1: #1 FAIL 3003ms | #2 OK 119995B 1077ms
RAW P4 截图 base-2: #1 FAIL 3011ms | #2 OK 119995B 81ms
RAW P4 无覆盖层，两次调用：{"a":"17d56ea82252a0b3","b":"17d56ea82252a0b3","same":true}；像素差 {"changed":0,"box":null,"total":792000}
RAW P4 截图 mounted-1: #1 FAIL 3013ms | #2 OK 119995B 80ms
RAW P4 截图 mounted-2: #1 FAIL 3015ms | #2 OK 119995B 86ms
RAW P4 刚刚挂上覆盖层（无标记）：与无覆盖层的像素差 {"changed":0,"box":null,"total":792000}；跨调用一致 {"same":true,"a":"17d56ea82252a0b3","b":"17d56ea82252a0b3"}
RAW P4 T5 形状断言在覆盖层挂着的图上：{"viewport":{"width":440,"height":800,"dpr":1.5},"width":660,"height":1200,"expected":{"width":660,"height":1200},"distinctColors":862,"hasFixtureBox":true}
```

**覆盖层挂着但没画任何标记时，截图与"完全没有覆盖层"逐字节相同**（1600 万像素里 changed = 0，digest 都是 `17d56ea82252a0b3`），而且跨调用稳定。T5 那三条（尺寸 = 视口×dpr、颜色数 > 1、夹具 `#obs-box` 色 `47,111,176` 在场）在"覆盖层挂着的图"上全部成立。

> 顺带实测：这里的截图**单发会挂住**（`docs/research/cdp-screenshot-stall.md` 记过）：`#1 FAIL 3003ms | #2 OK 1077ms` 的模式重复出现，并发两发**没有**解开（两发一起超时）。可行的用法就是"同一发再发一次"。

## 5. 坑四（二）：瞬时标记能不能被拍下来，取决于**产出那一帧的时刻**

这一段是本次最值钱的发现。同一次会话里，先拍静止基线，再画标记、立刻再拍：

```
RAW P4 点标记（60,90）在场时：{"digest":"3fe1594d0267ec2d","vsMounted":{"changed":292,"box":"x 90..109, y 135..164",...},"facts":{...,"children":["div.dsh-cursor"],...}}
RAW P4 读提示在场时：{"digest":"17d56ea82252a0b3","rest":"17d56ea82252a0b3","sameAsRest":true,"vsRest":{"changed":0,"box":null,...}}
RAW P4 失败标记在场时：{"digest":"17d56ea82252a0b3","sameAsRest":true,"vsRest":{"changed":0,"box":null,...}}
```

- 点标记（**常驻**的光标 + 涟漪）拍到了：292 个像素变了，范围正好在那个点上（(60,90) CSS → (90,135) 设备像素）。
- 读提示（**600ms 就淡出并自摘**）和失败标记（900ms 同）**一点像素都没拍到**——`#1 OK 119995B 1114ms`：这一帧是 **1.1 秒后**才产出/交付的，那时动画早就结束、元素早就自己摘掉了。

也就是说：**这一台机器上"一帧"可能来得比动画还晚**。瞬时标记不是"不可能拍到"，而是"要保证拍到时它还年轻"。接着量：

```
RAW P5 read：重画 1 次，一帧 140112B 126ms
RAW P5 read 与静止基线比：{"changed":{"changed":93965,"box":"x 0..636, y 0..1199"},"corners":{"topLeft":"51,193,255","topRight":"252,252,252","bottomLeft":"51,193,255","bottomRight":"252,252,252","centre":"255,255,229"},"restCorners":{"topLeft":"255,255,255","topRight":"252,252,252","bottomLeft":"255,255,255","centre":"255,255,229"}}
RAW P5 fail：重画 25 次，一帧 139619B 3142ms
RAW P5 fail 与静止基线比：{... "corners":{"topLeft":"255,59,48",...,"bottomLeft":"255,59,48",...,"centre":"255,255,229"}}
RAW P5 page：重画 24 次，一帧 141022B 3017ms
RAW P5 page 与静止基线比：{... "corners":{"topLeft":"245,165,36",...,"centre":"255,255,229"}}
RAW P5 point：重画 24 次，一帧 120335B 3022ms
RAW P5 point 在 (60,90) CSS：{"changed":{"changed":319,"box":"x 86..109, y 131..164"},"cornerTopLeft":"255,255,255","restCornerTopLeft":"255,255,255","centre":"255,255,229"}
```

**做法**：拍的同时**反复重画**同一个标记（每次重画都把动画拨回 0），这样无论那一帧什么时候产出，标记都还"年轻"。结果四种标记全部拍到了，而且**形状可判**：

- **环（read / fail / page）**：左上角、左下角都变色，**正中不变**（`centre` 与静止时逐字节相同）——它是**一圈边**，不是整页蒙一层。
- **点（point）**：四角都不变，变化的像素**聚在落点周围**（`x 86..109, y 131..164` 对落点设备坐标 (90,135)）。
- **颜色可辨**：read 是青的（`51,193,255`），fail 是红的（`255,59,48`），page 是琥珀的（`245,165,36`）。
- 注意颜色值**不是精确常量**：拍到的时刻动画已经走了一点（`#14b8ff` = 20,184,255 拍成 `51,193,255`，即 opacity ≈ 0.87）。所以断言只能比"变没变 / 在哪变 / 偏哪个色"，**不能**比精确 RGB。

**另外发现两条**：

- **根的滚动条画在覆盖层之上**：变化范围的右边界是 `x 0..636`（425 CSS 像素），不是 659。`/observe` 有竖向滚动条（`scrollWidth 425 < innerWidth 440`），那 15px 里覆盖层的内容看不到。
- **常驻的光标确实留得住**：点标记 1.5 秒后再拍，涟漪已自摘、光标还在（`children:["div.dsh-cursor"]`，292 个像素变化）。所以"人后来才看"也看得见 Agent 最后点在哪。

## 6. 这些事实对实现的要求

- 覆盖层容器：挂 `document.documentElement`，**不进 `body`**；`pointer-events: none`（容器与所有后代都要）；`aria-hidden="true"`；只由**无 role 的 `<div>` 与一张 `<style>`** 组成，绝不写文本节点。
- 挂载代码要**自带 `DOMContentLoaded` 兜底**（`addInitScript` 跑的时刻 `documentElement` 还是 `null`），且**幂等**。
- 重挂：`addInitScript`（新文档一开头就挂上）与 `framenavigated`（T5 观测缓冲那个钩子）各来一次，两者都幂等 —— 实测这两条**各自都够用**，见 6.5 的第 2 条。
- **静止 = 零像素**：导航后（新文档、还没画标记）截图与没有覆盖层逐字节相同。T5 的截图断言因此原样成立，**一个字都不用放宽**。
- 瞬时标记要能被独立读回，**读的一方必须保证"产出那一帧时标记还年轻"**（测试里：拍的同时反复重画）。这不是实现的责任，是**观测方法**的责任。
- 断言只能比形状/色相/位置，不能比精确 RGB。
- 光标标记的**锚点是它的左上角**（`left/top` 就是落点），涟漪标记**以落点为中心**（`translate(-50%,-50%)`）。实测 rect：光标 `x=落点x, y=落点y`（14×20），涟漪中心 = 落点。

## 6.5 写测试与做反证时又量到的五条

写 `tests/overlay.spec.ts`、并逐条"把对应修复回退掉看它变不变红"的过程中，又量到五条：

1. **坑三其实有两半，`body.innerText` 只挡住了一半。** 把容器挂回 `documentElement`（正确）但**往容器里塞一个文本节点**，实测：`body.innerText` **2774 一字不变**（`browser_extract` 照样与它逐字一致），而 `document.documentElement.innerText` 从 **2774 变成 2792**、覆盖层子树的字符数从 0 变成 16。也就是说"容器不在 body 里"这一半本身就能让 `extract` 那条断言继续成立；要真正锁住"这一层不往页面里塞字"，得再读一次**整篇文档**的 `innerText`。测试两边都读。
2. **重挂的两条机制各自都够用。** 实测（真导航，点链接跨文档）：只留 `addInitScript` → 重挂成功（新容器、旧戳消失）；只留 `framenavigated` 钩子 → 也成功（新容器上已经画上了那次点击的涟漪）；**两条都去掉 → 覆盖层不回来**。所以这条验收对两条路径分别成立，而两条一起留着买的是"新文档一开头就挂上"（不给页面留一段没有覆盖层的空窗）。同文档导航（`pushState`）实测**不会**多出第二个容器、也**不会**换掉原来那个（测试里给容器盖了个戳，`pushState` 之后戳还在）。
3. **像素比对会假绿。** 想验证"Agent 自己截的图里没有覆盖层"，如果拿"截图之后拍的像素"当基准，这条会**永远通过**：常驻的光标在两张图里都在，`changed` 当然是 0。这条守卫里真正能区分修与不修的是**"截图之后覆盖层上还剩几个标记"**（修了 = 0，没修 = 还留着 `dsh-aim`，实测）。所以测试在拍基准帧之前会先读一次标记数，把"基准是干净的一帧"也断言掉。
4. **一次 `obscured` 拒绝不会画光标。** 遮挡是在动手之前判出来的，那一刻动作还没有"瞄"过任何地方，所以覆盖层上只有失败环、没有光标。这不是缺陷，是不变式：**光标只出现在真的动过手的地方**。
5. **失败与成功在像素上分得开**（"失败如实反映"的可观测形式）：失败是沿视口边缘的一圈红（实测角落 `255,59,48`、正中不变），读取提示是同一形状的冷色（角落 `51,193,255`）。所以"失败被画成成功"不仅能从 DOM 上认出来，也能从像素上认出来。

## 7. 本实验**没有**验证

- 只在**本机**（150% 缩放、Electron 44.3.0、Playwright 1.62.1）量过。换缩放比、换版本没测。
- **窗口被遮住 / 最小化**时没测：那种情况下 CSS 动画可能根本不推进，`animationend` 来得更晚（实现里因此留了一道定时器保险）。
- **iframe**：覆盖层在非顶层框架里直接返回（`window.top !== window`），所以"iframe 里的页面不会看到覆盖层"这条**只是代码意图，没有实测**。
- **页面自己删掉/替换覆盖层**（例如 `documentElement.replaceChildren()`）之后的行为没测。实现的选择是"画笔不负责挂载"，所以那种页面上的标记会静默消失，直到下一次导航。
- 根滚动条那 15px 里覆盖层不可见（见第 5 节末），**没有**想办法绕开。
