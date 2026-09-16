import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeWhenFree } from './shell-harness.ts'

/**
 * 套件自己的清理契约。
 *
 * T5 与 T7 两次把"清理"变成了红：`afterAll` 里的裸 `rmSync` 撞上 Windows 文件锁抛 `EPERM`，
 * 于是**每个用例都过了、整个 spec 文件却报红**（负载下抓到的那一次原文：
 * `Test Files 1 failed | 7 passed (8)` 而 `Tests 77 passed (77)`，`Error: EPERM, Permission denied:
 * …\Temp\dsh-desktop-shell-spaces-SbYLNS`，位置 `tests/spaces.spec.ts:467`；
 * 见 `docs/research/suite-flake-two-signatures.md`）。
 *
 * 这一条用**确定性**的方式造出"目录还被别人握着"那一刻，然后钉住两件事：
 *
 *  1. **这一刻真的删不掉** —— 裸 `rmSync` 必须抛 `EPERM`。这是那条修复存在的理由：没有这一半，
 *     下一条断言可能只是碰巧成立（比如目录压根没被握住）。
 *  2. **`removeWhenFree` 会等到它能删为止**，而且**不抛** —— 清理是家务，不是结果。
 *
 * 反证：把 `removeWhenFree` 换回裸 `rmSync`，第 2 条立刻变红（原始输出见上面那份文档）。
 *
 * 第三件（票 #15 顺手做的那一条）：上面那两条规矩**只由 grep 保证过**，没有任何机制阻止将来
 * 再写一个裸 `rmSync`。T5 与 T7 已经各踩过一次同样的坑，所以这里加一条**守门用例**：
 * 扫 `tests/` 的源码，出现"别人的裸 `rmSync`"就红。
 */
const here = dirname(fileURLToPath(import.meta.url))

/**
 * 允许出现裸 `rmSync` 的地方 —— **逐个文件、逐个次数**写死。
 *
 * 写成"允许清单"而不是"忽略这些文件"，是为了让**新出现的那一处**必然变红：往清单外的文件里
 * 加一个 `rmSync`，或者往清单内的文件里多写一个，两条都会被抓到。
 *
 *  - `shell-harness.ts` 一处：`removeWhenFree` 自己。**唯一**该删目录的地方。
 *  - `cleanup.spec.ts` 一处：本文件第 1 条用例**故意**用裸 `rmSync` 证明"这一刻真的删不掉"——
 *    那是那条修复存在的理由，没有它，第二条断言可能只是碰巧成立。
 */
const ALLOWED_BARE_RM_SYNC: Record<string, number> = {
  'shell-harness.ts': 1,
  'cleanup.spec.ts': 1,
}

/** 把注释去掉：注释里写 `rmSync`（比如"不裸 rmSync"）不是调用。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 每个 `rmSync` 调用点所在的行号（1 起）。 */
function bareRmSyncLines(file: string): number[] {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
  const found: number[] = []
  for (const [index, line] of lines.entries()) {
    if (/\brmSync\s*\(/.test(line)) found.push(index + 1)
  }
  return found
}

/** 握着目录的那个夹具：打印 `HELD`，然后按给定毫秒数退出。 */
const HOLDER = join(here, 'fixtures', 'hold-directory.mjs')

/** 握多久：比一次删除尝试（250ms）长，好让"重试"这件事真的发生。 */
const HOLD_MS = 700

describe('清理：临时目录还被别人握着时，红的不该是整个套件', () => {
  let dir: string | undefined
  let holder: ChildProcess | undefined

  afterEach(() => {
    if (holder !== undefined && holder.exitCode === null && holder.signalCode === null) holder.kill()
    holder = undefined
    // 哪怕这条用例中途失败，也要把临时目录收干净（用同一套有界重试）。
    if (dir !== undefined) removeWhenFree(dir)
    dir = undefined
  })

  it('一个子进程拿这个目录当 cwd：裸 rmSync 抛 EPERM，removeWhenFree 等到它退出为止', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-cleanup-held-'))
    writeFileSync(join(dir, 'kept.txt'), 'x')
    holder = spawn(process.execPath, [HOLDER, String(HOLD_MS), dir], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    // 它说 HELD 的时候，那个"别人正握着这个目录"的状态就已经成立了。
    await once(holder.stdout as NodeJS.ReadableStream, 'data')
    console.log('RAW the directory is held by pid ' + String(holder.pid) + ': ' + dir)

    // 1) 这一刻真的删不掉 —— 这正是 T5 / T7 两次踩到的那个坑。
    const bare = ((): { ok: boolean; code?: string } => {
      try {
        rmSync(dir as string, { recursive: true, force: true })
        return { ok: true }
      } catch (error) {
        return { ok: false, code: (error as NodeJS.ErrnoException).code }
      }
    })()
    console.log('RAW bare rmSync while held: ' + JSON.stringify(bare))
    expect(bare.ok).toBe(false)
    expect(bare.code).toBe('EPERM')

    // 2) 有界重试：等那个进程退出（700ms 之后）就真的删掉了，而且**不抛**。
    const started = Date.now()
    expect(() => removeWhenFree(dir as string)).not.toThrow()
    const waited = Date.now() - started
    console.log('RAW removeWhenFree waited ' + waited + 'ms; stillExists=' + existsSync(dir as string))
    expect(existsSync(dir as string)).toBe(false)
    // 它确实重试过，不是运气好一次就成了：第一次尝试必然失败（此刻句柄还握着）。
    expect(waited).toBeGreaterThanOrEqual(200)
  }, 30_000)

  /**
   * 守门：**清理路径不许再写裸 `rmSync`**。
   *
   * 上面那条用例钉的是"`removeWhenFree` 行为对"，但"所有人都用它"这件事原来只由 grep 保证 ——
   * T5 与 T7 各踩过一次同样的坑（T7 在自己的 `afterAll` 里抄了一份裸删除，把 T5 修好的 bug
   * 又原样复现了一遍）。所以这里把它变成机制：扫 `tests/**` 的源码，**每个 `rmSync` 调用点**
   * 都必须出现在允许清单里，而且清单里的**次数**要对得上。
   *
   * 反证（票 #15 要求的那条）：往任意一个 spec 文件里加一行裸 `rmSync`，这条立刻变红
   * ——它会把文件和行号点名说出来。
   */
  it('清理路径不许再写裸 rmSync：除了 removeWhenFree 自己与"证明它真的会抛"的那一处', () => {
    const files = readdirSync(here, { recursive: true, encoding: 'utf8' })
      .map((entry) => entry.replace(/\\/g, '/'))
      .filter((entry) => entry.endsWith('.ts'))
      .sort()
    const seen: Record<string, number[]> = {}
    for (const file of files) {
      const lines = bareRmSyncLines(join(here, file))
      if (lines.length > 0) seen[file] = lines
    }
    console.log('RAW bare rmSync call sites under tests/: ' + JSON.stringify({ seen, allowed: ALLOWED_BARE_RM_SYNC }))

    // 扫到的文件一个都不能少：清单里的每个文件都要真的被扫过（否则清单会悄悄过期）。
    for (const file of Object.keys(ALLOWED_BARE_RM_SYNC)) {
      expect(files).toContain(file)
    }
    // 每个调用点都在清单里，且次数一致。
    for (const file of Object.keys(seen)) {
      expect(
        ALLOWED_BARE_RM_SYNC[file],
        `${file} 里有 ${seen[file].length} 处裸 rmSync（第 ${seen[file].join(', ')} 行），` +
          '但清理路径只允许走 tests/shell-harness.ts 的 removeWhenFree —— ' +
          '把一个刚被停掉的进程握着的临时目录裸删会抛 EPERM，' +
          '让"用例全过、整个 spec 文件报红"重演（见本文件顶部与 tests/shell-harness.ts 的注释）。',
      ).toBe(seen[file].length)
    }
    // 反过来：清单里写着的次数也必须真的在，别让清单变成一句空话。
    for (const [file, count] of Object.entries(ALLOWED_BARE_RM_SYNC)) {
      expect(seen[file]?.length ?? 0, `${file} 的 allowlist 说它有 ${count} 处裸 rmSync，实际扫到 ${seen[file]?.length ?? 0} 处`).toBe(count)
    }
  })
})
