# 0011 — 下载由外壳落盘、落盘位置由外壳发布；插件绝不使用 `download.path()`

**状态**：已接受
**日期**：2026-09-16
**关联**：ADR-0002（领养而不是启动）、ADR-0003（载体中立）、ADR-0010（空间通道与文件通道）、票 #10 第三条验收

## 背景

票 #10 要求"能触发下载并拿到落盘位置与内容预览"。宿主是 Electron，我们在它上面
`connectOverCDP` 领养一块原生视图。

实测（原始输出见 `docs/research/dialogs-upload-download-iframes.md` 第 3 节）：

- `page.waitForEvent('download')` **会来**（`suggestedFilename()` 也对），页面不受影响；
- 但 **`download.path()` / `download.failure()` / `download.saveAs()` 全部挂死**，文件既不进
  `Downloads` 也不进 `playwright-artifacts-*`；
- 原因在 Electron 自己身上（`electron.d.ts:8350`）：没人给 `will-download` 设 `setSavePath` 时，
  Electron 走"**弹原生另存为对话框**"那条默认路，而 Agent 驱动下没有第二个人去点它；
- 在外壳的 `will-download` 里设一个 `setSavePath` 之后，下载立刻完成（~210ms），文件内容与
  夹具逐字一致；
- 而**同一时刻** Playwright 的 `download.path()` 解析出来的是
  `playwright-artifacts-xxxx/<GUID>`，那里**根本没有文件**，`saveAs()` 直接 `ENOENT`。

## 决定

**一、下载的落盘位置由外壳决定，并且只有外壳说了算。**

每个空间的 session 上都装 `session.on('will-download')`，设
`item.setSavePath(<userDataDir>/downloads/<原文件名>)`；重名照浏览器习惯加 ` (2)` 后缀
（不给每次下载开唯一子目录：用户按路径找过去要认得出自己下的东西）。下载状态如实映射
（`completed` / `cancelled` / `interrupted`），失败的**报失败**。

**二、落盘位置经**既有**空间通道发布，不新开通道。**

外壳把 `{id, url, filename, savePath, state, bytes, startedAt, finishedAt}` 写进
`<通道目录>/downloads.json` —— 与 `state.json` **同目录、同方向（外壳写、插件读）**、同一套
原子写（temp + rename）与有界策略（最多 50 条，丢了多少条记在日志自己身上）。插件→外壳那一半
（`request.json`）一个字节都不动。

**三、插件只报它自己读过的字节。**

`browser_download` 从日志拿到路径后，**先 `stat` 再读**，大小与外壳记录的一致才给内容预览；
不存在、读不动、大小不符、还没下载完 —— 各说各的，绝不把一个自己没验过的路径报成"文件在这里"。
`download.path()` / `saveAs()` / `failure()` 在这个项目里**不得使用**：它们在这台宿主上指向一个
不存在的文件，将来任何人想"简化"成用它们，先读这一段。

**四、触发下载的那次点击如实说自己引发了一次下载。**

会话记录 Playwright 的 `download` 事件（它只说"开始了"），动作结果里带一行
"a download started: report.txt — where it was saved is the shell's answer"；落盘位置去
`browser_download` 要。**"下载开始了"不许被报成"页面变了"。**

## 理由

**为什么不让插件自己接住下载。** 它接不住：文件是 Electron 的 `DownloadItem` 写的，而写到哪里
由 `will-download` 决定。插件能拿到的那个 `Download` 对象在这台宿主上是**错的**（上面那条实测）。

**为什么放在既有通道里。** 空间通道已经是一条双向的文件通道（`request.json` 上去、
`state.json` 下来、`pending-deletion.json` 下来），下载日志就是**下来的第三个文件**。为它另立
一条通道（端口、IPC、新目录）只会多一个要维护的协议面，而它要传的东西和 `state.json` 是同一类：
"外壳实际做了什么"。

**为什么静默保存而不是弹对话框。** 这是能力能不能成立的前提，不是偏好：默认路径会弹一个没人
回答的原生对话框，于是下载永远不完成、触发它的那次点击挂满超时。副作用（用户不再被问"存哪"）
是明知的，且对 Agent 驱动的浏览器是必须的；保存位置固定、可预期、写在握手里，用户找得到。

**为什么日志要有界。** 一个每次下载都追加的文件是定时炸弹。50 条足够覆盖"我刚才下过什么"，
更旧的丢掉多少条写在日志里，读的人知道自己看到的不是全部。

## 后果

- **封住了**：下载永远不落盘（点击挂死）这件事；以及"插件报了一个它没验过的路径"这件事。
- **封住了**：`download.path()` 在这台宿主上撒谎这条坑被写进文档与代码注释，不会有人"顺手用一下"。
- **没有封住、也不要写成封住了**：
  - 日志最多 50 条，更旧的**真的丢了**（丢了多少条写在日志里，但内容不在）；
  - `interrupted` / `cancelled` 两条状态只有纯逻辑覆盖，没有在真宿主上真的中断过一次下载；
  - 多空间同时下载没有实测（处理器装在每个空间上，但只用默认空间跑过）；
  - 落盘目录是 `<userDataDir>/downloads`，**不是**用户的 `Downloads`：它是这个档案自己的目录，
    关掉档案不会自动清理（与空间一样，属于"下次启动清理"家族之外的**保留**目录）。
- 代价：下载不再弹对话框，用户失去"另存为"的选择权；需要另存时用 `browser_download` 拿到路径
  再自己复制。
