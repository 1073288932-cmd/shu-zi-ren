# 魔珐星云 3D 数字人主渲染 设计文档

**日期：** 2026-05-31
**背景：** 之前评估过 D-ID Streaming（详见 `2026-05-24-did-streaming-demo-mode-design.md`），但 D-ID 美元计价、海外延迟、合规成本高。改用**魔珐星云具身驱动 SDK**：3D 超写实、国内低延迟、按交互时长 ~0.5 积分/分钟（实测 32s→0.27 积分），明显更便宜。
**目标：** 把魔珐 3D 数字人做成**长期上线的默认主渲染**。本地 viseme（PNG 贴纸，详见 `2026-05-22-local-viseme-lipsync-design.md`）退居**离线/降级兜底**。失败自动回本地，并保留一个**极简手动 toggle** 可强制切本地。
**部署模型：** 个人/单点受控部署。魔珐 `appId/appSecret` 留在 main 进程 `.env`，经 IPC 注入 renderer，不打包硬编码、不对外分发。
**前置实测：** 已用官方调试台（应用 id=55230）+ 官方 SDK 文档（https://xingyun3d.com/developers/52-194）验证，详见 `XINGYUN-API-CHECK.md`。

---

## 非目标

- 不替换、不删除任何本地 viseme 代码——它是降级兜底。
- 不做对外分发版（appSecret 直传 renderer 仅在单点受控下可接受；将来分发需魔珐支持服务端 token 签发，届时再加后端，本设计在 Section 11 标注口子）。
- 不做云端模式持久化偏好（每次启动按 config 预查决定初值；见 Section 1）。
- 不做精确账单复核（魔珐控制台有"消耗记录"）；也**不做任何 UI 用量/计费指示**（用户选定极简）。
- 不做自定义形象 / 多形象切换（MVP 用控制台已配好、绑定在 appId 上的单一形象）。
- 不做 KA 动作的手工 SSML 编排（依赖控制台「KA 自动触发」按语义自动配手势；我们只发纯文本）。
- 不做"流式驱动"（边生成边说）——MVP 用整段 AI 回复一次性 speak；生产可后续评估流式降延迟。

---

## 整体策略

```
                          ┌──────────────────────────────┐
                          │ agentStore.renderMode         │
                          │   'cloud'(默认) | 'local'(兜底) │
                          └─────────────┬────────────────┘
                                        │
                                        ▼
useAI 拿到 AI 回复后，根据 renderMode 二选一：

  renderMode='cloud'(默认):              renderMode='local'(兜底):
  ┌──────────────────────┐               ┌─────────────────────┐
  │ sessionManager        │              │ lipSyncController    │
  │   .speak(reply)       │              │   .start(reply, …)   │
  │ (魔珐 SDK 自带 TTS+口型,│              │ ttsProvider          │
  │  不调本地 ttsProvider   │              │   .speak(reply)      │
  │  避免双声源)            │              │                     │
  └──────────────────────┘               └─────────────────────┘
        │                                          │
        ▼                                          ▼
  XmovAvatar.speak()                       store.currentViseme 改变
  在 <div> 里自绘 3D                          │
        │                                          ▼
        ▼                                   <LocalAvatar/> 切换 PNG
  onVoiceStateChange('end') → finishTalking
```

**关键不变量：**

1. **AI 调用链不变。** `aiProvider.chat()` / `addMessage` / `setMood('thinking')` 无论哪种模式都执行——它们是"思考态"，与渲染层无关。
2. **TTS 来源由模式决定。** cloud 模式用魔珐自带 voice，local 模式用 `ttsProvider`（WebSpeech），**两者互斥不并行**（否则双声源）。
3. **mood 状态机不变。** thinking / talking / idle / error 含义不变。
4. **本地模式 0 网络依赖。** 切回本地后，魔珐 SDK 必须真 `destroy()`，确保不再产生网络流量与计费。
5. **按会话时长计费 → 空闲必断。** 魔珐「具身驱动」按 SDK 连接时长计费，sessionManager 的 idle-timeout 是省钱关键。

---

## Section 1：模式状态机

新增/调整 store 字段（`src/store/agentStore.ts`）：

```ts
renderMode: 'cloud' | 'local'          // 初值 'cloud'；config 未配置时启动改 'local'（见下）
cloudConn: 'idle' | 'connecting' | 'streaming' | 'error'  // 初值 'idle'
cloudLastError: string | null          // 最近一次失败原因，触发 toast

// actions
setRenderMode(mode: 'cloud' | 'local'): void
setCloudConn(state: CloudConnectionState): void
setCloudError(msg: string | null): void
```

> **与 D-ID 设计的删减：** 不再有 `cloudMuted`（魔珐有真打断 `interactiveidle()`，无需本地软 mute）；不再有 `cloudMinutesThisMonth`（用户选定极简，无任何用量 UI）。

**初值为何是 'cloud' 又可能被改 'local'：** 魔珐是默认主力，store 默认 `'cloud'`。但若 `.env` 未配 `XINGYUN_APP_ID`，cloud 根本不可用——App 启动时 `<ModeToggle>` mount 调 `xingyunGetConfig()`，`configured === false` 则 `setRenderMode('local')` 并禁用 toggle（见 Section 9）。即"能用就默认魔珐，不能用就老老实实本地"。

**状态转换图：**

```
[启动] → config 预查
   ├─ configured=false → [local mode]（toggle 禁用，结束）
   └─ configured=true  → [cloud mode, conn=idle]
                              │  首条 AI 回复到达（connect-on-first-message）
                              ▼
                         [cloud, conn=connecting]   ←── 建 SDK + 下载 3D 资源
                              │  onStateChange 到就绪态
                              ▼
                         [cloud, conn=streaming]    ←── speak() → 3D 说话
                              │  onVoiceStateChange('end') + idle N 秒无新 speak
                              ▼
                         [cloud, conn=idle]         ←── SDK 已 destroy（停止计费），仍处 cloud mode
                              │
                              └─ 用户再发一句 → 重新建联（回 connecting）

# 异常分支：
[any cloud state]
   │  魔珐 网络/SDK 错误（onMessage 报错 / 连接超时）
   ▼
[local mode, conn=idle, error="..."]  ←── 自动回本地 + toast + 本地补讲；toggle 视觉翻回本地
```

**只有 3 个时机会写 `renderMode`：**

1. 用户点 toggle（cloud↔local，**无确认弹窗**）
2. 魔珐失败时自动从 'cloud' 翻 'local'（同时 `cloudLastError` 设值触发 toast）
3. 应用启动 config 预查（未配置→'local'）/ store reset

**强制不变量：** `setRenderMode('local')` 必须同时把 `currentViseme` 重置为 `'closed'`——避免 cloud→local 切换瞬间 LocalAvatar 挂载时显示残留嘴型。`setRenderMode('cloud')` 不触碰 local 状态。

---

## Section 2：魔珐 SDK 集成架构

**SDK 事实**（官方文档 + 调试台实测，详 `XINGYUN-API-CHECK.md`）：

- 加载：CDN `https://media.xingyun3d.com/xingyun3d/general/litesdk/xmovAvatar@latest.js`，全局 `window.XmovAvatar`，**无 npm 包**。本设计将其 **vendor 到本地锁版本**（见 Section 11）。
- 初始化：`new XmovAvatar({ containerId, appId, appSecret, gatewayServer, onStateChange, onVoiceStateChange, onMessage, onNetworkInfo, proxyWidget?, enableLogger? })`。**无需形象/场景 id**——形象绑定在 appId（控制台已配）。
- 方法：`speak(ssml, isStart, isEnd)` / `interactiveidle()`(打断) / `idle()`(待机) / `offlineMode()`(离线) / `destroy()`(销毁)。
- 回调：`onStateChange(state)`（state ∈ idle/interactiveidle/listen/think/...）、`onVoiceStateChange(status)`（说话 start/end）、`onMessage(msg)`（含错误，码段 10001–50004）、`onNetworkInfo(info)`（延迟/带宽）。

**关键安全边界：**
- `appId/appSecret` 只在 main 进程 `.env` 读取。
- main 暴露 `xingyunGetConfig()` IPC，返回 `{ configured, appId, appSecret, gatewayServer }` 给 renderer 用于 SDK 初始化。
- ⚠️ **appSecret 会进入 renderer 内存**——这是魔珐 SDK 的鉴权模型决定的（前端直传，无服务端 token 签发）。**仅在单点受控部署下可接受**。严禁把 appSecret 硬编码进 `src/`/打包产物；它只经 IPC 在运行时从 main 注入。
- 将来若要分发：需魔珐支持"服务端用 appId+appSecret 换临时 token"，那时把 `xingyunGetConfig` 改成 `xingyunGetToken`（main 侧签 token），renderer 永不见 appSecret。本设计保留这个替换口子。

**进程职责拆分（比 D-ID 大幅简化——SDK 自管连接，无需 REST 代理）：**

| 进程 | 文件 | 职责 |
|------|------|------|
| **main** | `electron/services/xingyunConfigHandler.ts` | 从 `process.env` 读 `XINGYUN_APP_ID`/`XINGYUN_APP_SECRET`（**必填**）+ `XINGYUN_GATEWAY_SERVER`（**可选**，缺省用代码内默认值）；暴露 `getConfig()`：缺 APP_ID 或 APP_SECRET 返 `{configured:false, missingKey:true, errorReason}`，否则返完整 config（gateway 已填默认）|
| **preload** | `electron/preload.ts` | 在现有 `window.electronAPI` 上**平铺追加** `xingyunGetConfig()`（与 `transcribeAudio` 等风格一致，不开子命名空间）|
| **renderer** | `src/services/xingyun/XingyunClient.ts` | 单次会话的 SDK 封装：确保脚本加载 → `new XmovAvatar` → 事件接线 → `speak`/`interrupt`/`destroy`；构造器接受 `sdkFactory` 便于测试注入 mock。**不导出单例** |
| **renderer** | `src/services/xingyun/sessionManager.ts` | **唯一**持有当前 `XingyunClient`；idle-timeout（空闲 N 秒 `destroy`）；`ensureConnected()`/`speak()`/`interrupt()`/`notifyIdle()`/`closeNow()` |
| **renderer** | `src/services/xingyun/index.ts` | **仅**导出 `sessionManager` 单例 |
| **renderer** | `src/services/xingyun/types.ts` | `XingyunErrorCode`、`XingyunConfig`、`XingyunConfigStatus` 等 |

**新增 `window.electronAPI` 方法（平铺）—— 1 个：**

| 方法 | 入参 | 返回 |
|---|---|---|
| `xingyunGetConfig()` | — | `Promise<XingyunConfigStatus>`，即 `{ configured: true, appId, appSecret, gatewayServer } \| { configured: false, missingKey: true, errorReason }`。**`configured` 只取决于 APP_ID + APP_SECRET**；`gatewayServer` 永远有值（env 缺省时为默认常量）|

**IPC channel 名：** `xingyun-get-config`。

**默认 gateway 常量（main 侧）：** `const DEFAULT_GATEWAY = 'https://nebula-agent.xingyun3d.com/user/v1/ttsa/session'`。`getConfig()` 用 `process.env.XINGYUN_GATEWAY_SERVER || DEFAULT_GATEWAY`。

**错误码（renderer 侧产生，统一进现有 `AppError` 体系）：**

```ts
type XingyunErrorCode =
  | 'XY_NOT_CONFIGURED'  // .env 缺 APP_ID/APP_SECRET
  | 'XY_SCRIPT'          // SDK 脚本加载失败
  | 'XY_CONNECT'         // 建联超时 / onMessage 报连接错误
  | 'XY_SPEAK'           // speak 期间 onMessage 报错
  | 'XY_SDK'             // 其他 SDK 错误
```

`XY_NOT_CONFIGURED` 不走错误路径——`xingyunGetConfig()` 直接返 `{configured:false}`，ModeToggle 据此禁用。

---

## Section 3：Session 生命周期（idle 超时 + 打断）

`sessionManager.ts` 是状态机，包住 `XingyunClient`，**是 renderer 侧魔珐相关状态的唯一入口**——CloudAvatar、useAI 只跟它打交道，不直接 import `XingyunClient`。

```ts
const IDLE_TIMEOUT_MS = 60_000   // 空闲 60s 自动 destroy（按会话时长计费，省钱）
                                  // 取 60s 而非更短：重连要重载 3D 资源（首连 ~30s，缓存后更快但仍有开销），
                                  // 一节课交互密集，60s 足够覆盖讲解间隙又不过度烧钱。可调。

class SessionManager {
  private client: XingyunClient | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  // useAI 在 cloud 模式、speak 前调
  async ensureConnected(): Promise<XingyunClient> {
    this.clearIdleTimer()
    if (this.client && this.client.isOpen()) return this.client
    const cfg = await loadConfig()                         // window.electronAPI.xingyunGetConfig()
    if (!cfg.configured) throw xyErr('XY_NOT_CONFIGURED', cfg.errorReason)
    useAgentStore.getState().setCloudConn('connecting')
    this.client = new XingyunClient()
    await this.client.open(cfg, XINGYUN_CONTAINER_ID)      // 加载脚本 → new XmovAvatar → 等就绪态
    useAgentStore.getState().setCloudConn('streaming')
    return this.client
  }

  // useAI 每条回复 speak。返回 'completed' | 'interrupted'。
  // 内部：若正在说话先 interrupt，再 speak；用 onVoiceStateChange('end') 兑现 promise。
  async speak(text: string): Promise<'completed' | 'interrupted'> {
    if (!this.client) throw xyErr('XY_SDK', 'no active client; call ensureConnected first')
    return this.client.speak(text)   // XingyunClient 内封装 end 事件 → resolve
  }

  // useAI 在新一轮 sendMessage 开头调（cloud 模式下取代 ttsProvider.stop() 的位置）
  interrupt(): void {
    this.client?.interrupt()         // → 先把 pending speak resolve 成 'interrupted'，再 SDK.interactiveidle()
  }

  // useAI 在每条回复 speak resolve 后调
  notifyIdle(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => { void this.closeNow() }, IDLE_TIMEOUT_MS)
  }

  // 切回 local / 报错 / 退出时调
  async closeNow(): Promise<void> {
    this.clearIdleTimer()
    if (this.client) {
      // destroy() 内部先把 pending speak resolve 成 'interrupted'（不 reject），
      // 再 SDK.destroy()。这样在 await sessionManager.speak() 上挂起的 useAI 拿到
      // 'interrupted' 干净早退——既不卡死、也不会被当成"云端失败"误弹 toast + 本地补讲。
      this.client.destroy()
      this.client = null
    }
    useAgentStore.getState().setCloudConn('idle')
  }

  getClient(): XingyunClient | null { return this.client }
  private clearIdleTimer(): void { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null } }
}
```

**说话完成信号 + pending speak 单一收尾契约（替代 D-ID 的 speak-promise）：**
`XingyunClient.speak(text)` 返回 Promise，内部记一个 **唯一的 pending resolver**，它**有且仅有三种收尾**：

| 收尾 | 触发 | resolve/reject |
|---|---|---|
| 正常说完 | `onVoiceStateChange('end')` | resolve `'completed'` |
| 被打断/被主动断开 | `interrupt()` 或 `destroy()`（手动 toggle / unmount / 退出 / 新一轮打断） | resolve **`'interrupted'`**（绝不 reject）|
| 真故障 | speak 期 `onMessage` 报致命错 | reject `XY_SPEAK`（→ 走 handleCloudFailure）|

> **关键不变量：** "主动断开" 与 "真故障" 必须分流——`interrupt()`/`destroy()` 永远 resolve `'interrupted'`，**只有 `onMessage` 致命错才 reject**。否则用户说话中点 toggle 会被误判为云端失败（误弹 toast + 本地重复补讲）。XingyunClient 在调 `interactiveidle()`/`destroy()` **之前**先兑现 pending resolver 为 `'interrupted'`，确保后续即便 SDK 抛错也不再触达这个已结算的 promise。

**连发 speak（打断旧讲新）：** 新一轮 sendMessage 头部 `sessionManager.interrupt()` → 先把旧 speak resolve 成 `'interrupted'`、再 SDK `interactiveidle()` 立刻停旧讲（魔珐真打断）。旧 speak 的 useAI 续段拿到 `'interrupted'` 早退（不 notifyIdle、不 finishTalking）；新一轮 `ensureConnected()`（复用连接）→ `speak(newReply)` 接管。generation guard 二次防御。

> **连发 speak 是否必须先切 state**（排队 vs 覆盖）属实现首日联调点；sessionManager.speak 内部封装"必要时先 interrupt"的时序，对 useAI 透明。

**Idle 计时起点（与 useAI 收尾对齐）：** **只有 speak resolve 为 `'completed'` 时**，useAI 才调 `notifyIdle()` 起 60s 计时。`'interrupted'` **不计 idle**——因为它只可能来自两种情况：(a) **新一轮 speak 打断**——新 speak 接管整个生命周期、由它自己的 `'completed'` 去 notifyIdle；(b) **手动 interrupt / closeNow**——session 已被 `closeNow` 主动 `destroy` 断开，无需再起 idle 计时。两种都不该由被打断的旧 speak 来起 idle。
**应用退出：** Avatar 父组件 unmount 触发 `closeNow()`（连带把 pending speak 结算为 `'interrupted'`）；electron `before-quit` 不持有 client（renderer 侧管），渲染进程关闭即断 SDK。

---

## Section 4：CloudAvatar 子组件

`src/components/Avatar/CloudAvatar.tsx`：

```tsx
import { sessionManager, XINGYUN_CONTAINER_ID } from '../../services/xingyun'

export function CloudAvatar() {
  const cloudConn = useAgentStore(s => s.cloudConn)
  const mood = useAgentStore(s => s.mood)

  // 卸载时确保断开（切回 local / 退出）
  useEffect(() => () => { void sessionManager.closeNow() }, [])

  return (
    <div className={styles.avatar}>
      <div className={[styles.wrap, styles[mood]].join(' ')}>
        {cloudConn === 'connecting' && <ConnectingOverlay />}
        {cloudConn === 'error' && <ErrorOverlay />}
        {/* 魔珐 SDK 把 3D 自绘进这个容器（containerId 选择器指向它）。不是 <video>，无 MediaStream */}
        <div id={XINGYUN_CONTAINER_ID} className={styles.stage} />
      </div>
    </div>
  )
}
```

**职责边界：**
- CloudAvatar **只**提供容器 div + 读 `cloudConn` 渲染 overlay；**不**持有 client、不调 speak/connect。
- 连接由 useAI 驱动（connect-on-first-message）；CloudAvatar 通过 `cloudConn` 感知状态。
- 容器 div 常驻（cloud 模式下）；SDK 在首条消息时构造进来、idle 后 destroy（容器留空待复用）。
- **没有 MediaStream / `<video>`**——魔珐 SDK 内部 WebGL 自绘。任何引入 video 流的实现视为设计偏离。

> **connect-on-first-message vs connect-on-mount（决策点，可在 spec review 翻）：** 本设计选 **first-message**——避免 App 打开但没交互时空烧会话时长。代价：首条消息前容器是 connecting/poster 占位，而非立刻站着一个数字人。若你更要"打开即见数字人"，改为 mount 即 `ensureConnected()`（代价：从启动就计费）。

---

## Section 5：LocalAvatar 子组件

把现有 `src/components/Avatar/index.tsx` **原封不动**搬到 `src/components/Avatar/LocalAvatar.tsx`（逻辑 0 变动）：

```tsx
export function LocalAvatar() {
  const mood = useAgentStore(s => s.mood)
  const isPushing = useAgentStore(s => s.isPushing)
  const currentViseme = useAgentStore(s => s.currentViseme)
  const setCurrentViseme = useAgentStore(s => s.setCurrentViseme)
  useEffect(() => () => { setCurrentViseme('closed') }, [setCurrentViseme])
  // ... 当前 Avatar 的全部逻辑（VISEME_SRC、wrapClass、JSX）
}
```

所有现有 viseme 约束（useAI 管 stop、CSS 变量定位、不重画整张图）继续生效。

---

## Section 6：RouterAvatar（替代原 index.tsx）

```tsx
import { LocalAvatar } from './LocalAvatar'
import { CloudAvatar } from './CloudAvatar'
import { useAgentStore } from '../../store/agentStore'

export function Avatar() {
  const renderMode = useAgentStore(s => s.renderMode)
  return renderMode === 'cloud' ? <CloudAvatar /> : <LocalAvatar />
}
```

5 行，故意保持薄。切换由 store 单一字段决定；组件挂载/卸载自然触发 LocalAvatar 的 cleanup 和 CloudAvatar 的 `closeNow()`。

---

## Section 7：useAI 改造

```ts
const sendMessage = useCallback(async (text: string) => {
  if (useAgentStore.getState().isLoading) return
  const myGen = ++generationRef.current

  // 新一轮开始：打断上一轮，无论模式
  ttsProvider.stop()                   // 本地 TTS（cloud 下 no-op）
  lipSyncController.stop()             // 本地 lipsync（cloud 下 no-op）
  if (useAgentStore.getState().renderMode === 'cloud') {
    sessionManager.interrupt()         // 魔珐真打断（interactiveidle）
  }

  // ... setIsLoading, setMood('thinking'), addMessage ...

  try {
    const response = await aiProvider.chat(useAgentStore.getState().messages)
    // ... addMessage / setResourceCards / setMood('talking') / setIsLoading(false) ...

    const mode = useAgentStore.getState().renderMode   // 按"决策时刻"的模式走（AI 等待期可能被切）

    if (mode === 'local') {
      lipSyncController.start(response.reply, useAgentStore.getState().setCurrentViseme)
      ttsProvider.speak(response.reply).then(finishTalkingLocal, finishTalkingLocal)
    } else {
      try {
        await sessionManager.ensureConnected()
        const result = await sessionManager.speak(response.reply)  // 'completed' | 'interrupted'
        if (generationRef.current !== myGen) return
        if (result === 'interrupted') return                       // 被打断不收尾、不计 idle
        sessionManager.notifyIdle()
        finishTalkingCloud()
      } catch (xyErr) {
        if (generationRef.current !== myGen) return
        await handleCloudFailure(xyErr, response.reply)
      }
    }
  } catch (aiErr) {
    if (useAgentStore.getState().renderMode === 'cloud') {
      await sessionManager.closeNow()
    }
    // ...（现有：setMood('error'), setError(...), setIsLoading(false)）
  }
}, [])
```

**两套 finishTalking：**
- `finishTalkingLocal`：现有逻辑（gen guard + lipSyncController.stop + setMood('idle')）。
- `finishTalkingCloud`：gen guard + setMood('idle') + setIsPushing(false)（魔珐流自身结束，不调 viseme stop——cloud 模式不用 currentViseme）。

**generation guard** 覆盖两种模式；cloud 新增 `result === 'interrupted'` 早退分支（被新一轮挤掉的 speak 不收尾）。

---

## Section 8：魔珐失败 → 自动回本地

**触发条件（任一）：** `ensureConnected()` 抛错（脚本加载/建联超时/onMessage 连接错）；`speak()` 抛错；运行中 onMessage 报致命错误。

```ts
async function handleCloudFailure(err: XingyunError, reply: string) {
  await sessionManager.closeNow()                       // 确保 SDK destroy、停计费
  const store = useAgentStore.getState()
  store.setRenderMode('local')                          // 翻本地（不变量保证 currentViseme='closed'）
  store.setCloudError(humanReadableError(err))          // 触发 toast
  store.setCloudConn('idle')
  // 把这条没讲出来的 reply 用本地补上
  lipSyncController.start(reply, store.setCurrentViseme)
  ttsProvider.speak(reply).then(finishTalkingLocal, finishTalkingLocal)
}
```

**用户体验：** 提问 → 魔珐建联/说话失败 → **本地立刻补讲这条** → toast: "魔珐数字人连接失败（原因），已切回本地。点右上角可重试。" → toggle 翻回本地。下一条默认本地，除非用户主动重开。

**不做：** ❌ 不自动重试（失败可能是积分用尽，无脑重试烧钱刷屏）；❌ 建联超时阈值——**首连含 3D 资源下载较慢，给宽到 ~30s**（实测首连 ~30s）；复用连接后无此问题。超过阈值判 `XY_CONNECT` 失败 fallback；❌ 不同时跑本地与魔珐抢救（双声源）。

**已知小问题（接受）：** 若魔珐已说出部分语音后断连，本地补讲会重复这条（先听半段魔珐、再听完整本地）。MVP 接受——优先"用户一定听到完整答案"。

---

## Section 9：Toggle UI（极简）

`src/components/ModeToggle/index.tsx`：主界面右上角常驻小按钮。**无确认弹窗、无用量/计费指示**（用户选定极简）。

**配置预查：** mount 时调一次 `window.electronAPI.xingyunGetConfig()`，存本地 state（`configured`、`disabledReason`）。决定按钮可点性与初始模式：
- `configured === false` → `setRenderMode('local')` + 按钮**禁用**，hover tooltip（如"未配置魔珐 — 请在 .env 填 XINGYUN_APP_ID / XINGYUN_APP_SECRET"）。
- `configured === true` → 按钮可点（store 默认已是 cloud）。

label 状态表：

| renderMode | cloudConn | 按钮显示 |
|---|---|---|
| local | * | `🎭 本地模式` |
| cloud | idle | `✨ 魔珐 · 待机` |
| cloud | connecting | `✨ 连接中...`（spinner，disabled）|
| cloud | streaming | `✨ 魔珐` |
| cloud | error | （不可能——error 已自动翻 local）|

**点击行为：** 直接切换，**无 modal**。
- cloud → local：`await sessionManager.closeNow()` + `setRenderMode('local')`。
- local → cloud：`setRenderMode('cloud')`（下一条消息触发 connect-on-first-message）。

**toast：** `cloudLastError !== null` 时显示 dismissable toast（5s 自动消失或点 x），含错误原因 + "点右上角可重试"；dismiss 时 `setCloudError(null)`；新错误替换旧 toast（不堆叠）。

---

## Section 10：错误处理细则

| 错误来源 | 处理 |
|---------|------|
| `XY_NOT_CONFIGURED`（.env 缺 key）| `xingyunGetConfig()` 返 `{configured:false}`，ModeToggle 禁用 + 初值 local；不走错误路径 |
| `XY_SCRIPT`（SDK 脚本加载失败）| toast: "数字人组件加载失败"；fallback local |
| `XY_CONNECT`（建联超时 / onMessage 连接错）| toast: "魔珐连接失败"；fallback local + 本地补讲 |
| `XY_SPEAK`（speak 期 onMessage 报错）| toast 含原因；fallback local + 本地补讲 |
| `XY_SDK`（其他）| toast 含原因；fallback local |

错误对象经现有 `AppError` 体系；**严禁** appSecret 出现在任何错误信息/日志里（XingyunClient 与 config handler 做擦除）。

---

## Section 11：SDK 脚本 vendor 与 CSP

**脚本 vendor（"长期上线"不依赖外部 @latest CDN）：**
- 把 `xmovAvatar@latest.js` 下载锁版本，放 `public/vendor/xmovAvatar.js`（Vite 静态资源，打包进 `dist`）。
- `index.html` 用 `<script src="/vendor/xmovAvatar.js"></script>` 引入（被 `script-src 'self'` 覆盖，无需放行外部脚本域）。
- `XingyunClient` 初始化前确认 `window.XmovAvatar` 存在；不存在抛 `XY_SCRIPT`。
- 记录所锁版本与下载日期到 `XINGYUN-API-CHECK.md`，便于将来升级比对。

**CSP（`index.html` meta）：** 现状 `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'` 会拦掉魔珐网关与 3D 资源。需放行**魔珐 SDK 运行时访问的域名**：

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
connect-src 'self' https://*.xingyun3d.com wss://*.xingyun3d.com;
img-src 'self' data: blob: https://*.xingyun3d.com;
media-src 'self' blob: https://*.xingyun3d.com;
worker-src 'self' blob:;
```

> **精确域名实现首日用 DevTools&gt;Network 核实并收窄**（已知 `media.xingyun3d.com`、`nebula-agent.xingyun3d.com`；3D 资源/TTS 音频域名待补）。`*.xingyun3d.com` 是起点白名单，确认后尽量收窄到具体子域。WebGL 可能需要 `blob:`/`data:`（资源解码），实测调整。

---

## Section 12：测试策略

魔珐 SDK 跑真 WebGL/WebSocket，端到端无法在 happy-dom 单测。策略：**XingyunClient 内注入 `sdkFactory`，把可测逻辑单测，3D/网络留手动验收**。

| 文件 | 覆盖点 | 类型 |
|------|--------|------|
| `tests/xingyunConfigHandler.test.ts` | 缺 APP_ID/APP_SECRET 返 `{configured:false, missingKey:true, errorReason}`；有 APP_ID+APP_SECRET 返完整 config；**缺 GATEWAY 仍 `configured:true` 且 gatewayServer=默认常量**；不抛错；appSecret 不混入错误对象 | 单测 |
| `tests/XingyunClient.test.ts` | 注入 mock `XmovAvatar`：构造参数（containerId/appId/appSecret/gatewayServer）正确；`speak` 调 SDK.speak 且 SSML **转义** AI 回复中的 `& < >`；`onVoiceStateChange('end')` resolve speak 为 'completed'；**`interrupt()` 在调 `interactiveidle()` 前先把 pending speak resolve 为 'interrupted'**；**`destroy()` 在调 SDK.destroy 前先把 pending speak resolve 为 'interrupted'（绝不 reject）**；**仅 speak 期 `onMessage` 致命错才 reject `XY_SPEAK`**；`window.XmovAvatar` 缺失 → `XY_SCRIPT` | 单测（SDK mock）|
| `tests/sessionManager.test.ts` | fake timers：idle timer 推进后 `destroy`；`ensureConnected` 复用未关 client；`closeNow` 调 destroy + setCloudConn('idle')；**说话中 `closeNow()` 让挂起的 `speak()` resolve 为 'interrupted'（不 reject、不卡死）**；`speak` 透传 'completed'/'interrupted'；`interrupt` 调 client.interrupt | 单测 |
| `tests/useAI.test.ts`（扩展）| cloud 默认路径：lipSync 不被调、调 `sessionManager.speak`；speak **reject** 触发 fallback、renderMode 翻 local、本地补讲执行；**speak resolve 'interrupted'（手动切本地/打断）不触发 fallback、不补讲、不报错**；只有 'completed' 才 `notifyIdle`；新一轮 sendMessage 调 `interrupt`；`mockLipStart` 与 `mockSessionSpeak` 互斥 | 单测 |
| `tests/ModeToggle.test.ts` | mount 调 `xingyunGetConfig`；`configured:false` → 禁用 + tooltip + 初值 local；configured → 点击直接切换（**无 modal**）；label 跟 cloudConn | 组件测 |
| `tests/RouterAvatar.test.ts` | renderMode='cloud' 渲染 CloudAvatar、'local' 渲染 LocalAvatar；切换 unmount 旧组件；CloudAvatar 不直接 import XingyunClient（grep 守护）| 组件测 |
| `tests/CloudAvatar.test.tsx` | 渲染容器 div（id=XINGYUN_CONTAINER_ID）；cloudConn='connecting'/'error' 显示对应 overlay；unmount 调 closeNow | 组件测 |
| `tests/agentStore.test.ts`（扩展）| 初值 renderMode='cloud'、cloudConn='idle'、cloudLastError=null；`setRenderMode('local')` 重置 currentViseme='closed'；`setRenderMode('cloud')` 不动 viseme；reset 复位 | 单测 |

**手动验收（不可由测试替代）：** 真实 3D 画质/中文口型、建联速度、打断真停、idle 后消耗记录停止、跨网络稳定性、CSP 收窄后仍可用。

---

## Section 13：文件清单

### 新增

| 文件 | 行数估 | 职责 |
|------|--------|------|
| `electron/services/xingyunConfigHandler.ts` | ~40 | 读 env、`getConfig()`、缺 APP_ID/APP_SECRET 返 not-configured；gateway 缺省补默认常量；appSecret 不泄漏 |
| `src/services/xingyun/XingyunClient.ts` | ~160 | 脚本加载守卫 + `new XmovAvatar` + 事件接线 + speak(SSML 转义)/interrupt/idle/destroy；`sdkFactory` 注入 |
| `src/services/xingyun/sessionManager.ts` | ~110 | 单例；ensureConnected/speak/interrupt/notifyIdle/closeNow；idle-timeout |
| `src/services/xingyun/index.ts` | ~3 | 仅导出 `sessionManager` 单例 + `XINGYUN_CONTAINER_ID` 常量 |
| `src/services/xingyun/types.ts` | ~30 | `XingyunErrorCode`/`XingyunConfig`/`XingyunConfigStatus`/`XingyunError` |
| `src/services/xingyun/ssml.ts` | ~20 | `buildSSML(text)`：XML 转义 + `<speak>` 包裹 |
| `src/components/Avatar/LocalAvatar.tsx` | ~50 | 现 Avatar 整段搬来，0 变动 |
| `src/components/Avatar/CloudAvatar.tsx` | ~70 | 容器 div + connecting/error overlay + unmount closeNow |
| `src/components/Avatar/CloudAvatar.module.css` | ~40 | stage 容器 / overlay 样式 |
| `src/components/ModeToggle/index.tsx` | ~90 | 极简 toggle（无 modal）+ config 预查 + toast |
| `src/components/ModeToggle/ModeToggle.module.css` | ~50 | 按钮 / toast 样式 |
| `public/vendor/xmovAvatar.js` | （vendored）| 锁版本的魔珐 SDK 脚本 |
| `src/types/xingyun-sdk.d.ts` | ~30 | `window.XmovAvatar` 类型声明 |
| 8 个测试文件 | ~100-200 each | 见 Section 12 |

### 修改

| 文件 | 改动 |
|------|------|
| `src/components/Avatar/index.tsx` | 改成 5 行 RouterAvatar；原内容搬至 LocalAvatar |
| `src/store/agentStore.ts` | 新增 `renderMode`(初值 cloud) / `cloudConn` / `cloudLastError` + 3 个 setter；`setRenderMode('local')` 重置 viseme；`reset()` 复位新字段 |
| `src/hooks/useAI.ts` | 按 renderMode 分支；cloud 头部 `interrupt`；新增 `handleCloudFailure`；catch 关 session |
| `electron/main.ts` | 注册 `xingyun-get-config` IPC |
| `electron/preload.ts` | 平铺追加 `xingyunGetConfig()` |
| `src/types/electron.d.ts` | 追加 `xingyunGetConfig` 类型 |
| `shared/types.ts` | 新增 `RenderMode`/`CloudConnectionState`/`XingyunErrorCode`/`XingyunError`/`XingyunConfig`/`XingyunConfigStatus` |
| `index.html` | 更新 CSP（Section 11）；引入 `/vendor/xmovAvatar.js` |
| `.env.example` | 已加 `XINGYUN_APP_ID`/`XINGYUN_APP_SECRET`/`XINGYUN_GATEWAY_SERVER`（本次会话已完成）|
| `src/App.tsx` | 顶层渲染 `<ModeToggle />`；toast 容器 |
| `tests/agentStore.test.ts` / `tests/useAI.test.ts` | 扩展 cloud 路径 |

### 删除
**无。** 本地 viseme 全保留。

---

## Section 14：环境变量与配置

```bash
# .env（已写入本次会话）
XINGYUN_APP_ID=<控制台 App密钥 中的 App ID>           # 必填
XINGYUN_APP_SECRET=<App Secret；可在控制台“刷新”轮换>  # 必填
XINGYUN_GATEWAY_SERVER=https://nebula-agent.xingyun3d.com/user/v1/ttsa/session  # 可选，缺省走代码内默认常量
```

**必填仅 `XINGYUN_APP_ID` + `XINGYUN_APP_SECRET`。** `XINGYUN_GATEWAY_SERVER` **可选**——不填时 `getConfig()` 用代码内 `DEFAULT_GATEWAY` 常量（见 Section 2），**不影响 `configured` 判定**。`.env.example` 里预填了 gateway 默认值仅作参考。

main 启动读取，缺 `XINGYUN_APP_ID` 或 `XINGYUN_APP_SECRET` → `xingyunGetConfig()` 返 `{configured:false, missingKey:true, errorReason:'未配置魔珐 — 请在 .env 填 XINGYUN_APP_ID / XINGYUN_APP_SECRET'}`，ModeToggle 据此禁用 + 初值 local。

**严禁：** appId/appSecret 出现在 `src/`/`shared/` 源码或打包产物里——只经 IPC 运行时注入。

---

## Section 15：分支与验收

**分支：** 从 `main` 新建 `feature/xingyun-streaming`，worktree 置于 `.worktrees/feature-xingyun-streaming/`。

**前置条件：**
1. ✅ 魔珐账号 + 应用（id=55230）+ 形象已配
2. ✅ `appId/appSecret` 已写入 `.env`（本次会话）
3. ✅ 官方调试台 + API 文档已验证核心能力（详 `XINGYUN-API-CHECK.md`）
4. ⬜ vendor 锁版本 SDK 脚本（Task 内完成）

**自动验收：** 全量 `npx vitest run` 通过；`npx tsc --noEmit` 无错；`npm run build` 三套产物通过。

**手动验收：**
1. `.env` 删 `XINGYUN_APP_ID` → toggle 禁用 + tooltip + 启动为本地模式
2. 填回 key → 启动默认魔珐；第一次发问题 → "连接中..." → 数秒后 3D 数字人讲这条回复、**中文口型对齐**
3. 它说话时再发一条 → 旧的**立刻被打断**（魔珐真打断），新的接管
4. 60s 不发问题 → session 自动断（控制台"消耗记录"不再增长）
5. 再发问题 → 自动重连 → 又能讲
6. 点 toggle 切本地 → CloudAvatar 卸载、SDK destroy、LocalAvatar 挂载、嘴回 closed；本地 viseme 正常
6b. **数字人正在说话时点 toggle 切本地** → 立刻停（pending speak 干净 interrupted）→ **不弹"云端失败"toast、不本地重复补讲这条**；切到本地后下一条正常走本地
7. **拔网线 / 改错 appSecret** → toast 提示 + toggle 翻回本地 + 本地补讲这条 reply
8. 关闭 App → 控制台无悬挂 session
9. CSP 收窄到实测域名后，1–8 仍正常

---

## 已知风险与待办

| 风险 | 缓解 |
|------|------|
| appSecret 进 renderer 内存（前端直传鉴权）| 单点受控部署可接受；保留改 token 签发的口子（Section 2）；严禁硬编码/分发 |
| 连发 speak 服务端行为未知（排队 vs 覆盖 vs 必须先切 state）| 实现首日联调；sessionManager.speak 内封装"必要时先 interrupt"，对 useAI 透明 |
| onVoiceStateChange('start'/'end') / 就绪态精确取值未最终确认 | 实现首日用调试台/spike 核实；XingyunClient 事件接线据实落地 |
| CSP 域名不全导致 3D 资源/TTS 被拦 | 起点 `*.xingyun3d.com` 白名单 + DevTools 核实收窄 |
| 首连慢（~30s 下载 3D 资源）| connecting overlay + 建联超时阈值 ~30s；复用连接后无此问题 |
| 会话未关导致计费泄漏 | idle-timeout `destroy` + CloudAvatar unmount closeNow + 退出断连 + 魔珐自身 session 超时 |
| 魔珐 SDK 仅 CDN 无 npm | vendor 锁版本到 `public/vendor/`，从 'self' 加载 |
| 中文长回复 SSML 特殊字符 | `buildSSML` 做 XML 转义（`& < >`）|
| 月度费用 | 按时长计费 + idle-timeout 控制；不做硬上限（用户自管，控制台可查）|
