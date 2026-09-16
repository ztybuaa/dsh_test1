# T13 底稿一：面板里那个页面，能不能经载体无关 RPC 驱动宿主

**问题**：票 #13 要在**面板**（外壳窗口里的那个 DSH 网页）里放一条工具条，去驱动**原生视图**。
`shell/preload.js` 顶部写着"这里除矩形外什么都不许过境，驱动视图走 CDP（ADR-0002/0003）"。
所以工具条不能走 preload，只能走 ADR-0003 定好的那条**载体无关 RPC**：
客户端半边 `ctx.connection.rpc.call(...)` → 宿主半边 → 宿主用它自己的 CDP 会话驱动视图。

**这需要先量清楚：那条通道在"外壳窗口里的 DSH 页面"上到底通不通。**

日期 2026-09-16。探针脚本与原始报告在会话工作区的 `.scratch/t13-probe/rpc-probe/`（不进仓库）。

---

## 结论（三句话）

1. **通。** 客户端半边在面板那一页上 `ctx.connection.rpc.call('/api', '<prefix>/<action>', payload)`
   能真的到达**宿主进程**（同一个 `dsh` 进程，`process.pid` 与 `cwd` 都读回来了），
   二元结果、业务失败、未知端点三种回答都正确。
2. **但 ADR-0003 字面点名的那个 API（`ctx.connection.rpc.handle`）在这台宿主上不可用**：
   它对**任何** ctx 都抛 `cannot get property "webServer" without inject`。
   这是 `@deepseek-ai/dsh-client-connection@0.1.5-rc.2` 自己的形状问题（见下）。
3. **可用的那条路是同一个包的另一半公开 API**：`ctx.connection.fetch.register(...)`，
   也就是第一方自己在用的那条（`dsh-client-file-upload`、`dsh-api-session-controller`）。
   它走的是**同一条共享 `/api` 通道**，信任与鉴权由通道施加，不是新通道。

---

## 原始测量

### 1. 客户端半边那一页上有什么（读回来的）

在真外壳（`--dsh`，真 `dsh` 宿主）的窗口页面上，从**插件真正拿到的那个 ctx** 里读：

```json
{
  "ctxKeys": ["fiber"],
  "connectionRead": {
    "ok": true,
    "present": true,
    "keys": ["isLoopback", "generation", "state", "rpc", "reconnect", "registerGenerationSource", "start"],
    "rpcKeys": ["call"],
    "rpcCallType": "function",
    "isLoopback": true
  }
}
```

- `ctx.connection` 在页面里**存在**，`rpc.call` 是函数 —— 客户端那一半成立。
- `isLoopback: true`。
- 注意 `ctxKeys: ["fiber"]`：cordis 的服务访问是**注入门控**的，没写进 `inject` 的服务
  连读一次属性都会抛 `cannot get property "connection" without inject`。
  所以客户端半边的 `inject` 里**必须**有 `connection`（实测：不写就抛）。

### 2. 三条失败的路（都不是最终方案，但都是事实）

| 走法 | 结果 |
|---|---|
| `inject = ['connection']`，宿主 `ctx.connection.rpc.handle(channel, handler)` | 抛 `cannot get property "webServer" without inject` |
| `inject = ['connection','webServer']`，同一句 | **同样抛** |
| `ctx.inject(['connection','webServer'], scoped => scoped.connection.rpc.handle(...))` | **同样抛** |

宿主 `ctx.webServer` 本身是**读得到**的：

```json
["ctx","name","config","exact","prefixes","upgrades","upgradedSockets","indexTaps","fallback","server","listenedPort","gzip"]
```

失败点在 `dsh-client-connection/lib/index.js:618`：

```js
register(owner, channel, handler) {
  ...
  return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);
}
```

而同一个包的 `inject` 是：

```
lib/index.js:736: const inject = ["credentials"];
```

**它注册的路由要读 `owner.webServer`，但它自己从不注入 `webServer`。**
`ctx.connection.rpc` 那个 getter 把 `this` 绑在**服务自己的 ctx** 上（cordis 的
`createTraceable` 给访问器做 shadow，`ctx.js:130-143`），所以调用方的 ctx 上有没有
`webServer` 都救不了它。→ **这条路对第三方插件不可用**，不是我们用错。

### 3. 可用的那条路（客户端调用的原文）

宿主侧：

```js
ctx.connection.fetch.register({
  path: '/api/<prefix>/<action>',   // 精确路由，必须满足 endpointFromPath('/api', path) 有定义
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: async (request) => { /* 读 {type,rpcId,method,payload} 信封，回 {type,rpcId,result} */ },
})
```

客户端侧：

```js
await ctx.connection.rpc.call('/api', '<prefix>/<action>', payload)
```

**为什么 channel 必须是 `/api`**：客户端 `assertTarget` 要求 channel 匹配
`/^\/[A-Za-z0-9._~-]+$/`（`lib/client.js:6186`）—— 单段，带不了 `/`。
端点可以带 `/`（逐段校验）。于是客户端发出的 URL 是 `POST /api/<prefix>/<action>`，
而宿主 `createSharedFetchHandler('/api')` 正是**先按 `url.pathname` 查精确路由表**
（`lib/index.js:576-583`），命中我们自己的处理器，而不是 `/api` 上那个兜底拦截器。

**为什么端点必须一条路由一个**：路由表是精确查表，没有前缀语义。

### 4. 端到端读回的原文

```json
{
  "ping":    { "ok": true,
               "value": { "endpoint": "t13-probe/ping",
                          "echoed": { "probe": "t13", "nonce": "1789524012344",
                                      "nested": { "a": [1,2,3], "b": "中文" } },
                          "hostPid": 36608,
                          "hostCwd": "G:\\dsh_test1",
                          "viewIdentityPresent": true } },
  "refuse":  { "ok": false,
               "error": { "code": "t13/refused", "message": "这一条是故意失败的端点", "details": {} } },
  "unknown": { "threw": "Error: transport failure for /api/t13-probe/no-such-endpoint: HTTP 404" }
}
```

`hostPid` / `hostCwd` 是**宿主进程自己报的**：`G:\dsh_test1` 是外壳给 `dsh` 的 cwd
（外壳的 cwd），不是页面里的任何值 —— 所以"真的到了宿主那一侧"不是推断出来的。

宿主侧记下的四个请求（4 = 1 ping + 1 refuse + 门禁那两次）：

```json
[{"method":"POST","pathname":"/api/t13-probe/ping","contentType":"application/json",
  "origin":"http://127.0.0.1:61935","host":"127.0.0.1:61935","cookiePresent":true}, …]
```

### 5. 门禁（信任 + 鉴权）真的在

```
POST /api/t13-probe/ping，credentials: 'omit'  →  401 "unauthorized"
```

通道在派发前跑 `browserAuth.isAuthenticated`（和 `requestRejection` 的 Host/Origin 围栏），
所以这条通道**不是**一个谁都能打的裸 HTTP 口子。这是"我们不是新开了一条通道"的证据之一。

---

## 对票 #13 的处置

- 工具条**走这条通道**，不走 preload、不走文件通道。
  `shell/preload.js` 顶部那句"这里除矩形外什么都不许过境"继续为真（一个字节都没改它）。
- 客户端半边与宿主半边是**同一个插件的两半**，所以"人的按钮"和"Agent 的工具"调的是
  **同一套会话能力**（同一份 `AdoptedViewSession`）。
- 宿主侧必须把 `connection` 写进 `inject`（读到服务的前提）；
  `webServer` **不需要**（`fetch.register` 不读它）——这一点也量过了：探针 F 两个都声明了，
  但真正干活的是 `fetch.register`。

## 这条底稿没证明到的

- **官方 Electron 桌面宿主**里这条通道通不通，没量过（那需要官方桌面应用；本票的宿主是
  `dsh web`）。ADR-0003 说两端都不必分叉，但本条只有 `dsh web` 一侧的实测。
- `connection.fetch.register` 的**流式**语义（`requestBody: 'streaming'`）没量过：
  本票只用 `'buffered'`，JSON 信封就够。
- 那条 `webServer` 依赖在别的 dsh 版本上是否已被修掉，没查（本机只有 `0.1.5-rc.2`）。
