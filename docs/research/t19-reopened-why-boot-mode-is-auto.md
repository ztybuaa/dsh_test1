# 票 #19 重新打开：真实产品的启动序列里，这一格到底是什么模式

**日期**：2026-09-17（当天晚些时候，票被重新打开之后）
**票**：[#19](https://github.com/ztybuaa/dsh_test1/issues/19)
**结论**：今天的代码在真实启动序列上是对的（`auto`），但**没有任何用例走过这条序列**；
把它补上之后，"启动时被谁切成 manual"这一类回归再也躲不过去了。下面每一条都是量出来的，
写清哪些是**今天量到的**、哪些是**票面现场留下、我复现不出来的**。

---

## 1. 受控实验：真外壳 + 真宿主 + 真插件，从零起一次

起法与本仓库其它用例同形（`tests/shell-harness.ts` 的 `startShell(['--dsh'])` + 临时 `DSH_HOME`，
用户自己的 `~/.dsh` 只读、一个字节不碰），脚本在 `.scratch/`（临时目录，已删）。

**第一次尝试失败得有价值**：我当时往临时 profile 里插了一个诊断插件，忘了它的 `package.json`
要有 `dsh.bundle`，宿主当场拒绝启动：

```
Error: dsh: profile bundle "t19-diag" declares no dsh.bundle in its package.json
DSH_SHELL FATAL {"message":"\"dsh web\" exited early (code 1, signal null)"}
```

而**外壳自己的一半仍然完成了**（握手照发、`spaces/state.json` 照写）。这条记在这里，因为它是
"外壳与宿主是两条命"的一个现场例子 —— 宿主死了，外壳不会假装一切正常，但它也不会因此不发布
自己那半份事实。

修好之后（诊断插件带 `cordis.patch.yml` 插入项），从宿主进程里读回的通道是这样：

```
    0ms  diag apply          spacesDir=…\dsh-t19-...\spaces  cwd=G:\dsh_test1
    2ms  request.json        (不存在)
    2ms  state.json          requestId: 0, cause: "startup", zoomMode: "auto", zoom: 1
   12ms  zoom.json           cause: "spaces:startup", mode: "auto", fitPasses: 0, fitChanges: 0
```

**`request.json` 从来不存在** —— 启动全程没有任何人往这条通道上写过一条命令。

## 2. 用户机器上的现场（只读）

用户那个外壳（`PID 56308`，22:20:34 起）的通道目录
`%APPDATA%\dsh-desktop-shell\spaces\`：

| 文件 | 最后一次写 | 内容要点 |
|---|---|---|
| `request.json` | 22:22:10 | `{"id":6,"active":"default","spaces":[{"name":"default","mode":"auto"}]}` —— 这是**维护者自己按的那次「自动」** |
| `state.json` | 22:22:11 | `requestId: 6`、`zoom: 0.599`、`zoomMode: "auto"` |
| `zoom.json` | 22:22:11 | `cause: "spaces:request"`、`mode: "auto"`、`fitPasses: 1`、`fitChanges: 2` |

票面引用的那条（`at: 1789654835022`、`mode: "manual"`、`fitPasses: 0`）**已经被 22:22:10 那次
「自动」覆盖掉了**，所以"是谁下的那条命令"在文件里查不到了 —— 这一条写在诚实清单里，
没有当作已知。

23:31 再读一次同一份文件（用户还在用）：`mode: "auto"`、`fitPasses: 13`、`fitChanges: 34`、
`cause: "fit:trailing"` —— 也就是说**拖侧边栏真的在改缩放**：功能在他那台机器上是活的。

## 3. 代码里"谁能让模式变成 manual"

把这条通道上所有会写模式的地方数了一遍（`git grep` 全仓，不是抽样）：

| 写模式的地方 | 触发条件 | 能不能在"刚启动"时发生 |
|---|---|---|
| `shell/main.js` 建空间时的缺省 | 每次启动 | 是 —— 而它是 **`auto`** |
| `applyZoom()` → `entry.zoomMode = 'manual'` | 只有 `applySpaceRequest` 在处理一条**带缩放命令**的请求时调它 | **只有插件写过请求才会** |
| `handBackToAuto()` → `entry.zoomMode = 'auto'` | 那条请求带 `mode: 'auto'` | 只有人工按过 |
| `fit.js` 的适配轮 | **从不写模式**，只在 `mode === 'auto'` 时才动手 | —— |

插件侧能让模式变 manual 的入口只有两个：`session.zoomTo()`（缺省 `manual`）与
`SpaceManager.setZoom()`（缺省 `manual`），而它们往上追只有三个调用者：面板的
`zoom-in`/`zoom-out`/`zoom-reset`/`auto`、工具的 `browser_view`、以及 `session.restart()`。
**启动路径上一个都没有**（`apply()` 里不写请求，客户端半边只调 RPC，`adopt()` 只读）。

## 4. 反证：把那条请求亲手写下去

`tests/product-startup.spec.ts` 最后一条用例**亲手**往 `request.json` 写一条旧形状的命令
（`{"name":"default","zoom":1,"mode":"manual"}`），外壳 150ms 轮询处理之后：

```
RAW 亲手写下去的状态回显:
{"requestId":3,"reading":{"zoom":1,"mode":"manual","modeCause":"zoom-request","fitPasses":1,"fitChanges":0,
 "lastFit":{"cause":"auto-request",…},"cause":"spaces:request"}}
```

`mode` 变成 `manual`、`modeCause` 变成 `zoom-request`、此后`fitPasses` 不再增长 ——
**与票面现场读数逐字段一致**。所以"启动时不许有请求、模式必须是 `auto`"这条断言不是空话：
真出现这样一条请求，它必红。

另一条反证是**变异**：把外壳建空间时的缺省从 `auto` 改成 `manual`（一行），
`tests/product-startup.spec.ts` **3 条用例变红**（`expected 'manual' to be 'auto'`），
改回来再跑全绿。两条反证一条对着"谁写请求"，一条对着"缺省是什么"。

## 5. 这一轮**没能**验证到的

- **现场那条命令的来路没有确证**：它在文件里被后来的写入覆盖了；今天这份代码里也**没有**
  一条调用链能在启动时发出它（§1 的受控实验量到 `requestId: 0`）。所以修的是
  "这条路允许发生"，不是"这一处写错了"。
- **面板真的渲染出来、工具条真的在 DOM 里**没量过：临时 profile 上 DSH 停在首启引导页
  （与 ADR-0013 同一条缺口）。量的是那条通道的回答，不是 DOM。
- **旧外壳 + 新插件**的组合没在真外壳上走过：旧外壳会忽略 `kind` 字段、照样按
  "指名了缩放值 ⇒ manual" 执行，但那是从它的代码读出来的，不是量出来的。
- **像素验收需要一块可见的桌面**（与 `zoom-pixels` 同一条限制）。
- 用户机器上那两次读数不是**同一时刻**的对照：一次是 22:22（按「自动」之后），
  一次是 23:31（拖了很多次之后）。中间那一段没有采样。
