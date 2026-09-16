import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 截图落在哪 —— 一条**纯判断**。
 *
 * 这个模块只回答一个问题："调用方没给 `path` 时，PNG 该写到哪个目录？" 它不碰文件、不连外壳、
 * 不认识 CDP，所以三种输入各出什么结果都能在不起外壳的情况下被单独读回。
 *
 * ## 为什么原来那个默认值是错的（票 #16）
 *
 * 原来的默认值是 `'.'`，也就是**宿主 `dsh` 进程的当前工作目录**。本仓库推荐的那条启动命令
 * （`npm run shell`）是从仓库根跑的，宿主是外壳的子进程、cwd 继承而来，于是 Agent 每截一张图，
 * **仓库根就多一个 `browser-<时间戳>.png`**，直接进 `git status` 的未跟踪列表。实测发生过一次
 * （2026-09-16 用户那一轮，仓库根留下两个 PNG —— 本票的现场证据）。
 *
 * cwd 不是任何东西的归属地：它是"用户在哪儿敲的命令"。所以现在三步走，**显式永远优先**：
 *
 *  1. 显式配置了 `screenshotDir` → 就用它；
 *  2. 外壳发布了档案目录 → `<userDataDir>/screenshots`，与下载那条决定**对称**
 *     （下载落 `<userDataDir>/downloads`，ADR-0011），不需要任何新通道；
 *  3. 都拿不到（例如没有外壳）→ {@link fallbackScreenshotsDir}，系统临时目录下的专用子目录。
 */

/**
 * 默认目录的名字（在档案目录下）。
 *
 * 与下载目录（`downloads`）一样是**档案目录下的一个普通子目录**：它属于这个档案，
 * 人找得到、删得掉，也不会混进任何一个 git 仓库。
 */
export const SCREENSHOTS_DIR_NAME = 'screenshots'

/**
 * 兜底目录在自己那一级下的名字。
 *
 * 名字里带着归属：`%TEMP%` 是个几千个进程共用的地方，一个叫 `screenshots` 的裸目录是谁的都说不清，
 * 而 `dsh-desktop-view-screenshots` 一眼能看出是谁放的、可以整目录删掉。
 */
const FALLBACK_DIR_NAME = 'dsh-desktop-view-screenshots'

/**
 * 拿不到档案目录时截图落在哪：**系统临时目录下一个专用子目录**。
 *
 * 为什么是它：那种情况下确实没有更合适的归属地（没有外壳就没有档案目录），而它是**说得清**的
 * —— 路径本身就写着这是谁的临时目录，不是"随手落在哪儿"。为什么不是 cwd：cwd 正是本票要修掉的
 * 那一个（见本文件顶部）。
 *
 * @returns 绝对路径。
 */
export function fallbackScreenshotsDir(): string {
  return join(tmpdir(), FALLBACK_DIR_NAME)
}

/** 截图会落在哪，以及这个答案是从哪来的。 */
export interface ScreenshotDirChoice {
  /** 目录，绝对路径。 */
  dir: string
  /** 这个答案的来源。 */
  source:
    /** 显式配置的 `screenshotDir`：以显式为准。 */
    | 'configured'
    /** 外壳发布的档案目录下的 {@link SCREENSHOTS_DIR_NAME}。 */
    | 'shell-profile'
    /** {@link fallbackScreenshotsDir}：既没配置、也没有外壳发布档案目录。 */
    | 'fallback'
}

/**
 * 决定"调用方没给 `path` 时截图落在哪"。
 *
 * 纯函数：同样的输入永远同样的输出，不读文件、不看环境、不认识外壳。
 *
 * 三条规则按优先级写在下面这一处，**别在调用点再写一遍**：两处各判一次优先级，迟早会不一致。
 *
 * @param input - 显式配置的目录，以及外壳发布的档案目录（都可能是 undefined）。
 * @returns 目录与它的来源。
 */
export function resolveScreenshotDir(input: { configured?: string; userDataDir?: string }): ScreenshotDirChoice {
  // 空串与纯空白都当"没配"：`screenshotDir: ''` 的意思不可能是"当前目录"。
  const configured = input.configured?.trim() ?? ''
  if (configured !== '') {
    return {
      dir: resolve(configured),
      source: 'configured',
    }
  }
  const profile = input.userDataDir?.trim() ?? ''
  if (profile !== '') {
    return {
      dir: resolve(profile, SCREENSHOTS_DIR_NAME),
      source: 'shell-profile',
    }
  }
  return {
    dir: fallbackScreenshotsDir(),
    source: 'fallback',
  }
}
