# 测量：T7 之后套件的两种偶发红（`EPERM` 清理竞态 / 端点读不回来的那一版空间表）

**问题**：T7 的两个提交（`685284b` + `89ed3a9`）之后，整包 `npm test` 复跑 6 次红了 2 次，而且两次的
**签名不同**。实现者自述的"77/77 全绿"是单次结果，掩盖了这件事。T8–T11 要拿这个套件当准绳，
所以"偶发红"本身必须先修掉 —— 否则一次真回归会被当成"又抽风了"忽略掉。

**结论（先给结论，证据在下面每一节）**

1. **签名一（`EPERM` 清理竞态）抓到了原文，也能确定性复现**：`afterAll` 里的裸 `rmSync` 撞上
   Windows 文件锁抛 `EPERM`，于是**每个用例都过、整个 spec 文件却报红**
   （`Test Files 1 failed | 7 passed` 而 `Tests 77 passed (77)`）。
   根因不是"偶发"，是**同一个坑被踩了第二次**：`tests/shell-harness.ts` 里 T5 已经为它写过有界重试的
   `removeWhenFree`，但它是那个文件的私有函数，T7 新写的 spec 又在 `afterAll` 里写了一遍裸 `rmSync`。
   ⇒ 修法：把它**导出**、让套件里**所有**清理路径走它；并加一条能**反证**的用例
   （`tests/cleanup.spec.ts`）。
2. **签名二（"外壳发布了缺 `targetId` 的空间表"）能确定性复现，但 17 次自然复跑里一次都没再抓到。**
   可达的成因是发布那张表时那一次 `GET /json/list` **读不回来**（原来那一行 `.catch(() => [])` 把一次
   瞬时失败变成了"这张表里的目标全没了"）。成因、探针、修复与原始输出独立成文：
   `docs/research/space-table-target-id-gap.md`。
3. **负载是签名一的放大器**：pristine HEAD 上**无负载 9 次全绿**；压 24 个忙进程跑 3 次，**第 3 次红**。
   所以"连续 5 次全绿"这条验收本身**不足以**证明它修好了 —— 修复后的验收里额外加了 2 次带负载的运行。

- 环境：Windows 10.0.26200 / 32 逻辑核 / Node v24.19.0 / Electron 44.3.0 / Playwright 1.62.1
- 起点：`HEAD = 89ed3a9`（工作树干净）；修复后：**9 文件 / 82 用例**
- 日期：2026-09-16
- 相关：`docs/research/space-table-target-id-gap.md`（签名二）、ADR-0010、`docs/research/task-space-isolation.md` §4

---

## 1. 签名一：负载下抓到的原文

复跑的形状：在 32 逻辑核上压 24 个忙进程（`node -e` 自旋），再跑整包 `npm test`，跑 3 次。

原始输出（第 3 次，`exit=1`）：

```text
⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯

 FAIL  tests/spaces.spec.ts > T7 — 验收 1：能创建/使用/关闭；关闭后页面真的没了，存储被抹掉，目录下次启动才删
Error: EPERM, Permission denied: \\?\C:\Users\ZHANGT~1\AppData\Local\Temp\dsh-desktop-shell-spaces-SbYLNS '\\?\C:\Users
\ZHANGT~1\AppData\Local\Temp\dsh-desktop-shell-spaces-SbYLNS'
 ❯ tests/spaces.spec.ts:467:32
    465|     if (shell !== undefined) await shell.stop()
    466|     if (site !== undefined) await site.close()
    467|     if (profile !== undefined) rmSync(profile, { recursive: true, forc…
       |                                ^
    468|   })
    469|
```

```text
 Test Files  1 failed | 7 passed (8)
      Tests  77 passed (77)
   Duration  48.69s
```

**注意最后两行**：`Tests 77 passed (77)` —— 一条用例都没失败，红的是**整个文件**。
这就是"偶发红会让真回归被忽略"的具体形状：报告写 `1 failed`，而红的原因与任何一条断言都无关，
位置（`afterAll`）与那 15 条用例（`验收 1`）也毫无关系。

### 1.1 复跑账本（pristine HEAD = `89ed3a9`）

| 条件 | 次数 | 红 | 红的是什么 |
|---|---|---|---|
| 无负载 | 9 | 0 | — |
| 24 个忙进程 | 3 | **1** | 签名一（上面那段原文） |
| 32 个忙进程 | 5 | 0 | — |

签名二在这 17 次里**一次都没自然出现**（见 §4 诚实清单第 1 条）。

---

## 2. 为什么是"同一个坑被踩了第二次"

- `tests/shell-harness.ts` 的 `removeWhenFree` 早就写明了这个 EPERM 与理由
  （"清理是家务，不是结果；删不掉要在 stderr 说清楚"）—— 但它是**那个文件私有的**；
- T7 新写的 `tests/spaces.spec.ts` 在 `afterAll` 里用了裸 `rmSync` → 一模一样地失败；
- 所以修法不是"在出错的那一行包个 `try`"，而是**让这个辅助成为套件里唯一的清理路径**：
  `tests/spaces.spec.ts`（2 处）、`tests/identity.spec.ts`（1 处）、`tests/observation.spec.ts`（1 处）
  全部改用它；"不许 `try/catch` 默默吞掉"这条留在它里面（删不掉就写 stderr）。

### 2.1 确定性复现"目录还被别人握着"

裸 `rmSync` 的 EPERM 是**竞态**（外壳刚被杀、句柄还没放手），跑测试不能靠运气。
量了三种"确定性握住一个目录"的办法（一次性实验，原始输出逐字）：

| 办法 | 别人的句柄还在时 | 它退出之后 |
|---|---|---|
| 另一个进程**打开着里面的文件**（Node `fs.openSync`） | **删得掉**（libuv 带 `FILE_SHARE_DELETE`） | — |
| 另一个进程的 **cwd 就是这个目录**（`node` 子进程） | **EPERM** | **删得掉** |
| 另一个进程的 **cwd 就是这个目录**（`cmd.exe`） | EPERM | **仍然 EPERM**（`kill` 之后句柄还赖着） |

```text
holder says HELD; argv sample: ["F:\\nodejs\\node.exe","G:\\deepseek_ex\\.scratch\\t7flake\\hold-experiment.mjs"]
first attempt: {"ok":true,"ms":2} stillExists= false          ← 打开着文件：删得掉，所以这条路不能用
```

```text
A child-cwd(cmd): first attempt FAILED code=EPERM in 1ms, exists=true
A after kill      : first attempt FAILED code=EPERM in 1ms, exists=true   ← cmd 当夹具不行
B cmd-redirect    : first attempt OK in 1ms, exists=false
C child-cwd(node) : first attempt FAILED code=EPERM in 1ms, exists=true
C after kill      : first attempt OK in 4ms, exists=false      ← 用它
```

⇒ 夹具是 `tests/fixtures/hold-directory.mjs`：一个"拿某目录当 cwd、打印 `HELD`、过 N 毫秒退出"的子进程。
`tests/cleanup.spec.ts` 用它把那一刻**造出来**，然后钉两件事（先钉"这一刻真的删不掉"，再钉"重试能删掉"）：

```text
RAW the directory is held by pid 32628: C:\Users\ZHANGT~1\AppData\Local\Temp\dsh-cleanup-held-z4Lg2z
RAW bare rmSync while held: {"ok":false,"code":"EPERM"}
RAW removeWhenFree waited 788ms; stillExists=false
 ✓ tests/cleanup.spec.ts (1 test) 900ms
```

**反证**：把 `removeWhenFree` 回退成"只试一次的裸 `rmSync`"，这条用例立刻变红，错误与套件当年那条同形：

```text
 × 一个子进程拿这个目录当 cwd：裸 rmSync 抛 EPERM，removeWhenFree 等到它退出为止 109ms
AssertionError: expected [Function] to not throw an error but 'Error: EPERM, Permission denied: \\?\…' was thrown
 Test Files  1 failed (1)
```

---

## 3. 验收：连续全绿

修复后（**9 文件 / 82 用例**），同一台机器、同一份工作树：

| 运行 | 条件 | exit | 摘要 |
|---|---|---|---|
| 1 | 无负载 | 0 | `Test Files  9 passed (9)` / `Tests  82 passed (82)` |
| 2 | 无负载 | 0 | `Test Files  9 passed (9)` / `Tests  82 passed (82)` |
| 3 | 无负载 | 0 | `Test Files  9 passed (9)` / `Tests  82 passed (82)` |
| 4 | 无负载 | 0 | `Test Files  9 passed (9)` / `Tests  82 passed (82)` |
| 5 | 无负载 | 0 | `Test Files  9 passed (9)` / `Tests  82 passed (82)` |
| 6 | **24 个忙进程** | 0 | `Test Files  9 passed (9)` / `Tests  82 passed (82)` |
| 7 | **24 个忙进程** | 0 | `Test Files  9 passed (9)` / `Tests  82 passed (82)` |

第 6、7 次就是 pristine HEAD 上曾经红过的那种条件；第 1–5 次是要求的"连续 ≥5 次"。
用例数从 77 涨到 82：新增 `tests/cleanup.spec.ts`（1 条，签名一的反证）+ `tests/spaces.spec.ts`
的 4 条（`mergeTargetIds` 纯逻辑、插件解析不许丢字段、两条故障注入的端到端）。

---

## 4. 没能验证到的（诚实清单）

1. **签名二在 17 次自然复跑里一次都没再抓到**（9 次无负载 + 3 次 24 忙进程 + 5 次 32 忙进程）。
   它的成因是**代码层面的确定事实**（`.catch(() => [])`），但在本机没有自然重现；本次是靠**故障注入**
   把它确定性地造出来的。**"注入的故障能造出这个签名"不等于"观察到的那次红就是这个成因"** ——
   这一条因果没有被证明，只是它是唯一一条能把整张表的目标抹掉的可达路径。
2. **负载注入不是"用户机器"的忠实再现**：只压了 CPU，没有压磁盘/内存/杀软扫描，而后两者同样能造成
   EPERM 与回环请求超时。签名一的复现率（3 次里 1 次）因此**不是**一个可外推的比率。
3. **`removeWhenFree` 的行为只在 Windows 上量过**：非 Windows 上"握着一个目录"不会 EPERM，
   所以 `tests/cleanup.spec.ts` 的第一条断言（裸 `rmSync` 必须抛 `EPERM`）**在非 Windows 上会失败**。
   这不是 bug，而是它测的事实本身是 Windows 的（本套件别处也已经有 Windows 专属断言，
   例如"关闭空间之后目录仍然在磁盘上"）。
4. **"所有清理路径都走 `removeWhenFree`"只由 grep 保证**：套件里没有任何机制能阻止将来有人再写一句
   裸 `rmSync`。新增的用例验的是**辅助本身**的重试语义，不是"每个 spec 都接上了它"。
5. 上表的 7 次运行都在**同一台机器、同一天**；跨机器的偶发率**没有量**。
6. `tests/cleanup.spec.ts` 与故障注入用例都会**真的起进程**（前者起一个 node 子进程，后者起 Electron）；
   它们带来的额外时长（~1.8s + ~7.5s）**没有**被优化过。
