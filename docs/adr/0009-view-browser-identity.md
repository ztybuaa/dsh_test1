# 0009 — 那一格的浏览器身份：关掉自动化标记、给它自己的持久档案，代理交给平台默认

**状态**：已接受
**日期**：2026-09-15
**依据**：`docs/research/browser-identity-and-profile.md`（全部原始测量）、票 #6

## 决定

### 1. 主动关掉 Chromium 的自动化标记（全局）

在 `shell/main.js` 里，紧挨着既有的两个 `appendSwitch` 再加一条：

```js
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
```

票面第 4 条验收是"站点不因自动化特征限流或拒绝登录"，而实测 `navigator.webdriver` 在今天
**就是 `true`**——在页面里读、没有挂任何调试器时也是 `true`，`--enable-automation` 从未加过。
根因是**我们自己**加的 `--remote-debugging-port`：裸 Electron 不给这个开关时是 `false`，
给了就是 `true`（六个变体量过）。那个端口不是可选项——它是插件领养视图的唯一入口（ADR-0002），
所以要让页面里的自动化标记消失，就只能在这个进程的命令行上把 Blink 的 `AutomationControlled`
特性关掉。

### 2. 代价（明确的取舍）

这条开关是**进程级**的：它不只作用于那一格，也作用于外壳界面那个窗口。实测影响面：

| 页面 | 改动前 `navigator.webdriver` | 改动后 |
|---|---|---|
| 那一格（视图） | `true` | `false` |
| DSH 界面（窗口） | `true` | `false` |

DSH 界面是本机回环上的自家页面，它的 `navigator.webdriver` 值不影响任何行为；
两个页面都变成 `false` 是**量出来的**，不是推断的。

### 3. 为什么不能 per-webContents

Blink 特性标志是渲染器启动时从命令行读的，Electron 没有"只对某个 `webContents` 关掉某个
Blink 特性"的 API。另一条路是给那一格额外挂一个 debugger、发
`Emulation.setAutomationOverride({enabled:false})`：它确实能 per-target 生效，但那样外壳就
在插件要 attach 的同一个目标上多占一个调试端点——插件的领养路径（ADR-0002、T1 接缝测试）
全部走 CDP attach，为一个可以被进程开关替代的效果去争调试器，风险大于收益。**否决**。

### 4. 那一格有自己的持久档案

```js
new WebContentsView({ webPreferences: { partition: 'persist:dsh-view' } })
```

`persist:` 前缀是 Electron 的"落盘"约定，档案落在 `<userDataDir>/Partitions/dsh-view`，
跨外壳重启保留；它与外壳界面那一路（`session.defaultSession`，档案就是 `userDataDir` 本身）
是两个罐子。票面第 1、2 条（登录一次、重启仍在；不退化为干净档案）都落在这一条上，
`app.setPath('userData', …)` 保持不动——档案目录仍然是外壳自己的目录。

### 5. UA 只做最窄的删除，且只动那一格

`view.webContents.setUserAgent(...)`（只这一格，不动 `app.userAgentFallback`），
删掉 Electron 追加的产品标记（`<应用名>/<版本>` 与 `Electron/<版本>`），其余一字不改。

两个标记都要删的原因：实测默认 UA 的形状是
`… <应用名>/<版本> Chrome/<版本> Electron/<版本> Safari/537.36`；本仓库今天跑在默认应用名
`Electron` 下，所以只看得见一个 `Electron/44.3.0`，一旦应用名被正式设置就会再多一个
`<应用名>/<版本>`——那比现在还响。

UA-CH（`navigator.userAgentData.brands`）实测**没有** Electron 品牌，所以不需要为此动全局。
保留未处理的"嵌壳签名"（UA 里 Chrome 版本是四段、UA-CH 少 `Google Chrome` 品牌、
`window.chrome` 可枚举键为空）都是指纹细节而非自动化特征，本票不动。

### 6. 代理：这里**不需要**代码（与 ADR-0005 第 3 项的关系）

ADR-0005 第 3 项继承的决定是"自动探测并继承系统代理（显式配置 → 环境变量 → Windows 系统代理），
本地回环一律 bypass"。本项目**不实现那条探测链**，因为它的前提在这里不成立：

- 那条链是为 **Playwright 自带的 Chromium** 写的——它默认直连，所以必须手写探测；
- 本项目的渲染器就是 Electron 的 Chromium，**默认模式就是 system**：实测
  `resolveProxy('https://example.com/')` 给出的就是系统设置的结果，且与
  `setProxy({mode:'system'})` 完全一致；
- 回环也**默认成立**：显式配上代理后，`127.0.0.1` / `localhost` / `[::1]` 仍然一律 `DIRECT`
  （Chromium 的隐含 bypass），并且用真实日志代理端到端验证过——外网请求进了代理，
  回环请求根本没到代理。

所以这里只保留两样东西：

1. **可观测性**：启动时把 `session.resolveProxy` 的读回发布成一行 `DSH_SHELL PROXY {...}`，
   验收与人都能看见外网与回环各解析成什么（这是唯一新增的代理相关代码）。
2. **一个显式的口子**：`--proxy <rules>` 直接交给 `session.setProxy({proxyRules})`，
   供"系统代理不是我要的那个"的场合使用。**刻意不设 `proxyBypassRules`**——实测
   `<-loopback>` 会把隐含 bypass 反过来，连回环都推进代理；只列 `localhost,127.0.0.1`
   又会漏掉 `[::1]`。不设它，回环就一直是 `DIRECT`。

**没有实现环境变量那一层**：Chromium 在 Windows 上不读 `HTTP(S)_PROXY`，要实现就得自己
解析环境变量再 `setProxy`，而那条路径没有任何已证实的需要——写了就是死代码。

原始证据（系统现状、每一步 `resolveProxy` 的七种配置、日志代理的请求记录）在
`docs/research/browser-identity-and-profile.md` 第 6 节。**将来谁要加显式代理配置，先读那一节
的 `<-loopback>` 那张表。**

**可测性说明**：`--proxy` 这一半是为了让第 3 条验收能有决定性测试而加的产品代码。做了三次
尝试想不写它：Chromium 的 `--proxy-server` 开关放在 app 路径**之前**会让 Electron 根本起不来
（app 路径解析被吃掉），放在**之后**则被外壳自己的 `args.js` 当成未知参数拒绝——唯一可行的
位置两个都不行。旧的 `--url <url>` 形状问题另行立票，不在本票内。

## 后果

- 页面里的 `navigator.webdriver` 在两个页面都是 `false`；这是**主动关闭**一个 Chromium 安全
  相关标记，换来的是站点不把这一格当自动化浏览器。取舍记录在此，不再散落在代码注释里。
- 登录态属于那一格自己：与外壳界面互不可见，跨重启保留（走优雅关闭；强杀会丢还没刷盘的写入，
  这是 Chromium 的行为，见事实文档第 5 节）。
- 代理的正确性依赖平台默认行为。如果将来有人为了别的原因给视图 session 调 `setProxy` 并带上
  `proxyBypassRules`，回环会被一起代理——第 6 节那张表就是这条的守卫。
