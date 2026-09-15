/**
 * 一个"握着某个目录"的子进程 —— `tests/cleanup.spec.ts` 的确定性夹具。
 *
 * Windows 会拒绝删除一个**别的进程正拿它当 cwd** 的目录（实测：该进程活着时 `rmSync` 抛
 * `EPERM`，它一退出同一句就成功）。所以这个夹具就是"句柄还没放手"那一刻的确定性版本：
 * 打印 `HELD` 之后按给定的毫秒数退出 —— 调用方等这一行，就知道目录**现在**真的删不掉。
 *
 * 用法：`node hold-directory.mjs <毫秒> <目录>`（目录也由 spawn 的 `cwd` 给出，这里再明确设一次）。
 */
const holdMs = Number(process.argv[2] ?? 600)
const dir = process.argv[3]

if (dir !== undefined && dir !== '') process.chdir(dir)
process.stdout.write('HELD\n')
setTimeout(() => process.exit(0), holdMs)
