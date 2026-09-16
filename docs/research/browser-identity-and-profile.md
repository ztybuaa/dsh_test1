# 测量：登录态与浏览器身份（持久 / 专属 / 代理 / 自动化特征）

**问题**：那一格里的原生视图，今天的**浏览器身份**长什么样？登录态到底持不持久？代理到底怎么走？——先量，再决定改什么。

**结论（先给结论，证据在下面每一节）**

1. UA 泄漏 `Electron/44.3.0`；**UA-CH 不泄漏**（没有 Electron 品牌）⇒ 最窄改法（只给这一格的 `webContents.setUserAgent()`）够用，不必动全局 `app.userAgentFallback`。
2. `navigator.webdriver` 今天是 **true**，**根因是外壳自己加的 `--remote-debugging-port`**（不是 Playwright 挂上来的，也不是 `--enable-automation`）；唯一的修法是进程级 `--disable-blink-features=AutomationControlled`。
3. 今天**已经**是持久档案（默认 session 落在 `--user-data-dir` 下），但视图与 DSH 界面**共用同一个 session**（cookie 罐双向可见）⇒ 票面"专属"这一条不成立，"持久"这一条成立但依附在别人的 session 上。
4. 代理：Chromium **默认就继承系统设置**，且**隐含 bypass 本地回环**（显式配上代理后 loopback 仍 `DIRECT`，日志代理端到端验证）。**不需要写 setProxy**；写 `proxyBypassRules: '<-loopback>'` 反而会把回环推进代理。
5. 顺带量到一条与本票无关但会让外壳 CLI 立刻死掉的形状（见第 8 节）。

- 探针：`%TEMP%\t6-probe\`（`wrap.cjs` + `run.cjs` + `wdprobe.cjs` + `matrix*.cjs`，**仓库外的一次性原型，不是交付物**；用完即弃）
- 日期：2026-09-15
- 起点：`HEAD = 0b43511`（工作树干净，`npm test` = 6 文件 / 53 用例全绿）

---

## 1. 环境

| 项 | 值 |
|---|---|
| Electron | **44.3.0**（Chromium `152.0.7977.78`） |
| Node | v24.19.0 |
| 系统 | Windows，`navigator.platform = Win32`，`hardwareConcurrency = 32` |
| 站点 | 探针自带 `127.0.0.1:39411`（固定端口：localStorage 按 origin 存，端口必须跨重启一致） |
| 探针方式 | 外壳源码**不改**：`wrap.cjs` 直接 `require('shell/main.js')`，从外面加观测钩子 |

系统代理现状（原始命令与输出）：

```powershell
PS> reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" | Select-String 'ProxyEnable|ProxyServer|ProxyOverride'
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ       127.0.0.1:7897
    ProxyOverride  REG_SZ       localhost;127.*;192.168.*;10.*;172.16.*;...;<local>

PS> Get-ChildItem env: | Where-Object { $_.Name -match 'proxy' }     # 无输出（没有代理环境变量）
```

**`ProxyEnable = 0x0`**：本机当前**没启用**系统代理。这一点决定了下面"外网"一列的期望值就是 `DIRECT`。

页内取值的两种途径（两种都量，用来分辨"是不是 Playwright 挂上来造成的"）：

| 途径 | 谁在读 | 有没有调试器挂着 |
|---|---|---|
| `webContents.executeJavaScript(...)`（`wrap.cjs`） | 外壳主进程发起，**页面里执行** | **没有** |
| Playwright `page.evaluate(...)`（`run.cjs`） | 插件生产路径 | **有** |

---

## 2. 身份特征（在那一格的页面里取）

### 2.1 原始输出：视图页面（无调试器，`executeJavaScript`）

```json
{"at":"view, via executeJavaScript, no debugger attached",
 "href":"http://127.0.0.1:39411/view",
 "userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36",
 "webdriver":true,"webdriverType":"boolean",
 "hasChrome":"object","chromeKeys":[],
 "plugins":5,"mimeTypes":2,
 "languages":["zh-CN","zh-Hans-CN"],"language":"zh-CN","platform":"Win32",
 "hardwareConcurrency":32,"deviceMemory":16,
 "userAgentData":{"brands":[{"brand":"Not?A_Brand","version":"24"},{"brand":"Chromium","version":"152"}],
                  "mobile":false,"platform":"Windows"},
 "highEntropy":{"architecture":"x86","bitness":"64",
                "fullVersionList":[{"brand":"Not?A_Brand","version":"24.0.0.0"},{"brand":"Chromium","version":"152.0.7977.78"}],
                "uaFullVersion":"152.0.7977.78","platformVersion":"19.0.0","model":"","wow64":false}}
```

同时用 Playwright 读同一页（有调试器）得到**逐字节相同**的值 ⇒ 这些特征不是 Playwright 带来的。

### 2.2 逐项判读

| 特征 | 今天 | 判读 |
|---|---|---|
| `navigator.userAgent` | `… Chrome/152.0.7977.78 **Electron/44.3.0** Safari/537.36` | **泄漏**。`Electron/44.3.0` 是 Electron 追加的产品标记（本应用 `app.getName()` = `Electron`，所以只有这一个标记，没有 `<应用名>/<版本>` 那一段） |
| `navigator.userAgentData.brands` | `[Not?A_Brand/24, Chromium/152]` | **不泄漏 Electron**。与真 Chrome 的差别是**少了 `Google Chrome` 品牌**（真 Chrome 是三个品牌）——是"嵌壳"签名，不是自动化信号 |
| `uaFullVersion` / `fullVersionList` | `152.0.7977.78` | 真 Chrome 的高熵值同样是完整版本号，不异常 |
| `navigator.webdriver` | **`true`**（布尔） | 自动化信号，见第 3 节 |
| `window.chrome` | 存在，`Object.keys()` = `[]` | 存在性正常；可枚举键为空这一点与真 Chrome 不同（真 Chrome 有 `loadTimes`/`csi` 等），本次**不处理**（属指纹细节，不属自动化特征） |
| `navigator.plugins.length` | 5 | 与 Chrome 一致（5 个内置 PDF 插件） |
| `navigator.languages` | `["zh-CN","zh-Hans-CN"]` | 与系统语言一致，不异常 |

### 2.3 外壳主进程侧的事实

```json
{"argv":["…\\electron.exe","…\\wrap.cjs","--user-data-dir","…\\profile-fFvqbw","--view-url","http://127.0.0.1:39411/view"],
 "appName":"Electron","appVersion":"44.3.0","appPath":"…\\t6-probe",
 "userData":"…\\profile-fFvqbw",
 "userAgentFallback":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36",
 "enableAutomationSwitch":false,
 "remoteDebuggingPort":"0","remoteDebuggingAddress":"127.0.0.1",
 "proxyServerSwitch":"","noProxyServerSwitch":false,"automationControlled":""}
```

---

## 3. `navigator.webdriver` 的归因（决定性）

**待验证的假设**是"外壳没有 `--enable-automation`，所以不该是 true"。量下来是 true，于是做了 6 个变体（`wdprobe.cjs`：裸 Electron 应用 + 自己的页面服务器，页面里 `executeJavaScript` 读值）：

```powershell
PS> foreach ($v in @('baseline','rdp','no-blink','rdp+no-blink','enable-automation','rdp+enable-automation')) {
      $env:T6_WD_VARIANT=$v; & $exe wdprobe.cjs | Select-String WDPROBE }
```

| 变体 | 命令行开关 | `navigator.webdriver` |
|---|---|---|
| `baseline` | 无 | **false** |
| `rdp` | `--remote-debugging-port=0` | **true** |
| `no-blink` | `--disable-blink-features=AutomationControlled` | false |
| `rdp+no-blink` | 两个都有 | **false** |
| `enable-automation` | `--enable-automation` | true |
| `rdp+enable-automation` | 两个都有 | true |

原始输出（`rdp` 与 `rdp+no-blink` 两行，逐字）：

```
WDPROBE {"variant":"rdp","hasEnableAutomation":false,"disableBlinkFeatures":"","remoteDebugging":"0","webdriver":true,
 "descriptor":{"on":"prototype","getter":"function","configurable":true},"userAgent":"… Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36",
 "brands":[{"brand":"Not?A_Brand","version":"24"},{"brand":"Chromium","version":"152"}]}
WDPROBE {"variant":"rdp+no-blink","hasEnableAutomation":false,"disableBlinkFeatures":"AutomationControlled","remoteDebugging":"0","webdriver":false,
 "descriptor":{"on":"prototype","getter":"function","configurable":true}, …}
```

**结论**：

- `--remote-debugging-port`（外壳为了把视图交给插件，**必须**加）单独就会把 `navigator.webdriver` 变成 true —— 与 `--enable-automation` 无关（`hasEnableAutomation` 全程 false）。
- `app.commandLine.appendSwitch('disable-blink-features','AutomationControlled')` 能把它清回 false，且与 `remote-debugging-port` 并存时依然有效。
- Blink 特性标志是**进程级**的（渲染器启动时从命令行读），Electron 没有 per-`webContents` 的等价开关；另一条路是再挂一个 debugger 发 `Emulation.setAutomationOverride({enabled:false})`，但那会与插件自己的 Playwright attach 争同一个调试端点，风险大于收益。**所以这一处只能全局改**，取舍记录在此。

---

## 4. UA 清理：最窄改法的实测

在真实外壳的视图上直接调 `webContents.setUserAgent(清理后的值)`，然后重新加载同一页再读：

```json
{"step":"default","userAgentFallback":"… Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36",
 "computed":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.78 Safari/537.36"}
{"step":"after setUserAgent","webContentsGetUserAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.78 Safari/537.36"}
{"at":"view after setUserAgent + reload","userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.78 Safari/537.36",
 "userAgentData":{"brands":[{"brand":"Not?A_Brand","version":"24"},{"brand":"Chromium","version":"152"}]}, …}
```

**结论**：`setUserAgent` 足够——UA 干净，UA-CH 前后一致（本来就没有 Electron 品牌），`webdriver` 不受它影响（那是第 3 节那条开关的事）。

**没有做的规范化（如实记录）**：真 Chrome 的 UA 里是 `Chrome/152.0.0.0`（只留主版本 + 三个 0），而这里是 `Chrome/152.0.7977.78`。这是"嵌壳"签名而非自动化特征，本票只清自动化特征，故**保持原样**；如果之后要更彻底，只需再一行把它规范成与 UA-CH 品牌一致的主版本。

### 4.1 那两个标记到底是什么（决定了清理逻辑的形状）

用一个自带 `package.json`（`{"name":"t6-ua-probe","version":"9.9.9"}`）的临时应用量 Electron 默认 UA 的模板：

```powershell
PS> & $exe "$env:TEMP\t6-probe\appname"
UAPROBE {"appName":"t6-ua-probe","appVersion":"9.9.9","userAgentFallback":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) t6-ua-probe/9.9.9 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36"}
```

模板是 **`<应用名>/<应用版本> Chrome/<版本> Electron/<版本>`**。本仓库今天跑在默认应用名
`Electron` 下，所以 UA 里只看得见一个 `Electron/44.3.0`；**一旦应用名被正式设置
（`dsh-desktop-view`），UA 里会再多出一个 `dsh-desktop-view/0.1.0`——比现在还响**。
⇒ 清理逻辑必须两段都删（只删 `Electron/` 不够），这正是 `shell/identity.js` 的
`browserUserAgent` 做的事。

---

## 5. 今天到底持不持久

两个 profile 目录，各跑一次"写入 → 停外壳 → 重启 → 读回"。

### 5.1 优雅关闭（关掉外壳窗口，用户的实际路径）

```powershell
PS> node run.cjs persist write  %TEMP%\t6-probe\profile-persist-graceful graceful
T6DRIVE {"kind":"persist-write","value":{"cookie":"t6persist=alpha; t6session=beta","local":"gamma","session":"delta"}}
T6DRIVE {"kind":"persist-stop","value":{"stopMode":"graceful","exitedGracefully":true,"stillAlive":false}}

PS> node run.cjs persist read   %TEMP%\t6-probe\profile-persist-graceful
T6DRIVE {"kind":"persist-read","value":{"cookie":"t6persist=alpha","local":"gamma","session":null,"origin":"http://127.0.0.1:39411"}}
```

写进去的四样东西与读回来的结果：

| 写入 | 类型 | 重启后 | 判读 |
|---|---|---|---|
| `t6persist=alpha; max-age=86400` | 持久 cookie | **活着** | 正是"登录一次跨重启仍有效"所依赖的那一类 |
| `t6session=beta`（无 max-age） | 会话 cookie | 消失 | 浏览器语义如此，同时证明"读到的是新进程的新页面"而不是陈旧页面 |
| `localStorage.t6local = gamma` | 持久存储 | **活着** | |
| `sessionStorage.t6ss = delta` | 会话存储 | 消失 | 同上，控制项 |

### 5.2 强杀（`taskkill /pid <pid> /T /F`，即测试 harness 今天的 `stop()`）

```powershell
PS> node run.cjs persist write  %TEMP%\t6-probe\profile-persist-force force
T6DRIVE {"kind":"persist-write","value":{"cookie":"t6persist=alpha; t6session=beta","local":"gamma","session":"delta"}}
T6DRIVE {"kind":"persist-stop","value":{"stopMode":"force-kill","alive":false}}

PS> node run.cjs persist read   %TEMP%\t6-probe\profile-persist-force
T6DRIVE {"kind":"persist-read","value":{"cookie":"","local":null,"session":null,"origin":"http://127.0.0.1:39411"}}
```

**结论**：写完立刻强杀，**连持久 cookie 和 localStorage 都丢**（Chromium 还没刷盘）。

- 事实层面：今天的外壳**是**持久的（默认 session 就在 `--user-data-dir` 下），票面"不退化为每次都是干净档案"这一条今天成立。
- 测试层面：**任何"跨重启持久"的测试都不能用强杀**，否则测的是刷盘时机而不是档案是否持久。本票的测试走"关窗口"的优雅停止（`window.close()` ⇒ `window-all-closed` ⇒ `app.quit()`，实测 `exitedGracefully: true`）。

### 5.3 "专属"：今天不成立

窗口页与视图页（探针把两者放在**同源**上，这样共用 cookie 罐/存储罐就一定看得见）：

```json
{"windowOrigin":"http://127.0.0.1:39411","viewOrigin":"http://127.0.0.1:39411","sameOrigin":true}
{"step":"written in the window page","written":{"cookie":"t6fromwindow=from-window","local":"from-window"}}
{"step":"read in the view page","seenByView":{"cookie":"t6fromwindow=from-window","local":"from-window"}}
{"step":"written in the view page","writtenInView":{"cookie":"t6fromwindow=from-window; t6fromview=from-view"}}
{"step":"read in the window page","seenByWindow":{"cookie":"t6fromwindow=from-window; t6fromview=from-view","local":"from-view"}}
```

主进程侧同一事实：

```json
{"viewIsDefaultSession":true,"windowIsDefaultSession":true,"viewAndWindowShareOneSession":true,
 "viewStoragePath":"…\\profile-fFvqbw","windowStoragePath":"…\\profile-fFvqbw","defaultStoragePath":"…\\profile-fFvqbw"}
```

**结论**：视图与 DSH 界面**是同一个 session、同一个档案目录**。双向可见 ⇒ 不是两个罐子碰巧长得像。

---

## 6. 代理

### 6.1 默认（外壳不调 `setProxy`）

`session.resolveProxy` 读回（视图 session 与默认 session 完全一致）：

```json
{"at":"view-session","readings":{
 "external":{"url":"https://example.com/","result":"DIRECT"},
 "externalHttp":{"url":"http://example.com/","result":"DIRECT"},
 "loopback127":{"url":"http://127.0.0.1:9/","result":"DIRECT"},
 "loopbackName":{"url":"http://localhost:9/","result":"DIRECT"},
 "loopbackV6":{"url":"http://[::1]:9/","result":"DIRECT"}}}
```

与系统现状（`ProxyEnable=0`）**一致** ⇒ 外网这一列取到的就是系统设置的结果。

### 6.2 显式配上代理之后（本机真实代理端口不参与，用死端口 `127.0.0.1:9`）

| 步骤 | 外网 `https://example.com/` | `127.0.0.1` | `localhost` | `[::1]` |
|---|---|---|---|---|
| 不调 `setProxy`（今天） | `DIRECT` | `DIRECT` | `DIRECT` | `DIRECT` |
| `setProxy({proxyRules:'127.0.0.1:9'})` | `PROXY 127.0.0.1:9` | **`DIRECT`** | **`DIRECT`** | **`DIRECT`** |
| `setProxy({proxyRules:'http=127.0.0.1:9'})` | `DIRECT`（https 未配） | `DIRECT` | `DIRECT` | `DIRECT` |
| `+ proxyBypassRules:'<-loopback>'` | `PROXY 127.0.0.1:9` | **`PROXY …`** ⚠️ | **`PROXY …`** ⚠️ | **`PROXY …`** ⚠️ |
| `+ proxyBypassRules:'<local>,localhost,127.0.0.1,::1'` | `PROXY …` | `DIRECT` | `DIRECT` | `DIRECT` |
| `+ proxyBypassRules:'<-loopback>,localhost,127.0.0.1'` | `PROXY …` | `DIRECT` | `DIRECT` | **`PROXY …`** |
| `setProxy({mode:'system'})` | `DIRECT` | `DIRECT` | `DIRECT` | `DIRECT` |

原始输出（决定性两行，逐字）：

```
{"step":"setProxy({proxyRules: '127.0.0.1:9'}) only","readings":{"external":…"PROXY 127.0.0.1:9","loopback127":…"DIRECT","loopbackName":…"DIRECT","loopbackV6":…"DIRECT"}}
{"step":"setProxy({proxyRules, proxyBypassRules: '<-loopback>'})","readings":{"external":…"PROXY 127.0.0.1:9","loopback127":…"PROXY 127.0.0.1:9","loopbackName":…"PROXY 127.0.0.1:9","loopbackV6":…"PROXY 127.0.0.1:9"}}
```

**判读**：

- Chromium 的**隐含 loopback bypass 默认生效**，连 `127.0.0.0/8`、`::1`、`localhost` 一起覆盖，**不需要我们写 bypass 规则**。
- 一旦写 `proxyBypassRules`，**`<-loopback>` 会把隐含 bypass 关掉**（这正是派工书提醒的互相覆盖）；只列 `localhost,127.0.0.1` 时 IPv6 回环 `[::1]` 又会漏进代理。⇒ 只要不是非写不可，就**不要碰 `proxyBypassRules`**。

### 6.3 端到端：真的走了代理 / 真的没走

用一个**真实的日志代理**监听 `127.0.0.1:39412`，把它显式配成视图 session 的代理，然后让视图去访问 loopback 站点与一个假外网站点：

```
{"step":"loopback navigation","outcome":"loaded","url":"http://127.0.0.1:39411/view"}
{"step":"external navigation","outcome":"loaded","url":"http://t6-probe.invalid/t6-external"}
{"kind":"proxy-log","value":{"requests":["GET http://t6-probe.invalid/t6-external"]}}
```

**代理日志里只有外网那一条**：loopback 的请求**根本没到代理**（而它确实成功打开了），外网请求**确实进了代理**。这不是读数的解释，是流量的事实。

### 6.4 代理这一节的结论（决定了不改什么）

- 外网站点继承系统代理：**Chromium/Electron 默认就是 system 模式**，不需要我们探测。这与旁支项目 `G:\dsh_test\` 的情况**不同**——那里的 `src/proxy.ts` 手写"显式配置 → 环境变量 → 注册表"探测链，是因为 **Playwright 自带的 Chromium 默认直连**；本项目的渲染器就是 Electron 的 Chromium，系统代理是它的默认行为。
- `127.0.0.1` / `localhost` 不经代理：**隐含 bypass 默认成立**，显式配了代理也成立。
- 因此本票的实现**不实现探测链、不写 `proxyBypassRules`**；只保留两件事：把这个读回发布出来（`DSH_SHELL PROXY`），以及一个显式的口子 `--proxy <rules>`（直接交给 `setProxy({proxyRules})`，见 ADR-0009 第 6 节）。

### 6.5 试过让 Chromium 自己的 `--proxy-server` 开关顶替这个口子（失败了，记录原因）

这样测试就能不依赖任何新代码。量了两种放法（`matrix5.cjs`）：

| 放法 | 结果 |
|---|---|
| 放在 app 路径**之前**：`electron --proxy-server 127.0.0.1:39412 main.js …` | **app 模块从未开始执行**（15s 超时；`--proxy-server` 是空格取值，Electron 把那个值当成了 app 路径） |
| 放在 app 路径**之后**、等号形式：`electron main.js --proxy-server=127.0.0.1:39412` | 起得来，`app.commandLine.getSwitchValue('proxy-server')` = `127.0.0.1:39412` ⇒ **Chromium 确实认这个开关** |
| 放在 app 路径**之后**、空格形式：`--proxy-server 127.0.0.1:39412` | 起得来，但 `getSwitchValue('proxy-server')` = `""` ⇒ 空格形式注册不上值（Chromium 的 Windows 命令行要等号形式） |

**结论**：开关本身能被 Chromium 认到，但**没有一个位置同时满足"Chromium 看得见"与"外壳的
`args.js` 不把它当未知参数拒掉"**——放在 app 路径之后时，`process.argv` 里有它，而
`args.js` 对未知参数是直接 `throw`。于是最小代价是给外壳加一个自己的 `--proxy <rules>`
（等号形式对 `args.js` 也不适用，它按空格取值解析），这正是 ADR-0009 记录的那一处取舍。

---

## 7. 没验证到的（诚实清单）

1. **系统代理启用状态下的正向继承**没有在本机用测试证明：本机 `ProxyEnable=0x0`，量到的外网结果只能是 `DIRECT`。第 6.2/6.3 节的"配了代理就走代理"是用**显式 `setProxy` + 日志代理**证明的；把系统代理打开再验一次需要改用户的系统设置，本次**没有做**。
2. 没有访问任何**真实登录站点**（票面第 4 条）。端到端的"站点是否因此不拒绝登录"由用户在本机实测；本次只能断言机制（UA 干净、`navigator.webdriver` 为假、没有 `--enable-automation`）。
3. `window.chrome` 的**可枚举键为空**、UA-CH **缺 `Google Chrome` 品牌**、UA 里**Chrome 版本是四段**这三处"嵌壳签名"**没有处理**（不属于自动化特征）。
4. 强杀丢数据只量到"写完立刻杀"这一种时序；**没有**测"等 N 秒再杀"的边界，也没有测 Chromium 的刷盘周期。
5. 第 8 节的 argv 现象只量到"能起/不能起"，**没有**定位到 Electron/Chromium 内部的具体机制。

---

## 8. 顺带量到的：一种 argv 形状会让 Electron 根本起不来（与本票无关，仅记录）

`electron main.js --url <http://…> --view-url <http://…>` ⇒ Electron 在**任何 app 代码跑起来之前**退出（exit `0xFFFFFFFF`、stdout/stderr 全空、过程约 65ms、事件日志无崩溃记录）。用"第一个语句就写文件"的探针确认过：**模块从未开始执行**。

矩阵实测（`matrix*.cjs`）：

| argv 形状 | 结果 |
|---|---|
| `--url <29 个普通字符> --view-url <29 个普通字符>` | 起得来 |
| `--url x --view-url y` | 起得来 |
| `--url http://127.0.0.1:39411/look` （URL 是最后一个 token） | 起得来 |
| `--url x --view-url http://127.0.0.1:39411/view` （URL 最后） | 起得来 |
| `--url a://b --bounds 0,0,1,1` （未知 scheme） | 起得来 |
| `--url a:b --bounds 0,0,1,1` | 起得来 |
| **`--url http://127.0.0.1:39411/look --view-url y`** | **起不来** |
| **`--url http://127.0.0.1:39411/look --bounds 0,0,100,100`** | **起不来** |
| **`--url http:/x --bounds 0,0,1,1`** / **`--url http:x --bounds …`** | **起不来** |
| **`--url mailto:a@b --bounds 0,0,1,1`** | **起不来** |
| **`--url=… --view-url=…`（等号形式）** | 起得来 |

**可用的规律**：一个**标准 scheme 的 URL**（`http`/`https`/`file`/`ftp`/`mailto`）作为**独立 token** 传进来、而它**后面还有 argv**，就会触发；URL 放最后一个 token 就没事，等号形式也没事（但外壳的 `args.js` 不支持等号形式）。

**本票的影响**：探针与测试都避开这个形状（唯一一个 URL 参数放最后，或不通过 CLI 传 URL）；**没有**顺手去修外壳的 CLI 解析（不属本票范围）。

> 续集：票 **#14** 把这半张表补完了（94 个形状、判据的精确边界、等号形式在任何位置都免疫），
> 并据此改了 README 与 `--help` 的写法、给 `args.js` 补上 `--url=<url>` / `--view-url=<url>`、
> 加了一条跑文档命令的守卫测试。完整规则与原始输出见
> [`t14-cli-url-token-kills-electron.md`](t14-cli-url-token-kills-electron.md) ——
> 本节那张表与它逐条一致，唯一被**放宽**的是"标准 scheme"这个说法：`foo:` / `tel:+123` 一样触发。

---

## 9. 对实现的直接含义

| 票面验收 | 今天 | 改动 |
|---|---|---|
| 登录一次、重启仍登录 | 持久（默认 session 在 userDataDir 下），但依附 DSH 界面的 session | 给这一格 `partition: 'persist:dsh-view'`（`persist:` 前缀 = 落盘，跨重启保留） |
| 不退化为"每次都是干净档案" | 未退化 | 同上；并用"优雅重启后 cookie + localStorage 仍在"把它钉住 |
| 外网继承系统代理、回环不走代理 | 两条都成立（第 6 节） | **不实现探测链、不写 `proxyBypassRules`**；发布 `DSH_SHELL PROXY` 读回，并留一个显式口子 `--proxy`（第 6.4/6.5 节，ADR-0009） |
| 站点不因自动化特征限流/拒绝登录 | UA 带 `Electron/44.3.0`；`navigator.webdriver = true`（根因 `--remote-debugging-port`） | 视图级 `setUserAgent`（去掉两个产品标记）+ 进程级 `disable-blink-features=AutomationControlled`（第 3、4 节，ADR-0009） |

**没有改**：`app.userAgentFallback`（全局 UA）、`app.setPath('userData', …)`（必须保留）、窗口那一路的 session、窗口的 UA（DSH 界面不需要）。

**改动之后复量一次（同一套探针，改完重跑 `node run.cjs identity-wrapped`）**：

| 特征 | 改前 | 改后 |
|---|---|---|
| 视图 `navigator.userAgent` | `… Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36` | `… Chrome/152.0.7977.78 Safari/537.36` |
| 视图 `navigator.webdriver` | `true` | **`false`** |
| 窗口 `navigator.webdriver` | `true` | **`false`**（影响面：量出来的） |
| 窗口 UA | 带 `Electron/44.3.0` | 不变（有意为之：只动那一格） |
| 视图 session | `=== defaultSession` | `persist:dsh-view`，`storagePath = <userDataDir>\Partitions\dsh-view` |
| 窗口/视图互相可见 cookie | 可见 | **看不见**（同源前提下） |
