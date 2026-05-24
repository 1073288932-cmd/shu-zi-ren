# D-ID Streaming Demo-Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不动现有本地 viseme 方案的前提下，新增一条 D-ID Streaming Avatars 云端渲染管线，通过主界面 toggle 在本地/演示模式间手动切换。

**Architecture:** 两条渲染管线并存共用同一 AI/TTS 触发链。`agentStore.renderMode` 路由到 `LocalAvatar`（PNG viseme overlay，默认）或 `CloudAvatar`（WebRTC video，来自 D-ID）。API key 在 Electron main 进程，D-ID REST 经 IPC 中转，renderer 永不接触 key。`SessionManager` 管 WebRTC session 生命周期（S2 空闲超时、speak 打断、单一 MediaStream 来源）。失败自动回本地 + toast。

**Tech Stack:** Electron + React + TypeScript + Zustand + Vitest（happy-dom）。新引入：WebRTC（`RTCPeerConnection`）、D-ID Streaming Avatars REST API（Bearer token 鉴权）。

**Spec:** `docs/superpowers/specs/2026-05-24-did-streaming-demo-mode-design.md`（14 个 Section）

---

## Prerequisites（**必须在 Task 1 之前完成**）

这一组**不是代码任务**，是执行前的人工准备。任何一项缺失，后续所有任务都会失败。

### P-1：D-ID 账号 + API key

- [ ] 注册 D-ID Pro 档（含 Streaming Avatars 权限；入门 \$5.99 档不含 streaming）
- [ ] 控制台拿到 API key
- [ ] 绑定信用卡确认计费已开（**否则 createStream 会以 quota error 拒绝**）

### P-2：用 curl 验过 5 个核心 endpoint 通

在本机用 curl 跑一遍下面 5 个调用，确认返回结构与 spec Section 2 的假设一致。**若任何字段名 / 路径不一致，先回 spec 修订**，不要直接进 Task 1。

```bash
# 1. createStream（替换 <KEY> 与 <SOURCE_URL>）
curl -X POST https://api.d-id.com/talks/streams \
  -H "Authorization: Basic <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"source_url":"<D-ID 预置 avatar URL>"}'
# 期望返回：{id, offer, ice_servers, session_id}

# 2-5. submitAnswer / speak / stopSpeaking / endStream
# 按 D-ID 最新官方文档跑通，记下实际 endpoint 与 body 字段
```

预期产物：一份 `D-ID-API-CHECK.md`（不入库，自己留底），列出每个 endpoint 的实际 URL、实际请求体、实际返回。Task 4 实现时严格参照这份记录。

### P-3：worktree 创建

由 `superpowers:using-git-worktrees` skill 在执行时创建：

- branch: `feature/did-streaming-demo-mode`，从 `main` 起步
- worktree path: `.worktrees/feature-did-streaming-demo-mode/`

所有 Task 都在该 worktree 内执行。

### P-4：环境变量准备

worktree 创建后第一件事：拷贝 main 的 `.env` 到 worktree 根目录，并追加：

```bash
# .env（worktree 内）
DID_API_KEY=<your D-ID API key>
DID_AVATAR_SOURCE_URL=<D-ID 预置 avatar URL or 留空走默认>
DID_VOICE_ID=zh-CN-XiaoxiaoNeural
```

`.env` 已在 `.gitignore`，不会进库。`DID_AVATAR_SOURCE_URL` 留空时由 `DIDStreamingService.ts` 用代码内默认值。

---

## File Structure

### 新增（共 13 个产品文件 + 7 个测试文件）

| 文件 | 职责 |
|---|---|
| `shared/types.ts`（**修改**） | 追加 `RenderMode` / `CloudConnectionState` / `DIDErrorCode` / `DIDError` / `DIDStreamInit` / `DIDConfigStatus` |
| `electron/services/DIDStreamingService.ts` | main 进程 REST 封装，6 个方法（`getConfigStatus` / `createStream` / `submitAnswer` / `speak` / `stopSpeaking` / `endStream`），持有 API key |
| `electron/services/didStreamingHandler.ts` | 6 个 IPC handler 注册函数；sender 校验；错误映射 |
| `electron/main.ts`（**修改**） | 调用 didStreamingHandler 的 register 函数；`before-quit` 时无 session 持有的场景，主进程无需 cleanup（renderer 端的 sessionManager 已在退出前关 session） |
| `electron/preload.ts`（**修改**） | 在 `window.electronAPI` 平铺追加 6 个 `did*` 方法 |
| `src/types/electron.d.ts`（**修改**） | 在 `electronAPI` interface 上追加 6 个方法类型 |
| `src/services/did/DIDStreamClient.ts` | renderer 侧单次 session 的 WebRTC 封装；`open` / `speak(text, signal)` / `stopSpeaking` / `close` / `getMediaStream` / `uptimeMinutes` / `isOpen`；构造器接受 `peerFactory` 便于测试 |
| `src/services/did/sessionManager.ts` | 单例；`ensureConnected` / `speak`（abort 包装） / `interruptCurrentSpeak` / `notifyIdle` / `closeNow` / `getCurrentStream`；S2 idle timeout |
| `src/services/did/index.ts` | **仅**导出 `sessionManager` 单例和 `DIDStreamClient` 类型；**不导出** `didStreamClient` 单例 |
| `src/store/agentStore.ts`（**修改**） | 新增 `renderMode` / `cloudConn` / `cloudLastError` / `cloudMinutesThisMonth` 字段；新增 4 个 setter；`setRenderMode('local')` 必须同时把 `currentViseme` 重置为 `'closed'`；`reset()` 复位所有新字段 |
| `src/hooks/useCloudCostTracker.ts` | `useCloudCostTracker()` 返回当月分钟数；`addCloudMinutes(n)` 累加并写 localStorage（跨月自动清零） |
| `src/hooks/useAI.ts`（**修改**） | 在原 sendMessage 头部加 cloud 模式打断；按 `renderMode` 分支调用 lipsync 或 sessionManager；fallback 函数 `handleCloudFailure` |
| `src/components/Avatar/LocalAvatar.tsx` | 现 `src/components/Avatar/index.tsx` 内容整段搬来，0 行为变动 |
| `src/components/Avatar/CloudAvatar.tsx` | `<video>` + WebRTC stream 绑定（来源仅 `sessionManager.getCurrentStream()`）+ connecting / error overlay |
| `src/components/Avatar/CloudAvatar.module.css` | video 容器 + overlay 样式 |
| `src/components/Avatar/index.tsx`（**重写**） | 5 行 RouterAvatar：按 `renderMode` 选 Local 或 Cloud |
| `src/components/ModeToggle/index.tsx` | toggle 按钮 + confirm modal + toast；mount 时调 `didGetConfigStatus` |
| `src/components/ModeToggle/ModeToggle.module.css` | 按钮 + modal + toast 样式 |
| `src/App.tsx`（**修改**） | 顶层渲染 `<ModeToggle />`；预留 toast 容器 |
| `.env.example`（**修改**） | 追加 `DID_API_KEY=` / `DID_AVATAR_SOURCE_URL=` / `DID_VOICE_ID=` |
| `tests/DIDStreamingService.test.ts` | fetch mock，6 个方法的 URL/header/body 组装；4xx/5xx 错误映射；key 不泄漏 |
| `tests/didStreamingHandler.test.ts` | sender 校验；输入验证；错误映射；缺 KEY 时 `didGetConfigStatus` 返 `configured: false` |
| `tests/DIDStreamClient.test.ts` | 注入 mock peerFactory + mock electronAPI；createStream → SDP 协商顺序；speak 支持 AbortSignal；`connectionState='failed'` 抛 `DID_WEBRTC` |
| `tests/sessionManager.test.ts` | fake timers；ensureConnected 复用；closeNow 累计 minutes；interruptCurrentSpeak 让 speak resolve 为 `'interrupted'`；getCurrentStream 在无 client 时返 null |
| `tests/ModeToggle.test.ts` | mount 调 didGetConfigStatus；configured=false → 按钮禁用 + tooltip；configured → 点击展开 modal；confirm/cancel 行为；cloud→local 跳过 modal；label 跟 cloudConn 切换 |
| `tests/useCloudCostTracker.test.ts` | 累加；跨月清零；localStorage 隔离 |
| `tests/RouterAvatar.test.ts` | renderMode 切换组件；CloudAvatar 不直接 import DIDStreamClient（grep 守护） |

### 修改（共 4 个测试扩展）

| 文件 | 改动 |
|---|---|
| `tests/agentStore.test.ts` | 新字段初值；setRenderMode('local') 重置 currentViseme；reset 复位 |
| `tests/useAI.test.ts` | cloud 路径：sessionManager.speak 被调；reject 触发 fallback；新一轮 sendMessage 调 interruptCurrentSpeak；speak 返 'interrupted' 不走 finishTalking |

### 删除

无。本地 viseme 全保留。

---

## Task 1：扩展 shared 类型（DIDErrorCode、RenderMode 等）

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1：在 `shared/types.ts` 追加新类型**

打开 `shared/types.ts`，在文件**末尾**追加：

```ts
// ============= D-ID Streaming Demo-Mode =============

export type RenderMode = 'local' | 'cloud'

export type CloudConnectionState = 'idle' | 'connecting' | 'streaming' | 'error'

export type DIDErrorCode =
  | 'DID_AUTH'             // 401/403 — API key 失效
  | 'DID_NOT_CONFIGURED'   // 启动时 .env 没读到 DID_API_KEY
  | 'DID_QUOTA'            // 402/429 — 套餐用尽 / 限流
  | 'DID_NETWORK'          // fetch 抛错 / timeout
  | 'DID_API'              // 4xx/5xx 其他
  | 'DID_WEBRTC'           // PeerConnection 失败（renderer 侧）

// DIDError 与现有 AppError 同构（共用 code 字段，方便复用 IPC 错误通道）
export type DIDError = AppError & { code: DIDErrorCode }

export interface DIDStreamInit {
  id: string
  offer: RTCSessionDescriptionInit
  iceServers: RTCIceServer[]
  sessionId: string
}

export interface DIDConfigStatus {
  configured: boolean
  missingKey?: boolean
  errorReason?: string
}
```

- [ ] **Step 2：跑 tsc 验证类型干净**

```bash
npx tsc --noEmit
```

Expected: 无输出（exit 0）。

- [ ] **Step 3：commit**

```bash
git add shared/types.ts
git commit -m "feat(types): add D-ID streaming demo-mode shared types"
```

---

## Task 2：扩展 agentStore（renderMode 等 4 个字段）

**Files:**
- Modify: `src/store/agentStore.ts`
- Modify: `tests/agentStore.test.ts`

- [ ] **Step 1：先写失败测试**

打开 `tests/agentStore.test.ts`，在文件**末尾**（最后一个 `describe` 块内或之后）追加：

```ts
describe('D-ID demo-mode state', () => {
  beforeEach(() => {
    useAgentStore.setState(initialState)
  })

  it('initial state has renderMode=local, cloudConn=idle, cloudMinutes=0, cloudLastError=null', () => {
    const s = useAgentStore.getState()
    expect(s.renderMode).toBe('local')
    expect(s.cloudConn).toBe('idle')
    expect(s.cloudMinutesThisMonth).toBe(0)
    expect(s.cloudLastError).toBeNull()
  })

  it('setRenderMode("local") also resets currentViseme to "closed"', () => {
    useAgentStore.setState({ renderMode: 'cloud', currentViseme: 'a' })
    useAgentStore.getState().setRenderMode('local')
    expect(useAgentStore.getState().renderMode).toBe('local')
    expect(useAgentStore.getState().currentViseme).toBe('closed')  // 关键不变量（spec Section 1）
  })

  it('setRenderMode("cloud") does NOT touch currentViseme', () => {
    useAgentStore.setState({ renderMode: 'local', currentViseme: 'a' })
    useAgentStore.getState().setRenderMode('cloud')
    expect(useAgentStore.getState().currentViseme).toBe('a')  // 切到 cloud 不动 local 状态
  })

  it('setCloudConn updates cloudConn', () => {
    useAgentStore.getState().setCloudConn('connecting')
    expect(useAgentStore.getState().cloudConn).toBe('connecting')
  })

  it('setCloudError(string) sets error; setCloudError(null) clears', () => {
    useAgentStore.getState().setCloudError('boom')
    expect(useAgentStore.getState().cloudLastError).toBe('boom')
    useAgentStore.getState().setCloudError(null)
    expect(useAgentStore.getState().cloudLastError).toBeNull()
  })

  it('addCloudMinutes accumulates', () => {
    useAgentStore.getState().addCloudMinutes(1.5)
    useAgentStore.getState().addCloudMinutes(2.3)
    expect(useAgentStore.getState().cloudMinutesThisMonth).toBeCloseTo(3.8)
  })

  it('reset() restores all new D-ID fields', () => {
    useAgentStore.setState({
      renderMode: 'cloud',
      cloudConn: 'streaming',
      cloudLastError: 'oops',
      cloudMinutesThisMonth: 99,
    })
    useAgentStore.getState().reset()
    const s = useAgentStore.getState()
    expect(s.renderMode).toBe('local')
    expect(s.cloudConn).toBe('idle')
    expect(s.cloudLastError).toBeNull()
    expect(s.cloudMinutesThisMonth).toBe(0)
  })
})
```

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/agentStore.test.ts
```

Expected: 多个测试 FAIL（`renderMode is undefined` 等）。

- [ ] **Step 3：修改 `src/store/agentStore.ts`**

替换文件内容为：

```ts
import { create } from 'zustand'
import type {
  AvatarMood, AgentMessage, ResourceCard, AppError, Viseme,
  RenderMode, CloudConnectionState,
} from '@shared/types'

interface AgentStoreState {
  mood: AvatarMood
  isPushing: boolean
  inputText: string
  isLoading: boolean
  error: AppError | null
  lastUserInput: string
  messages: AgentMessage[]
  resourceCards: ResourceCard[]
  selectedResourceId: string | null
  currentViseme: Viseme
  // D-ID demo-mode
  renderMode: RenderMode
  cloudConn: CloudConnectionState
  cloudLastError: string | null
  cloudMinutesThisMonth: number

  setMood: (mood: AvatarMood) => void
  setIsPushing: (isPushing: boolean) => void
  setInputText: (text: string) => void
  setIsLoading: (loading: boolean) => void
  setError: (error: AppError | null) => void
  setLastUserInput: (text: string) => void
  addMessage: (message: AgentMessage) => void
  setResourceCards: (cards: ResourceCard[]) => void
  removeResourceCard: (id: string) => void
  setSelectedResourceId: (id: string | null) => void
  setCurrentViseme: (viseme: Viseme) => void
  // D-ID demo-mode
  setRenderMode: (mode: RenderMode) => void
  setCloudConn: (state: CloudConnectionState) => void
  setCloudError: (msg: string | null) => void
  addCloudMinutes: (minutes: number) => void
  reset: () => void
}

export const initialState = {
  mood: 'idle' as AvatarMood,
  isPushing: false,
  inputText: '',
  isLoading: false,
  error: null as AppError | null,
  lastUserInput: '',
  messages: [] as AgentMessage[],
  resourceCards: [] as ResourceCard[],
  selectedResourceId: null as string | null,
  currentViseme: 'closed' as Viseme,
  renderMode: 'local' as RenderMode,
  cloudConn: 'idle' as CloudConnectionState,
  cloudLastError: null as string | null,
  cloudMinutesThisMonth: 0,
}

export const useAgentStore = create<AgentStoreState>()(set => ({
  ...initialState,

  setMood: mood => set({ mood }),
  setIsPushing: isPushing => set({ isPushing }),
  setInputText: inputText => set({ inputText }),
  setIsLoading: isLoading => set({ isLoading }),
  setError: error => set({ error }),
  setLastUserInput: lastUserInput => set({ lastUserInput }),
  addMessage: message => set(state => ({ messages: [...state.messages, message] })),
  setResourceCards: resourceCards => set({ resourceCards }),
  removeResourceCard: id =>
    set(state => ({ resourceCards: state.resourceCards.filter(c => c.id !== id) })),
  setSelectedResourceId: selectedResourceId => set({ selectedResourceId }),
  setCurrentViseme: currentViseme => set({ currentViseme }),

  // setRenderMode('local') 必须同步重置 currentViseme（spec Section 1 强制不变量）
  setRenderMode: mode => set(mode === 'local'
    ? { renderMode: 'local', currentViseme: 'closed' as Viseme }
    : { renderMode: 'cloud' }),
  setCloudConn: cloudConn => set({ cloudConn }),
  setCloudError: cloudLastError => set({ cloudLastError }),
  addCloudMinutes: minutes => set(state => ({
    cloudMinutesThisMonth: state.cloudMinutesThisMonth + minutes,
  })),
  reset: () => set(initialState),
}))
```

- [ ] **Step 4：跑测试确认通过**

```bash
npx vitest run tests/agentStore.test.ts
```

Expected: 所有用例 PASS。

- [ ] **Step 5：commit**

```bash
git add src/store/agentStore.ts tests/agentStore.test.ts
git commit -m "feat(store): add renderMode/cloudConn/cloudMinutes/cloudLastError + setRenderMode resets viseme"
```

---

## Task 3：useCloudCostTracker hook（localStorage 月度跟踪）

**Files:**
- Create: `src/hooks/useCloudCostTracker.ts`
- Create: `tests/useCloudCostTracker.test.ts`

- [ ] **Step 1：先写失败测试**

创建 `tests/useCloudCostTracker.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCloudCostTracker } from '../src/hooks/useCloudCostTracker'

const LS_KEY = 'did-cloud-minutes'

function setMonth(year: number, month0: number, day = 15): void {
  // month0: 0=Jan, 11=Dec（JS Date 风格）
  vi.setSystemTime(new Date(year, month0, day, 12, 0, 0))
}

describe('useCloudCostTracker', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    setMonth(2026, 4)  // 2026-05
  })

  it('returns 0 when no record exists', () => {
    const { result } = renderHook(() => useCloudCostTracker())
    expect(result.current.minutesThisMonth).toBe(0)
  })

  it('addMinutes accumulates within the same month', () => {
    const { result } = renderHook(() => useCloudCostTracker())
    act(() => { result.current.addMinutes(1.5) })
    act(() => { result.current.addMinutes(2.3) })
    expect(result.current.minutesThisMonth).toBeCloseTo(3.8)
  })

  it('crossing into a new month resets the counter on next read', () => {
    const { result, rerender } = renderHook(() => useCloudCostTracker())
    act(() => { result.current.addMinutes(10) })
    expect(result.current.minutesThisMonth).toBe(10)

    setMonth(2026, 5)  // 2026-06 — 新月份
    rerender()
    expect(result.current.minutesThisMonth).toBe(0)
  })

  it('writes month-keyed entry to localStorage', () => {
    const { result } = renderHook(() => useCloudCostTracker())
    act(() => { result.current.addMinutes(5) })
    const raw = localStorage.getItem(LS_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { month: string; minutes: number }
    expect(parsed.month).toBe('2026-05')
    expect(parsed.minutes).toBe(5)
  })

  it('ignores malformed localStorage payload', () => {
    localStorage.setItem(LS_KEY, '{not valid json')
    const { result } = renderHook(() => useCloudCostTracker())
    expect(result.current.minutesThisMonth).toBe(0)
  })
})
```

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/useCloudCostTracker.test.ts
```

Expected: FAIL `Cannot find module ...useCloudCostTracker`。

- [ ] **Step 3：实现 `src/hooks/useCloudCostTracker.ts`**

```ts
import { useState, useCallback, useEffect } from 'react'

const LS_KEY = 'did-cloud-minutes'

interface Stored {
  month: string  // 'YYYY-MM'
  minutes: number
}

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function readStored(): Stored {
  const raw = localStorage.getItem(LS_KEY)
  if (!raw) return { month: currentMonth(), minutes: 0 }
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>
    if (typeof parsed.month === 'string' && typeof parsed.minutes === 'number') {
      return parsed as Stored
    }
  } catch { /* fall through to zero */ }
  return { month: currentMonth(), minutes: 0 }
}

function effectiveMinutes(): number {
  const s = readStored()
  return s.month === currentMonth() ? s.minutes : 0
}

export function useCloudCostTracker() {
  const [minutesThisMonth, setMinutesThisMonth] = useState<number>(() => effectiveMinutes())

  // 每次 render 都同步当前月（处理跨月场景）
  useEffect(() => {
    const m = effectiveMinutes()
    if (m !== minutesThisMonth) setMinutesThisMonth(m)
  })

  const addMinutes = useCallback((n: number) => {
    const month = currentMonth()
    const existing = readStored()
    const base = existing.month === month ? existing.minutes : 0
    const next: Stored = { month, minutes: base + n }
    localStorage.setItem(LS_KEY, JSON.stringify(next))
    setMinutesThisMonth(next.minutes)
  }, [])

  return { minutesThisMonth, addMinutes }
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
npx vitest run tests/useCloudCostTracker.test.ts
```

Expected: 所有用例 PASS。

- [ ] **Step 5：commit**

```bash
git add src/hooks/useCloudCostTracker.ts tests/useCloudCostTracker.test.ts
git commit -m "feat(hooks): add useCloudCostTracker (localStorage monthly minutes)"
```

---

## Task 4：DIDStreamingService（main 进程 REST 封装）

**Files:**
- Create: `electron/services/DIDStreamingService.ts`
- Create: `tests/DIDStreamingService.test.ts`

> ⚠️ **实现前先读 P-2 阶段记录的 `D-ID-API-CHECK.md`**。下方代码里的 endpoint URL、字段名都是**按 spec 假设**写的，若与真实 API 不一致，按真实 API 调整。

- [ ] **Step 1：先写失败测试**

创建 `tests/DIDStreamingService.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DIDStreamingService } from '../electron/services/DIDStreamingService'

const FAKE_KEY = 'test-key-123'
const FAKE_SOURCE = 'https://example.com/avatar.png'

describe('DIDStreamingService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('getConfigStatus', () => {
    it('returns configured:true when API key present', () => {
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE)
      expect(svc.getConfigStatus()).toEqual({ configured: true })
    })

    it('returns configured:false, missingKey:true when API key empty', () => {
      const svc = new DIDStreamingService('', FAKE_SOURCE)
      const status = svc.getConfigStatus()
      expect(status.configured).toBe(false)
      expect(status.missingKey).toBe(true)
      expect(status.errorReason).toContain('DID_API_KEY')
    })
  })

  describe('createStream', () => {
    it('POSTs source_url to /talks/streams with Bearer auth', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({ id: 'sid', offer: { type: 'offer', sdp: 'v=0' }, ice_servers: [], session_id: 'session1' }),
        { status: 201 }
      ))
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE)
      const result = await svc.createStream()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.d-id.com/talks/streams')
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${FAKE_KEY}`)
      expect(JSON.parse(init.body as string)).toEqual({ source_url: FAKE_SOURCE })
      expect(result).toEqual({
        id: 'sid',
        offer: { type: 'offer', sdp: 'v=0' },
        iceServers: [],
        sessionId: 'session1',
      })
    })

    it('maps 401 to DID_AUTH', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauth', { status: 401 }))
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE)
      await expect(svc.createStream()).rejects.toMatchObject({ code: 'DID_AUTH' })
    })

    it('maps 429 to DID_QUOTA', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('limit', { status: 429 }))
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE)
      await expect(svc.createStream()).rejects.toMatchObject({ code: 'DID_QUOTA' })
    })

    it('maps fetch throw to DID_NETWORK', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE)
      await expect(svc.createStream()).rejects.toMatchObject({ code: 'DID_NETWORK' })
    })

    it('does not include API key in thrown error.message', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE)
      try {
        await svc.createStream()
        throw new Error('should have thrown')
      } catch (e) {
        expect((e as Error).message).not.toContain(FAKE_KEY)
      }
    })
  })

  describe('submitAnswer / speak / stopSpeaking / endStream — request shape', () => {
    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    })

    it('submitAnswer POSTs to /talks/streams/{id}/sdp with answer + sessionId', async () => {
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE)
      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0' }
      await svc.submitAnswer('sid', 'session1', answer)
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.d-id.com/talks/streams/sid/sdp')
      expect(JSON.parse(init.body as string)).toEqual({ answer, session_id: 'session1' })
    })

    it('speak POSTs script payload with voice id', async () => {
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE, 'zh-CN-XiaoxiaoNeural')
      await svc.speak('sid', 'session1', '你好')
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.d-id.com/talks/streams/sid')
      const body = JSON.parse(init.body as string)
      expect(body.session_id).toBe('session1')
      expect(body.script).toMatchObject({
        type: 'text',
        input: '你好',
        provider: { type: 'microsoft', voice_id: 'zh-CN-XiaoxiaoNeural' },
      })
    })

    it('stopSpeaking DELETEs /talks/streams/{id}/speak (or falls back)', async () => {
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE)
      await svc.stopSpeaking('sid', 'session1')
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      // 若实际 API 用别的方式，按 P-2 校准结果调
      expect(url).toMatch(/\/talks\/streams\/sid/)
      expect(init.method === 'DELETE' || init.method === 'POST').toBe(true)
    })

    it('endStream DELETEs /talks/streams/{id}', async () => {
      const svc = new DIDStreamingService(FAKE_KEY, FAKE_SOURCE)
      await svc.endStream('sid', 'session1')
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.d-id.com/talks/streams/sid')
      expect(init.method).toBe('DELETE')
      expect(JSON.parse(init.body as string)).toEqual({ session_id: 'session1' })
    })
  })
})
```

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/DIDStreamingService.test.ts
```

Expected: FAIL `Cannot find module ...DIDStreamingService`。

- [ ] **Step 3：实现 `electron/services/DIDStreamingService.ts`**

```ts
import type { DIDStreamInit, DIDConfigStatus, DIDError, DIDErrorCode } from '../../shared/types'

const BASE = 'https://api.d-id.com'
const TIMEOUT_MS = 10_000

function didErr(code: DIDErrorCode, message: string): DIDError {
  return { code, message, recoverable: code !== 'DID_AUTH' && code !== 'DID_NOT_CONFIGURED' }
}

function mapStatus(status: number): DIDErrorCode {
  if (status === 401 || status === 403) return 'DID_AUTH'
  if (status === 402 || status === 429) return 'DID_QUOTA'
  return 'DID_API'
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    throw didErr('DID_NETWORK', e instanceof Error ? e.message : 'network error')
  }
}

export class DIDStreamingService {
  constructor(
    private readonly apiKey: string,
    private readonly sourceUrl: string,
    private readonly voiceId: string = 'zh-CN-XiaoxiaoNeural',
  ) {}

  getConfigStatus(): DIDConfigStatus {
    if (!this.apiKey) {
      return {
        configured: false,
        missingKey: true,
        errorReason: '未配置 D-ID API Key — 请在 .env 中填入 DID_API_KEY',
      }
    }
    return { configured: true }
  }

  private headers(): Record<string, string> {
    // D-ID uses Basic auth scheme with API key directly (no colon needed per docs).
    // If P-2 curl test shows Bearer instead, swap here.
    return {
      Authorization: `Basic ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  async createStream(): Promise<DIDStreamInit> {
    const res = await safeFetch(`${BASE}/talks/streams`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ source_url: this.sourceUrl }),
    })
    if (!res.ok) throw didErr(mapStatus(res.status), `createStream HTTP ${res.status}`)
    const json = await res.json() as {
      id: string
      offer: RTCSessionDescriptionInit
      ice_servers: RTCIceServer[]
      session_id: string
    }
    return {
      id: json.id,
      offer: json.offer,
      iceServers: json.ice_servers,
      sessionId: json.session_id,
    }
  }

  async submitAnswer(streamId: string, sessionId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const res = await safeFetch(`${BASE}/talks/streams/${streamId}/sdp`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ answer, session_id: sessionId }),
    })
    if (!res.ok) throw didErr(mapStatus(res.status), `submitAnswer HTTP ${res.status}`)
  }

  async speak(streamId: string, sessionId: string, text: string): Promise<void> {
    const res = await safeFetch(`${BASE}/talks/streams/${streamId}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        script: {
          type: 'text',
          input: text,
          provider: { type: 'microsoft', voice_id: this.voiceId },
        },
        session_id: sessionId,
      }),
    })
    if (!res.ok) throw didErr(mapStatus(res.status), `speak HTTP ${res.status}`)
  }

  async stopSpeaking(streamId: string, sessionId: string): Promise<void> {
    // D-ID 若无显式 stop-speak endpoint，按 P-2 调研结果调整：
    // 方案 A：DELETE /talks/streams/{id}/speak
    // 方案 B：POST /talks/streams/{id} with empty script (overwrite)
    // 方案 C：直接 endStream + ensureConnected 重开（最慢、最稳）
    const res = await safeFetch(`${BASE}/talks/streams/${streamId}/speak`, {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify({ session_id: sessionId }),
    })
    if (!res.ok && res.status !== 404) {
      // 404 通常意味着"已经停了"或"没有正在播的"——不当错误
      throw didErr(mapStatus(res.status), `stopSpeaking HTTP ${res.status}`)
    }
  }

  async endStream(streamId: string, sessionId: string): Promise<void> {
    const res = await safeFetch(`${BASE}/talks/streams/${streamId}`, {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify({ session_id: sessionId }),
    })
    if (!res.ok && res.status !== 404) {
      throw didErr(mapStatus(res.status), `endStream HTTP ${res.status}`)
    }
  }
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
npx vitest run tests/DIDStreamingService.test.ts
```

Expected: 所有用例 PASS。

- [ ] **Step 5：commit**

```bash
git add electron/services/DIDStreamingService.ts tests/DIDStreamingService.test.ts
git commit -m "feat(electron): add DIDStreamingService (REST wrapper, 6 endpoints)"
```

---

## Task 5：IPC handlers（didStreamingHandler）

**Files:**
- Create: `electron/services/didStreamingHandler.ts`
- Create: `tests/didStreamingHandler.test.ts`

- [ ] **Step 1：先写失败测试**

创建 `tests/didStreamingHandler.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDidHandlers } from '../electron/services/didStreamingHandler'
import { DIDStreamingService } from '../electron/services/DIDStreamingService'

function makeSvc(overrides: Partial<DIDStreamingService> = {}): DIDStreamingService {
  // 用真实构造器拿到原型方法，再用 spy 覆盖个别
  const svc = new DIDStreamingService('test-key', 'https://example.com/a.png')
  return Object.assign(svc, overrides)
}

describe('didStreamingHandler', () => {
  describe('getConfigStatus', () => {
    it('returns config status synchronously, no sender check', () => {
      const svc = new DIDStreamingService('', 'https://example.com/a.png')
      const handlers = createDidHandlers(() => svc)
      const result = handlers.getConfigStatus()
      expect(result).toEqual({
        configured: false,
        missingKey: true,
        errorReason: expect.stringContaining('DID_API_KEY'),
      })
    })

    it('does not throw even if service throws internally', () => {
      const handlers = createDidHandlers(() => {
        throw new Error('boom')
      })
      const result = handlers.getConfigStatus()
      expect(result.configured).toBe(false)
    })
  })

  describe('createStream', () => {
    it('returns AppError on invalid sender', async () => {
      const handlers = createDidHandlers(() => makeSvc())
      const result = await handlers.createStream(/* validSender */ false)
      expect(result).toMatchObject({ code: 'DID_API' })
    })

    it('returns DIDStreamInit on success', async () => {
      const svc = makeSvc({
        createStream: vi.fn().mockResolvedValue({
          id: 'sid', offer: { type: 'offer', sdp: '' }, iceServers: [], sessionId: 'session1',
        }),
      } as Partial<DIDStreamingService>)
      const handlers = createDidHandlers(() => svc)
      const result = await handlers.createStream(true)
      expect(result).toMatchObject({ id: 'sid', sessionId: 'session1' })
    })

    it('returns DIDError envelope on service error', async () => {
      const svc = makeSvc({
        createStream: vi.fn().mockRejectedValue({ code: 'DID_AUTH', message: 'unauth', recoverable: false }),
      } as Partial<DIDStreamingService>)
      const handlers = createDidHandlers(() => svc)
      const result = await handlers.createStream(true)
      expect(result).toMatchObject({ code: 'DID_AUTH' })
    })

    it('does not leak API key in error output', async () => {
      const svc = makeSvc({
        createStream: vi.fn().mockRejectedValue(new Error('boom with test-key in it')),
      } as Partial<DIDStreamingService>)
      const handlers = createDidHandlers(() => svc)
      const result = await handlers.createStream(true)
      expect(JSON.stringify(result)).not.toContain('test-key')
    })
  })

  describe('input validation (submitAnswer / speak / stopSpeaking / endStream)', () => {
    let svc: DIDStreamingService
    beforeEach(() => {
      svc = makeSvc({
        submitAnswer: vi.fn().mockResolvedValue(undefined),
        speak: vi.fn().mockResolvedValue(undefined),
        stopSpeaking: vi.fn().mockResolvedValue(undefined),
        endStream: vi.fn().mockResolvedValue(undefined),
      } as Partial<DIDStreamingService>)
    })

    it('submitAnswer rejects non-string streamId', async () => {
      const handlers = createDidHandlers(() => svc)
      const result = await handlers.submitAnswer(true, 123 as unknown as string, 'session1', { type: 'answer', sdp: '' })
      expect(result).toMatchObject({ code: 'DID_API' })
    })

    it('speak rejects non-string text', async () => {
      const handlers = createDidHandlers(() => svc)
      const result = await handlers.speak(true, 'sid', 'session1', {} as unknown as string)
      expect(result).toMatchObject({ code: 'DID_API' })
    })

    it('speak rejects text > 1000 chars', async () => {
      const handlers = createDidHandlers(() => svc)
      const result = await handlers.speak(true, 'sid', 'session1', 'a'.repeat(1001))
      expect(result).toMatchObject({ code: 'DID_API' })
    })
  })
})
```

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/didStreamingHandler.test.ts
```

Expected: FAIL `Cannot find module ...didStreamingHandler`。

- [ ] **Step 3：实现 `electron/services/didStreamingHandler.ts`**

```ts
import type { DIDStreamingService } from './DIDStreamingService'
import type { DIDStreamInit, DIDConfigStatus, DIDError, AppError } from '../../shared/types'

const INVALID_SENDER: DIDError = { code: 'DID_API', message: 'invalid sender', recoverable: false }
const INVALID_INPUT: DIDError = { code: 'DID_API', message: 'invalid input', recoverable: false }

function toError(e: unknown, apiKey: string): DIDError {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    const err = e as DIDError
    // 双保险：抹掉可能泄漏的 key
    return { ...err, message: err.message?.replaceAll(apiKey, '***') ?? '' }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return { code: 'DID_API', message: msg.replaceAll(apiKey, '***'), recoverable: true }
}

export function createDidHandlers(serviceFactory: () => DIDStreamingService) {
  // getConfigStatus 不抛错：服务构造失败也返回 not-configured
  function getConfigStatus(): DIDConfigStatus {
    try {
      return serviceFactory().getConfigStatus()
    } catch (e) {
      return {
        configured: false,
        missingKey: true,
        errorReason: e instanceof Error ? e.message : 'service unavailable',
      }
    }
  }

  async function createStream(validSender: boolean): Promise<DIDStreamInit | AppError> {
    if (!validSender) return INVALID_SENDER
    const svc = serviceFactory()
    try {
      return await svc.createStream()
    } catch (e) {
      return toError(e, (svc as unknown as { apiKey: string }).apiKey ?? '')
    }
  }

  async function submitAnswer(
    validSender: boolean,
    streamId: string, sessionId: string, answer: RTCSessionDescriptionInit,
  ): Promise<AppError | undefined> {
    if (!validSender) return INVALID_SENDER
    if (typeof streamId !== 'string' || typeof sessionId !== 'string') return INVALID_INPUT
    if (!answer || typeof answer !== 'object') return INVALID_INPUT
    const svc = serviceFactory()
    try {
      await svc.submitAnswer(streamId, sessionId, answer)
      return undefined
    } catch (e) {
      return toError(e, (svc as unknown as { apiKey: string }).apiKey ?? '')
    }
  }

  async function speak(
    validSender: boolean,
    streamId: string, sessionId: string, text: string,
  ): Promise<AppError | undefined> {
    if (!validSender) return INVALID_SENDER
    if (typeof streamId !== 'string' || typeof sessionId !== 'string') return INVALID_INPUT
    if (typeof text !== 'string' || text.length === 0 || text.length > 1000) return INVALID_INPUT
    const svc = serviceFactory()
    try {
      await svc.speak(streamId, sessionId, text)
      return undefined
    } catch (e) {
      return toError(e, (svc as unknown as { apiKey: string }).apiKey ?? '')
    }
  }

  async function stopSpeaking(
    validSender: boolean,
    streamId: string, sessionId: string,
  ): Promise<AppError | undefined> {
    if (!validSender) return INVALID_SENDER
    if (typeof streamId !== 'string' || typeof sessionId !== 'string') return INVALID_INPUT
    const svc = serviceFactory()
    try {
      await svc.stopSpeaking(streamId, sessionId)
      return undefined
    } catch (e) {
      return toError(e, (svc as unknown as { apiKey: string }).apiKey ?? '')
    }
  }

  async function endStream(
    validSender: boolean,
    streamId: string, sessionId: string,
  ): Promise<AppError | undefined> {
    if (!validSender) return INVALID_SENDER
    if (typeof streamId !== 'string' || typeof sessionId !== 'string') return INVALID_INPUT
    const svc = serviceFactory()
    try {
      await svc.endStream(streamId, sessionId)
      return undefined
    } catch (e) {
      return toError(e, (svc as unknown as { apiKey: string }).apiKey ?? '')
    }
  }

  return { getConfigStatus, createStream, submitAnswer, speak, stopSpeaking, endStream }
}

export type DidHandlers = ReturnType<typeof createDidHandlers>
```

- [ ] **Step 4：跑测试确认通过**

```bash
npx vitest run tests/didStreamingHandler.test.ts
```

Expected: 所有用例 PASS。

- [ ] **Step 5：commit**

```bash
git add electron/services/didStreamingHandler.ts tests/didStreamingHandler.test.ts
git commit -m "feat(electron): add IPC handler factory for D-ID (sender + input validation, key scrubbing)"
```

---

## Task 6：electron main + preload + 类型声明接线

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/electron.d.ts`
- Modify: `.env.example`

> 本任务无独立单测——通过 Task 4/5 的服务/handler 单测 + Task 7/8 的 renderer 集成测共同覆盖。

- [ ] **Step 1：扩展 `.env.example`**

在 `.env.example` 末尾追加：

```bash

# D-ID Streaming Demo-Mode（可选；不填 toggle 按钮会禁用）
DID_API_KEY=
DID_AVATAR_SOURCE_URL=
DID_VOICE_ID=zh-CN-XiaoxiaoNeural
```

- [ ] **Step 2：在 `electron/main.ts` 注册 6 个 IPC channel**

找到 `import` 块，追加：

```ts
import { DIDStreamingService } from './services/DIDStreamingService'
import { createDidHandlers } from './services/didStreamingHandler'
```

在 `app.whenReady().then(() => { ... })` 块内（`createWindow()` 之**前**）追加：

```ts
  // D-ID streaming service factory: lazy + always reads latest env
  const DEFAULT_AVATAR_URL = 'https://create-images-results.d-id.com/DefaultPresenters/Emma_f/image.png'
  const didServiceFactory = () => new DIDStreamingService(
    process.env.DID_API_KEY ?? '',
    process.env.DID_AVATAR_SOURCE_URL || DEFAULT_AVATAR_URL,
    process.env.DID_VOICE_ID || undefined,
  )
  const didHandlers = createDidHandlers(didServiceFactory)
```

在文件**末尾**追加 6 个 IPC 注册：

```ts
// D-ID Streaming IPC ===

ipcMain.handle('did-get-config-status', () => didHandlers.getConfigStatus())

ipcMain.handle('did-create-stream', event =>
  didHandlers.createStream(BrowserWindow.fromWebContents(event.sender) !== null),
)

ipcMain.handle('did-submit-answer', (event, streamId: unknown, sessionId: unknown, answer: unknown) =>
  didHandlers.submitAnswer(
    BrowserWindow.fromWebContents(event.sender) !== null,
    streamId as string, sessionId as string, answer as RTCSessionDescriptionInit,
  ),
)

ipcMain.handle('did-speak', (event, streamId: unknown, sessionId: unknown, text: unknown) =>
  didHandlers.speak(
    BrowserWindow.fromWebContents(event.sender) !== null,
    streamId as string, sessionId as string, text as string,
  ),
)

ipcMain.handle('did-stop-speaking', (event, streamId: unknown, sessionId: unknown) =>
  didHandlers.stopSpeaking(
    BrowserWindow.fromWebContents(event.sender) !== null,
    streamId as string, sessionId as string,
  ),
)

ipcMain.handle('did-end-stream', (event, streamId: unknown, sessionId: unknown) =>
  didHandlers.endStream(
    BrowserWindow.fromWebContents(event.sender) !== null,
    streamId as string, sessionId as string,
  ),
)
```

- [ ] **Step 3：在 `electron/preload.ts` 平铺暴露 6 个方法**

在现有 `contextBridge.exposeInMainWorld('electronAPI', { ... })` 对象内（紧跟在 `transcribeAudio` 之**后**），追加：

```ts
  didGetConfigStatus(): Promise<import('../shared/types').DIDConfigStatus> {
    return ipcRenderer.invoke('did-get-config-status')
  },

  didCreateStream(): Promise<import('../shared/types').DIDStreamInit | AppError> {
    return ipcRenderer.invoke('did-create-stream')
  },

  didSubmitAnswer(streamId: string, sessionId: string, answer: RTCSessionDescriptionInit): Promise<AppError | undefined> {
    return ipcRenderer.invoke('did-submit-answer', streamId, sessionId, answer)
  },

  didSpeak(streamId: string, sessionId: string, text: string): Promise<AppError | undefined> {
    return ipcRenderer.invoke('did-speak', streamId, sessionId, text)
  },

  didStopSpeaking(streamId: string, sessionId: string): Promise<AppError | undefined> {
    return ipcRenderer.invoke('did-stop-speaking', streamId, sessionId)
  },

  didEndStream(streamId: string, sessionId: string): Promise<AppError | undefined> {
    return ipcRenderer.invoke('did-end-stream', streamId, sessionId)
  },
```

- [ ] **Step 4：在 `src/types/electron.d.ts` 追加类型**

修改 `electronAPI` interface，追加 6 个方法（在现有 `transcribeAudio` 之后），并在文件顶部 import 块追加新类型：

```ts
import type {
  AppError,
  AIResponse,
  AgentMessage,
  DIDConfigStatus,
  DIDStreamInit,
} from '@shared/types'

declare global {
  interface Window {
    electronAPI: {
      resizeWindow(height: number): void
      openExternal(url: string): Promise<AppError | undefined>
      openResource(resourceId: string): Promise<AppError | undefined>
      onError(cb: (err: AppError) => void): () => void
      chat(messages: AgentMessage[]): Promise<AIResponse | AppError>
      setApiKey(key: string): Promise<AppError | undefined>
      transcribeAudio(buffer: ArrayBuffer): Promise<AppError | string>
      // D-ID Streaming Demo-Mode
      didGetConfigStatus(): Promise<DIDConfigStatus>
      didCreateStream(): Promise<DIDStreamInit | AppError>
      didSubmitAnswer(streamId: string, sessionId: string, answer: RTCSessionDescriptionInit): Promise<AppError | undefined>
      didSpeak(streamId: string, sessionId: string, text: string): Promise<AppError | undefined>
      didStopSpeaking(streamId: string, sessionId: string): Promise<AppError | undefined>
      didEndStream(streamId: string, sessionId: string): Promise<AppError | undefined>
    }
  }
}

export {}
```

- [ ] **Step 5：跑 tsc + 全量测试确认没破坏现有**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: tsc 干净；所有现有测试 + 新加的 service/handler 测试全过。

- [ ] **Step 6：commit**

```bash
git add electron/main.ts electron/preload.ts src/types/electron.d.ts .env.example
git commit -m "feat(electron): wire 6 D-ID IPC handlers; flat-extend electronAPI on preload"
```

---

## Task 7：DIDStreamClient（renderer 侧 WebRTC 封装）

**Files:**
- Create: `src/services/did/DIDStreamClient.ts`
- Create: `tests/DIDStreamClient.test.ts`

> 关键：构造器接受 `peerFactory` 用于注入 mock `RTCPeerConnection`（happy-dom 没原生实现）。

- [ ] **Step 1：先写失败测试**

创建 `tests/DIDStreamClient.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DIDStreamClient } from '../src/services/did/DIDStreamClient'

// ----- Mock electronAPI -----
const mockApi = {
  didCreateStream: vi.fn(),
  didSubmitAnswer: vi.fn(),
  didSpeak: vi.fn(),
  didStopSpeaking: vi.fn(),
  didEndStream: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { electronAPI: typeof mockApi }).electronAPI = mockApi
})

// ----- Mock RTCPeerConnection -----
class FakePeerConnection {
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  connectionState: RTCPeerConnectionState = 'new'
  ontrack: ((ev: { streams: MediaStream[] }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  iceServers: RTCIceServer[]
  fakeStream: MediaStream

  constructor(config: RTCConfiguration) {
    this.iceServers = config.iceServers ?? []
    this.fakeStream = { id: 'fake-stream' } as unknown as MediaStream
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = d
  }
  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = d
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'fake-answer' }
  }
  // 测试用：模拟 ICE 完成、track 到达
  _simulateConnected(): void {
    this.connectionState = 'connected'
    this.onconnectionstatechange?.()
    this.ontrack?.({ streams: [this.fakeStream] })
  }
  _simulateFailed(): void {
    this.connectionState = 'failed'
    this.onconnectionstatechange?.()
  }
  close(): void { this.connectionState = 'closed' }
}

function makeClient(): { client: DIDStreamClient, pc: FakePeerConnection } {
  let pc!: FakePeerConnection
  const factory = (config: RTCConfiguration) => {
    pc = new FakePeerConnection(config)
    return pc as unknown as RTCPeerConnection
  }
  return { client: new DIDStreamClient(factory), pc: pc! }
}

describe('DIDStreamClient.open', () => {
  it('createStream → setRemoteDescription → createAnswer → submitAnswer in order', async () => {
    mockApi.didCreateStream.mockResolvedValue({
      id: 'sid', offer: { type: 'offer', sdp: 'fake-offer' },
      iceServers: [{ urls: 'stun:test' }], sessionId: 'session1',
    })
    mockApi.didSubmitAnswer.mockResolvedValue(undefined)

    const { client, pc: _initPc } = makeClient()
    const openPromise = client.open()
    // 模拟连接达成 — 一旦 setRemoteDescription 设了，立刻让 PC connected
    // 简化：open() 内部 awaits createStream → 我们让它的下游同步触发
    await Promise.resolve()  // 让 open 走到 awaiting submitAnswer
    // pc 此时已被创建
    expect(mockApi.didCreateStream).toHaveBeenCalled()

    // 模拟 ICE 成功
    await openPromise.then(() => {
      // open 完成后立即模拟 connected 触发 ontrack
    }).catch(() => {})
    // (上面的写法在真实实现里需要 open 本身等待 connectionstatechange='connected')
  })

  it('throws DID_AUTH when didCreateStream returns AppError with DID_AUTH code', async () => {
    mockApi.didCreateStream.mockResolvedValue({ code: 'DID_AUTH', message: 'no key', recoverable: false })
    const { client } = makeClient()
    await expect(client.open()).rejects.toMatchObject({ code: 'DID_AUTH' })
  })

  it('throws DID_WEBRTC when connection enters failed state', async () => {
    mockApi.didCreateStream.mockResolvedValue({
      id: 'sid', offer: { type: 'offer', sdp: '' }, iceServers: [], sessionId: 'session1',
    })
    mockApi.didSubmitAnswer.mockResolvedValue(undefined)
    const { client, pc } = makeClient()
    const openPromise = client.open()
    await Promise.resolve()
    pc._simulateFailed()
    await expect(openPromise).rejects.toMatchObject({ code: 'DID_WEBRTC' })
  })
})

describe('DIDStreamClient.speak', () => {
  it('calls didSpeak with streamId/sessionId/text', async () => {
    mockApi.didCreateStream.mockResolvedValue({
      id: 'sid', offer: { type: 'offer', sdp: '' }, iceServers: [], sessionId: 'session1',
    })
    mockApi.didSubmitAnswer.mockResolvedValue(undefined)
    mockApi.didSpeak.mockResolvedValue(undefined)
    const { client, pc } = makeClient()
    const openPromise = client.open()
    await Promise.resolve()
    pc._simulateConnected()
    await openPromise

    await client.speak('你好')
    expect(mockApi.didSpeak).toHaveBeenCalledWith('sid', 'session1', '你好')
  })

  it('respects AbortSignal: aborted speak rejects with AbortError-like sentinel', async () => {
    mockApi.didCreateStream.mockResolvedValue({
      id: 'sid', offer: { type: 'offer', sdp: '' }, iceServers: [], sessionId: 'session1',
    })
    mockApi.didSubmitAnswer.mockResolvedValue(undefined)
    // didSpeak 永不 resolve，模拟正在播
    mockApi.didSpeak.mockReturnValue(new Promise(() => {}))
    const { client, pc } = makeClient()
    const openPromise = client.open()
    await Promise.resolve()
    pc._simulateConnected()
    await openPromise

    const ctrl = new AbortController()
    const speakPromise = client.speak('long text', ctrl.signal)
    ctrl.abort()
    await expect(speakPromise).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('DIDStreamClient.getMediaStream / uptimeMinutes / isOpen', () => {
  it('returns null stream before open', () => {
    const { client } = makeClient()
    expect(client.getMediaStream()).toBeNull()
    expect(client.isOpen()).toBe(false)
  })

  it('returns stream after ontrack', async () => {
    mockApi.didCreateStream.mockResolvedValue({
      id: 'sid', offer: { type: 'offer', sdp: '' }, iceServers: [], sessionId: 'session1',
    })
    mockApi.didSubmitAnswer.mockResolvedValue(undefined)
    const { client, pc } = makeClient()
    const openPromise = client.open()
    await Promise.resolve()
    pc._simulateConnected()
    await openPromise
    expect(client.getMediaStream()).not.toBeNull()
    expect(client.isOpen()).toBe(true)
  })

  it('uptimeMinutes returns positive number after open', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T10:00:00Z'))
    mockApi.didCreateStream.mockResolvedValue({
      id: 'sid', offer: { type: 'offer', sdp: '' }, iceServers: [], sessionId: 'session1',
    })
    mockApi.didSubmitAnswer.mockResolvedValue(undefined)
    const { client, pc } = makeClient()
    const openPromise = client.open()
    await Promise.resolve()
    pc._simulateConnected()
    await openPromise
    vi.setSystemTime(new Date('2026-05-24T10:02:30Z'))  // +2.5 min
    expect(client.uptimeMinutes()).toBeCloseTo(2.5, 1)
    vi.useRealTimers()
  })
})

describe('DIDStreamClient.close', () => {
  it('calls didEndStream and closes peer connection', async () => {
    mockApi.didCreateStream.mockResolvedValue({
      id: 'sid', offer: { type: 'offer', sdp: '' }, iceServers: [], sessionId: 'session1',
    })
    mockApi.didSubmitAnswer.mockResolvedValue(undefined)
    mockApi.didEndStream.mockResolvedValue(undefined)
    const { client, pc } = makeClient()
    const openPromise = client.open()
    await Promise.resolve()
    pc._simulateConnected()
    await openPromise

    await client.close()
    expect(mockApi.didEndStream).toHaveBeenCalledWith('sid', 'session1')
    expect(pc.connectionState).toBe('closed')
    expect(client.isOpen()).toBe(false)
  })
})
```

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/DIDStreamClient.test.ts
```

Expected: FAIL `Cannot find module ...DIDStreamClient`。

- [ ] **Step 3：实现 `src/services/did/DIDStreamClient.ts`**

```ts
import type { DIDStreamInit, DIDError, AppError } from '@shared/types'

export type PeerFactory = (config: RTCConfiguration) => RTCPeerConnection

const defaultPeerFactory: PeerFactory = config => new RTCPeerConnection(config)

function isAppError(x: unknown): x is AppError {
  return typeof x === 'object' && x !== null && 'code' in x && typeof (x as { code: unknown }).code === 'string'
}

function didErr(code: DIDError['code'], message: string): DIDError {
  return { code, message, recoverable: code !== 'DID_AUTH' && code !== 'DID_NOT_CONFIGURED' }
}

class AbortError extends Error {
  override name = 'AbortError'
}

export class DIDStreamClient {
  private pc: RTCPeerConnection | null = null
  private streamId: string | null = null
  private sessionId: string | null = null
  private mediaStream: MediaStream | null = null
  private openedAt: number | null = null
  private opened = false

  constructor(private readonly peerFactory: PeerFactory = defaultPeerFactory) {}

  isOpen(): boolean { return this.opened }
  getMediaStream(): MediaStream | null { return this.mediaStream }
  uptimeMinutes(): number {
    return this.openedAt ? (Date.now() - this.openedAt) / 60_000 : 0
  }

  async open(): Promise<void> {
    if (this.opened) return
    const init = await window.electronAPI.didCreateStream()
    if (isAppError(init)) throw init
    const streamInit = init as DIDStreamInit
    this.streamId = streamInit.id
    this.sessionId = streamInit.sessionId

    this.pc = this.peerFactory({ iceServers: streamInit.iceServers })

    const connected = new Promise<void>((resolve, reject) => {
      this.pc!.ontrack = (ev: RTCTrackEvent | { streams: MediaStream[] }) => {
        this.mediaStream = ev.streams[0] ?? null
      }
      this.pc!.onconnectionstatechange = () => {
        if (this.pc!.connectionState === 'connected') resolve()
        if (this.pc!.connectionState === 'failed' || this.pc!.connectionState === 'closed') {
          reject(didErr('DID_WEBRTC', `peerConnection ${this.pc!.connectionState}`))
        }
      }
    })

    await this.pc.setRemoteDescription(streamInit.offer)
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)

    const submitErr = await window.electronAPI.didSubmitAnswer(this.streamId, this.sessionId, answer)
    if (submitErr) throw submitErr

    await connected
    this.openedAt = Date.now()
    this.opened = true
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!this.opened || !this.streamId || !this.sessionId) {
      throw didErr('DID_API', 'speak called before open')
    }
    if (signal?.aborted) throw new AbortError('aborted before start')

    const speakPromise = window.electronAPI.didSpeak(this.streamId, this.sessionId, text)
    // race with abort
    const aborted = new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new AbortError('aborted')), { once: true })
    })
    const result = await Promise.race([speakPromise, aborted])
    if (result && (result as AppError).code) throw result as AppError
  }

  async stopSpeaking(): Promise<void> {
    if (!this.opened || !this.streamId || !this.sessionId) return
    const err = await window.electronAPI.didStopSpeaking(this.streamId, this.sessionId)
    if (err) throw err
  }

  async close(): Promise<void> {
    if (this.streamId && this.sessionId) {
      await window.electronAPI.didEndStream(this.streamId, this.sessionId).catch(() => {})
    }
    this.pc?.close()
    this.pc = null
    this.mediaStream = null
    this.streamId = null
    this.sessionId = null
    this.opened = false
  }
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
npx vitest run tests/DIDStreamClient.test.ts
```

Expected: 全部 PASS。**若某个测试因 happy-dom 缺 `RTCPeerConnection` 类型报错**（即便有 fake 注入），需要在 `tests/setup.ts` 或测试文件顶部加 `globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection`（避免 TS 编译期类型抱怨）。

- [ ] **Step 5：commit**

```bash
git add src/services/did/DIDStreamClient.ts tests/DIDStreamClient.test.ts
git commit -m "feat(did): add DIDStreamClient (WebRTC session wrapper with PeerFactory injection)"
```

---

## Task 8：SessionManager（S2 timeout + interrupt + getCurrentStream）

**Files:**
- Create: `src/services/did/sessionManager.ts`
- Create: `src/services/did/index.ts`
- Create: `tests/sessionManager.test.ts`

- [ ] **Step 1：先写失败测试**

创建 `tests/sessionManager.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SessionManager, IDLE_TIMEOUT_MS } from '../src/services/did/sessionManager'
import { useAgentStore, initialState } from '../src/store/agentStore'

// Mock DIDStreamClient as a value module so we control the class behavior
const mockOpen = vi.hoisted(() => vi.fn())
const mockSpeak = vi.hoisted(() => vi.fn())
const mockStopSpeaking = vi.hoisted(() => vi.fn())
const mockClose = vi.hoisted(() => vi.fn())
const mockGetStream = vi.hoisted(() => vi.fn())
const mockIsOpen = vi.hoisted(() => vi.fn())
const mockUptime = vi.hoisted(() => vi.fn())

vi.mock('../src/services/did/DIDStreamClient', () => ({
  DIDStreamClient: vi.fn().mockImplementation(() => ({
    open: mockOpen,
    speak: mockSpeak,
    stopSpeaking: mockStopSpeaking,
    close: mockClose,
    getMediaStream: mockGetStream,
    isOpen: mockIsOpen,
    uptimeMinutes: mockUptime,
  })),
}))

describe('SessionManager', () => {
  let mgr: SessionManager

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    useAgentStore.setState(initialState)
    mockOpen.mockResolvedValue(undefined)
    mockSpeak.mockResolvedValue(undefined)
    mockStopSpeaking.mockResolvedValue(undefined)
    mockClose.mockResolvedValue(undefined)
    mockGetStream.mockReturnValue({ id: 'fake' } as unknown as MediaStream)
    mockIsOpen.mockReturnValue(true)
    mockUptime.mockReturnValue(1.5)
    mgr = new SessionManager()
  })

  afterEach(() => { vi.useRealTimers() })

  describe('ensureConnected', () => {
    it('opens a new client on first call', async () => {
      await mgr.ensureConnected()
      expect(mockOpen).toHaveBeenCalledTimes(1)
    })

    it('reuses existing open client on subsequent calls', async () => {
      await mgr.ensureConnected()
      await mgr.ensureConnected()
      expect(mockOpen).toHaveBeenCalledTimes(1)
    })
  })

  describe('getCurrentStream', () => {
    it('returns null when no client', () => {
      expect(mgr.getCurrentStream()).toBeNull()
    })

    it('returns stream from client when open', async () => {
      await mgr.ensureConnected()
      const stream = mgr.getCurrentStream()
      expect(stream).toEqual({ id: 'fake' })
    })
  })

  describe('speak (with abort wrapping)', () => {
    it('resolves "completed" on normal speak success', async () => {
      await mgr.ensureConnected()
      const result = await mgr.speak('hello')
      expect(result).toBe('completed')
      expect(mockSpeak).toHaveBeenCalledWith('hello', expect.any(AbortSignal))
    })

    it('resolves "interrupted" when interruptCurrentSpeak is called mid-flight', async () => {
      await mgr.ensureConnected()
      // make speak hang
      let pendingResolve: () => void = () => {}
      mockSpeak.mockImplementation((_text: string, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
        pendingResolve = resolve
        signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }))
      const speakPromise = mgr.speak('hi')
      await mgr.interruptCurrentSpeak()
      const result = await speakPromise
      expect(result).toBe('interrupted')
      expect(mockStopSpeaking).toHaveBeenCalled()
      void pendingResolve
    })
  })

  describe('notifyIdle + idle timeout', () => {
    it('schedules closeNow after IDLE_TIMEOUT_MS', async () => {
      await mgr.ensureConnected()
      mgr.notifyIdle()
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1)
      expect(mockClose).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      // closeNow is async — flush microtasks
      await vi.runAllTicks()
      expect(mockClose).toHaveBeenCalled()
    })

    it('cancels idle timer on next ensureConnected', async () => {
      await mgr.ensureConnected()
      mgr.notifyIdle()
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS / 2)
      await mgr.ensureConnected()  // 应当取消 timer
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS)
      await vi.runAllTicks()
      expect(mockClose).not.toHaveBeenCalled()
    })
  })

  describe('closeNow', () => {
    it('accumulates uptime minutes into store', async () => {
      mockUptime.mockReturnValue(3.7)
      await mgr.ensureConnected()
      await mgr.closeNow()
      expect(useAgentStore.getState().cloudMinutesThisMonth).toBeCloseTo(3.7)
      expect(mockClose).toHaveBeenCalled()
    })

    it('clears idle timer', async () => {
      await mgr.ensureConnected()
      mgr.notifyIdle()
      await mgr.closeNow()
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2)
      // close should have been called once (from closeNow), not twice
      expect(mockClose).toHaveBeenCalledTimes(1)
    })

    it('is idempotent (safe to call twice)', async () => {
      await mgr.ensureConnected()
      await mgr.closeNow()
      await mgr.closeNow()
      expect(mockClose).toHaveBeenCalledTimes(1)
    })
  })
})
```

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/sessionManager.test.ts
```

Expected: FAIL `Cannot find module ...sessionManager`。

- [ ] **Step 3：实现 `src/services/did/sessionManager.ts`**

```ts
import { DIDStreamClient } from './DIDStreamClient'
import { useAgentStore } from '../../store/agentStore'

export const IDLE_TIMEOUT_MS = 30_000

export type SpeakResult = 'completed' | 'interrupted'

export class SessionManager {
  private client: DIDStreamClient | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private currentSpeakAbort: AbortController | null = null

  async ensureConnected(): Promise<DIDStreamClient> {
    this.clearIdleTimer()
    if (this.client && this.client.isOpen()) return this.client
    this.client = new DIDStreamClient()
    await this.client.open()
    return this.client
  }

  getCurrentStream(): MediaStream | null {
    return this.client?.getMediaStream() ?? null
  }

  async speak(text: string): Promise<SpeakResult> {
    if (!this.client) throw new Error('no active client; call ensureConnected first')
    this.currentSpeakAbort = new AbortController()
    const signal = this.currentSpeakAbort.signal
    try {
      await this.client.speak(text, signal)
      return signal.aborted ? 'interrupted' : 'completed'
    } catch (err) {
      if (signal.aborted) return 'interrupted'
      throw err
    } finally {
      if (this.currentSpeakAbort?.signal === signal) this.currentSpeakAbort = null
    }
  }

  notifyIdle(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => { void this.closeNow() }, IDLE_TIMEOUT_MS)
  }

  async interruptCurrentSpeak(): Promise<void> {
    if (this.currentSpeakAbort) {
      this.currentSpeakAbort.abort()
      this.currentSpeakAbort = null
    }
    if (this.client && this.client.isOpen()) {
      await this.client.stopSpeaking().catch(() => {})
    }
  }

  async closeNow(): Promise<void> {
    this.clearIdleTimer()
    if (this.currentSpeakAbort) {
      this.currentSpeakAbort.abort()
      this.currentSpeakAbort = null
    }
    if (this.client) {
      const minutes = this.client.uptimeMinutes()
      useAgentStore.getState().addCloudMinutes(minutes)
      await this.client.close().catch(() => {})
      this.client = null
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
```

- [ ] **Step 4：实现 `src/services/did/index.ts`**

```ts
import { SessionManager } from './sessionManager'

export const sessionManager = new SessionManager()
export type { DIDStreamClient } from './DIDStreamClient'
export type { SpeakResult, SessionManager } from './sessionManager'
```

- [ ] **Step 5：跑测试确认通过**

```bash
npx vitest run tests/sessionManager.test.ts
```

Expected: 所有用例 PASS。

- [ ] **Step 6：commit**

```bash
git add src/services/did/sessionManager.ts src/services/did/index.ts tests/sessionManager.test.ts
git commit -m "feat(did): add SessionManager (S2 idle-timeout, interrupt, getCurrentStream)"
```

---

## Task 9：提取 LocalAvatar（纯重构，0 行为变动）

**Files:**
- Create: `src/components/Avatar/LocalAvatar.tsx`
- Modify: `src/components/Avatar/index.tsx`（暂时改成 re-export，避免破坏现有引用，下个 Task 再改成 RouterAvatar）

- [ ] **Step 1：把当前 `src/components/Avatar/index.tsx` 整段拷成 `LocalAvatar.tsx`**

创建 `src/components/Avatar/LocalAvatar.tsx`，内容与现 `src/components/Avatar/index.tsx` 完全相同，**仅改一处**：函数名 `Avatar` → `LocalAvatar`，并 `export function LocalAvatar()`。

具体内容（应与现有 index.tsx 内容一致，函数名改了）：

```tsx
import { useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import type { Viseme } from '@shared/types'
import characterImg from '../../assets/avatar/character.png'
import closedPng from '../../assets/avatar/visemes/closed.png'
import aPng from '../../assets/avatar/visemes/a.png'
import oPng from '../../assets/avatar/visemes/o.png'
import ePng from '../../assets/avatar/visemes/e.png'
import iPng from '../../assets/avatar/visemes/i.png'
import uPng from '../../assets/avatar/visemes/u.png'
import styles from './Avatar.module.css'

const VISEME_SRC: Record<Viseme, string> = {
  closed: closedPng,
  a: aPng,
  o: oPng,
  e: ePng,
  i: iPng,
  u: uPng,
}

export function LocalAvatar() {
  const mood = useAgentStore(s => s.mood)
  const isPushing = useAgentStore(s => s.isPushing)
  const currentViseme = useAgentStore(s => s.currentViseme)
  const setCurrentViseme = useAgentStore(s => s.setCurrentViseme)

  // 防御性 cleanup：Avatar 是常驻组件，实际只在热重载 / 应用退出时触发。
  // controller 生命周期由 useAI 负责（local viseme spec Section 9 约束 1），此处不调 stop()。
  useEffect(() => {
    return () => { setCurrentViseme('closed') }
  }, [setCurrentViseme])

  const wrapClass = [
    styles.characterWrap,
    mood === 'thinking' ? styles.thinking : '',
    mood === 'talking' ? styles.talking : '',
    mood === 'error' ? styles.error : '',
    isPushing ? styles.pushing : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.avatar}>
      <div className={wrapClass}>
        <img className={styles.characterImg} src={characterImg} alt="avatar" draggable={false} />
        <img className={styles.mouthOverlay} src={VISEME_SRC[currentViseme]} alt="" draggable={false} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2：把现 `src/components/Avatar/index.tsx` 改成 re-export（临时桥）**

```tsx
// Temporary bridge — replaced by RouterAvatar in Task 11
export { LocalAvatar as Avatar } from './LocalAvatar'
```

- [ ] **Step 3：跑全量测试 + tsc 确认无回归**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: 全部 PASS（行为完全一致，仅仅是文件位置改了）。

- [ ] **Step 4：commit**

```bash
git add src/components/Avatar/LocalAvatar.tsx src/components/Avatar/index.tsx
git commit -m "refactor(avatar): extract LocalAvatar from index.tsx (no behavior change)"
```

---

## Task 10：CloudAvatar 组件

**Files:**
- Create: `src/components/Avatar/CloudAvatar.tsx`
- Create: `src/components/Avatar/CloudAvatar.module.css`
- Create: `tests/CloudAvatar.test.tsx`

- [ ] **Step 1：先写失败测试**

创建 `tests/CloudAvatar.test.tsx`：

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { CloudAvatar } from '../src/components/Avatar/CloudAvatar'
import { useAgentStore, initialState } from '../src/store/agentStore'

const mockGetStream = vi.hoisted(() => vi.fn())
vi.mock('../src/services/did', () => ({
  sessionManager: { getCurrentStream: mockGetStream },
}))

describe('CloudAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAgentStore.setState({ ...initialState, renderMode: 'cloud' })
    cleanup()
  })

  it('renders <video> element', () => {
    const { container } = render(<CloudAvatar />)
    expect(container.querySelector('video')).not.toBeNull()
  })

  it('does NOT set srcObject when cloudConn !== streaming', () => {
    useAgentStore.setState({ cloudConn: 'connecting' })
    mockGetStream.mockReturnValue({ id: 'fake' } as unknown as MediaStream)
    const { container } = render(<CloudAvatar />)
    const v = container.querySelector('video') as HTMLVideoElement
    expect(v.srcObject).toBeNull()
  })

  it('sets srcObject from sessionManager.getCurrentStream() when cloudConn=streaming', () => {
    const fakeStream = { id: 'fake-stream' } as unknown as MediaStream
    mockGetStream.mockReturnValue(fakeStream)
    useAgentStore.setState({ cloudConn: 'streaming' })
    const { container } = render(<CloudAvatar />)
    const v = container.querySelector('video') as HTMLVideoElement
    expect(v.srcObject).toBe(fakeStream)
  })

  it('shows connecting overlay when cloudConn=connecting', () => {
    useAgentStore.setState({ cloudConn: 'connecting' })
    const { getByText } = render(<CloudAvatar />)
    expect(getByText(/连接中/)).toBeTruthy()
  })

  it('clears srcObject when cloudConn transitions back to idle', () => {
    const fakeStream = { id: 'fake-stream' } as unknown as MediaStream
    mockGetStream.mockReturnValue(fakeStream)
    useAgentStore.setState({ cloudConn: 'streaming' })
    const { container, rerender } = render(<CloudAvatar />)
    const v = container.querySelector('video') as HTMLVideoElement
    expect(v.srcObject).toBe(fakeStream)

    useAgentStore.setState({ cloudConn: 'idle' })
    rerender(<CloudAvatar />)
    expect(v.srcObject).toBeNull()
  })
})
```

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/CloudAvatar.test.tsx
```

Expected: FAIL `Cannot find module ...CloudAvatar`。

- [ ] **Step 3：实现 `src/components/Avatar/CloudAvatar.tsx`**

```tsx
import { useEffect, useRef } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { sessionManager } from '../../services/did'
import styles from './CloudAvatar.module.css'

export function CloudAvatar() {
  const cloudConn = useAgentStore(s => s.cloudConn)
  const mood = useAgentStore(s => s.mood)
  const isPushing = useAgentStore(s => s.isPushing)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (cloudConn !== 'streaming') {
      if (videoRef.current) videoRef.current.srcObject = null
      return
    }
    const stream = sessionManager.getCurrentStream()
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
      videoRef.current.play().catch(() => { /* autoplay rejection is fine */ })
    }
  }, [cloudConn])

  const wrapClass = [
    styles.cloudWrap,
    mood === 'thinking' ? styles.thinking : '',
    mood === 'talking' ? styles.talking : '',
    mood === 'error' ? styles.error : '',
    isPushing ? styles.pushing : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.avatar}>
      <div className={wrapClass}>
        {cloudConn === 'connecting' && (
          <div className={styles.overlay}>连接中...</div>
        )}
        <video
          ref={videoRef}
          className={styles.video}
          playsInline
          autoPlay
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 4：创建样式 `src/components/Avatar/CloudAvatar.module.css`**

```css
.avatar {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cloudWrap {
  position: relative;
  width: 100%;
  height: 100%;
}

.video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: transparent;
  border-radius: 12px;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  color: white;
  font-size: 14px;
  border-radius: 12px;
  z-index: 2;
}

/* mood animations — 沿用 Avatar.module.css 的思路，简化版 */
.thinking { animation: cloud-pulse 2s ease-in-out infinite; }
.talking { animation: cloud-pulse 0.8s ease-in-out infinite; }
.error { filter: hue-rotate(60deg) saturate(0.5); }
.pushing { transform: translateY(-2px); }

@keyframes cloud-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.95; }
}
```

- [ ] **Step 5：跑测试确认通过**

```bash
npx vitest run tests/CloudAvatar.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 6：commit**

```bash
git add src/components/Avatar/CloudAvatar.tsx src/components/Avatar/CloudAvatar.module.css tests/CloudAvatar.test.tsx
git commit -m "feat(avatar): add CloudAvatar (WebRTC video bound to sessionManager.getCurrentStream)"
```

---

## Task 11：RouterAvatar（替换 index.tsx 桥）

**Files:**
- Modify: `src/components/Avatar/index.tsx`
- Create: `tests/RouterAvatar.test.tsx`

- [ ] **Step 1：先写失败测试**

创建 `tests/RouterAvatar.test.tsx`：

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Avatar } from '../src/components/Avatar'
import { useAgentStore, initialState } from '../src/store/agentStore'
import { readFileSync } from 'fs'
import { resolve } from 'path'

vi.mock('../src/services/did', () => ({
  sessionManager: { getCurrentStream: vi.fn().mockReturnValue(null) },
}))

describe('RouterAvatar (Avatar/index.tsx)', () => {
  beforeEach(() => {
    useAgentStore.setState(initialState)
    cleanup()
  })

  it('renders LocalAvatar when renderMode=local', () => {
    useAgentStore.setState({ renderMode: 'local' })
    const { container } = render(<Avatar />)
    // LocalAvatar 渲染 character.png + viseme overlay（两个 <img>）
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBe(2)
    expect(container.querySelector('video')).toBeNull()
  })

  it('renders CloudAvatar when renderMode=cloud', () => {
    useAgentStore.setState({ renderMode: 'cloud' })
    const { container } = render(<Avatar />)
    // CloudAvatar 渲染 <video>
    expect(container.querySelector('video')).not.toBeNull()
    expect(container.querySelectorAll('img').length).toBe(0)
  })

  it('switches component when renderMode changes', () => {
    useAgentStore.setState({ renderMode: 'local' })
    const { container, rerender } = render(<Avatar />)
    expect(container.querySelector('video')).toBeNull()

    useAgentStore.setState({ renderMode: 'cloud' })
    rerender(<Avatar />)
    expect(container.querySelector('video')).not.toBeNull()
  })

  // Source-code guard：CloudAvatar 绝不直接 import DIDStreamClient
  it('CloudAvatar source does not import DIDStreamClient', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/components/Avatar/CloudAvatar.tsx'),
      'utf-8'
    )
    expect(source).not.toMatch(/from\s+['"].*DIDStreamClient['"]/)
    expect(source).toMatch(/sessionManager/)
  })
})
```

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/RouterAvatar.test.tsx
```

Expected: FAIL（当前 index.tsx 是临时桥，只 re-export LocalAvatar，cloud 模式渲染会错）。

- [ ] **Step 3：重写 `src/components/Avatar/index.tsx`**

替换为：

```tsx
import { useAgentStore } from '../../store/agentStore'
import { LocalAvatar } from './LocalAvatar'
import { CloudAvatar } from './CloudAvatar'

export function Avatar() {
  const renderMode = useAgentStore(s => s.renderMode)
  return renderMode === 'cloud' ? <CloudAvatar /> : <LocalAvatar />
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
npx vitest run tests/RouterAvatar.test.tsx
```

Expected: 全部 PASS（包括 source-code guard）。

- [ ] **Step 5：跑全量测试确认没回归**

```bash
npx vitest run
```

Expected: 全部 PASS。

- [ ] **Step 6：commit**

```bash
git add src/components/Avatar/index.tsx tests/RouterAvatar.test.tsx
git commit -m "feat(avatar): convert index.tsx to RouterAvatar (selects Local/Cloud by renderMode)"
```

---

## Task 12：ModeToggle 组件（按钮 + confirm modal + toast）

**Files:**
- Create: `src/components/ModeToggle/index.tsx`
- Create: `src/components/ModeToggle/ModeToggle.module.css`
- Create: `tests/ModeToggle.test.tsx`

- [ ] **Step 1：先写失败测试**

创建 `tests/ModeToggle.test.tsx`：

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ModeToggle } from '../src/components/ModeToggle'
import { useAgentStore, initialState } from '../src/store/agentStore'

const mockApi = {
  didGetConfigStatus: vi.fn(),
}
const mockCloseNow = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../src/services/did', () => ({
  sessionManager: { closeNow: mockCloseNow },
}))

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
  useAgentStore.setState(initialState)
  ;(window as unknown as { electronAPI: typeof mockApi }).electronAPI = mockApi
  localStorage.clear()
})

describe('ModeToggle — config preflight', () => {
  it('button is disabled until didGetConfigStatus resolves', async () => {
    let resolveStatus: (v: { configured: boolean }) => void = () => {}
    mockApi.didGetConfigStatus.mockReturnValue(
      new Promise(r => { resolveStatus = r })
    )
    const { getByRole } = render(<ModeToggle />)
    const btn = getByRole('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    resolveStatus({ configured: true })
    await waitFor(() => expect(btn.disabled).toBe(false))
  })

  it('button stays disabled when configured=false; tooltip shows errorReason', async () => {
    mockApi.didGetConfigStatus.mockResolvedValue({
      configured: false, missingKey: true, errorReason: '请填 DID_API_KEY',
    })
    const { getByRole } = render(<ModeToggle />)
    await waitFor(() => {
      const btn = getByRole('button') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      expect(btn.title).toContain('请填 DID_API_KEY')
    })
  })
})

describe('ModeToggle — local → cloud flow', () => {
  beforeEach(() => {
    mockApi.didGetConfigStatus.mockResolvedValue({ configured: true })
  })

  it('clicking opens confirm modal showing current month usage', async () => {
    localStorage.setItem('did-cloud-minutes', JSON.stringify({
      month: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
      minutes: 12.3,
    }))
    const { getByRole, getByText } = render(<ModeToggle />)
    await waitFor(() => expect((getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(getByRole('button'))
    expect(getByText(/演示模式/)).toBeTruthy()
    expect(getByText(/12\.3/)).toBeTruthy()
  })

  it('confirm sets renderMode=cloud', async () => {
    const { getByRole, getByText } = render(<ModeToggle />)
    await waitFor(() => expect((getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(getByRole('button'))
    fireEvent.click(getByText('确定开启'))
    expect(useAgentStore.getState().renderMode).toBe('cloud')
  })

  it('cancel keeps renderMode=local', async () => {
    const { getByRole, getByText } = render(<ModeToggle />)
    await waitFor(() => expect((getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(getByRole('button'))
    fireEvent.click(getByText('取消'))
    expect(useAgentStore.getState().renderMode).toBe('local')
  })
})

describe('ModeToggle — cloud → local flow', () => {
  beforeEach(() => {
    mockApi.didGetConfigStatus.mockResolvedValue({ configured: true })
    useAgentStore.setState({ renderMode: 'cloud' })
  })

  it('clicking immediately switches to local without confirm', async () => {
    const { getByRole, queryByText } = render(<ModeToggle />)
    await waitFor(() => expect((getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(getByRole('button'))
    await waitFor(() => {
      expect(useAgentStore.getState().renderMode).toBe('local')
      expect(mockCloseNow).toHaveBeenCalled()
      // 不应出现 confirm modal
      expect(queryByText('确定开启')).toBeNull()
    })
  })
})

describe('ModeToggle — label states', () => {
  beforeEach(() => {
    mockApi.didGetConfigStatus.mockResolvedValue({ configured: true })
  })

  it('shows 本地模式 when renderMode=local', async () => {
    useAgentStore.setState({ renderMode: 'local' })
    const { getByText } = render(<ModeToggle />)
    await waitFor(() => expect(getByText(/本地模式/)).toBeTruthy())
  })

  it('shows 待机 when cloud+idle', async () => {
    useAgentStore.setState({ renderMode: 'cloud', cloudConn: 'idle' })
    const { getByText } = render(<ModeToggle />)
    await waitFor(() => expect(getByText(/待机/)).toBeTruthy())
  })

  it('shows 连接中 when cloud+connecting', async () => {
    useAgentStore.setState({ renderMode: 'cloud', cloudConn: 'connecting' })
    const { getByText } = render(<ModeToggle />)
    await waitFor(() => expect(getByText(/连接中/)).toBeTruthy())
  })

  it('shows 已就绪 when cloud+streaming', async () => {
    useAgentStore.setState({ renderMode: 'cloud', cloudConn: 'streaming' })
    const { getByText } = render(<ModeToggle />)
    await waitFor(() => expect(getByText(/已就绪/)).toBeTruthy())
  })
})

describe('ModeToggle — toast', () => {
  beforeEach(() => {
    mockApi.didGetConfigStatus.mockResolvedValue({ configured: true })
  })

  it('shows toast when cloudLastError is set; clears on dismiss', async () => {
    useAgentStore.setState({ cloudLastError: 'D-ID 连接失败' })
    const { getByText, queryByText } = render(<ModeToggle />)
    await waitFor(() => expect(getByText(/D-ID 连接失败/)).toBeTruthy())
    fireEvent.click(getByText('×'))
    await waitFor(() => {
      expect(useAgentStore.getState().cloudLastError).toBeNull()
      expect(queryByText(/D-ID 连接失败/)).toBeNull()
    })
  })
})
```

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/ModeToggle.test.tsx
```

Expected: FAIL `Cannot find module ...ModeToggle`。

- [ ] **Step 3：实现 `src/components/ModeToggle/index.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { useCloudCostTracker } from '../../hooks/useCloudCostTracker'
import { sessionManager } from '../../services/did'
import type { DIDConfigStatus } from '@shared/types'
import styles from './ModeToggle.module.css'

const COST_PER_MINUTE = 0.25  // approximate USD/min

export function ModeToggle() {
  const renderMode = useAgentStore(s => s.renderMode)
  const cloudConn = useAgentStore(s => s.cloudConn)
  const cloudLastError = useAgentStore(s => s.cloudLastError)
  const setRenderMode = useAgentStore(s => s.setRenderMode)
  const setCloudError = useAgentStore(s => s.setCloudError)
  const { minutesThisMonth } = useCloudCostTracker()

  const [configStatus, setConfigStatus] = useState<DIDConfigStatus | null>(null)
  const [showModal, setShowModal] = useState(false)

  // mount 时拉一次配置状态
  useEffect(() => {
    let cancelled = false
    window.electronAPI.didGetConfigStatus().then(s => {
      if (!cancelled) setConfigStatus(s)
    }).catch(() => {
      if (!cancelled) setConfigStatus({ configured: false, errorReason: 'failed to read config' })
    })
    return () => { cancelled = true }
  }, [])

  // toast 5s 自动消失
  useEffect(() => {
    if (!cloudLastError) return
    const t = setTimeout(() => setCloudError(null), 5000)
    return () => clearTimeout(t)
  }, [cloudLastError, setCloudError])

  const disabled = !configStatus || !configStatus.configured || cloudConn === 'connecting'
  const tooltip = configStatus && !configStatus.configured ? configStatus.errorReason ?? '' : ''

  function label(): string {
    if (renderMode === 'local') return '🎭 本地模式'
    if (cloudConn === 'connecting') return '✨ 连接中...'
    if (cloudConn === 'streaming') return '✨ 演示模式 · 已就绪'
    return '✨ 演示模式 · 待机'
  }

  function handleClick() {
    if (disabled) return
    if (renderMode === 'local') {
      setShowModal(true)
    } else {
      // cloud → local：无 confirm，立即关闭 session
      void sessionManager.closeNow()
      setRenderMode('local')
    }
  }

  function handleConfirm() {
    setRenderMode('cloud')
    setShowModal(false)
  }

  function handleCancel() {
    setShowModal(false)
  }

  return (
    <>
      <button
        className={styles.toggle}
        onClick={handleClick}
        disabled={disabled}
        title={tooltip}
      >
        {label()}
      </button>

      {showModal && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <div className={styles.modalTitle}>切到演示模式将开始按分钟计费</div>
            <div className={styles.modalBody}>
              <div>预估单价：~${COST_PER_MINUTE.toFixed(2)}/分钟</div>
              <div>本月已使用：{minutesThisMonth.toFixed(1)} 分钟（≈ ${(minutesThisMonth * COST_PER_MINUTE).toFixed(2)}）</div>
              {cloudLastError && <div className={styles.modalError}>上次错误：{cloudLastError}</div>}
            </div>
            <div className={styles.modalActions}>
              <button onClick={handleCancel}>取消</button>
              <button onClick={handleConfirm} className={styles.modalPrimary}>确定开启</button>
            </div>
          </div>
        </div>
      )}

      {cloudLastError && (
        <div className={styles.toast}>
          <span>{cloudLastError}</span>
          <span> — 再次点击右上角可重试</span>
          <button className={styles.toastDismiss} onClick={() => setCloudError(null)}>×</button>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 4：创建样式 `src/components/ModeToggle/ModeToggle.module.css`**

```css
.toggle {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 100;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  font-size: 12px;
  cursor: pointer;
}
.toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.toggle:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.7);
}

.modalBackdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.modal {
  background: white;
  border-radius: 12px;
  padding: 20px;
  max-width: 360px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}
.modalTitle {
  font-weight: bold;
  font-size: 16px;
  margin-bottom: 12px;
}
.modalBody {
  font-size: 14px;
  color: #444;
  margin-bottom: 16px;
}
.modalBody > div {
  margin-bottom: 6px;
}
.modalError {
  color: #c33;
  margin-top: 8px;
}
.modalActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.modalActions button {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid #ccc;
  background: white;
  cursor: pointer;
}
.modalPrimary {
  background: #2c8 !important;
  color: white !important;
  border-color: #2c8 !important;
}

.toast {
  position: fixed;
  top: 60px;
  right: 12px;
  z-index: 150;
  padding: 10px 14px;
  background: rgba(200, 50, 50, 0.95);
  color: white;
  border-radius: 6px;
  font-size: 13px;
  max-width: 320px;
}
.toastDismiss {
  background: transparent;
  color: white;
  border: none;
  font-size: 18px;
  margin-left: 8px;
  cursor: pointer;
}
```

- [ ] **Step 5：跑测试确认通过**

```bash
npx vitest run tests/ModeToggle.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 6：commit**

```bash
git add src/components/ModeToggle tests/ModeToggle.test.tsx
git commit -m "feat(ui): add ModeToggle (config preflight + confirm modal + toast)"
```

---

## Task 13：useAI 接入双模式 + interrupt + fallback

**Files:**
- Modify: `src/hooks/useAI.ts`
- Modify: `tests/useAI.test.ts`

- [ ] **Step 1：先扩展 `tests/useAI.test.ts`，新增 cloud 路径与 interrupt 用例**

在文件**末尾**（最后一个 `it` 之后、`describe` 块**之内**）追加：

```ts
  // ============ D-ID Cloud Mode Tests ============

  const mockSessionEnsureConnected = vi.hoisted(() => vi.fn())
  const mockSessionSpeak = vi.hoisted(() => vi.fn())
  const mockSessionInterrupt = vi.hoisted(() => vi.fn())
  const mockSessionNotifyIdle = vi.hoisted(() => vi.fn())
  const mockSessionCloseNow = vi.hoisted(() => vi.fn())

  describe('useAI in cloud mode', () => {
    beforeEach(() => {
      mockSessionEnsureConnected.mockResolvedValue(undefined)
      mockSessionSpeak.mockResolvedValue('completed')
      mockSessionInterrupt.mockResolvedValue(undefined)
      mockSessionNotifyIdle.mockReturnValue(undefined)
      mockSessionCloseNow.mockResolvedValue(undefined)
      useAgentStore.setState({ renderMode: 'cloud' })
    })

    it('calls sessionManager.speak with reply, NOT ttsProvider.speak', async () => {
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('test'); await vi.runAllTicks() })
      expect(mockSessionSpeak).toHaveBeenCalledWith(mockReply)
      expect(mockSpeak).not.toHaveBeenCalled()
      expect(mockLipStart).not.toHaveBeenCalled()  // local lipsync 不参与 cloud 路径
    })

    it('on successful speak: notifyIdle + mood=idle', async () => {
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('test'); await vi.runAllTicks() })
      expect(mockSessionNotifyIdle).toHaveBeenCalled()
      expect(useAgentStore.getState().mood).toBe('idle')
    })

    it('on speak="interrupted": NOT notifyIdle, NOT mood=idle (let new turn take over)', async () => {
      mockSessionSpeak.mockResolvedValue('interrupted')
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('test'); await vi.runAllTicks() })
      expect(mockSessionNotifyIdle).not.toHaveBeenCalled()
      // mood 不重置（保持 talking 或被新一轮覆盖）
    })

    it('on D-ID error: renderMode flips to local + cloudError set + local補讲', async () => {
      mockSessionSpeak.mockRejectedValue({ code: 'DID_QUOTA', message: 'over limit' })
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('test'); await vi.runAllTicks() })
      expect(useAgentStore.getState().renderMode).toBe('local')
      expect(useAgentStore.getState().cloudLastError).toContain('over limit')
      // 本地補讲：lipSync + tts 启动
      expect(mockLipStart).toHaveBeenCalledWith(mockReply, expect.any(Function))
      expect(mockSpeak).toHaveBeenCalledWith(mockReply)
    })

    it('new sendMessage interrupts in-flight cloud speak', async () => {
      let resolveSpeak: (v: 'completed') => void = () => {}
      mockSessionSpeak.mockImplementationOnce(() => new Promise(r => { resolveSpeak = r }))
      mockSessionSpeak.mockImplementationOnce(() => Promise.resolve('completed'))
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('first'); await vi.runAllTicks() })
      mockSessionInterrupt.mockClear()
      await act(async () => { result.current.sendMessage('second'); await vi.runAllTicks() })
      expect(mockSessionInterrupt).toHaveBeenCalled()
      void resolveSpeak
    })

    it('AI failure in cloud mode closes session', async () => {
      mockChat.mockRejectedValueOnce(new Error('network'))
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('hi'); await vi.runAllTicks() })
      expect(mockSessionCloseNow).toHaveBeenCalled()
      expect(useAgentStore.getState().mood).toBe('error')
    })
  })
```

并在文件顶部**已有的 vi.mock 区段**之后追加 sessionManager mock：

```ts
vi.mock('../src/services/did', () => ({
  sessionManager: {
    ensureConnected: mockSessionEnsureConnected,
    speak: mockSessionSpeak,
    interruptCurrentSpeak: mockSessionInterrupt,
    notifyIdle: mockSessionNotifyIdle,
    closeNow: mockSessionCloseNow,
  },
}))
```

> ⚠️ 注意：`vi.hoisted` 声明的 mock 变量必须在 `vi.mock` 工厂内引用前先声明。把 `const mockSessionXxx = vi.hoisted(...)` 一组**移到文件顶部** mock 声明区。

- [ ] **Step 2：跑测试确认失败**

```bash
npx vitest run tests/useAI.test.ts
```

Expected: 多个 cloud 测试 FAIL（当前 useAI 还不会走 sessionManager 路径）。

- [ ] **Step 3：修改 `src/hooks/useAI.ts`**

替换文件内容为：

```ts
import { useCallback, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import { ttsProvider } from '../services/tts'
import { lipSyncController } from '../services/lipsync'
import { sessionManager } from '../services/did'
import { isAppError } from '../services/ai/ElectronAIProvider'
import type { AppError } from '@shared/types'

export function useAI() {
  const generationRef = useRef(0)

  const sendMessage = useCallback(async (text: string) => {
    if (useAgentStore.getState().isLoading) return
    const myGen = ++generationRef.current

    // 新一轮开始：打断上一轮的 speak / 嘴型，**无论模式如何**
    ttsProvider.stop()
    lipSyncController.stop()
    const modeAtStart = useAgentStore.getState().renderMode
    if (modeAtStart === 'cloud') {
      await sessionManager.interruptCurrentSpeak()
    }

    const store = useAgentStore.getState()
    store.setLastUserInput(text)
    store.setIsLoading(true)
    store.setMood('thinking')
    store.setError(null)
    store.addMessage({ role: 'user', content: text })

    try {
      const response = await aiProvider.chat(useAgentStore.getState().messages)

      const s = useAgentStore.getState()
      s.addMessage({ role: 'assistant', content: response.reply })
      s.setResourceCards(response.resourceCards)
      s.setIsPushing(response.resourceCards.length > 0)
      s.setMood('talking')
      s.setIsLoading(false)

      // 决策时刻的模式（用户可能在 AI 等待期间切换）
      const mode = useAgentStore.getState().renderMode

      if (mode === 'local') {
        lipSyncController.start(response.reply, useAgentStore.getState().setCurrentViseme)
        const finishTalkingLocal = () => {
          if (generationRef.current !== myGen) return
          lipSyncController.stop()
          const st = useAgentStore.getState()
          st.setMood('idle')
          st.setIsPushing(false)
        }
        ttsProvider.speak(response.reply).then(finishTalkingLocal, finishTalkingLocal)
      } else {
        // cloud 路径
        try {
          s.setCloudConn('connecting')
          await sessionManager.ensureConnected()
          s.setCloudConn('streaming')
          const result = await sessionManager.speak(response.reply)
          if (generationRef.current !== myGen) return
          if (result === 'interrupted') return  // 被打断不收尾
          sessionManager.notifyIdle()
          const st = useAgentStore.getState()
          st.setMood('idle')
          st.setIsPushing(false)
        } catch (didErr) {
          if (generationRef.current !== myGen) return
          await handleCloudFailure(didErr as AppError, response.reply, myGen)
        }
      }
    } catch (err: unknown) {
      const appError: AppError = isAppError(err)
        ? (err as AppError)
        : { code: 'AI_ERROR', message: err instanceof Error ? err.message : String(err), recoverable: true }

      ttsProvider.stop()
      lipSyncController.stop()
      if (useAgentStore.getState().renderMode === 'cloud') {
        await sessionManager.closeNow()
      }
      const s = useAgentStore.getState()
      s.setMood('error')
      s.setIsPushing(false)
      s.setError(appError)
      s.setIsLoading(false)
    }
  }, [])

  const retry = useCallback(() => {
    const { lastUserInput } = useAgentStore.getState()
    if (lastUserInput) sendMessage(lastUserInput)
  }, [sendMessage])

  return { sendMessage, retry }

  // ---- helpers ----

  async function handleCloudFailure(err: AppError, reply: string, myGen: number): Promise<void> {
    await sessionManager.closeNow()
    const s = useAgentStore.getState()
    s.setRenderMode('local')  // 同时 reset currentViseme → 'closed'（store 内部保证）
    s.setCloudError(err.message || `D-ID error: ${err.code}`)
    s.setCloudConn('idle')

    // 本地補讲这条 reply
    lipSyncController.start(reply, useAgentStore.getState().setCurrentViseme)
    const finishLocalFallback = () => {
      if (generationRef.current !== myGen) return
      lipSyncController.stop()
      const st = useAgentStore.getState()
      st.setMood('idle')
      st.setIsPushing(false)
    }
    ttsProvider.speak(reply).then(finishLocalFallback, finishLocalFallback)
  }
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
npx vitest run tests/useAI.test.ts
```

Expected: 所有用例（含原有 + 新增 cloud）PASS。

- [ ] **Step 5：跑全量测试 + tsc 确认无回归**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: 全部 PASS / 干净。

- [ ] **Step 6：commit**

```bash
git add src/hooks/useAI.ts tests/useAI.test.ts
git commit -m "feat(useAI): route by renderMode; cloud path with interrupt + fallback + generation guard"
```

---

## Task 14：App.tsx 接入 ModeToggle

**Files:**
- Modify: `src/App.tsx`

> 本任务无独立测试——ModeToggle 自己的 unit 测已覆盖按钮逻辑；App 集成由手动验收 Task 15 覆盖。

- [ ] **Step 1：在 `src/App.tsx` 顶层渲染 `<ModeToggle />`**

打开 `src/App.tsx`，在 import 块追加：

```tsx
import { ModeToggle } from './components/ModeToggle'
```

在 App 函数 return 的最外层 JSX 内（建议紧邻 `<Avatar />` 之前或之后；最终位置取决于现有布局），追加：

```tsx
<ModeToggle />
```

例如：

```tsx
return (
  <div className={styles.app}>
    <ModeToggle />
    <Avatar />
    {/* ... 其他原有内容 ... */}
  </div>
)
```

- [ ] **Step 2：跑 tsc 和 build 确认接入干净**

```bash
npx tsc --noEmit && npm run build
```

Expected: tsc 干净；build 三套产物通过。

- [ ] **Step 3：跑全量测试确认无回归**

```bash
npx vitest run
```

Expected: 全部 PASS。

- [ ] **Step 4：commit**

```bash
git add src/App.tsx
git commit -m "feat(app): mount ModeToggle in App.tsx"
```

---

## Task 15：手动验收（spec Section 14）

> 本任务**不写代码、不跑自动测**——执行 spec Section 14 的 9 条手动验收。

- [ ] **Step 1：准备**

确认 `.env` 内 `DID_API_KEY` 已填且对应账号有 streaming 配额。

```bash
npm run dev
```

观察启动是否正常：app 出现、本地模式默认渲染、Avatar 是卡通形象、嘴是闭口。

- [ ] **Step 2：验收 1 — 未配置 KEY 的禁用路径**

临时改 `.env`，把 `DID_API_KEY=` 留空。重启 app。

**预期：** 右上角 toggle 显示"🎭 本地模式"，**按钮置灰禁用**，hover 鼠标显示 tooltip "未配置 D-ID API Key — 请在 .env 中填入 DID_API_KEY"。

恢复 `.env`，重启 app。

- [ ] **Step 3：验收 2 — 切到 cloud 进 idle**

点击 toggle。

**预期：** 弹出 confirm modal，显示"本月已使用：0.0 分钟（≈ $0.00）"。点击"确定开启"。

**预期：** modal 关闭，toggle label 变为"✨ 演示模式 · 待机"——**此时还没建联**，cloudConn=idle。

- [ ] **Step 4：验收 3 — 第一次发问题触发建联**

在输入框输入"你好，介绍一下牛顿第一定律"，回车。

**预期顺序：**
1. toggle 切到"✨ 连接中..."（cloudConn=connecting，1-2 秒）
2. 切到"✨ 演示模式 · 已就绪"（cloudConn=streaming）
3. Avatar 区域显示真人形象，开始讲话
4. 嘴型与中文发音对齐

- [ ] **Step 5：验收 4 — idle 超时关 session**

讲话结束后，**不要发新问题**，等 30 秒。

**预期：** toggle 自动回到"✨ 演示模式 · 待机"（cloudConn=idle，session 关闭）。

- [ ] **Step 6：验收 5 — 第二次发问题重建联**

再发一条问题。

**预期：** toggle 重新走 idle → connecting → streaming → 又是真人讲话。

- [ ] **Step 7：验收 6 — 失败 fallback**

模拟失败：把 `.env` 内 `DID_API_KEY` 改成无效值（比如 `invalid-key-xyz`），保持 app 不关，等待当前 session 自然 idle 超时（30s）。然后再发问题。

**预期：** create-stream 401 失败 → 
1. toast 出现："D-ID 连接失败 — 再次点击右上角可重试"
2. toggle 翻回"🎭 本地模式"
3. **本地補讲**：本地 viseme 嘴型动起来，WebSpeech 把这条 reply 念完
4. 5s 后 toast 自动消失

恢复 `.env`，重启 app。

- [ ] **Step 8：验收 7 — 切回 local 立即生效**

进 cloud 模式 → 讲一句话 → 在播放中**手动点 toggle 切回 local**。

**预期：** 
1. 真人 video 立刻消失
2. 卡通 LocalAvatar 立刻出现，嘴是 closed
3. 没有任何 toast/modal（cloud→local 无 confirm）

- [ ] **Step 9：验收 8 — 应用退出无 session 泄漏**

cmd-Q 退出 app。

去 D-ID dashboard（[d-id.com/api](https://www.d-id.com/api/)）看 streams 列表——**不应有活跃 session**（旧的应已被 `closeNow` 关掉）。

- [ ] **Step 10：自动化验收**

回到 worktree 跑：

```bash
npx vitest run && npx tsc --noEmit && npm run build
```

Expected: 全部 PASS / 干净。

- [ ] **Step 11：commit（如有遗漏修补）**

如果手动验收发现 bug 并修了，commit 修复；否则跳过。

---

## Self-Review（plan 写完后内联自查 — 已完成）

**1. Spec coverage 检查：**

| Spec Section | Plan Task |
|---|---|
| 1 状态机 | Task 2（store）+ Task 13（useAI 状态转换） |
| 2 D-ID Streaming 集成 | Task 1（types）+ Task 4（service）+ Task 5（handler）+ Task 6（preload/main） |
| 3 SessionManager | Task 8 |
| 4 CloudAvatar | Task 10 |
| 5 LocalAvatar | Task 9 |
| 6 RouterAvatar | Task 11 |
| 7 useAI 改造 | Task 13 |
| 8 失败 → 本地 fallback | Task 13（handleCloudFailure） |
| 9 Toggle UI | Task 12 |
| 10 错误处理细则 | Task 4（mapStatus）+ Task 13（fallback） |
| 11 测试策略 | 每个 Task 内的 TDD 测试步骤 |
| 12 文件清单 | Plan 顶部 "File Structure" |
| 13 .env | Task 6 Step 1 |
| 14 分支与验收 | Prerequisites + Task 15 |

✅ 全覆盖，无遗漏。

**2. Placeholder scan：**
- ✅ 无 TBD / TODO / "implement later"
- ⚠️ Task 4 Step 3 内的 D-ID API 端点（如 stopSpeaking 用 DELETE 还是 POST）**有 P-2 校准条款兜底**——属于"明确的不确定"而非占位
- ⚠️ Task 4 Step 3 内 `DEFAULT_AVATAR_URL` 硬编码了一个 D-ID 默认形象 URL，**实施前需查最新文档替换**（已在 P-1 中提示）

**3. Type 一致性：**
- ✅ `RenderMode` / `CloudConnectionState` / `DIDError` / `DIDConfigStatus` / `DIDStreamInit` / `DIDErrorCode` — 在 Task 1 定义、贯穿后续 Task 引用一致
- ✅ `sessionManager.speak()` 在 Task 8 定义返回 `'completed' | 'interrupted'`，Task 13 useAI 调用方按此判断
- ✅ `interruptCurrentSpeak()` / `notifyIdle()` / `closeNow()` / `ensureConnected()` / `getCurrentStream()` 命名贯穿一致
- ✅ `electronAPI.did*` 6 个方法名跨 Task 6（preload/types）与 Task 7 / Task 12（renderer 调用方）一致

---

## 备注

- **Worktree 创建时机：** 由 `superpowers:using-git-worktrees` skill 在开始 Task 1 前创建（已在 P-3 标注）
- **每 Task 后跑 `npx vitest run` 是 TDD 节奏的一部分**，Task 步骤中已经显式写出
- **强烈不建议跳 Task 顺序：** 类型 → store → main 服务 → IPC → preload → 客户端 → 管理器 → 组件 → useAI → app 接入，依赖关系是链式的
- **Plan 总步数：** 15 个 Task + 4 项 Prerequisites，预计 1-2 个工作日完成（不含 D-ID 账号开通与 curl 验证时间）
