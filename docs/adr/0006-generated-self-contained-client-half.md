# 0006 — 客户端半边是一个「由共享源拼接生成」的自包含单文件

**状态**：已接受
**日期**：2026-09-15

## 决定

插件的客户端半边以**一个生成出来的自包含文件** `client.js` 发布。它由

- `shell/panel-rect.js`（面板测量逻辑）
- `src/client-body.js`（标签类型、标签 body、面板组件）

**拼接**而成，产物**提交进仓库**；`npm run build` 重新生成它，并有 `--check` 模式在产物与源不一致时**失败**。

## 理由

这里有一个真实的矛盾，两边都不能让步：

1. **DSH 的 web loader 每个插件只取一个脚本。** 脚本通过 `window.__ModuleLoader__.load({ id, factory })` 注册工厂，而在工厂内部 `require()` **只能到达平台自己的模块**（如 `react`）。所以发布产物里**没有打包器**可用，客户端那半边必须是**一个自包含文件**。
2. **面板的测量逻辑同时被外壳的夹具页使用**，而那是自动化证据赖以成立的地方。如果把测量逻辑在客户端文件里**复制一份**，那么自动化证据测的就是**另一份实现**——证据会退化成"证明某个副本能工作"，而不是"真正的面板能工作"。

拼接同时满足两边：**只有一份**测量源码，而它在两个地方都以同一份内容出现。夹具页直接读 `shell/panel-rect.js`；真面板用的是拼接进 `client.js` 的同一份源码。

## 实现中真实踩到的坑（必读）

拼接会引入一个**极隐蔽的失败**：`shell/panel-rect.js` 是 UMD，它自己会写 `module.exports = api`。拼进工厂后，那一步会**覆盖**掉 `client-body.js` 写 `apply` / `inject` 的那个对象 —— 而工厂返回的正是 `module.exports`。

后果是：宿主拿到的**不是插件，而是面板的 API**。真 DSH 里的报错是

```
failed to apply loader entry … (dsh-desktop-view):
invalid plugin, expect function or object with an apply method, received object
```

而**只看仓库里的测试是发现不了的**（当时的测试在"外壳窗口页里按契约加载 `client.js`"，而不是塞进真 DSH 的启动图）。表现就是"插件像是装上了、什么都不注册、也不报错"。

所以：

- 生成时**必须**把 `panel-rect` 那段围进它**自己的 module 作用域**，不能与插件体共享一个 `module`。
- 生成后**必须校验** `typeof module.exports.apply === 'function'`，让这类失败在**命名的地方**炸。

## 考虑过的替代

- **手写整个客户端文件，把测量逻辑复制进去**：正是第 2 条要避免的——证据会与真实实现漂移。弃用。
- **引入打包器**：产物里没有打包器可用（见第 1 条），为此引入一个构建依赖也不划算。弃用。
- **让夹具页去加载生成出来的 `client.js`**：夹具页要跑在**普通网页**里验证测量逻辑，而不是跑在 DSH 的模块系统里；让它去依赖 `__ModuleLoader__` 会把测试与被测宿主耦死。弃用。

## 后果

- **改了那两个源文件就必须重新生成**；忘了生成会让 `--check` 失败——这是有意的：陈旧产物必须是个响亮的错误，而不是一个悄悄生效的旧行为。
- 产物被提交，所以**从零克隆的人不需要额外构建就能拿到客户端那半边**。但服务端那半边的 `lib/` 仍然需要 `npm run build`（`lib/` 被 gitignore，而 `main` 指向它）。
- 面板测量逻辑的**唯一事实源**是 `shell/panel-rect.js`。它的坐标语义见 `docs/research/page-coordinates-map-to-view-bounds.md`（页面坐标可原样直传 `setBounds`）。
- 宿主确实会把这个半边接进客户端启动图（`exports["./client"]` + `dsh.client` 声明即可），实测条目见 `docs/research/plugin-transport-and-panel-home.md` 第 6 节。
