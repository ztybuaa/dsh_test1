import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
 */
const here = dirname(fileURLToPath(import.meta.url))

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
})
