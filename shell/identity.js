'use strict'

/**
 * 那一格的浏览器身份。
 *
 * 这个文件只回答三个问题，而且都是"这一格是谁、它的东西存在哪"：
 *   1. 它的登录态存在哪儿（{@link VIEW_PARTITION}）——自己的持久档案，不是外壳界面那份；
 *   2. 它以什么身份上网（{@link browserUserAgent}）——把 Electron 追加的产品标记去掉；
 *   3. 要不要留自动化标记（{@link AUTOMATION_BLINK_FEATURE}）——`--remote-debugging-port`
 *      会把它打开，而那个端口是整个架构的地基（ADR-0002），所以只能在进程级关掉（ADR-0009）。
 *
 * 这里是纯逻辑：Electron 只在 `shell/main.js` 里碰，本文件不 require('electron')，
 * 因此每一条判断都能在不起外壳的情况下被单独读回。
 */

/**
 * 那一格自己的持久档案。
 *
 * `persist:` 前缀是 Electron 的约定：有前缀 = 落盘（存在 `<userDataDir>/Partitions/<名字>` 下），
 * 跨重启保留；没有前缀 = 只在内存里，关掉就没了——那正是票面第 2 条要防的"每次都是干净档案"。
 *
 * 它与外壳界面那一路（`session.defaultSession`，档案就是 `<userDataDir>` 本身）是两个罐子：
 * 在同一个 origin 上，一边写的 cookie 与 localStorage，另一边读不到（实测见
 * `docs/research/browser-identity-and-profile.md` 第 5 节）。
 */
const VIEW_PARTITION = 'persist:dsh-view'

/**
 * 关掉 Chromium 自动化标记所需的 Blink 特性名。
 *
 * 实测：外壳自己加的 `--remote-debugging-port`（为了把视图交给插件，见 ADR-0002）单独就会让
 * 页面里的 `navigator.webdriver` 变成 `true`；不加它时是 `false`，且与 `--enable-automation`
 * 无关（外壳从来没加过后者）。把这个名字交给 `--disable-blink-features` 就能清掉，
 * 与 remote debugging 并存时依然有效。取舍与备选方案见 `docs/adr/0009`。
 */
const AUTOMATION_BLINK_FEATURE = 'AutomationControlled'

/**
 * 代理读回用的探针地址。
 *
 * 票面第 3 条要的是"外网站点继承系统代理；`127.0.0.1` / `localhost` 不经代理"，
 * 而这两半都能用 `session.resolveProxy` 读回来。四种写法各有理由：
 * 一个外网站点（看它是否取到系统设置的代理），以及回环的三种写法
 * （IPv4 字面量、主机名、IPv6——实测隐含 bypass 覆盖三者，而显式写 bypass 规则时
 * `[::1]` 最容易漏，见事实文档第 6 节）。
 */
const PROXY_PROBE_URLS = {
  external: 'https://example.com/',
  loopback127: 'http://127.0.0.1:9/',
  loopbackLocalhost: 'http://localhost:9/',
  loopbackV6: 'http://[::1]:9/',
}

/**
 * 把 Electron 默认 UA 里的"这不是浏览器"标记去掉，其余一字不改。
 *
 * 实测 `app.userAgentFallback` 的形状（应用名 `t6-ua-probe` / 版本 `9.9.9` 时的原值）：
 *
 *   `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
 *    t6-ua-probe/9.9.9 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36`
 *
 * 两个标记都要去，而且**不能只去 `Electron/`**：本仓库今天跑在默认应用名 `Electron` 下，
 * 所以只看得见 `Electron/44.3.0`；一旦应用名被正式设成 `dsh-desktop-view`，UA 里会再多出
 * 一个 `dsh-desktop-view/0.1.0`——那比现在还响。
 *
 * 只做删除，不做改写：Chrome 那一版号保持原样（真 Chrome 的 UA 只留主版本号，
 * 这一点属于"嵌壳签名"而不是"自动化特征"，不在本票范围内，见事实文档第 4 节）。
 *
 * @param {string} userAgent - `app.userAgentFallback`。
 * @param {string} appName - `app.getName()`。
 * @param {string} appVersion - `app.getVersion()`。
 * @returns {string} 去掉产品标记后的 UA。
 */
function browserUserAgent(userAgent, appName, appVersion) {
  return String(userAgent)
    .replace(new RegExp(`\\s*${escapeRegExp(String(appName))}/${escapeRegExp(String(appVersion))}`, 'g'), '')
    .replace(/\s*Electron\/[^\s]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 转义正则元字符，让应用名可以安全地拼进正则。
 * @param {string} text - 原文。
 * @returns {string} 转义后的文本。
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = { VIEW_PARTITION, AUTOMATION_BLINK_FEATURE, PROXY_PROBE_URLS, browserUserAgent }
