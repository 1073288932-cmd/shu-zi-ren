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
| **main** | `electron/services/DIDStreamingService.ts` | 持有 API key；封装 5 个 REST 调用（createStream / submitAnswer / speak / endStream），返回响应 |
| **main** | `electron/services/didStreamingHandler.ts` | 注册 4 个 IPC handler；输入校验；错误映射 |
| **preload** | `electron/preload.ts` | 用 contextBridge 暴露 `window.did.{createStream, submitAnswer, speak, endStream}` |
| **renderer** | `src/services/did/DIDStreamClient.ts` | 管理 `RTCPeerConnection` 生命周期；调 `window.did.*`；暴露 `MediaStream`、`speak()`、`close()` 给 UI |
| **renderer** | `src/services/did/sessionManager.ts` | 实现 S2 idle-timeout 策略（30s 无 speak 自动 close）；暴露 `ensureConnected()` / `notifyIdle()` |

**IPC channel 命名：**
- `did:create-stream` → `{id, offer, iceServers, sessionId}`
- `did:submit-answer` → `void`
- `did:speak` → `void`（或 throw on 4xx/5xx）
- `did:end-stream` → `void`

每个 IPC handler 内部错误一律映射为统一的 `DIDError`：

```ts
type DIDErrorCode =
  | 'DID_AUTH'          // 401/403 — API key 失效
  | 'DID_QUOTA'         // 402/429 — 套餐用尽 / 限流
  | 'DID_NETWORK'       // fetch 抛错 / timeout
  | 'DID_API'           // 4xx/5xx 其他
  | 'DID_WEBRTC'        // PeerConnection 失败（renderer 侧）
```

---

## Section 3：Session 生命周期（S2 空闲超时）

`sessionManager.ts` 是状态机，包住 `DIDStreamClient`：

```ts
const IDLE_TIMEOUT_MS = 30_000

class SessionManager {
  private client: DIDStreamClient | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  // 由 useAI 在 cloud 模式下、要发 speak 前调
  async ensureConnected(): Promise<DIDStreamClient> {
    this.clearIdleTimer()
    if (this.client && this.client.isOpen()) return this.client
    this.client = new DIDStreamClient()
    await this.client.open()  // 走 createStream → SDP 协商 → ICE done
    return this.client
  }

  // 由 useAI 在每条回复 speak resolve 后调
  notifyIdle(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => this.closeNow(), IDLE_TIMEOUT_MS)
  }

  // 由 useAI 在切回 local 时、或 D-ID 报错时调
  async closeNow(): Promise<void> {
    this.clearIdleTimer()
    if (this.client) {
      const minutes = this.client.uptimeMinutes()
      useAgentStore.getState().addCloudMinutes(minutes)
      await this.client.close().catch(() => {})  // close 失败不再抛
      this.client = null
    }
  }

  private clearIdleTimer(): void { ... }
}
```

**Idle 计时起点：** 上一次 `speak()` 的 promise resolve 之时。
**Idle 计时清除：** 新一次 `ensureConnected()` / `closeNow()`。
**应用退出时：** Avatar 父组件 unmount 触发 `closeNow()`（防御性）；electron `before-quit` 事件再兜底一次。

---

## Section 4：CloudAvatar 子组件

`src/components/Avatar/CloudAvatar.tsx`：

```tsx
export function CloudAvatar() {
  const cloudConn = useAgentStore(s => s.cloudConn)
  const mood = useAgentStore(s => s.mood)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const stream = didStreamClient.getMediaStream()
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
      videoRef.current.play().catch(() => {})
    }
  }, [cloudConn])  // 流 ready 时切到 streaming，触发 srcObject 绑定

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
- CloudAvatar 不主动建联——`didStreamClient` 的连接由 useAI/SessionManager 驱动
- CloudAvatar 只**订阅** `cloudConn` 来切 UI 覆盖层（connecting spinner、error 提示）
- `srcObject` 绑定时机：cloudConn 进入 'streaming' 之后

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
try {
  const response = await aiProvider.chat(messages)
  // ... addMessage, setMood('talking') 等不变 ...

  const mode = useAgentStore.getState().renderMode

  if (mode === 'local') {
    // 走现有逻辑（一字不改）
    lipSyncController.start(response.reply, setCurrentViseme)
    ttsProvider.speak(response.reply).then(finishTalkingLocal, finishTalkingLocal)
  } else {
    // cloud 模式：交给 D-ID
    try {
      const client = await sessionManager.ensureConnected()
      await client.speak(response.reply)  // 这个 promise 在 D-ID 视频播完时 resolve
      sessionManager.notifyIdle()
      finishTalkingCloud()
    } catch (didErr) {
      // 自动回本地（spec Section 8 详述）
      await handleCloudFailure(didErr, response.reply)
    }
  }
} catch (aiErr) {
  // AI 调用本身失败：两种模式共用 catch
  // ...（同现有逻辑：setMood('error'), setError(...)）
  // cloud 模式还要 await sessionManager.closeNow() 确保不留连接
}
```

**两套 finishTalking：**
- `finishTalkingLocal`：现有逻辑（lipSyncController.stop + setMood('idle')）
- `finishTalkingCloud`：setMood('idle') + setIsPushing(false)（D-ID 流自身结束，不需要 stop 嘴）

**generation guard 继续生效**，覆盖两种模式（防过期 speak 回调污染新一轮状态）。

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

主界面右上角常驻按钮（小尺寸，类似设置图标风格），label：

| renderMode | cloudConn | 按钮显示 |
|---|---|---|
| local | * | `🎭 本地模式` |
| cloud | idle | `✨ 演示模式 · 待机` |
| cloud | connecting | `✨ 连接中...`（spinner，disabled） |
| cloud | streaming | `✨ 演示模式 · 播放中` |
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
| 启动时 `.env` 缺 `DID_API_KEY` | toggle 按钮**禁用**并显示 tooltip "未配置 D-ID API Key" |

---

## Section 11：测试策略

WebRTC 实时流**没法**用单测覆盖端到端（happy-dom 没有 RTCPeerConnection，CI 也跑不动真 WebRTC）。策略是**在 DIDStreamClient 内部切出 adapter，把可测部分单测，把不可测部分留给手动验收**。

| 文件 | 覆盖点 | 类型 |
|------|--------|------|
| `tests/DIDStreamingService.test.ts` | 5 个 REST 调用：URL/header/body 正确组装；4xx/5xx 映射到正确 `DIDErrorCode`；API key 不出现在错误对象里 | 单测（fetch mock） |
| `tests/didStreamingHandler.test.ts` | IPC handler 输入校验；错误映射；不泄漏 API key 到 renderer | 单测 |
| `tests/sessionManager.test.ts` | idle timer 推进；`ensureConnected` 复用未关 client；`closeNow` 累加 minutes；超时后下一次 ensure 重新建联 | 单测（fake timers） |
| `tests/DIDStreamClient.test.ts` | mock `window.did.*` + 注入假 RTCPeerConnection；验证 createStream → SDP 协商顺序；speak / close 调用契约；connectionState='failed' 抛 `DID_WEBRTC` | 单测（adapter mock） |
| `tests/useAI.test.ts` | 新增：`renderMode='cloud'` 时 lipSyncController 不被调用、调 didStreamClient.speak；speak reject 触发 fallback、`renderMode` 翻回 local、本地 lipSync 补救执行；`mockLipStart` 与 `mockDidSpeak` 互斥 | 单测（在现有测试上扩展 cloud 路径） |
| `tests/ModeToggle.test.ts` | 点击展开 modal；confirm 设 `renderMode='cloud'`；cancel 不改；cloud→local 跳过 modal；按钮 label 跟 cloudConn 切换 | 组件测 |
| `tests/useCloudCostTracker.test.ts` | 累加正确；跨月清零；localStorage 读写隔离 | 单测 |
| `tests/RouterAvatar.test.ts` | renderMode='local' 渲染 LocalAvatar；'cloud' 渲染 CloudAvatar；切换时旧组件 unmount | 组件测 |

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
| `electron/services/DIDStreamingService.ts` | ~150 | main 进程 D-ID REST 封装；持有 API key |
| `electron/services/didStreamingHandler.ts` | ~80 | IPC handler 注册；错误映射 |
| `src/services/did/DIDStreamClient.ts` | ~180 | renderer RTCPeerConnection 生命周期；speak / close |
| `src/services/did/sessionManager.ts` | ~80 | S2 idle-timeout；client 复用 |
| `src/services/did/index.ts` | ~5 | 单例导出 |
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
| `electron/main.ts` | 注册 4 个 DID IPC handler；`before-quit` 关 session |
| `electron/preload.ts` | 暴露 `window.did.{...}` |
| `src/types/electron.d.ts` | DID IPC 方法类型声明 |
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

main 进程启动时读取，缺失 `DID_API_KEY` → 不抛错，但 IPC `did:create-stream` 调用时返回 `DID_AUTH` 错误（让 toggle 自然禁用）。

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
3. confirm → toggle 进入 connecting → 1-2s 后切到 streaming
4. 发问题 → 看到真人级头像讲话、口型与中文对得上
5. 30s 不发问题 → toggle 自动回到 "演示模式 · 待机"（session 已关）
6. 再发问题 → 自动重建联 → 又是 streaming
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
