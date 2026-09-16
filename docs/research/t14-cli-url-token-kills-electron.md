# #14 底稿：一个"独立 URL 参数后面还跟着参数"，就让 electron.exe 在应用代码之前退出

票面现象（`README.md` 里那条示例，`82c3fc2` 那版第 82 行）：

```pwsh
npx electron shell/main.js --url https://example.com --view-url https://example.org
```

```text
=== A: README:54 的形状,等待退出 ===
exited after 1.15s, code=-1 (0xFFFFFFFF)
```

零输出、零提示，退出码 `0xFFFFFFFF`。用户看到的是"命令敲了，什么都没发生"。

**要害**：失败发生在**应用代码跑起来之前**，所以 `shell/args.js` 里的 argv 校验**永远不会执行** ——
**外壳运行时无法自保**（这也解释了为什么 `--help` 打不出来）。因此这条 bug 的修法只能两件事：
**文档只用已证明安全的形状** + **一条跑文档命令的守卫测试**。

本文件是本轮**实测**的完整刻画：94 个 argv 形状、真外壳那一层的复现、能做与不能做的边界。
所有结论都有原始输出，没有一条来自"看起来应该"。

---

## 1. 一句话规则

把命令行按 Chromium 的方式切开：以 `-` 开头的 token 是**开关**，其余 token 是**独立 token**
（"值"与"位置参数"在它眼里是同一类东西）。一个独立 token 只要形如

```text
<字母><字母数字 | + | - | . 至少一个>:
```

—— 也就是**"方案 + 冒号"，冒号后面是什么都不影响** —— 就算"看起来像 URL"。那么：

> **只要这样一个 token 后面还跟着另一个独立 token，electron.exe 就在应用代码之前自己退出：
> 零输出、退出码 `0xFFFFFFFF`、大约 60ms。**

等价的说法：**那个 URL 必须是最后一个独立 token**，或者它后面只跟开关。

三条容易踩的推论：

1. **空格形式的开关值在 Chromium 眼里不是"值"**。实测：`--user-data-dir=<dir>` 会把目录建出来，
   `--user-data-dir <dir>` **不会**（见 §4）。所以 `--url https://a --view-url https://b` 里
   `https://b` 是**独立 token** —— 这正是票面那条命令会死的原因，跟"两个 URL"无关
   （`--url https://a --view-url x` 一样死，实测 J4）。
2. **等号形式把 URL 留在开关 token 里**，它永远不会变成独立 token，所以**在任何位置都免疫**
   （B1 / B3 / M1 / M7 / M13 / M15，全部实测安全）。这就是文档推荐 `--url=<url>` 的全部理由。
3. **单字母"方案"是盘符，不算 URL**：`C:\x`、`a:b` 都安全（K9 / Q1 / Q2 / Q15）；方案不能以数字开头
   （`1http://x` 安全，N3 / Q6）；没有方案的 `//example.com` 不算（K5）。

---

## 2. 量具

一个**最小 Electron 应用**放在临时目录里（不进仓库），它只做一件事：

```js
const { app, BrowserWindow } = require('electron')
// ① 应用代码的第一行就同步打印 argv —— 能打印出来就说明"失败在应用代码之前"不成立
process.stdout.write('PROBE APP-CODE-RAN argv=' + JSON.stringify(process.argv) + '\n')
app.whenReady().then(async () => {
  process.stdout.write('PROBE READY\n')
  app.exit(0)   // 不建窗口，也不落任何东西
})
```

驱动脚本用 `child_process.spawn` **直接起 `electron.exe`**（中间不经过 shell / npm / npx，
量到的就是 Electron 自己看到的那份 argv），每个用例一个自己的 `--user-data-dir`，
逐例记录：退出码、耗时、`PROBE APP-CODE-RAN` 有没有出现、stdout / stderr 全文。

量具的两条已知缺陷（写在前面，免得读者把量具的话当成 Electron 的话）：

- **空格形式的 `--user-data-dir` 不被 Chromium 消费**（§4），所以探针那些用例其实都用的是
  Electron 的默认档案。这**不影响**"会死 / 不会死"的判断（死的那一类根本没走到档案初始化），
  但"探针之间档案隔离"这句话是不成立的。
- 探针的应用路径是一个**文件**（`probe-main.js`），与 README 里 `shell/main.js` 同形；
  "应用路径是目录（package.json 应用）"这一种没量。

---

## 3. 规则表（94 个形状，全部实测）

`会死` = 退出码 `4294967295`（`0xFFFFFFFF`）、约 60ms、`PROBE APP-CODE-RAN` **没有**出现、
stdout 与 stderr **都是 0 字节**。

### 3.1 会死的形状（关键几类）

| 用例 | argv（`--user-data-dir <临时目录>` 之后的部分） | 为什么 |
|---|---|---|
| A1 | `--url https://example.com --view-url https://example.org` | **票面那条**：`https://example.com` 后面还有独立 token |
| A2 | `--view-url https://example.org --url https://example.com` | 两个 URL 换顺序也没用：第一个 URL 后面还有 token |
| E2 | `--url https://a.example --url https://b.example --no-show` | 同上 |
| C1 / J11 | `--url https://example.com extra-positional` | 后面的东西是不是开关都无所谓，是独立 token 就行 |
| J4 | `--url https://example.com --view-url x` | **后面的值不必是 URL**：`x` 一样触发 |
| J3 | `--url https://example.com --no-show x` | 隔着开关也算：`x` 是独立 token |
| C2 / M3 | `--url https://example.com https://example.org` / `https://example.com https://example.org` | 连开关都不需要 |
| M12 | `x https://example.com y` | URL 前面的东西不相干，后面有就行 |
| M2 | `--url=https://example.com https://example.org x` | 等号只保住它自己那个 token |
| Q3 / Q4 | `ab: z` / `foo: z` | **冒号后面可以什么都没有**：`foo:` 也算 URL |
| Q10 / Q16 / Q17 | `foo:bar z` / `mailto:a@b z` / `tel:+123 z` | 与 `//` 无关，与是不是 http 无关 |
| K1 / K2 / K3 / K6 / K7 / N6 / N7 | `http://…` / `file:///C:/x` / `foo://bar` / `https:/example.com` / `ws://…` / `http:\example.com` / `HTTPS://…` | 方案大小写无所谓、单斜杠也算、反斜杠也算 |
| N1 / N2 / N4 / Q7 | `foo:` / `a1+b-c.d://x` / `http:/` / `a1:` | 方案字符集就按 RFC 那一套 |
| C4 | `--url https://example.com --user-data-dir C:\tmp\x` | 后面的值长得像路径也没用 |

### 3.2 安全的形状（关键几类）

| 用例 | argv | 为什么安全 |
|---|---|---|
| B3 / M15 | `--url=https://example.com --view-url=https://example.org` | **文档推荐写法**：一个独立 URL token 都没有 |
| B1 | `--url=https://example.com --view-url https://example.org` | 唯一的独立 URL token 在最后 |
| M1 / M13 | `--url=https://example.com x` / `--url=https://example.com --no-show` | 等号形式后面跟什么都不怕 |
| M7 | `--url=https://example.com --view-url=https://example.org --dsh` | 后面还能再加开关 |
| A3 / O3 / G1 | `--url https://example.com` / `https://example.com` / `--dsh-profile dshviewer --view-url https://cn.bing.com` | 空格形式但 URL 是**最后一个** token |
| C3 / H3 / E1 / E3 / H1 / H2 | `--url https://example.com --no-show` 之类：URL 后面**只剩开关** | 开关不是独立 token |
| J5 / M5 / M6 | `--url https://example.com --view-url` / `… --no-show --no-show` / `--url https://x --view-url --no-show` | 同上 |
| M11 / M14 / J8 | `x https://example.com` / `x --no-show https://example.com` / `--url x --view-url https://example.org` | URL 在最后 |
| K9 / Q1 | `--url C:\x\y --view-url C:\a\b` / `C:\x\y z` | 盘符不是方案 |
| Q2 / Q15 | `a:b z` / `a:b c:d` | 单字母方案 = 盘符 |
| N3 / Q6 | `1http://x z` / `1a:b z` | 方案必须以字母开头 |
| Q5 | `:foo z` | 没有方案 |
| K5 | `--url //example.com --view-url https://example.org` | 没有方案 |
| K10 / K11 / Q8 / Q12 / Q13 / D2–D6 | `example.com` / `./a.html` / `a/b` / `\\server\share` … | 都不像 URL |
| F1 / F2 | `--profile dshviewer --no-open --port 0`（**外壳 spawn `dsh` 用的正是这条**） | 一个 URL token 都没有 |

### 3.3 被排除的竞争解释

- **"位置参数太多"**（外部资料就是这么解释的，见 §8）：**不成立**。O1（`a b c d`）、O2（`--no-show x y z`）、
  K9 / K10 / K11 都有 3–5 个独立 token，全部安全；而死掉的那些只要把 URL 挪到最后一个 token 就活了。
- **"`--url` 这个开关名特殊"**：**不成立**。H1 / H2 用完全陌生的开关名（`--some-unknown-flag`）一样会死；
  A3 / J1 里 `--url` 在不在都不影响结论（J1 = `https://example.com x`，没有 `--url`，照样死）。
- **"后面的值也得是 URL"**：**不成立**。J4（`--view-url x`）、C1（`extra-positional`）、C4（`C:\tmp\x`）都会死。
- **"只有第一个 URL 参数会触发"**：判据是"**第一个**像 URL 的独立 token 后面还有没有独立 token"，
  这跟"任何一个 URL 后面还有独立 token"是同一件事；M2 就是等号 URL 打头、裸 URL 在中间的例子，照样死。

---

## 4. 原始输出

### 4.1 全部 94 个形状（逐行原文，`node probe-driver.mjs` 的 stdout）

```text
A1-README-原样                       EXITED code=4294967295 @64ms 应用代码=false
A2-URL在最后                          EXITED code=4294967295 @57ms 应用代码=false
A3-只有一个URL-末尾                      OK 正常退出 code=0 应用代码跑了 @287ms 输出293字节
A4-无URL                            OK 正常退出 code=0 应用代码跑了 @294ms 输出275字节
B1-第一个等号                           OK 正常退出 code=0 应用代码跑了 @290ms 输出326字节
B2-第二个等号                           OK 正常退出 code=0 应用代码跑了 @292ms 输出326字节
B3-两个都等号                           OK 正常退出 code=0 应用代码跑了 @291ms 输出324字节
B4-等号-布尔后跟URL                      OK 正常退出 code=0 应用代码跑了 @290ms 输出338字节
C1-URL后跟非选项                        EXITED code=4294967295 @59ms 应用代码=false
C2-URL后跟另一个URL                     EXITED code=4294967295 @58ms 应用代码=false
C3-URL后跟选项但选项无值                    OK 正常退出 code=0 应用代码跑了 @295ms 输出305字节
C4-URL后跟选项带非URL值                   EXITED code=4294967295 @59ms 应用代码=false
C5-选项带URL值后再跟选项                    OK 正常退出 code=0 应用代码跑了 @282ms 输出312字节
D1-带冒号无斜杠                          OK 正常退出 code=0 应用代码跑了 @279ms 输出293字节
D2-相对路径                            OK 正常退出 code=0 应用代码跑了 @275ms 输出302字节
D3-Windows路径                       OK 正常退出 code=0 应用代码跑了 @280ms 输出310字节
D4-裸域名                             OK 正常退出 code=0 应用代码跑了 @298ms 输出297字节
D5-单斜杠开头                           OK 正常退出 code=0 应用代码跑了 @293ms 输出295字节
D6-双斜杠开头                           OK 正常退出 code=0 应用代码跑了 @283ms 输出301字节
D7-file协议                          OK 正常退出 code=0 应用代码跑了 @296ms 输出312字节
E1-第二个URL非末尾                       OK 正常退出 code=0 应用代码跑了 @286ms 输出319字节
E2-两个URL都非末尾                       EXITED code=4294967295 @64ms 应用代码=false
E3-URL在中间-前后都有                     OK 正常退出 code=0 应用代码跑了 @306ms 输出317字节
F1-dsh形状                           OK 正常退出 code=0 应用代码跑了 @305ms 输出312字节
F2-dsh形状加尾部URL                     OK 正常退出 code=0 应用代码跑了 @302ms 输出342字节
G1-view-url在最后                     OK 正常退出 code=0 应用代码跑了 @319ms 输出326字节
H1-陌生开关-URL-开关                     OK 正常退出 code=0 应用代码跑了 @278ms 输出319字节
H2-陌生开关-URL-陌生开关                   OK 正常退出 code=0 应用代码跑了 @288ms 输出327字节
H3-只有view-url在中间                   OK 正常退出 code=0 应用代码跑了 @288ms 输出310字节
H4-裸URL在开头                         OK 正常退出 code=0 应用代码跑了 @291ms 输出297字节
H5-裸URL在末尾                         OK 正常退出 code=0 应用代码跑了 @313ms 输出297字节
H6-裸URL在末尾-后无参数                    OK 正常退出 code=0 应用代码跑了 @294ms 输出309字节
J1-裸URL后跟位置参数                      EXITED code=4294967295 @63ms 应用代码=false
J2-开关-裸URL-位置参数                    EXITED code=4294967295 @61ms 应用代码=false
J3-URL-无值开关-位置参数                   EXITED code=4294967295 @60ms 应用代码=false
J4-URL后跟开关+非URL值                   EXITED code=4294967295 @61ms 应用代码=false
J5-URL后跟无值开关在末尾                    OK 正常退出 code=0 应用代码跑了 @290ms 输出306字节
J6-A1再加尾部无值开关                      EXITED code=4294967295 @60ms 应用代码=false
J7-等号-再跟URL-再跟选项值                  EXITED code=4294967295 @60ms 应用代码=false
J8-普通值-URL在末尾                      OK 正常退出 code=0 应用代码跑了 @284ms 输出310字节
J9-URL后跟双横线                        OK 正常退出 code=0 应用代码跑了 @284ms 输出298字节
J11-URL后跟一个位置参数                    EXITED code=4294967295 @67ms 应用代码=false
J12-等号-第二个URL后跟选项值                 EXITED code=4294967295 @61ms 应用代码=false
K1-http两边                          EXITED code=4294967295 @66ms 应用代码=false
K2-file后跟https                     EXITED code=4294967295 @61ms 应用代码=false
K3-非http方案                         EXITED code=4294967295 @63ms 应用代码=false
K4-后一个值非http方案                     EXITED code=4294967295 @60ms 应用代码=false
K5-双斜杠无方案                          OK 正常退出 code=0 应用代码跑了 @280ms 输出322字节
K6-单斜杠有冒号                          EXITED code=4294967295 @62ms 应用代码=false
K7-ws方案                            EXITED code=4294967295 @61ms 应用代码=false
K9-两条Windows路径                     OK 正常退出 code=0 应用代码跑了 @285ms 输出306字节
K10-两个裸域名                          OK 正常退出 code=0 应用代码跑了 @297ms 输出312字节
K11-两个相对路径                         OK 正常退出 code=0 应用代码跑了 @303ms 输出306字节
M1-等号URL后跟位置参数                     OK 正常退出 code=0 应用代码跑了 @305ms 输出295字节
M2-等号URL-裸URL-位置参数                 EXITED code=4294967295 @60ms 应用代码=false
M3-两个裸URL                          EXITED code=4294967295 @62ms 应用代码=false
M5-URL后跟两个无值开关                     OK 正常退出 code=0 应用代码跑了 @316ms 输出317字节
M6-URL后跟带开关名的开关                    OK 正常退出 code=0 应用代码跑了 @294ms 输出318字节
M7-两个等号URL加布尔                      OK 正常退出 code=0 应用代码跑了 @310ms 输出332字节
M11-位置参数在URL前                      OK 正常退出 code=0 应用代码跑了 @323ms 输出289字节
M12-位置参数-URL-位置参数                  EXITED code=4294967295 @60ms 应用代码=false
M13-等号URL后跟布尔                      OK 正常退出 code=0 应用代码跑了 @287ms 输出303字节
M14-裸URL位置参数在最后                    OK 正常退出 code=0 应用代码跑了 @301ms 输出301字节
M15-文档候选形状                         OK 正常退出 code=0 应用代码跑了 @282ms 输出324字节
N1-方案冒号后什么也没有                      EXITED code=4294967295 @58ms 应用代码=false
N2-复杂方案名                           EXITED code=4294967295 @64ms 应用代码=false
N3-方案以数字开头                         OK 正常退出 code=0 应用代码跑了 @280ms 输出318字节
N4-只有方案与斜杠                         EXITED code=4294967295 @62ms 应用代码=false
N5-含等号的位置参数                        OK 正常退出 code=0 应用代码跑了 @284ms 输出291字节
N6-反斜杠方案                           EXITED code=4294967295 @59ms 应用代码=false
N7-大写方案                            EXITED code=4294967295 @64ms 应用代码=false
O1-四个位置参数无URL                      OK 正常退出 code=0 应用代码跑了 @298ms 输出279字节
O2-开关后三个位置参数                       OK 正常退出 code=0 应用代码跑了 @296ms 输出287字节
O3-裸URL位置参数唯一                      OK 正常退出 code=0 应用代码跑了 @293ms 输出285字节
O4-等号值在中间                          OK 正常退出 code=0 应用代码跑了 @290ms 输出309字节
O5-裸URL后跟开关再位置参数                   OK 正常退出 code=0 应用代码跑了 @280ms 输出302字节
O6-两个URL中间夹开关                      EXITED code=4294967295 @61ms 应用代码=false
Q1-Windows路径                       OK 正常退出 code=0 应用代码跑了 @322ms 输出278字节
Q2-单字母方案                           OK 正常退出 code=0 应用代码跑了 @272ms 输出273字节
Q3-两字母方案裸冒号                        EXITED code=4294967295 @59ms 应用代码=false
Q4-三字母方案裸冒号                        EXITED code=4294967295 @60ms 应用代码=false
Q5-冒号在开头                           OK 正常退出 code=0 应用代码跑了 @281ms 输出274字节
Q6-方案以数字开头                         OK 正常退出 code=0 应用代码跑了 @274ms 输出274字节
Q7-方案字母加数字                         EXITED code=4294967295 @58ms 应用代码=false
Q8-裸域名                             OK 正常退出 code=0 应用代码跑了 @284ms 输出281字节
Q9-http对照                          EXITED code=4294967295 @66ms 应用代码=false
Q10-冒号在中间                          EXITED code=4294967295 @59ms 应用代码=false
Q11-file对照                         EXITED code=4294967295 @60ms 应用代码=false
Q12-只有斜杠                           OK 正常退出 code=0 应用代码跑了 @319ms 输出273字节
Q13-UNC路径                          OK 正常退出 code=0 应用代码跑了 @305ms 输出287字节
Q14-URL位置参数在最后                     OK 正常退出 code=0 应用代码跑了 @322ms 输出285字节
Q15-两个带冒号值                         OK 正常退出 code=0 应用代码跑了 @294ms 输出275字节
Q16-mailto                         EXITED code=4294967295 @65ms 应用代码=false
Q17-tel                            EXITED code=4294967295 @68ms 应用代码=false
```

（`A2 / D7 / H4 / H5 / O5` 等"看起来矛盾"的行，其判据都在 §1：**看的是独立 token 的先后，不是开关的名字**。
两次独立整跑（分轮跑与整跑）逐例一致，没有一例翻转。）

### 4.2 关键形状的完整记录（原样 JSON）

```json
{
  "name": "A1-README-原样",
  "args": ["--url", "https://example.com", "--view-url", "https://example.org"],
  "exitCode": 4294967295,
  "aliveAtTimeout": false,
  "ranAppCode": false,
  "durationMs": 64,
  "stdout": "",
  "stderr": ""
}
{
  "name": "B3-两个都等号",
  "args": ["--url=https://example.com", "--view-url=https://example.org"],
  "exitCode": 0,
  "aliveAtTimeout": false,
  "ranAppCode": true,
  "durationMs": 291,
  "stdout": "\r\nPROBE APP-CODE-RAN argv=[\"G:\\\\dsh_test1\\\\node_modules\\\\electron\\\\dist\\\\electron.exe\",\"C:\\\\Users\\\\zhangtianyi\\\\AppData\\\\Local\\\\Temp\\\\dsh-t14-probe\\\\probe-main.js\",\"--user-data-dir\",\"C:\\\\Users\\\\ZHANGT~1\\\\AppData\\\\Local\\\\Temp\\\\dsh-t14-profile-qD0BVf\",\"--url=https://example.com\",\"--view-url=https://example.org\"]\nPROBE READY\n",
  "stderr": ""
}
{
  "name": "C3-URL后跟选项但选项无值",
  "args": ["--url", "https://example.com", "--no-show"],
  "exitCode": 0,
  "ranAppCode": true,
  "durationMs": 295,
  "stdout": "\r\nPROBE APP-CODE-RAN argv=[\"G:\\\\dsh_test1\\\\node_modules\\\\electron\\\\dist\\\\electron.exe\",\"C:\\\\Users\\\\zhangtianyi\\\\AppData\\\\Local\\\\Temp\\\\dsh-t14-probe\\\\probe-main.js\",\"--user-data-dir\",\"C:\\\\Users\\\\ZHANGT~1\\\\AppData\\\\Local\\\\Temp\\\\dsh-t14-profile-6p1scV\",\"--url\",\"https://example.com\",\"--no-show\"]\nPROBE READY\n",
  "stderr": ""
}
{
  "name": "J4-URL后跟开关+非URL值",
  "args": ["--url", "https://example.com", "--view-url", "x"],
  "exitCode": 4294967295,
  "ranAppCode": false,
  "durationMs": 61,
  "stdout": "",
  "stderr": ""
}
{
  "name": "J5-URL后跟无值开关在末尾",
  "args": ["--url", "https://example.com", "--view-url"],
  "exitCode": 0,
  "ranAppCode": true,
  "durationMs": 290,
  "stdout": "\r\nPROBE APP-CODE-RAN argv=[\"G:\\\\dsh_test1\\\\node_modules\\\\electron\\\\dist\\\\electron.exe\",\"C:\\\\Users\\\\zhangtianyi\\\\AppData\\\\Local\\\\Temp\\\\dsh-t14-probe\\\\probe-main.js\",\"--user-data-dir\",\"C:\\\\Users\\\\ZHANGT~1\\\\AppData\\\\Local\\\\Temp\\\\dsh-t14-profile-QfwIPs\",\"--url\",\"https://example.com\",\"--view-url\"]\nPROBE READY\n",
  "stderr": ""
}
{
  "name": "K9-两条Windows路径",
  "args": ["--url", "C:\\x\\y", "--view-url", "C:\\a\\b"],
  "exitCode": 0,
  "ranAppCode": true,
  "durationMs": 285,
  "stdout": "\r\nPROBE APP-CODE-RAN argv=[\"G:\\\\dsh_test1\\\\node_modules\\\\electron\\\\dist\\\\electron.exe\",\"C:\\\\Users\\\\zhangtianyi\\\\AppData\\\\Local\\\\Temp\\\\dsh-t14-probe\\\\probe-main.js\",\"--user-data-dir\",\"C:\\\\Users\\\\ZHANGT~1\\\\AppData\\\\Local\\\\Temp\\\\dsh-t14-profile-k7gv4I\",\"--url\",\"C:\\\\x\\\\y\",\"--view-url\",\"C:\\\\a\\\\b\"]\nPROBE READY\n",
  "stderr": ""
}
{
  "name": "Q4-三字母方案裸冒号",
  "args": ["foo:", "z"],
  "exitCode": 4294967295,
  "ranAppCode": false,
  "durationMs": 60,
  "stdout": "",
  "stderr": ""
}
```

### 4.3 死得多早：三条独立证据

1. **应用代码一行都没跑**：`PROBE APP-CODE-RAN`（模块第一行）在死掉的那一类里从不出现；
   活着的那一类里它出现，而且 stdout 里能看到 Electron 收到的那份 argv 原样。
2. **Chromium 连档案目录都没建**（用等号形式把目录指到一个全新路径，先删掉再跑）：

   ```text
   死亡形状  exit=4294967295    70ms 应用代码=false 档案目录=没有
   安全形状  exit=0            314ms 应用代码=true  档案目录=有(0 文件)
   ```

3. **连日志都没来得及开**：在 URL 之前加上 `--enable-logging=stderr --v=1` 并设
   `ELECTRON_ENABLE_LOGGING=1`，结论仍然是 `exit=-1，输出 0 字节`。

也就是说：这条判断发生在 **`electron.exe` 启动的最初阶段**（Chromium 初始化之前），
比"加载应用脚本"还早 —— 这就是为什么外壳里任何防御代码都救不了它。

### 4.4 真外壳那一层：README 命令原样复现

`cmd /c npx electron shell/main.js --url https://example.com --view-url https://example.org --user-data-dir <临时目录>`：

```json
{
  "exitCode": 4294967295,
  "timedOut": false,
  "durationMs": 5968,
  "stdoutBytes": 0,
  "stderrBytes": 335,
  "handshake": false,
  "fatal": null,
  "stdout": "",
  "stderr": "npm warn Unknown project config \"electron_mirror\". …\nnpm warn Unknown project config \"playwright_skip_browser_download\". …\n"
}
```

**stdout 0 字节**、`handshake: false`、`DSH_SHELL FATAL` 也没有（外壳一个字都没来得及说），
stderr 里那 335 字节全是 npm 自己的 `.npmrc` 警告 —— 也就是说用户看到的确实只有 npm 的噪音。
那几个秒是 `npx` 的启动开销（直接起 `electron.exe` 只要 ~60ms）。

### 4.5 等号形式：不只是"不死"，而是**走到了应用代码**

同一个形状改成等号（`82c3fc2` 那版的 `shell/args.js` 还不认等号）：

```text
exitCode: 2      （应用代码跑了，自己报了错）
stdoutBytes: 2
stderr: … shell: unknown argument: --url=https://example.com
        Usage: electron shell/main.js [options]
        …（完整 --help 全文）…
```

两件事一次量到：**等号形式不会被 Electron 拦下**（它进了 `args.js`），而且 **argv 原样可见**
（`unknown argument: --url=https://example.com`）—— 这也是"让 `args.js` 接受等号形式"能做的依据。

### 4.6 空格形式的开关值：Chromium 不消费它

```text
等号形式  eq   exit=0   307ms 应用代码=true  档案目录=有(0 文件)
空格形式  sp   exit=0   307ms 应用代码=true  档案目录=没有
```

`--user-data-dir=<dir>` 建了目录，`--user-data-dir <dir>` **没有**。这条不是本票的 bug，
但它是 §1 第 1 条推论（"开关后面的那一坨也是独立 token"）的直接证据，
也解释了为什么外壳要自己 `app.setPath('userData', …)`（`shell/main.js:87-89`）。

---

## 5. 外壳自己 spawn 的 `dsh` 子进程会不会中？

**不会，两条独立理由：**

1. **那条 argv 里一个 URL token 都没有**。`shell/main.js` 里是
   `['--profile', options.dshProfile, '--no-open', '--port', '0']`（第 405 行与第 1129 行两处），
   `tests/acceptance.spec.ts` 还从**操作系统的进程表**里读回过 `--no-open` / `--port 0`。
   实测同样的形状 `--profile dshviewer --no-open --port 0`：安全（F1）。
2. **`dsh` 跑的是 Node，不是 Electron**。把同一份致命 argv 交给 Node：

   ```text
   node probe-node.mjs --url https://example.com --view-url https://example.org
   NODE-ARGV ["--url","https://example.com","--view-url","https://example.org"]   exit=0
   ```

   Node 不解析 argv 里的 URL，原样交给应用。PATH 上的 `dsh` 是一个垫片
   （`F:\claude code\global\dsh.ps1`），最终跑 `@deepseek-ai/dsh/lib/bin.js`，即 Node。

结论：这条 bug 是 **Electron 启动器**（Windows）的事，插件侧那条子进程链路不受影响。

---

## 6. 修法

只做两件事（票面允许的范围）：

1. **文档只用已证明安全的形状**，并写明这个坑：
   - `README.md` 里那条示例改成 `--url=https://example.com --view-url=https://example.org`；
     正文里"往脚本上追加参数也一样"那条改成 `npm run shell -- --view-url=https://www.bing.com`；
   - 紧跟代码块加了引用块：坑的后果（应用代码之前、零输出、`0xFFFFFFFF`）、
     "空格形式只在 URL 是最后一个参数时才安全（那是**位置**安全）"、"优先写等号形式"，
     并指向本文件；
   - `shell/args.js` 的 `--help` 文本同样改成等号形式 + 同样说明 + 指向本文件。
2. **`args.js` 同时接受 `--url=<url>` / `--view-url=<url>`**（**唯一**的产品改动，只对这两个开关生效，
   CLI 语义没有重排：`--user-data-dir=<dir>`、`--bounds=…` 仍然是 `unknown argument`，实测钉在测试里）。
   动机不是"好看"：等号形式是**唯一**在"URL 后面还会跟参数"时也安全的写法，
   而"后面还会跟参数"正是使用者天天在做的事（追加一个开关就中招）。

**没有**改 `shell/main.js` 的启动逻辑，也**没有**加任何运行时防御 —— 加了也永远不会执行（§4.3）。

### 6.1 守卫：`tests/cli-shape.spec.ts`

六条测试，三条静态三条动态：

| 测试 | 钉住什么 |
|---|---|
| 规则本体 | §1 的判据对着 14 个"会死"+ 17 个"安全"的**实测样本**两边都成立 |
| `args.js` 等号形式 | `--url=` / `--view-url=` 生效；空格形式照旧；别的开关仍然报 `unknown argument` |
| `--help` 文本 | 写了 `--url=<url>` / `--view-url=<url>`、写了 `0xFFFFFFFF`、写了"外壳救不了自己"、指明了底稿 |
| **文档门禁** | 从 `README.md` **解析**出每一条调用外壳的命令（代码块行 + 行内反引号），逐条按 §1 的判据检查；条数有下限，不许"零条 = 全绿" |
| **动态守卫** | 把 README 里带 URL 的那条命令**原样**拿来（只把 URL **值**换成本机回环页面的地址，token 个数 / 开关名 / `=` / 顺序一字不动），起真 Electron：必须拿到握手、`viewUrl` 与窗口地址都读回来对得上 |
| **反证** | 同一个 URL 值、换成旧形状：必须秒退 `0xFFFFFFFF`、stdout 0 字节 |

`--dsh` 的那种文档命令（要真宿主、几十秒）在动态守卫里**只做形状门禁**，并在 stdout 上写明
"这一条只做了形状门禁、为什么" —— 不是静默跳过。它的端到端证据在 §6.3。

原始输出（本机跑一次）：

```text
RAW 判据: 会死 14 例 / 安全 17 例，全部对上
RAW parseArgv 等号形式: {"windowUrl":"https://example.com","viewUrl":"https://example.org"}
RAW --help 里的等号形式与坑: 都在
RAW 真跑文档形状: README.md:83: npx electron shell/main.js --url=https://example.com --view-url=https://example.org
                 → argv=["--url=http://127.0.0.1:61845/shell","--view-url=http://127.0.0.1:61845/view"]
RAW 握手: {"viewUrl":"http://127.0.0.1:61845/view","targetUrl":"http://127.0.0.1:61845/view"}
RAW 窗口地址（从窗口自己读回来）: http://127.0.0.1:61845/shell
RAW 只做形状门禁（起真宿主要几十秒，URL 开关与 --dsh 无关）: README.md:106（行内反引号）: npm run shell -- --view-url=https://www.bing.com
RAW 旧形状: {"argv":["--url","http://127.0.0.1:61845/shell","--view-url","http://127.0.0.1:61845/view"],
             "exitCode":4294967295,"exitCodeHex":"0xffffffff","durationMs":65,
             "stdoutBytes":0,"stderrBytes":0,"killedMyTree":false}
```

### 6.2 反证：把文档改回坑里的形状

把 `README.md:83` 改回 `--url https://example.com --view-url https://example.org`，同一个 spec：

```text
 ❯ tests/cli-shape.spec.ts (6 tests | 2 failed) 148ms
     ✓ 规则：像 URL 的独立 token 后面还跟着 token → electron.exe 在应用代码之前退出 2ms
     ✓ args.js 同时接受 --url=<url> 与 --view-url=<url>，空格形式与其它开关的语义没变 1ms
     ✓ --help 写了等号形式，也写了这个坑的后果 0ms
     × README 与 --help 里每一条外壳命令都是已证明安全的形状 8ms
     × README 里那条带 URL 的命令真的跑得起来，而且两个 URL 都真的生效 70ms
     ✓ 反证：同一个 URL 值，换成 README 的旧形状就秒退 0xFFFFFFFF 且零输出 61ms

AssertionError: 文档里出现了"独立 URL token 后面还跟着参数"的形状：那条命令会让 electron.exe 在应用代码之前退掉
+   "README.md:83: npx electron shell/main.js --url https://example.com --view-url https://example.org（致命 token: https: …

Error: the shell exited with code 4294967295 before publishing a handshake
 Test Files  1 failed (1)
      Tests  2 failed | 4 passed (6)
```

两条测试同时红：**静态门禁**（形状）与**动态守卫**（真跑一次，秒退）。改回来之后恢复全绿。

### 6.3 `npm run shell -- --view-url=https://www.bing.com` 的端到端核对

这条要真 `dsh` 宿主，所以放在守卫测试之外，人工跑一次：临时 `DSH_HOME`
（照 `tests/shell-harness.ts` 的 `makeTempDshHome` 搭：临时 home + 装好本插件的 `dshviewer` profile）
+ 临时 `--user-data-dir` —— 用户自己的 `~/.dsh` 与他自己那个外壳进程都没碰。原始输出（长 JSON 里用 `…`
标出省略的部分，`token` 的值抹掉了，其余逐字）：

```text
> dsh-desktop-view@0.1.0 shell
> electron shell/main.js --dsh --view-url=https://www.bing.com --user-data-dir C:\Users\…\Temp\dsh-t14-bing-ATchHu

DSH_SHELL CDP {"cdpUrl":"http://127.0.0.1:51285"}
DSH_SHELL SPACES {"protocol":1,"requestId":0,"error":null,"active":"default", … "spaces":[{"name":"default", … "url":"https://cn.bing.com/", … "cookieCount":13}]}
DSH_DESKTOP_VIEW_HANDSHAKE {"cdpUrl":"http://127.0.0.1:51285", … "targetUrl":"https://cn.bing.com/","viewUrl":"https://www.bing.com", … }
DSH_SHELL DSH_ARGV {"command":"dsh","argv":["--profile","dshviewer","--no-open","--port","0"]}
DSH_SHELL HOST_STDOUT {"text":"dsh web: http://127.0.0.1:58024/?token=…\n"}
DSH_SHELL DSH_URL {"url":"http://127.0.0.1:58024/?token=…"}
```

量到的：`handshake: true`、`viewUrl: "https://www.bing.com"`（等号形式真的被解析了）、
真宿主起来了（有 `DSH_URL`）、耗时 10.9s、`fatal: null`。
同一份输出里还有 **`DSH_ARGV {"command":"dsh","argv":["--profile","dshviewer","--no-open","--port","0"]}`** ——
§5 那条"子进程 argv 里没有 URL"在这里是外壳自己打出来的事实，不是我们从代码里读出来的意图。

---

## 7. 没能验证到的（诚实清单）

- **机制没有解出来**。能确定的只有"发生在 `electron.exe` 启动的最初阶段、Chromium 档案目录
  建出来之前、且零输出"（§4.3），以及"判据作用在 Chromium 眼里的 argv 切分上"（§4.5/§4.6）。
  Electron 内部是哪一行做的判断，没有证据；上游 issue / 文档里也没找到能对上的条目（§8）。
- **只在 Windows + `electron@44.3.0`（`package.json` 里钉住的版本）上量过**。
  macOS / Linux 一个都没量；这条判断看起来在 Windows 启动器那一层，但**不能**据此推断别的平台。
- **只量了 `-` 前缀的开关**。Windows 风格 `/switch` 没量（`//example.com` 安全有两种可能成因，
  没有区分开）。
- **空格形式开关值不被消费**，只在 `--user-data-dir` 上量过；其它开关没逐个量（§4.6）。
- **`foo:` 为什么算 URL**（"方案 + 冒号"里冒号后面可以什么都没有）只量到"会死"，
  没找到是哪一套判据（RFC 3986 允许空 opaque path，Win32 `PathIsURL` 也可能这么判 —— 都是猜测）。
- **单字母方案 = 盘符**这条也只量到"不死"，成因（盘符豁免）是推断。
- 探针**用的是 Electron 的默认档案**（因为空格形式 `--user-data-dir` 不被消费），
  探针之间没有做到档案隔离；死掉的那一类走不到档案初始化，所以不影响结论，但这是个量具缺陷。
- 探针的应用路径是**文件**（`probe-main.js`）；"应用路径是目录（package.json 应用）"这一种没量。
- 没量"URL 后面跟一个**空字符串** token"（`""`）这种形状。
- `--url=`（等号后为空）现在解析成空串，随后 `loadURL('')` 会**响亮**报错 —— 这条路径没写测试。
- **门禁判据本身只在"量到的边界内"被证明**：`tests/cli-shape.spec.ts` 里那个正则
  （`^[A-Za-z][A-Za-z0-9+.-]+:`）对着 94 个实测形状全对，但边界**以外**的形状没量过，
  所以它可能对陌生形状过严（误报红）或过松（漏报）。真出现误报时，正确做法是**补量一个形状**，
  再按新证据改判据，而不是把这条门禁删掉。
- 门禁覆盖的是**"调用外壳的命令"**（`npx electron shell/main.js …` / `electron shell/main.js …` /
  `npm run shell[:fixture] …`，含代码块行与行内反引号）。README 里其它命令（`npm install`、
  `npm test`、`$env:ELECTRON_MIRROR = …`）不经过 Electron 的启动器，不在判据的作用范围内。

---

## 8. 相邻证据与外部旁证（只当线索，不当证据）

### 8.1 仓库里早就有**半张表**（T6 的底稿，同一份现象）

[`browser-identity-and-profile.md` §8](browser-identity-and-profile.md) 在 T6 时就顺带量到过这件事，
并且写明了"与本票无关，仅记录"、"没有定位到内部机制"。它那张矩阵与本轮的规则**逐条对得上**
（包括 `--url a://b --bounds …` 起得来 —— 按本轮判据那是因为 `a` 是单字母方案 = 盘符；
以及 `--url http:x --bounds …` 起不来 —— `http:` 就是"方案 + 冒号"）：

| T6 底稿那一行 | 本轮的规则怎么说 |
|---|---|
| `--url http://…/look`（URL 最后）起得来 | 独立 URL token 在最后 → 安全（A3） |
| `--url x --view-url http://…/view`（URL 最后）起得来 | 同上（J8） |
| `--url a://b --bounds 0,0,1,1`、`--url a:b --bounds …` 起得来 | 单字母方案 = 盘符，不算 URL（Q2 / Q15） |
| `--url http://…/look --view-url y` 起不来 | `y` 是独立 token（J4） |
| `--url http://…/look --bounds 0,0,100,100` 起不来 | `0,0,100,100` 是独立 token |
| `--url http:/x --bounds …`、`--url http:x --bounds …` 起不来 | `http:` 已经算 URL（Q10） |
| `--url mailto:a@b --bounds …` 起不来 | 同上（Q16） |
| `--url=… --view-url=…` 起得来 | 等号形式免疫（B3 / M15） |
| 规律："**标准 scheme** 的 URL（http/https/file/ftp/mailto）" | 本轮把这条**放宽**了：不需要是标准 scheme，`foo:` / `tel:+123` / `ws://` / `a1:` 一样触发 |

T6 那张表的最后一句话是"**没有**顺手去修外壳的 CLI 解析（不属本票范围）"——
本票 #14 就是那半张表的续集：把判据补完整、把文档改成已证明安全的形状、给等号形式补上解析、
再加一条跑文档命令的守卫。

### 8.2 外部条目

- 一篇实务记录（[掘金：electron 命令行参数的踩坑](https://juejin.cn/post/7332048519157792787)，2024-02）
  描述了同一个现象："如果传入第三个参数进去的话,electron.exe 就会直接退出（不是你至少给个报错啊）"，
  并附了"直接退出、没有任何输出"的截图。它的解释是"electron 只允许最多两个参数" ——
  **这个解释与本轮实测不符**（§3.3：4 个位置参数照样安全，只要里面没有"不在最后的 URL"）。
  现象对得上、成因不对，所以只当线索。
- [electron/electron#13039 "Remove command line argument black-list"](https://github.com/electron/electron/pull/13039)
  与 [SO 78798129](https://stackoverflow.com/questions/78798129/extrange-problem-with-url-command-line-parameters-on-electron-app)
  是搜索到的近邻条目，但**没有**一条能直接对上本轮的判据；没有当作依据使用。

---

## 9. 复现方式

量具（最小探针 `probe-main.js`、驱动 `probe-driver.mjs`、真外壳驱动 `shell-run.mjs`、
阶段探针 `stage-probe.mjs`）都在临时目录里，**没有进仓库**。要复现，按 §2 的描述重建即可：

1. 最小 Electron 应用：模块第一行打印 `process.argv`，`app.whenReady()` 后打印一行并 `app.exit(0)`；
2. `spawn(electron.exe, [探针, '--user-data-dir=<临时目录>', ...形状])`，记录退出码、耗时、
   stdout/stderr 与"应用代码跑了没有"；
3. 把这 94 个形状过一遍，与 §4.1 对照。

守卫与门禁则在仓库里长期跑：`tests/cli-shape.spec.ts`（`npm test` 的一部分）。
