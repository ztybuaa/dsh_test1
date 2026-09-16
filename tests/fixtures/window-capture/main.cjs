// 测试夹具：把**一个真实窗口**的画面拍下来，并把里面两种颜色的量出来。
//
// 为什么必须由一支单独的 Electron 进程来拍：`desktopCapturer` 是 Electron 的 API，测试进程
// （vitest，纯 node）够不到；而 Playwright 的截图**不是**窗格看到的东西 —— 它交付的是
// "布局视口 × 屏幕 dpr"，缩放≠1 时与窗格的物理像素不是一回事（实测见
// `docs/research/t13-zoom-out-measured.md`）。票 #13 的验收是"缩到 50% 之后页面最右端
// 在**窗格里**真的看得见"，只有真窗口画面答得了。
//
// 用法（环境变量）：
//   T13_CAPTURE_DIR    报告 JSON 落在这里
//   T13_CAPTURE_LABEL  这一次的名字
//   T13_CAPTURE_MATCH  窗口标题里要匹配的子串
//   T13_CAPTURE_OUT    截图 PNG 的路径
//
// 退出码 0 = 拍到了；2 = 没找到那个窗口（消息里带上看到了哪些窗口，便于查）。
'use strict'

const { app, desktopCapturer } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const DIR = process.env.T13_CAPTURE_DIR
const LABEL = process.env.T13_CAPTURE_LABEL ?? 'shot'
const MATCH = process.env.T13_CAPTURE_MATCH ?? ''
const OUT = process.env.T13_CAPTURE_OUT

/** 数一种颜色（带容差，窗口画面会被重采样）的像素数 + 包围盒。 */
function measure(bitmap, width, height, test) {
  let count = 0
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      // Windows 上 Electron 给的是 BGRA；容差足够大时通道序不影响"红/蓝各在哪一侧"的判定，
      // 所以这里按 BGRA 读，并由报告里的 `sampleBar` 自证通道序（条子是 #4a6fa5）。
      const blue = bitmap[at]
      const green = bitmap[at + 1]
      const red = bitmap[at + 2]
      if (!test(red, green, blue)) continue
      count += 1
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (count === 0) return { count: 0, box: null }
  return { count, box: { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 } }
}

app.whenReady().then(async () => {
  const report = { label: LABEL, match: MATCH, found: false, sources: [] }
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 2400, height: 2400 },
      fetchWindowIcons: false,
    })
    report.sources = sources.map((source) => source.name)
    const chosen = sources.find((source) => source.name.includes(MATCH))
    if (chosen === undefined) {
      report.reason = `no window whose title contains ${JSON.stringify(MATCH)}`
    } else {
      const image = chosen.thumbnail
      const size = image.getSize()
      const bitmap = image.toBitmap()
      report.found = true
      report.window = chosen.name
      report.size = size
      // 红标：纯红（#ff0000）。
      report.red = measure(bitmap, size.width, size.height, (r, g, b) => r > 200 && g < 60 && b < 60)
      // 那条 1200px 的蓝条（#4a6fa5）：它在窗口像素里的**高度**是"内容有没有被缩放"的判据 ——
      // 缩到 50% 时它必须变成一半。
      report.bar = measure(bitmap, size.width, size.height, (r, g, b) => Math.abs(r - 74) < 14 && Math.abs(g - 111) < 14 && Math.abs(b - 165) < 14)
      report.sampleBar = [bitmap[0], bitmap[1], bitmap[2], bitmap[3]]
      if (OUT !== undefined) fs.writeFileSync(OUT, image.toPNG())
    }
  } catch (error) {
    report.reason = String(error && error.stack ? error.stack : error)
  }
  fs.writeFileSync(path.join(DIR, `${LABEL}.json`), JSON.stringify(report, null, 2))
  console.log('T13_CAPTURE ' + JSON.stringify(report))
  app.exit(report.found ? 0 : 2)
})

app.on('window-all-closed', () => app.quit())
