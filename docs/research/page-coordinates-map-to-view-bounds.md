# 测量：网页坐标能不能直接当 `view.setBounds()` 用

**问题**：面板（网页那半边）用 `getBoundingClientRect()` 量出自己占的矩形并上报；外壳要拿这个矩形去调 `view.setBounds(rect)` 摆放原生视图。**这两套坐标是同一套数字吗？** 如果不是，就得做偏移/缩放换算，而且会表现成"那一格偏了一点"这种难查的小毛病。

**结论：是同一套，可以原样直传，不需要任何换算。**

日期 2026-09-15。一次性实验代码在 `G:\deepseek_ex\.scratch\coord-probe\`（仓库外，用完即弃）。

## 怎么量的

一个最小 Electron 应用：一个带边框的普通 `BrowserWindow`（1200×800），里面放一个块级元素（`left:120px; top:80px; 300×150`），再 `addChildView` 一块 `WebContentsView` 并用 `setBounds({x:400,y:200,width:300,height:150})` 摆放。然后用 `webContents.executeJavaScript` 读页面侧的尺寸与元素矩形，与 Electron 侧的三个矩形对照。

## 原始结果

```json
{
  "winBounds":        { "x": 253, "y": 109, "width": 1201, "height": 801 },
  "winContentBounds": { "x": 261, "y": 165, "width": 1186, "height": 738 },
  "viewRequested":    { "x": 400, "y": 200, "width": 300, "height": 150 },
  "viewGetBounds":    { "x": 400, "y": 200, "width": 300, "height": 150 },
  "setBoundsRoundTripsExactly": true,
  "page": {
    "innerWidth": 1186, "innerHeight": 738,
    "outerWidth": 1201, "outerHeight": 801,
    "devicePixelRatio": 1.5,
    "elementRect": { "x": 120, "y": 80, "width": 300, "height": 150 },
    "visualViewport": { "width": 1186, "height": 738, "scale": 1, "offsetLeft": 0, "offsetTop": 0 }
  },
  "contentWidthEqualsInnerWidth": true,
  "contentHeightEqualsInnerHeight": true
}
```

## 读出来的三条

1. **`setBounds` 完全往返一致**：设进去 `{400,200,300,150}`，读回来一模一样（`setBoundsRoundTripsExactly: true`）。所以 `setBounds` 的坐标就是"内容区左上角为原点"。
2. **内容区尺寸 = 页面的视口尺寸**：`win.getContentBounds()` 的 1186×738 与 `window.innerWidth/innerHeight` 的 1186×738 **完全相同**。也就是说**页面的视口原点就是内容区原点** —— 这正是"可以直传"的原因。
3. **设备像素比不影响这件事**：本机是 **150% 显示缩放（`devicePixelRatio = 1.5`）**，而两套数字仍然 1:1。因为网页的 CSS 像素与 Electron 的 DIP 是同一套逻辑单位；物理像素缩放由窗口系统统一处理，不进入这条链路。`visualViewport.scale = 1`、偏移为 0，说明也没有额外的视觉视口变换。

窗口本身是**带边框**的（`winBounds` 1201×801 vs `winContentBounds` 1186×738，差出来的就是标题栏与边框），但这不影响结论：`getBoundingClientRect()` 相对**视口**、`setBounds` 相对**内容区**，而这两者的原点重合。

## 对实现的要求

- 面板上报的矩形**直接**交给 `view.setBounds()`，**不要**再加窗口位置偏移、不要乘 `devicePixelRatio`、不要做缩放换算。
- 四舍五入到整数像素是允许的（`setBounds` 需要整数），但**不要**引入任何"为了保险"的额外偏移 —— 那只会把对齐弄坏。
- 注意区分：`getBoundingClientRect()` 给的是相对视口的坐标，**不是**屏幕坐标。若将来需要在屏幕坐标里对齐（例如独立窗口叠放方案），才需要 `screenX/screenY` 那套。

## 本实验**没有**验证

- 非 100% 的页面缩放（Ctrl +/- 或 `webContents.setZoomFactor`）下是否仍然 1:1
- 多显示器不同缩放比之间拖动窗口时的行为
- 侧边栏浮动/停靠过程中的中间态
