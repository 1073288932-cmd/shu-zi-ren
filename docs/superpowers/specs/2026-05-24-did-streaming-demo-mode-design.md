# D-ID Streaming 演示模式 设计文档

**日期：** 2026-05-24
**背景：** 本地 viseme + PNG lipsync 方案（详见 `2026-05-22-local-viseme-lipsync-design.md`）已合并 main，日常上课够用，但视觉是卡通贴纸级，不达"真人讲话"水平。家长会、汇报、对外演示等场合需要更高质量的真人级数字人。
**目标：** 在不破坏本地方案的前提下，**新增一条云端渲染管线**——基于 D-ID Streaming Avatars (WebRTC)——并通过主界面 toggle 在「本地模式」与「演示模式」间手动切换。本地模式 $0 成本、毫秒级；演示模式按分钟付费、真人级画质。**两套管线全程并存、共用同一 AI/TTS 触发链。**

---

## 非目标

- 不做按回复内容自动路由（短回复本地、长回复云端）——之前 brainstorm 已否决，理由是视觉割裂体验差。
- 不做云端模式持久化跨重启（每次启动默认本地，避免无意烧钱）。
- 不做 D-ID Agents 产品集成（那是 D-ID 自家 LLM/对话栈，会替换我们整套 AI 链）——我们只用 D-ID Streaming 当渲染层。
- 不做自定义 Avatar（D-ID Personal Avatar 是付费功能、效果不稳定）——MVP 用 D-ID 预置形象。
- 不做精确账单复核（D-ID 自己有 dashboard）——只做"本月大致使用分钟数"展示，用于 UI 提醒。
- 不替换、不删除任何本地 viseme 代码。

---

## 整体策略

```
                          ┌──────────────────────────────┐
                          │ agentStore.renderMode         │
                          │   'local' | 'cloud'           │
                          └─────────────┬────────────────┘
                                        │
                                        ▼
useAI 拿到 AI 回复后，根据 renderMode 二选一：

  renderMode='local':                    renderMode='cloud':
  ┌─────────────────────┐                ┌──────────────────────┐
  │ lipSyncController   │                │ didStreamClient       │
  │   .start(reply, …)  │                │   .speak(reply)       │
  │ ttsProvider         │                │ (D-ID 自带 TTS, 我们   │
  │   .speak(reply)     │                │  不再调本地 ttsProvider│
  │                     │                │  避免双声源)           │
  └─────────────────────┘                └──────────────────────┘
        │                                          │
        ▼                                          ▼
  store.currentViseme 改变             didStreamClient 内部 MediaStream
        │                                          │
        ▼                                          ▼
  <LocalAvatar/> 切换 PNG               <CloudAvatar/> <video> 播 WebRTC 流
```

**关键不变量：**

1. **AI 调用链不变。** `aiProvider.chat()` / `addMessage` / `setMood('thinking')` 等无论哪种模式都执行——它们是"思考态"，与渲染层无关。
2. **TTS 来源由模式决定。** 本地模式用 `ttsProvider`（WebSpeech），云端模式用 D-ID 自带 voice，**两者互斥不并行**（否则会双声源）。
3. **mood 状态机不变。** thinking / talking / idle / error 在两种模式下含义相同；CloudAvatar 也订阅 mood 做姿态动画（CSS 层）。
4. **本地模式 0 网络依赖。** 切到本地后，D-ID session 必须真关，确保不再产生网络流量。

---

## Section 1：模式状态机

新增 store 字段（`src/store/agentStore.ts`）：

```ts
renderMode: 'local' | 'cloud'         // 初值 'local'，不持久化（每次启动重置）
cloudConn: 'idle' | 'connecting' | 'streaming' | 'error'  // 初值 'idle'
cloudMinutesThisMonth: number          // localStorage 持久化（仅用于 UI 显示）
cloudLastError: string | null          // 最近一次失败原因，UI 显示

// actions
setRenderMode(mode: 'local' | 'cloud'): void
setCloudConn(state: CloudConnState): void
addCloudMinutes(minutes: number): void  // 累计本月使用
setCloudError(msg: string | null): void
```

**状态转换图：**

```
[local mode]
    │  user toggles ON + confirm modal
    │
    ▼
[cloud mode, conn=idle]
    │  first AI reply arrives
    │
    ▼
[cloud mode, conn=connecting]   ←── 1-2s 建联
    │  WebRTC ICE done
    │
    ▼
[cloud mode, conn=streaming]    ←── speak() → 视频流播放
    │  speak resolves + 30s 无新 speak
    │
    ▼
[cloud mode, conn=idle]         ←── session 已关，但仍处于 cloud mode
    │
    └─── 用户再发一句 → 重新建联（回到 connecting）

# 异常分支：
[any cloud state]
    │  D-ID 网络/API 错误
    │
    ▼
[local mode, conn=idle, error="..."]   ←── 自动回本地 + toast 提示
                                          toggle 视觉也翻回 OFF
```

**只有 3 个时机会写 `renderMode`：**

1. 用户点 toggle 并通过 confirm
2. D-ID 失败时自动从 'cloud' 翻回 'local'（同时 `cloudLastError` 设值，触发 toast）
3. 应用启动 / store reset → 'local'

**强制不变量：** `setRenderMode('local')` 必须同时把 `currentViseme` 重置为 `'closed'`——避免 cloud → local 切换瞬间 LocalAvatar 挂载时显示残留的非 closed 嘴型（LocalAvatar 的 useEffect cleanup 只在 unmount 时跑，挂载时不会自动 reset）。

---

## Section 2：D-ID Streaming 集成架构

**D-ID Streaming Avatars** 工作流程（基于 D-ID 公开 API，**具体 endpoint URL / 字段名实现前需对照最新官方文档校准**）：

```
1. POST /talks/streams           → {id, offer (SDP), ice_servers, session_id}
   body: {source_url: "<预置 avatar URL>"}

2. Renderer 建 RTCPeerConnection、setRemoteDescription(offer)、生成 answer

3. POST /talks/streams/{id}/sdp  → 提交 answer SDP
   body: {answer, session_id}

4. WebRTC ICE 协商完成，PeerConnection 收到 MediaStream → <video srcObject>

5. POST /talks/streams/{id}      → 让 avatar 说话（每条回复一次）
   body: {script: {type: 'text', input: '<reply>', provider: {type: 'microsoft', voice_id: 'zh-CN-XiaoxiaoNeural'}}, session_id}

6. DELETE /talks/streams/{id}    → 关闭 session（idle timeout 或用户切回本地时）
```

**关键安全边界：**
- D-ID API key 是长期凭证、**绝对不能进入 renderer**
- API key 只在 main 进程 `.env` 读取
- Renderer 通过 IPC 请求 main 代理 REST 调用，main 把 API key 加到 Authorization header
- IPC 返回给 renderer 的内容：仅包含 stream id / ICE servers / SDP 字符串等**会话期临时凭证**，泄漏只影响这一次 session（最多让别人偷看几分钟视频）

**进程职责拆分：**

| 进程 | 文件 | 职责 |
|------|------|------|
| **main** | `electron/services/DIDStreamingService.ts` | 持有 API key；封装 5 个 REST 调用 + 配置状态读取；返回响应 |
| **main** | `electron/services/didStreamingHandler.ts` | 注册 5 个 IPC handler；输入校验；错误映射 |
| **preload** | `electron/preload.ts` | 在**现有** `window.electronAPI` 对象上**追加**新方法（**不开 `window.did` 子命名空间**，跟 `resizeWindow` / `setApiKey` / `transcribeAudio` 平铺一致） |
| **renderer** | `src/services/did/DIDStreamClient.ts` | 管理单次 session 的 `RTCPeerConnection` 生命周期；调 `window.electronAPI.did*`；暴露 `MediaStream` getter、`speak()`、`stopSpeaking()`、`close()`。**不导出为单例**——只由 SessionManager 内部 `new` |
| **renderer** | `src/services/did/sessionManager.ts` | **唯一**持有当前活跃的 `DIDStreamClient`；实现 S2 idle-timeout（30s 无 speak 自动 close）；暴露 `ensureConnected()` / `notifyIdle()` / `getCurrentStream()` / `interruptCurrentSpeak()` / `closeNow()` |
| **renderer** | `src/services/did/index.ts` | 仅导出 `sessionManager` 单例（**不导出** `didStreamClient` 单例——它根本不存在） |

**新增 `window.electronAPI` 方法（平铺、verb-first，与现有风格一致）：**

| 方法 | 入参 | 返回 |
|---|---|---|
| `didGetConfigStatus()` | — | `Promise<{ configured: boolean, missingKey?: boolean, errorReason?: string }>` |
| `didCreateStream()` | — | `Promise<{ id, offer, iceServers, sessionId } \| AppError>` |
| `didSubmitAnswer(streamId, sessionId, answer)` | strings + RTCSessionDescriptionInit | `Promise<AppError \| undefined>` |
| `didSpeak(streamId, sessionId, text)` | strings | `Promise<AppError \| undefined>` |
| `didStopSpeaking(streamId, sessionId)` | strings | `Promise<AppError \| undefined>`（D-ID 若不支持显式停讲，由 main 侧降级为 close+reopen 信号） |
| `didEndStream(streamId, sessionId)` | strings | `Promise<AppError \| undefined>` |

**IPC channel 名（仅在 main/preload 之间，renderer 不感知）：**
`did-get-config-status` / `did-create-stream` / `did-submit-answer` / `did-speak` / `did-stop-speaking` / `did-end-stream`。

每个 handler 内部错误统一映射进**现有的 `AppError` 体系**（与 `chat()` / `transcribeAudio()` 一致），`code` 字段扩展新值：

```ts
// 追加进 AppError code 的可能值
type DIDErrorCode =
  | 'DID_AUTH'          // 401/403 — API key 失效
  | 'DID_NOT_CONFIGURED'// 启动时 .env 没读到 DID_API_KEY
  | 'DID_QUOTA'         // 402/429 — 套餐用尽 / 限流
  | 'DID_NETWORK'       // fetch 抛错 / timeout
  | 'DID_API'           // 4xx/5xx 其他
  | 'DID_WEBRTC'        // PeerConnection 失败（renderer 侧产生，非 IPC）
```

`DID_NOT_CONFIGURED` 不通过 IPC 错误路径——`didGetConfigStatus()` 直接返回 `{ configured: false, missingKey: true }`，让 renderer 在调任何 API **之前**就知道。

---

## Section 3：Session 生命周期（S2 空闲超时）

`sessionManager.ts` 是状态机，包住 `DIDStreamClient`，**作为整个 renderer 侧 D-ID 流相关状态的唯一入口**——CloudAvatar、useAI 都只跟 sessionManager 打交道，**不直接 import DIDStreamClient**。

```ts
const IDLE_TIMEOUT_MS = 30_000

class SessionManager {
  private client: DIDStreamClient | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private currentSpeakAbort: AbortController | null = null

  // 由 useAI 在 cloud 模式下、要发 speak 前调
  async ensureConnected(): Promise<DIDStreamClient> {
    this.clearIdleTimer()
    if (this.client && this.client.isOpen()) return this.client
    this.client = new DIDStreamClient()
    await this.client.open()  // 走 createStream → SDP 协商 → ICE done
    return this.client
  }

  // CloudAvatar 唯一获取 MediaStream 的入口（read-only）。
  // 没活跃 client → null。客户端 useEffect 在 cloudConn 切到 'streaming' 时拉一次。
  getCurrentStream(): MediaStream | null {
    return this.client?.getMediaStream() ?? null
  }

  // 由 useAI 在每条回复 speak resolve 后调
  notifyIdle(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => this.closeNow(), IDLE_TIMEOUT_MS)
  }

  // 由 useAI 在新一轮 sendMessage 开头调（cloud 模式下取代 ttsProvider.stop() 的位置），
  // 用于打断 D-ID 还在播旧 reply 的情况——避免新 reply 开始时旧的还在出声。
  //
  // 行为：
  // 1. 中止上一轮 speak() 的 pending promise（abort signal）——promise resolve 为
  //    'interrupted' 状态，**不**抛错、**不**触发 handleCloudFailure
  // 2. 调 client.stopSpeaking() 让 D-ID 端立刻停播（API 不支持时降级为 close+重开 session）
  // 3. 保持 client 连接不变（speak 是会话级的子操作，不需要重新建联）
  async interruptCurrentSpeak(): Promise<void> {
    if (this.currentSpeakAbort) {
      this.currentSpeakAbort.abort()
      this.currentSpeakAbort = null
    }
    if (this.client && this.client.isOpen()) {
      await this.client.stopSpeaking().catch(() => {})
    }
  }

  // 由 useAI 在切回 local 时、D-ID 报错时、或应用退出时调
  async closeNow(): Promise<void> {
    this.clearIdleTimer()
    if (this.currentSpeakAbort) {
      this.currentSpeakAbort.abort()
      this.currentSpeakAbort = null
    }
    if (this.client) {
      const minutes = this.client.uptimeMinutes()
      useAgentStore.getState().addCloudMinutes(minutes)
      await this.client.close().catch(() => {})  // close 失败不再抛
      this.client = null
    }
  }

  // 包装 speak 以便支持 abort——useAI 应通过这个方法调，而不是直接 client.speak()
  async speak(text: string): Promise<'completed' | 'interrupted'> {
    if (!this.client) throw new Error('no active client; call ensureConnected first')
    this.currentSpeakAbort = new AbortController()
    const signal = this.currentSpeakAbort.signal
    try {
      await this.client.speak(text, signal)
      return signal.aborted ? 'interrupted' : 'completed'
    } catch (err) {
      if (signal.aborted) return 'interrupted'  // 自打断不当错误
      throw err
    } finally {
      if (this.currentSpeakAbort?.signal === signal) this.currentSpeakAbort = null
    }
  }

  private clearIdleTimer(): void { ... }
}
```

**Idle 计时起点：** 上一次 `speak()` 的 promise resolve（含 'completed' 与 'interrupted'）之时。
**Idle 计时清除：** 新一次 `ensureConnected()` / `closeNow()` / `interruptCurrentSpeak()` 后立刻 ensure 新 speak。
**应用退出时：** Avatar 父组件 unmount 触发 `closeNow()`（防御性）；electron `before-quit` 事件再兜底一次。

---

## Section 4：CloudAvatar 子组件

`src/components/Avatar/CloudAvatar.tsx`：

```tsx
import { sessionManager } from '../../services/did'

export function CloudAvatar() {
  const cloudConn = useAgentStore(s => s.cloudConn)
  const mood = useAgentStore(s => s.mood)
  const videoRef = useRef<HTMLVideoElement>(null)

  // 唯一获取 MediaStream 的方式：sessionManager.getCurrentStream()
  // 不引入 didStreamClient 这个 import——它根本不应作为单例存在
  useEffect(() => {
    if (cloudConn !== 'streaming') {
      // 非 streaming 状态（idle/connecting/error）清空 srcObject，让 <video> 释放资源
      if (videoRef.current) videoRef.current.srcObject = null
      return
    }
    const stream = sessionManager.getCurrentStream()
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
      videoRef.current.play().catch(() => {})
    }
  }, [cloudConn])

  // mood 仍驱动姿态动画（CSS class）
  const wrapClass = [...]

  return (
    <div className={styles.avatar}>
      <div className={wrapClass}>
        {cloudConn === 'connecting' && <ConnectingOverlay />}
        {cloudConn === 'error' && <ErrorOverlay />}
        <video ref={videoRef} className={styles.video} playsInline muted={false} />
      </div>
    </div>
  )
}
```

**职责边界：**
- CloudAvatar **只读** sessionManager；不持有 client 引用、不调 speak/close/connect
- 连接由 useAI 驱动，CloudAvatar 通过 `cloudConn` 这一个 store 字段感知"现在能拿流了"
- `srcObject` 绑定时机：cloudConn 进入 'streaming' 之后；离开 'streaming' 立刻清空
- **没有第二个流引用源。** 任何"从其他地方拿 MediaStream"的实现都视为 bug。

---

## Section 5：LocalAvatar 子组件

把现有 `src/components/Avatar/index.tsx` **原封不动**搬到 `src/components/Avatar/LocalAvatar.tsx`：

```tsx
export function LocalAvatar() {
  const mood = useAgentStore(s => s.mood)
  const isPushing = useAgentStore(s => s.isPushing)
  const currentViseme = useAgentStore(s => s.currentViseme)
  const setCurrentViseme = useAgentStore(s => s.setCurrentViseme)

  useEffect(() => {
    return () => { setCurrentViseme('closed') }
  }, [setCurrentViseme])

  // ... 当前 Avatar 的全部逻辑，包括 VISEME_SRC、wrapClass、JSX
}
```

**重要：** LocalAvatar 内部行为 0 变动。所有当前 spec Section 9 约束（useAI 管 stop、CSS 变量定位、不重画整张图）继续生效。

---

## Section 6：RouterAvatar（替代原 index.tsx）

`src/components/Avatar/index.tsx` 改成路由：

```tsx
import { LocalAvatar } from './LocalAvatar'
import { CloudAvatar } from './CloudAvatar'
import { useAgentStore } from '../../store/agentStore'

export function Avatar() {
  const renderMode = useAgentStore(s => s.renderMode)
  return renderMode === 'cloud' ? <CloudAvatar /> : <LocalAvatar />
}
```

**5 行，故意保持薄。** 切换由 store 单一字段决定，组件挂载/卸载自然触发 LocalAvatar 的 cleanup（setCurrentViseme('closed')）和 CloudAvatar 的 video 资源回收。

---

## Section 7：useAI 改造

```ts
// useAI.ts 关键改动
const sendMessage = useCallback(async (text: string) => {
  if (useAgentStore.getState().isLoading) return
  const myGen = ++generationRef.current

  // 新一轮开始：打断上一轮的 speak / 嘴型，无论模式如何
  ttsProvider.stop()                   // 本地 TTS（cloud 模式下是 no-op，安全）
  lipSyncController.stop()             // 本地 lipsync（同上）
  const modeAtStart = useAgentStore.getState().renderMode
  if (modeAtStart === 'cloud') {
    // 关键：让 D-ID 端立刻停播旧 reply，避免新 reply 开始时旧的还在出声
    await sessionManager.interruptCurrentSpeak()
  }

  // ... 余下：setIsLoading, setMood('thinking'), addMessage ...

  try {
    const response = await aiProvider.chat(useAgentStore.getState().messages)
    // ... addMessage / setResourceCards / setMood('talking') / setIsLoading(false) 等不变 ...

    // 注意：模式可能在 AI 等待期间被切换（用户点了 toggle），按"决策时刻"的模式走
    const mode = useAgentStore.getState().renderMode

    if (mode === 'local') {
      lipSyncController.start(response.reply, useAgentStore.getState().setCurrentViseme)
      ttsProvider.speak(response.reply).then(finishTalkingLocal, finishTalkingLocal)
    } else {
      try {
        await sessionManager.ensureConnected()
        const result = await sessionManager.speak(response.reply)  // 'completed' | 'interrupted'
        if (generationRef.current !== myGen) return                // gen guard：被新一轮挤掉
        if (result === 'interrupted') return                       // 被打断不收尾、不计 idle
        sessionManager.notifyIdle()
        finishTalkingCloud()
      } catch (didErr) {
        if (generationRef.current !== myGen) return
        await handleCloudFailure(didErr, response.reply)
      }
    }
  } catch (aiErr) {
    // AI 调用本身失败：两种模式共用 catch
    if (useAgentStore.getState().renderMode === 'cloud') {
      await sessionManager.closeNow()  // cloud 模式下确保不留连接
    }
    // ...（同现有逻辑：setMood('error'), setError(...), setIsLoading(false)）
  }
}, [])
```

**两套 finishTalking：**
- `finishTalkingLocal`：现有逻辑（gen guard + lipSyncController.stop + setMood('idle')）
- `finishTalkingCloud`：gen guard + setMood('idle') + setIsPushing(false)（D-ID 流自身结束，**不调** stop 嘴——cloud 模式没在用 currentViseme）

**generation guard 继续生效**，覆盖两种模式。Cloud 模式新增 `result === 'interrupted'` 的早退分支：被新一轮 sendMessage 打断的 speak**不应走收尾**（不重置 mood / 不计 idle timer），让新一轮接管整个状态。

**interruptCurrentSpeak 与 generation guard 的关系：**
- 用户连发两条 cloud 消息：第二条 sendMessage 头部 `await interruptCurrentSpeak()`
- interrupt 触发后，第一条的 `sessionManager.speak()` 立刻 resolve 为 `'interrupted'`
- 第一条的 then-block 检查 `generationRef.current !== myGen` 为 true（gen 已被 ++），return
- 也即：interrupt 让旧 speak 干净退出、gen guard 二次防御。两层冗余、互不依赖。

---

## Section 8：D-ID 失败 → 自动回本地

**触发条件（任一）：**
- `sessionManager.ensureConnected()` 抛错
- `client.speak()` 抛错
- WebRTC 连接中途断开（`peerConnection.connectionState === 'failed'`）

**回退流程：**

```ts
async function handleCloudFailure(err: DIDError, reply: string) {
  await sessionManager.closeNow()                       // 确保 D-ID 端关掉
  const store = useAgentStore.getState()
  store.setRenderMode('local')                          // 模式翻回本地
  store.setCloudError(humanReadableError(err))          // 触发 toast 显示
  store.setCloudConn('idle')

  // 把这条没讲出来的 reply 用本地方案补上，避免用户问题没回答
  lipSyncController.start(reply, store.setCurrentViseme)
  ttsProvider.speak(reply).then(finishTalkingLocal, finishTalkingLocal)
}
```

**用户体验：**
- 提问 → AI 回复 → 云端开始建联失败 → **本地立刻补上讲这条回复** → toast: "演示模式连接失败（具体原因），已切回本地。再次点击右上角可重试。"
- toggle 视觉翻回 OFF
- 下一条提问默认走本地，除非用户主动重开

**不做的事：**
- ❌ 不自动重试。失败可能是 quota 用尽，无脑重试只会烧更多钱+刷屏失败提示
- ❌ 不在云端模式里"等更长时间再算失败"。WebRTC 建联超过 5s 就认定失败
- ❌ 不在失败时同时跑本地 lipsync 和云端 streaming 抢救（双声源混乱）

**已知小问题（接受）：** 若 D-ID 已播出部分语音后连接中途挂掉，本地补讲会**重复**这条 reply（用户先听了云端版本前半段、再听本地版本完整版）。MVP 接受这个轻微体验割裂——优先保证"用户一定听到完整答案"，比"完美无重复"更重要。后续可在 client.speak() 提供 partial-played 信号时优化。

---

## Section 9：Toggle UI（T3）

`src/components/ModeToggle/index.tsx`：

主界面右上角常驻按钮（小尺寸，类似设置图标风格）。

**配置状态预查（关键）：** ModeToggle 在 mount 时调用 `window.electronAPI.didGetConfigStatus()` 一次，把结果存到本地 state（`configured`、`disabledReason`）。**这一步必须在用户能点击之前完成**，避免"点了才发现没配 API key"的退避路径。结果决定按钮初始可点性：

- `configured === false` → 按钮**禁用**，hover 显示 tooltip `disabledReason`（如"未配置 D-ID API Key — 请在 .env 中填入 DID_API_KEY"）
- `configured === true` → 按钮可点，按下表 label/状态走

label 状态表：

| renderMode | cloudConn | 按钮显示 |
|---|---|---|
| local | * | `🎭 本地模式` |
| cloud | idle | `✨ 演示模式 · 待机` |
| cloud | connecting | `✨ 连接中...`（spinner，disabled） |
| cloud | streaming | `✨ 演示模式 · 已就绪`（"streaming"是 session 状态名，UI 显示为"已就绪"——D-ID 是否正在出声由 useAI 在 send/finish 时点本地 UI hint 即可，不污染 store） |
| cloud | error | （不可能——error 时已自动翻回 local） |

**点击行为：**

- local → cloud：**弹 confirm modal**
  ```
  ┌──────────────────────────────────────┐
  │ 切到演示模式将开始按分钟计费          │
  │                                      │
  │ 预估单价：~$0.25/分钟                │
  │ 本月已使用：12.3 分钟（≈ $3.08）    │
  │ 上次错误：(可选显示 cloudLastError)  │
  │                                      │
  │   [取消]           [确定开启]         │
  └──────────────────────────────────────┘
  ```
- cloud → local：**无 confirm**，立即 `await sessionManager.closeNow()` + `setRenderMode('local')`

**toast 显示：**
- 当 `cloudLastError !== null` 时显示一个 dismissable toast（5s 自动消失或用户点 x）
- toast 内容含错误原因 + "再次点击右上角可重试"
- dismiss 时 `setCloudError(null)`
- **连续多次失败的策略：** 新错误直接**替换**旧 toast 内容（不排队、不堆叠）；toast 显示时计时器重置为 5s

**Cost tracker：**
- `useCloudCostTracker.ts` hook：每次 `addCloudMinutes()` 写 localStorage（key 含 `YYYY-MM`），跨月自动清零
- modal 展示 `cloudMinutesThisMonth * 0.25` 美元（粗估，不是真实账单）

---

## Section 10：错误处理细则

| 错误来源 | 处理 |
|---------|------|
| `DID_AUTH` (401/403) | toast: "API Key 无效，请检查 .env 配置"；不重试；模式翻 local |
| `DID_QUOTA` (402/429) | toast: "套餐用尽或限流，请稍后再试"；不重试；模式翻 local |
| `DID_NETWORK` (fetch fail/timeout) | toast: "网络连接失败"；不重试；模式翻 local |
| `DID_API` (其他 4xx/5xx) | toast 含 HTTP status；不重试；模式翻 local |
| `DID_WEBRTC` (ICE/PeerConnection fail) | toast: "音视频连接失败"；不重试；模式翻 local |
| 启动时 `.env` 缺 `DID_API_KEY` | `didGetConfigStatus()` 返回 `{ configured: false, missingKey: true }`，ModeToggle mount 时拿到该结果就禁用按钮（详见 Section 9）——不再走任何"点了才报错"的路径 |

---

## Section 11：测试策略

WebRTC 实时流**没法**用单测覆盖端到端（happy-dom 没有 RTCPeerConnection，CI 也跑不动真 WebRTC）。策略是**在 DIDStreamClient 内部切出 adapter，把可测部分单测，把不可测部分留给手动验收**。

| 文件 | 覆盖点 | 类型 |
|------|--------|------|
| `tests/DIDStreamingService.test.ts` | 6 个调用（含 `getConfigStatus` / `stopSpeaking`）：URL/header/body 正确组装；4xx/5xx 映射到正确 `DIDErrorCode`；API key 不出现在错误对象里 | 单测（fetch mock） |
| `tests/didStreamingHandler.test.ts` | IPC handler 输入校验；错误映射；不泄漏 API key 到 renderer；`didGetConfigStatus` 在缺 KEY 时返 `{configured: false, missingKey: true}` 而非抛错 | 单测 |
| `tests/sessionManager.test.ts` | idle timer 推进；`ensureConnected` 复用未关 client；`closeNow` 累加 minutes；超时后下一次 ensure 重新建联；**`interruptCurrentSpeak` 让正在 await 的 `speak()` 立刻 resolve 为 'interrupted'**；`getCurrentStream` 在无 client 时返 null | 单测（fake timers + abort signal） |
| `tests/DIDStreamClient.test.ts` | mock `window.electronAPI.did*` + 注入假 RTCPeerConnection；验证 createStream → SDP 协商顺序；speak 支持 AbortSignal；stopSpeaking / close 调用契约；connectionState='failed' 抛 `DID_WEBRTC` | 单测（adapter mock） |
| `tests/useAI.test.ts` | 新增：`renderMode='cloud'` 时 lipSyncController 不被调用、调 `sessionManager.speak`；speak reject 触发 fallback、`renderMode` 翻回 local、本地 lipSync 补救执行；**cloud 模式下新一轮 sendMessage 调 `interruptCurrentSpeak`**；旧 speak 返 'interrupted' 不走 finishTalking；`mockLipStart` 与 `mockSessionSpeak` 互斥 | 单测（在现有测试上扩展 cloud 路径） |
| `tests/ModeToggle.test.ts` | **mount 时调 `didGetConfigStatus`，`configured: false` 时按钮禁用 + tooltip**；configured 时点击展开 modal；confirm 设 `renderMode='cloud'`；cancel 不改；cloud→local 跳过 modal；按钮 label 跟 cloudConn 切换 | 组件测（mock `window.electronAPI`） |
| `tests/useCloudCostTracker.test.ts` | 累加正确；跨月清零；localStorage 读写隔离 | 单测 |
| `tests/RouterAvatar.test.ts` | renderMode='local' 渲染 LocalAvatar；'cloud' 渲染 CloudAvatar；切换时旧组件 unmount；**CloudAvatar 唯一通过 `sessionManager.getCurrentStream()` 取流**（断言它不直接 import DIDStreamClient） | 组件测 |

**不写自动化测试的部分（手动验收）：**
- 真实 D-ID WebRTC 建联速度、画质
- 真实 D-ID API quota / 计费走势
- 切换瞬间真实的 video 元素回收 / DOM 抖动
- 跨网络环境（家庭宽带 / 4G / 公司代理）的稳定性

---

## Section 12：文件清单

### 新增

| 文件 | 行数估 | 职责 |
|------|--------|------|
| `electron/services/DIDStreamingService.ts` | ~180 | main 进程 D-ID REST 封装（含 `getConfigStatus` / `stopSpeaking`）；持有 API key |
| `electron/services/didStreamingHandler.ts` | ~100 | 6 个 IPC handler 注册；错误映射 |
| `src/services/did/DIDStreamClient.ts` | ~200 | renderer RTCPeerConnection 生命周期；speak（含 AbortSignal）/ stopSpeaking / close。**仅 SessionManager 内部 new**，不导出单例 |
| `src/services/did/sessionManager.ts` | ~120 | S2 idle-timeout；client 复用；`getCurrentStream` / `interruptCurrentSpeak` / `speak`（abort 包装） |
| `src/services/did/index.ts` | ~3 | **仅**导出 `sessionManager` 单例 |
| `src/services/did/types.ts` | ~30 | `DIDErrorCode`、`DIDStreamConfig` 等 |
| `src/components/Avatar/LocalAvatar.tsx` | ~50 | 当前 Avatar 整段搬过来 |
| `src/components/Avatar/CloudAvatar.tsx` | ~80 | `<video>` + WebRTC stream 绑定 + connecting overlay |
| `src/components/Avatar/CloudAvatar.module.css` | ~40 | video 容器 / overlay 样式 |
| `src/components/ModeToggle/index.tsx` | ~120 | toggle 按钮 + confirm modal |
| `src/components/ModeToggle/ModeToggle.module.css` | ~80 | 按钮 / modal / toast 样式 |
| `src/hooks/useCloudCostTracker.ts` | ~40 | localStorage 跨月分钟跟踪 |
| 7 个**新**测试文件 | ~100-200 each | 见 Section 11（useAI 与 agentStore 测试只是扩展，不算新增） |

### 修改

| 文件 | 改动 |
|------|------|
| `src/components/Avatar/index.tsx` | 整个文件改成 5 行 RouterAvatar；原内容已搬至 LocalAvatar |
| `src/store/agentStore.ts` | 新增 `renderMode` / `cloudConn` / `cloudMinutesThisMonth` / `cloudLastError` + 4 个 setter；`reset()` 把 `renderMode` 复位 `'local'` |
| `src/hooks/useAI.ts` | 在响应后按 renderMode 分支；新增 `handleCloudFailure`；catch 块也要 close cloud session |
| `electron/main.ts` | 注册 6 个 DID IPC handler；`before-quit` 关 session |
| `electron/preload.ts` | 在 `window.electronAPI` 对象上**追加** `didGetConfigStatus` / `didCreateStream` / `didSubmitAnswer` / `didSpeak` / `didStopSpeaking` / `didEndStream` 6 个方法（平铺，跟现有方法风格一致，**不开 `window.did` 子命名空间**） |
| `src/types/electron.d.ts` | 在现有 `electronAPI` interface 上追加 6 个方法类型 |
| `shared/types.ts` | 新增 `RenderMode` / `CloudConnectionState` / `DIDErrorCode` / `DIDError` |
| `.env.example` | 新增 `DID_API_KEY=` |
| `src/App.tsx` | 在顶层渲染 `<ModeToggle />`；toast 容器 |
| `tests/agentStore.test.ts` | 新字段断言；reset 行为 |
| `tests/useAI.test.ts` | 新增 cloud 路径 + fallback 测试 |

### 删除

**无。** 本地方案全保留。

---

## Section 13：环境变量与配置

```bash
# .env
DID_API_KEY=                              # 必填，启动时不读到则禁用 toggle
DID_AVATAR_SOURCE_URL=https://...         # 可选，D-ID 预置 avatar URL；不填用代码内默认值
DID_VOICE_ID=zh-CN-XiaoxiaoNeural         # 可选，默认普通话女声
```

main 进程启动时读取，缺失 `DID_API_KEY` → 不抛错。`didGetConfigStatus()` IPC 同步返回 `{ configured: false, missingKey: true, errorReason: '未配置 D-ID API Key — 请在 .env 中填入 DID_API_KEY' }`。ModeToggle 在 mount 时拿到该结果就**直接禁用按钮**（详见 Section 9）——renderer 永远不会真的去调 `didCreateStream`，也就不会撞到 `DID_AUTH` 错误路径。

**严禁：** 任何 D-ID 配置出现在 `src/`、`shared/` 的代码里——它们打包进 renderer 就暴露给浏览器 devtools 了。

---

## Section 14：分支与验收

**分支：** 从 `main` 新建 `feature/did-streaming-demo-mode`，worktree 置于 `.worktrees/feature-did-streaming-demo-mode/`。

**前置条件（动代码前必须备齐）：**
1. ✅ D-ID 付费账号开通（Pro 档以上，含 Streaming Avatars 权限）
2. ✅ API key 拿到、信用卡绑好
3. ✅ 用 curl/Postman 手动验过至少 1 次 createStream API 通（确认 API 文档与实现假设一致）

**自动验收：**
- 全量 `npx vitest run` 通过
- `npx tsc --noEmit` 无错
- `npm run build` 三套产物通过

**手动验收（不可由测试替代）：**
1. `.env` 不填 `DID_API_KEY` → toggle 按钮禁用，hover 显示 tooltip
2. 填上 key → toggle 可点；点 OFF→ON 弹 modal，显示本月用量
3. confirm → toggle 立即显示 "演示模式 · 待机"（cloudConn = idle，**此时还没建联**——与 Section 1 状态机一致）
4. 第一次发问题 → toggle 切到 "连接中..." → 1-2s 后切到 "演示模式 · 已就绪"（cloudConn: idle → connecting → streaming）→ 看到真人级头像讲话、口型与中文对得上
5. 30s 不发问题 → toggle 自动回到 "演示模式 · 待机"（cloudConn 回 idle，session 已关）
6. 再发问题 → 自动重建联 → 又是 "已就绪" + 真人讲话
7. **拔网线 / mock API 返 500** → 看到 toast 提示 + toggle 翻回 OFF + 本地补讲这条 reply
8. 切回 local → 立即 CloudAvatar 卸载、LocalAvatar 挂载、嘴回 closed
9. 关闭 app → D-ID dashboard 上看不到悬挂 session

---

## 已知风险与待办

| 风险 | 缓解 |
|------|------|
| D-ID API 字段名/endpoint 与本设计假设不符 | Section 14 前置条件 3：动代码前必须 curl 验过；spec 实施阶段第一个 task 就是文档校验 |
| 中文 voice 口型对齐可能不如英文好 | 验收第 4 条手动验证；若不达标考虑 voice_id 切换或 fallback 提示 |
| WebRTC 在用户网络环境下不稳定 | 自动回本地兜底；失败 toast 让用户感知 |
| Streaming session 异常未关导致计费泄漏 | `closeNow()` 容错 + `before-quit` 兜底 + D-ID 自身有 session timeout |
| 月度费用失控 | `useCloudCostTracker` UI 提醒；不做硬上限（用户自管） |

**实施前需补充：**
- D-ID 官方文档校对（endpoint URL、字段名、错误码）
- 预置 Avatar URL 确认（D-ID 提供的免费形象 URL 是否长期稳定）
- voice_id 是否在所选档位可用
