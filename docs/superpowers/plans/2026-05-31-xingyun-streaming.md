# 魔珐星云 3D 数字人主渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把魔珐星云 3D 数字人做成默认主渲染（云端模式），本地 viseme 退居降级兜底，失败自动回本地，并保留一个极简手动 toggle。

**Architecture:** `agentStore.renderMode` 路由到 `CloudAvatar`（魔珐 SDK 自绘 WebGL，默认）或 `LocalAvatar`（PNG viseme，兜底）。魔珐 SDK 跑在 renderer、连自家网关；main 进程只经 1 个 IPC 把 `.env` 的 `appId/appSecret/gateway` 注入 renderer。`sessionManager` 管 SDK 单例的连接生命周期（idle-timeout 省钱、真打断、pending speak 单一收尾契约）。失败自动回本地 + toast。

**Tech Stack:** Electron + React + TypeScript + Zustand + Vitest（happy-dom, pool=forks）。新引入：魔珐 `XmovAvatar` LiteSDK（vendor 本地脚本，全局 `window.XmovAvatar`）。

**Spec:** `docs/superpowers/specs/2026-05-31-xingyun-streaming-design.md`（15 个 Section）

---

## Prerequisites（Task 1 之前）

- **P-1 ✅** 魔珐账号 + 应用（id=55230）+ 形象已配（绑定在 appId）。
- **P-2 ✅** `appId/appSecret` 已写入根 `.env`（`XINGYUN_APP_ID` / `XINGYUN_APP_SECRET` / `XINGYUN_GATEWAY_SERVER`，本次会话完成）；`.env.example` 已加占位模板。
- **P-3 ✅** 官方调试台 + API 文档实测，详 `XINGYUN-API-CHECK.md`（连接/中文说话/打断/计费/方法名/回调名已确认；onMessage 错误 payload 精确形状、就绪态精确取值、连发 speak 行为留实现首日联调）。
- **P-4** worktree：由 `superpowers:using-git-worktrees` 创建 `feature/xingyun-streaming`，置于 `.worktrees/feature-xingyun-streaming/`，从 `main` 起步。worktree 内第一件事：拷贝根 `.env` 过去（含魔珐三个变量）。

---

## File Structure

### 新增

| 文件 | 职责 |
|---|---|
| `electron/services/xingyunConfigHandler.ts` | 纯函数 `getXingyunConfig(env)`：读 env，缺 APP_ID/APP_SECRET 返 not-configured，gateway 缺省补默认常量 |
| `src/services/xingyun/types.ts` | `XINGYUN_CONTAINER_ID` 常量 + `xyError()` 工厂 |
| `src/services/xingyun/ssml.ts` | `escapeXml()` + `buildSSML()` |
| `src/services/xingyun/XingyunClient.ts` | 单次会话 SDK 封装：`open`/`speak`/`interrupt`/`destroy`/`isOpen`；pending speak 单一收尾契约；`sdkFactory` 注入 |
| `src/services/xingyun/sessionManager.ts` | 单例：`ensureConnected`/`speak`/`interrupt`/`notifyIdle`/`closeNow`；idle-timeout；`clientFactory` 注入 |
| `src/services/xingyun/index.ts` | 导出 `sessionManager` 单例 + `XINGYUN_CONTAINER_ID` |
| `src/types/xingyun-sdk.d.ts` | `window.XmovAvatar` 类型声明 |
| `src/components/Avatar/LocalAvatar.tsx` | 现 `Avatar/index.tsx` 整段搬来，0 行为变动 |
| `src/components/Avatar/CloudAvatar.tsx` | 容器 div + connecting/error overlay + unmount closeNow |
| `src/components/Avatar/CloudAvatar.module.css` | stage 容器 + overlay 样式 |
| `src/components/ModeToggle/index.tsx` | 极简 toggle（无 modal）+ config 预查 + toast |
| `src/components/ModeToggle/ModeToggle.module.css` | 按钮 + toast 样式 |
| `public/vendor/xmovAvatar.js` | vendor 锁版本的魔珐 SDK 脚本（Task 8 下载）|

### 修改

| 文件 | 改动 |
|---|---|
| `shared/types.ts` | 追加 `RenderMode`/`CloudConnectionState`/`XingyunErrorCode`/`XingyunError`/`XingyunConfig`/`XingyunConfigStatus` |
| `src/store/agentStore.ts` | 新增 `renderMode`(初值 cloud)/`cloudConn`/`cloudLastError` + 3 setter；`setRenderMode('local')` 重置 viseme；reset 复位 |
| `electron/main.ts` | 注册 `xingyun-get-config` IPC（含 sender 校验）|
| `electron/preload.ts` | 平铺追加 `xingyunGetConfig()` |
| `src/types/electron.d.ts` | 追加 `xingyunGetConfig` 类型 |
| `src/hooks/useAI.ts` | 按 renderMode 分支；cloud 头部 interrupt；cloud 路径 + `handleCloudFailure` |
| `src/components/Avatar/index.tsx` | 重写为 5 行 RouterAvatar |
| `src/App.tsx` | 顶层渲染 `<ModeToggle />` |
| `index.html` | 更新 CSP + 引入 `/vendor/xmovAvatar.js` |
| `tests/agentStore.test.ts` / `tests/useAI.test.ts` | 扩展 cloud 路径 |

### 删除
无。本地 viseme 全保留。

---

## Task 1：扩展 shared 类型

**Files:** Modify `shared/types.ts`

- [ ] **Step 1：在 `shared/types.ts` 末尾追加**

```ts
// ============= 魔珐星云 具身驱动 =============

export type RenderMode = 'cloud' | 'local'

export type CloudConnectionState = 'idle' | 'connecting' | 'streaming' | 'error'

export type XingyunErrorCode =
  | 'XY_NOT_CONFIGURED'   // .env 缺 APP_ID/APP_SECRET
  | 'XY_SCRIPT'           // SDK 脚本未加载
  | 'XY_CONNECT'          // 建联超时 / 就绪前致命错
  | 'XY_SPEAK'            // speak 期致命错
  | 'XY_SDK'              // 其他 SDK 错误

export type XingyunError = AppError & { code: XingyunErrorCode }

export interface XingyunConfig {
  appId: string
  appSecret: string
  gatewayServer: string
}

export type XingyunConfigStatus =
  | ({ configured: true } & XingyunConfig)
  | { configured: false; missingKey: true; errorReason: string }
```

- [ ] **Step 2：`npx tsc --noEmit`** → 无输出（exit 0）。

- [ ] **Step 3：commit**

```bash
git add shared/types.ts
git commit -m "feat(types): add 魔珐星云 streaming shared types"
```

---

## Task 2：扩展 agentStore（renderMode 等 3 字段）

**Files:** Modify `src/store/agentStore.ts`, `tests/agentStore.test.ts`

- [ ] **Step 1：先写失败测试** —— 在 `tests/agentStore.test.ts` 末尾、最后一个 `it` 之后、`})` 之前追加：

```ts
  it('initial renderMode is cloud, cloudConn idle, cloudLastError null', () => {
    const s = useAgentStore.getState()
    expect(s.renderMode).toBe('cloud')
    expect(s.cloudConn).toBe('idle')
    expect(s.cloudLastError).toBeNull()
  })

  it('setRenderMode("local") resets currentViseme to "closed"', () => {
    useAgentStore.setState({ renderMode: 'cloud', currentViseme: 'a' })
    useAgentStore.getState().setRenderMode('local')
    expect(useAgentStore.getState().renderMode).toBe('local')
    expect(useAgentStore.getState().currentViseme).toBe('closed')
  })

  it('setRenderMode("cloud") does NOT touch currentViseme', () => {
    useAgentStore.setState({ renderMode: 'local', currentViseme: 'a' })
    useAgentStore.getState().setRenderMode('cloud')
    expect(useAgentStore.getState().currentViseme).toBe('a')
  })

  it('setCloudConn updates cloudConn', () => {
    useAgentStore.getState().setCloudConn('connecting')
    expect(useAgentStore.getState().cloudConn).toBe('connecting')
  })

  it('setCloudError sets and clears cloudLastError', () => {
    useAgentStore.getState().setCloudError('boom')
    expect(useAgentStore.getState().cloudLastError).toBe('boom')
    useAgentStore.getState().setCloudError(null)
    expect(useAgentStore.getState().cloudLastError).toBeNull()
  })

  it('reset restores renderMode=cloud, cloudConn=idle, cloudLastError=null', () => {
    useAgentStore.setState({ renderMode: 'local', cloudConn: 'streaming', cloudLastError: 'x' })
    useAgentStore.getState().reset()
    const s = useAgentStore.getState()
    expect(s.renderMode).toBe('cloud')
    expect(s.cloudConn).toBe('idle')
    expect(s.cloudLastError).toBeNull()
  })
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/agentStore.test.ts`
Expected: 新用例 FAIL（`renderMode` 等 undefined）。

- [ ] **Step 3：修改 `src/store/agentStore.ts`** —— 替换整个文件为：

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
  // 魔珐 cloud-mode
  renderMode: RenderMode
  cloudConn: CloudConnectionState
  cloudLastError: string | null

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
  // 魔珐 cloud-mode
  setRenderMode: (mode: RenderMode) => void
  setCloudConn: (state: CloudConnectionState) => void
  setCloudError: (msg: string | null) => void
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
  renderMode: 'cloud' as RenderMode,
  cloudConn: 'idle' as CloudConnectionState,
  cloudLastError: null as string | null,
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
  reset: () => set(initialState),
}))
```

- [ ] **Step 4：跑测试确认通过**

Run: `npx vitest run tests/agentStore.test.ts`
Expected: 全 PASS。

- [ ] **Step 5：commit**

```bash
git add src/store/agentStore.ts tests/agentStore.test.ts
git commit -m "feat(store): add renderMode(default cloud)/cloudConn/cloudLastError; setRenderMode resets viseme"
```

---

## Task 3：xingyunConfigHandler（main 进程 config）

**Files:** Create `electron/services/xingyunConfigHandler.ts`, `tests/xingyunConfigHandler.test.ts`

- [ ] **Step 1：先写失败测试** —— 创建 `tests/xingyunConfigHandler.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getXingyunConfig, DEFAULT_GATEWAY } from '../electron/services/xingyunConfigHandler'

describe('getXingyunConfig', () => {
  it('returns not-configured when APP_ID missing', () => {
    const r = getXingyunConfig({ XINGYUN_APP_SECRET: 's' })
    expect(r.configured).toBe(false)
    if (!r.configured) {
      expect(r.missingKey).toBe(true)
      expect(r.errorReason).toContain('XINGYUN_APP_ID')
    }
  })

  it('returns not-configured when APP_SECRET missing', () => {
    const r = getXingyunConfig({ XINGYUN_APP_ID: 'a' })
    expect(r.configured).toBe(false)
  })

  it('returns configured with default gateway when GATEWAY unset', () => {
    const r = getXingyunConfig({ XINGYUN_APP_ID: 'a', XINGYUN_APP_SECRET: 's' })
    expect(r.configured).toBe(true)
    if (r.configured) {
      expect(r.appId).toBe('a')
      expect(r.appSecret).toBe('s')
      expect(r.gatewayServer).toBe(DEFAULT_GATEWAY)
    }
  })

  it('uses custom gateway when provided', () => {
    const r = getXingyunConfig({ XINGYUN_APP_ID: 'a', XINGYUN_APP_SECRET: 's', XINGYUN_GATEWAY_SERVER: 'https://gw.example/x' })
    expect(r.configured && r.gatewayServer).toBe('https://gw.example/x')
  })

  it('errorReason does not contain the secret', () => {
    const r = getXingyunConfig({ XINGYUN_APP_SECRET: 'super-secret' })
    expect(JSON.stringify(r)).not.toContain('super-secret')
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/xingyunConfigHandler.test.ts`
Expected: FAIL `Cannot find module ...xingyunConfigHandler`。

- [ ] **Step 3：实现 `electron/services/xingyunConfigHandler.ts`**

```ts
import type { XingyunConfigStatus } from '../../shared/types'

export const DEFAULT_GATEWAY = 'https://nebula-agent.xingyun3d.com/user/v1/ttsa/session'

export function getXingyunConfig(env: NodeJS.ProcessEnv = process.env): XingyunConfigStatus {
  const appId = env.XINGYUN_APP_ID ?? ''
  const appSecret = env.XINGYUN_APP_SECRET ?? ''
  if (!appId || !appSecret) {
    return {
      configured: false,
      missingKey: true,
      errorReason: '未配置魔珐 — 请在 .env 填 XINGYUN_APP_ID / XINGYUN_APP_SECRET',
    }
  }
  return {
    configured: true,
    appId,
    appSecret,
    gatewayServer: env.XINGYUN_GATEWAY_SERVER || DEFAULT_GATEWAY,
  }
}
```

- [ ] **Step 4：跑测试确认通过**

Run: `npx vitest run tests/xingyunConfigHandler.test.ts`
Expected: 全 PASS。

- [ ] **Step 5：commit**

```bash
git add electron/services/xingyunConfigHandler.ts tests/xingyunConfigHandler.test.ts
git commit -m "feat(electron): add getXingyunConfig (gateway optional with default; secret-safe)"
```

---

## Task 4：electron 接线（main IPC + preload + 类型）

**Files:** Modify `electron/main.ts`, `electron/preload.ts`, `src/types/electron.d.ts`

> 无独立单测——Task 3 已覆盖 config 逻辑，Task 7/11 的 renderer 集成 + 手动验收覆盖接线。

- [ ] **Step 1：`electron/main.ts` 注册 IPC** —— 在 import 块追加：

```ts
import { getXingyunConfig } from './services/xingyunConfigHandler'
import type { XingyunConfigStatus } from '../shared/types'
```

在文件**末尾**追加：

```ts
// IPC: 魔珐 config（含 sender 校验——返回 appSecret，必须确认是真实窗口）
ipcMain.handle('xingyun-get-config', (event): XingyunConfigStatus => {
  if (!BrowserWindow.fromWebContents(event.sender)) {
    return { configured: false, missingKey: true, errorReason: 'invalid sender' }
  }
  return getXingyunConfig()
})
```

- [ ] **Step 2：`electron/preload.ts` 平铺暴露** —— 在 `transcribeAudio` 方法之后（对象内）追加：

```ts
  xingyunGetConfig(): Promise<import('../shared/types').XingyunConfigStatus> {
    return ipcRenderer.invoke('xingyun-get-config')
  },
```

- [ ] **Step 3：`src/types/electron.d.ts` 追加类型** —— import 块改为：

```ts
import type {
  AppError,
  AIResponse,
  AgentMessage,
  XingyunConfigStatus,
} from '@shared/types'
```

在 `electronAPI` interface 内 `transcribeAudio` 行之后追加：

```ts
      xingyunGetConfig(): Promise<XingyunConfigStatus>
```

- [ ] **Step 4：`npx tsc --noEmit && npx vitest run`** → tsc 干净；现有测试全过。

- [ ] **Step 5：commit**

```bash
git add electron/main.ts electron/preload.ts src/types/electron.d.ts
git commit -m "feat(electron): wire xingyun-get-config IPC; flat-extend electronAPI"
```

---

## Task 5：SSML 构建（buildSSML + 转义）

**Files:** Create `src/services/xingyun/ssml.ts`, `tests/xingyunSsml.test.ts`

- [ ] **Step 1：先写失败测试** —— 创建 `tests/xingyunSsml.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { buildSSML, escapeXml } from '../src/services/xingyun/ssml'

describe('xingyun ssml', () => {
  it('escapes & < > in order', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('wraps text in <speak> with escaping', () => {
    expect(buildSSML('1 < 2 & true')).toBe('<speak>1 &lt; 2 &amp; true</speak>')
  })

  it('handles plain Chinese text', () => {
    expect(buildSSML('你好世界')).toBe('<speak>你好世界</speak>')
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/xingyunSsml.test.ts`
Expected: FAIL `Cannot find module`。

- [ ] **Step 3：实现 `src/services/xingyun/ssml.ts`**

```ts
// & 必须最先替换，否则会二次转义 &lt; 里的 &
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildSSML(text: string): string {
  return `<speak>${escapeXml(text)}</speak>`
}
```

- [ ] **Step 4：跑测试确认通过** → 全 PASS。

- [ ] **Step 5：commit**

```bash
git add src/services/xingyun/ssml.ts tests/xingyunSsml.test.ts
git commit -m "feat(xingyun): add buildSSML with XML escaping"
```

---

## Task 6：XingyunClient（renderer SDK 封装）

**Files:** Create `src/services/xingyun/types.ts`, `src/types/xingyun-sdk.d.ts`, `src/services/xingyun/XingyunClient.ts`, `tests/XingyunClient.test.ts`

> 核心：构造器接受 `sdkFactory` 注入假 SDK（happy-dom 无 `window.XmovAvatar`）。pending speak **单一收尾契约**：voice 'end'→`'completed'`；interrupt/destroy→`'interrupted'`（绝不 reject）；speak 期致命 onMessage→reject `XY_SPEAK`。

- [ ] **Step 1：建常量/工厂 `src/services/xingyun/types.ts`**

```ts
import type { XingyunErrorCode, XingyunError } from '@shared/types'

export const XINGYUN_CONTAINER_ID = 'xingyun-stage'

export function xyError(code: XingyunErrorCode, message: string): XingyunError {
  return { code, message, recoverable: code !== 'XY_NOT_CONFIGURED' }
}
```

- [ ] **Step 2：建 SDK 类型声明 `src/types/xingyun-sdk.d.ts`**

```ts
export interface XmovAvatarOptions {
  containerId: string
  appId: string
  appSecret: string
  gatewayServer: string
  enableLogger?: boolean
  onStateChange?: (state: string) => void
  onVoiceStateChange?: (status: string) => void
  onMessage?: (msg: unknown) => void
  onNetworkInfo?: (info: unknown) => void
}

export interface XmovAvatarInstance {
  speak(ssml: string, isStart: boolean, isEnd: boolean): void
  interactiveidle(): void
  idle(): void
  offlineMode(): void
  destroy(): void
}

declare global {
  interface Window {
    XmovAvatar?: new (options: XmovAvatarOptions) => XmovAvatarInstance
  }
}

export {}
```

- [ ] **Step 3：先写失败测试** —— 创建 `tests/XingyunClient.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { XingyunClient } from '../src/services/xingyun/XingyunClient'
import type { XmovAvatarOptions, XmovAvatarInstance } from '../src/types/xingyun-sdk'
import type { XingyunConfig } from '@shared/types'

const cfg: XingyunConfig = { appId: 'a', appSecret: 's', gatewayServer: 'wss://gw' }

// 受测试驱动的假 SDK：记下回调，暴露触发器
class FakeSdk implements XmovAvatarInstance {
  opts: XmovAvatarOptions
  speakCalls: Array<[string, boolean, boolean]> = []
  interrupted = 0
  destroyed = 0
  constructor(opts: XmovAvatarOptions) { this.opts = opts }
  speak(ssml: string, s: boolean, e: boolean) { this.speakCalls.push([ssml, s, e]) }
  interactiveidle() { this.interrupted++ }
  idle() {}
  offlineMode() {}
  destroy() { this.destroyed++ }
  // 测试触发器
  emitState(st: string) { this.opts.onStateChange?.(st) }
  emitVoice(st: string) { this.opts.onVoiceStateChange?.(st) }
  emitMessage(m: unknown) { this.opts.onMessage?.(m) }
}

function make(): { client: XingyunClient; sdk: () => FakeSdk } {
  let sdk!: FakeSdk
  const client = new XingyunClient((opts) => { sdk = new FakeSdk(opts); return sdk })
  return { client, sdk: () => sdk }
}

describe('XingyunClient.open', () => {
  it('constructs SDK with #containerId + config, resolves on ready state', async () => {
    const { client, sdk } = make()
    const p = client.open(cfg, 'xingyun-stage')
    sdk().emitState('idle')              // 就绪态
    await expect(p).resolves.toBeUndefined()
    expect(sdk().opts.containerId).toBe('#xingyun-stage')
    expect(sdk().opts.appId).toBe('a')
    expect(sdk().opts.appSecret).toBe('s')
    expect(sdk().opts.gatewayServer).toBe('wss://gw')
    expect(client.isOpen()).toBe(true)
  })

  it('rejects XY_CONNECT on fatal onMessage before ready', async () => {
    const { client, sdk } = make()
    const p = client.open(cfg, 'xingyun-stage')
    sdk().emitMessage({ code: 40001, msg: 'auth fail' })
    await expect(p).rejects.toMatchObject({ code: 'XY_CONNECT' })
  })
})

describe('XingyunClient.speak', () => {
  async function opened() {
    const h = make()
    const p = h.client.open(cfg, 'xingyun-stage')
    h.sdk().emitState('idle')
    await p
    return h
  }

  it('calls SDK.speak with built SSML and resolves "completed" on voice end', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('你好 < 世界')
    expect(sdk().speakCalls[0]).toEqual(['<speak>你好 &lt; 世界</speak>', true, true])
    sdk().emitVoice('end')
    await expect(sp).resolves.toBe('completed')
  })

  it('interrupt() resolves pending speak "interrupted" BEFORE calling interactiveidle', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('讲一段话')
    client.interrupt()
    await expect(sp).resolves.toBe('interrupted')
    expect(sdk().interrupted).toBe(1)
  })

  it('destroy() resolves pending speak "interrupted" (never rejects) then destroys', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('讲一段话')
    client.destroy()
    await expect(sp).resolves.toBe('interrupted')
    expect(sdk().destroyed).toBe(1)
    expect(client.isOpen()).toBe(false)
  })

  it('rejects XY_SPEAK on fatal onMessage during speak', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('讲一段话')
    sdk().emitMessage({ code: 50002, msg: 'stream error' })
    await expect(sp).rejects.toMatchObject({ code: 'XY_SPEAK' })
  })

  it('benign onMessage (no error code) does not settle pending speak', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('讲一段话')
    sdk().emitMessage({ type: 'subtitle_on' })
    let settled = false
    void sp.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    sdk().emitVoice('end')
    await expect(sp).resolves.toBe('completed')
  })
})
```

- [ ] **Step 4：跑测试确认失败**

Run: `npx vitest run tests/XingyunClient.test.ts`
Expected: FAIL `Cannot find module ...XingyunClient`。

- [ ] **Step 5：实现 `src/services/xingyun/XingyunClient.ts`**

```ts
import type { XingyunConfig } from '@shared/types'
import type { XmovAvatarOptions, XmovAvatarInstance } from '../../types/xingyun-sdk'
import { xyError } from './types'
import { buildSSML } from './ssml'

type SdkFactory = (options: XmovAvatarOptions) => XmovAvatarInstance

// 首连含 3D 资源下载（实测 ~30s）；复用连接后无此问题
const CONNECT_TIMEOUT_MS = 30_000
// 就绪态：onStateChange 进入运行态即视为连上（实现首日按真实取值确认/收窄）
const READY_STATES = new Set(['idle', 'interactiveidle', 'listen', 'think'])

// 魔珐错误码段 10001–50004；onMessage 也会带 widget/info 等非错误消息，需甄别
function looksLikeError(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Record<string, unknown>
  const code = m.code ?? m.errorCode ?? m.error_code
  if (typeof code === 'number' && code >= 10000) return true
  return m.type === 'error'
}
function describeMsg(msg: unknown): string {
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>
    return String(m.msg ?? m.message ?? JSON.stringify(m))
  }
  return String(msg)
}

function defaultSdkFactory(options: XmovAvatarOptions): XmovAvatarInstance {
  if (typeof window.XmovAvatar !== 'function') {
    throw xyError('XY_SCRIPT', 'window.XmovAvatar 未加载（vendor 脚本未引入或加载失败）')
  }
  return new window.XmovAvatar(options)
}

export class XingyunClient {
  private sdk: XmovAvatarInstance | null = null
  private opened = false
  private pendingSpeak: {
    resolve: (r: 'completed' | 'interrupted') => void
    reject: (e: unknown) => void
  } | null = null

  constructor(private readonly sdkFactory: SdkFactory = defaultSdkFactory) {}

  isOpen(): boolean { return this.opened }

  open(config: XingyunConfig, containerId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(xyError('XY_CONNECT', `建联超时（>${CONNECT_TIMEOUT_MS}ms）`))
      }, CONNECT_TIMEOUT_MS)

      const finishOpen = (err?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) { reject(err); return }
        this.opened = true
        resolve()
      }

      try {
        this.sdk = this.sdkFactory({
          containerId: `#${containerId}`,
          appId: config.appId,
          appSecret: config.appSecret,
          gatewayServer: config.gatewayServer,
          enableLogger: false,
          onStateChange: (state: string) => {
            if (READY_STATES.has(state)) finishOpen()
          },
          onVoiceStateChange: (status: string) => {
            if (status === 'end' && this.pendingSpeak) {
              const p = this.pendingSpeak
              this.pendingSpeak = null
              p.resolve('completed')
            }
          },
          onMessage: (msg: unknown) => {
            if (!looksLikeError(msg)) return
            const reason = describeMsg(msg)
            if (!settled) { finishOpen(xyError('XY_CONNECT', reason)); return }
            // 就绪后致命错：优先 reject 正在等待的 speak（→ useAI fallback）
            if (this.pendingSpeak) {
              const p = this.pendingSpeak
              this.pendingSpeak = null
              p.reject(xyError('XY_SPEAK', reason))
            }
            // 无 pending speak（空闲期断连）：标记失效，下次 ensureConnected 重建
            this.opened = false
          },
        })
      } catch (e) {
        finishOpen(e)
      }
    })
  }

  speak(text: string): Promise<'completed' | 'interrupted'> {
    const sdk = this.sdk
    if (!sdk) return Promise.reject(xyError('XY_SDK', 'no active sdk'))
    this.settleInterrupted()  // 防御：上一条未收尾先结算
    return new Promise<'completed' | 'interrupted'>((resolve, reject) => {
      this.pendingSpeak = { resolve, reject }
      try {
        sdk.speak(buildSSML(text), true, true)
      } catch (e) {
        this.pendingSpeak = null
        reject(xyError('XY_SPEAK', e instanceof Error ? e.message : String(e)))
      }
    })
  }

  interrupt(): void {
    this.settleInterrupted()        // 先把 pending speak resolve 成 'interrupted'
    try { this.sdk?.interactiveidle() } catch { /* ignore */ }
  }

  destroy(): void {
    this.settleInterrupted()        // 主动断开绝不 reject pending（避免误判失败）
    try { this.sdk?.destroy() } catch { /* ignore */ }
    this.sdk = null
    this.opened = false
  }

  // 把挂起的 speak 干净 resolve 成 'interrupted'（用于 interrupt/destroy）
  private settleInterrupted(): void {
    if (this.pendingSpeak) {
      const p = this.pendingSpeak
      this.pendingSpeak = null
      p.resolve('interrupted')
    }
  }
}
```

- [ ] **Step 6：跑测试确认通过**

Run: `npx vitest run tests/XingyunClient.test.ts`
Expected: 全 PASS。

- [ ] **Step 7：commit**

```bash
git add src/services/xingyun/types.ts src/types/xingyun-sdk.d.ts src/services/xingyun/XingyunClient.ts tests/XingyunClient.test.ts
git commit -m "feat(xingyun): add XingyunClient (SDK wrapper, pending-speak single-settlement contract)"
```

---

## Task 7：sessionManager（idle-timeout + 单例）

**Files:** Create `src/services/xingyun/sessionManager.ts`, `src/services/xingyun/index.ts`, `tests/sessionManager.test.ts`

- [ ] **Step 1：先写失败测试** —— 创建 `tests/sessionManager.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SessionManager } from '../src/services/xingyun/sessionManager'
import { useAgentStore, initialState } from '../src/store/agentStore'
import type { XingyunClient } from '../src/services/xingyun/XingyunClient'

function fakeClient(over: Partial<XingyunClient> = {}): XingyunClient {
  return {
    isOpen: vi.fn().mockReturnValue(false),
    open: vi.fn().mockResolvedValue(undefined),
    speak: vi.fn().mockResolvedValue('completed'),
    interrupt: vi.fn(),
    destroy: vi.fn(),
    ...over,
  } as unknown as XingyunClient
}

const okConfig = { configured: true, appId: 'a', appSecret: 's', gatewayServer: 'wss://gw' }

beforeEach(() => {
  useAgentStore.setState(initialState)
  ;(window as unknown as { electronAPI: { xingyunGetConfig: () => Promise<unknown> } }).electronAPI = {
    xingyunGetConfig: vi.fn().mockResolvedValue(okConfig),
  }
})
afterEach(() => { vi.clearAllMocks() })

describe('SessionManager', () => {
  it('ensureConnected opens a client and sets cloudConn connecting→streaming', async () => {
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()
    expect(client.open).toHaveBeenCalledWith(okConfig, 'xingyun-stage')
    expect(useAgentStore.getState().cloudConn).toBe('streaming')
  })

  it('ensureConnected opens once, then reuses the open client (no second open)', async () => {
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(true) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()   // client 为 null → 必然 open 一次
    await sm.ensureConnected()   // isOpen()=true → 复用，不再 open
    expect(client.open).toHaveBeenCalledTimes(1)
  })

  it('throws XY_NOT_CONFIGURED when config missing', async () => {
    ;(window as unknown as { electronAPI: { xingyunGetConfig: () => Promise<unknown> } }).electronAPI = {
      xingyunGetConfig: vi.fn().mockResolvedValue({ configured: false, missingKey: true, errorReason: 'no key' }),
    }
    const sm = new SessionManager(() => fakeClient())
    await expect(sm.ensureConnected()).rejects.toMatchObject({ code: 'XY_NOT_CONFIGURED' })
  })

  it('notifyIdle destroys the client after IDLE_TIMEOUT and sets cloudConn idle', async () => {
    vi.useFakeTimers()
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()
    sm.notifyIdle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.destroy).toHaveBeenCalled()
    expect(useAgentStore.getState().cloudConn).toBe('idle')
    vi.useRealTimers()
  })

  it('closeNow destroys the client and sets cloudConn idle', async () => {
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()
    await sm.closeNow()
    expect(client.destroy).toHaveBeenCalled()
    expect(useAgentStore.getState().cloudConn).toBe('idle')
  })

  it('interrupt delegates to the active client', async () => {
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()
    sm.interrupt()
    expect(client.interrupt).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/sessionManager.test.ts`
Expected: FAIL `Cannot find module ...sessionManager`。

- [ ] **Step 3：实现 `src/services/xingyun/sessionManager.ts`**

```ts
import { XingyunClient } from './XingyunClient'
import { XINGYUN_CONTAINER_ID, xyError } from './types'
import { useAgentStore } from '../../store/agentStore'

const IDLE_TIMEOUT_MS = 60_000  // 按会话时长计费，空闲 60s 自动断（省钱）；可调

type ClientFactory = () => XingyunClient

export class SessionManager {
  private client: XingyunClient | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly clientFactory: ClientFactory = () => new XingyunClient()) {}

  async ensureConnected(): Promise<XingyunClient> {
    this.clearIdleTimer()
    if (this.client && this.client.isOpen()) return this.client
    const cfg = await window.electronAPI.xingyunGetConfig()
    if (!cfg.configured) throw xyError('XY_NOT_CONFIGURED', cfg.errorReason)
    useAgentStore.getState().setCloudConn('connecting')
    const client = this.clientFactory()
    await client.open(cfg, XINGYUN_CONTAINER_ID)
    this.client = client
    useAgentStore.getState().setCloudConn('streaming')
    return client
  }

  async speak(text: string): Promise<'completed' | 'interrupted'> {
    if (!this.client) throw xyError('XY_SDK', 'no active client; call ensureConnected first')
    return this.client.speak(text)
  }

  interrupt(): void {
    this.client?.interrupt()
  }

  notifyIdle(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => { void this.closeNow() }, IDLE_TIMEOUT_MS)
  }

  async closeNow(): Promise<void> {
    this.clearIdleTimer()
    if (this.client) {
      // destroy() 内部先把 pending speak resolve 成 'interrupted'，再断 SDK
      this.client.destroy()
      this.client = null
    }
    useAgentStore.getState().setCloudConn('idle')
  }

  getClient(): XingyunClient | null { return this.client }

  private clearIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }
}

export const sessionManager = new SessionManager()
```

- [ ] **Step 4：建 `src/services/xingyun/index.ts`**

```ts
export { sessionManager } from './sessionManager'
export { XINGYUN_CONTAINER_ID } from './types'
```

- [ ] **Step 5：跑测试确认通过** → 全 PASS。

- [ ] **Step 6：commit**

```bash
git add src/services/xingyun/sessionManager.ts src/services/xingyun/index.ts tests/sessionManager.test.ts
git commit -m "feat(xingyun): add sessionManager (idle-timeout, single client lifecycle)"
```

---

## Task 8：vendor SDK 脚本 + index.html（CSP + 引入）

**Files:** Create `public/vendor/xmovAvatar.js`, Modify `index.html`

> 无单测——手动验收（Task 14）覆盖真实加载。

- [ ] **Step 1：下载并锁版本 SDK 脚本**

```bash
mkdir -p public/vendor
curl -fsSL -o public/vendor/xmovAvatar.js \
  https://media.xingyun3d.com/xingyun3d/general/litesdk/xmovAvatar@latest.js
ls -l public/vendor/xmovAvatar.js   # 应有内容（非 0 字节）
```

把下载日期 + 文件大小记到 `XINGYUN-API-CHECK.md` 的「结论」段（便于将来比对升级）。

- [ ] **Step 2：修改 `index.html`** —— 替换为：

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self';
               style-src 'self' 'unsafe-inline';
               connect-src 'self' https://*.xingyun3d.com wss://*.xingyun3d.com;
               img-src 'self' data: blob: https://*.xingyun3d.com;
               media-src 'self' blob: https://*.xingyun3d.com;
               worker-src 'self' blob:" />
    <title>数字人助手</title>
    <!-- 魔珐 SDK：vendor 本地、由 'self' 加载，注册 window.XmovAvatar -->
    <script src="/vendor/xmovAvatar.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

> **首日联调（Task 14 手动验收时）：** 打开 DevTools，若控制台报 CSP 拦截（如 WebGL 需要 `wasm-unsafe-eval`，或资源域名不在白名单），按真实报错补/收窄 `script-src`/`connect-src`/`img-src`/`media-src`，并把最终域名清单写回 `XINGYUN-API-CHECK.md`。

- [ ] **Step 3：构建自检**

Run: `npm run build`
Expected: 构建通过；`dist/vendor/xmovAvatar.js` 存在（public 被拷进 dist）。

- [ ] **Step 4：commit**

```bash
git add public/vendor/xmovAvatar.js index.html
git commit -m "build(xingyun): vendor XmovAvatar SDK; relax CSP for xingyun3d domains"
```

---

## Task 9：抽取 LocalAvatar（纯搬迁，不动 index.tsx）

**Files:** Create `src/components/Avatar/LocalAvatar.tsx`

> 纯抽取：把现 `Avatar/index.tsx` 内容搬到 `LocalAvatar.tsx`，函数名改 `LocalAvatar`。**本任务不改 `index.tsx`**（仍导出旧 `Avatar()`，应用照常工作）→ Task 9 的 commit 绿灯、自包含、便于 subagent 交接。RouterAvatar 改造 + 两个组件测试全部放 Task 10 一次性转绿（避免提交红测试）。

- [ ] **Step 1：建 `src/components/Avatar/LocalAvatar.tsx`** —— 把现 `Avatar/index.tsx` 内容整段搬来，仅把函数名 `Avatar` 改为 `LocalAvatar`（其余 0 变动）：

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
  closed: closedPng, a: aPng, o: oPng, e: ePng, i: iPng, u: uPng,
}

export function LocalAvatar() {
  const mood = useAgentStore(s => s.mood)
  const isPushing = useAgentStore(s => s.isPushing)
  const currentViseme = useAgentStore(s => s.currentViseme)
  const setCurrentViseme = useAgentStore(s => s.setCurrentViseme)

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

- [ ] **Step 2：tsc 验证 LocalAvatar 编译，且 `index.tsx` 未动（应用仍用旧 Avatar）**

Run: `npx tsc --noEmit`
Expected: 无错。LocalAvatar.tsx 为新增、此刻暂未被引用（跨文件未用的导出不算 tsc 错），`index.tsx` 仍导出旧 `Avatar()`，应用不受影响。

- [ ] **Step 3：commit（绿灯、自包含）**

```bash
git add src/components/Avatar/LocalAvatar.tsx
git commit -m "refactor(avatar): extract LocalAvatar (verbatim move; index.tsx unchanged)"
```

---

## Task 10：CloudAvatar + RouterAvatar（一次性转绿）

**Files:** Create `src/components/Avatar/CloudAvatar.tsx`, `src/components/Avatar/CloudAvatar.module.css`, `tests/CloudAvatar.test.tsx`, `tests/RouterAvatar.test.tsx`; Rewrite `src/components/Avatar/index.tsx`

- [ ] **Step 1：先写失败测试** —— 创建 `tests/CloudAvatar.test.tsx`：

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

const mockCloseNow = vi.hoisted(() => vi.fn())
vi.mock('../src/services/xingyun', () => ({
  sessionManager: { closeNow: mockCloseNow },
  XINGYUN_CONTAINER_ID: 'xingyun-stage',
}))

import { CloudAvatar } from '../src/components/Avatar/CloudAvatar'

describe('CloudAvatar', () => {
  beforeEach(() => { useAgentStore.setState(initialState); mockCloseNow.mockClear() })

  it('always renders the SDK container div', () => {
    const { container } = render(<CloudAvatar />)
    expect(container.querySelector('#xingyun-stage')).not.toBeNull()
  })

  it('shows connecting overlay when cloudConn=connecting', () => {
    useAgentStore.setState({ cloudConn: 'connecting' })
    const { getByText } = render(<CloudAvatar />)
    expect(getByText('连接中…')).not.toBeNull()
  })

  it('shows error overlay when cloudConn=error', () => {
    useAgentStore.setState({ cloudConn: 'error' })
    const { getByText } = render(<CloudAvatar />)
    expect(getByText('连接失败')).not.toBeNull()
  })

  it('calls sessionManager.closeNow on unmount', () => {
    const { unmount } = render(<CloudAvatar />)
    unmount()
    expect(mockCloseNow).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/CloudAvatar.test.tsx`
Expected: FAIL `Cannot find module ...CloudAvatar`。

- [ ] **Step 3：实现 `src/components/Avatar/CloudAvatar.tsx`**

```tsx
import { useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { sessionManager, XINGYUN_CONTAINER_ID } from '../../services/xingyun'
import styles from './CloudAvatar.module.css'

export function CloudAvatar() {
  const cloudConn = useAgentStore(s => s.cloudConn)
  const mood = useAgentStore(s => s.mood)

  // 卸载（切回 local / 退出）时断开 SDK，停止计费
  useEffect(() => {
    return () => { void sessionManager.closeNow() }
  }, [])

  const wrapClass = [
    styles.wrap,
    mood === 'thinking' ? styles.thinking : '',
    mood === 'talking' ? styles.talking : '',
    mood === 'error' ? styles.error : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.avatar}>
      <div className={wrapClass}>
        {cloudConn === 'connecting' && <div className={styles.overlay}>连接中…</div>}
        {cloudConn === 'error' && <div className={styles.overlay}>连接失败</div>}
        {/* 魔珐 SDK 把 3D 自绘进这个容器；非 <video>，无 MediaStream */}
        <div id={XINGYUN_CONTAINER_ID} className={styles.stage} />
      </div>
    </div>
  )
}
```

- [ ] **Step 4：实现 `src/components/Avatar/CloudAvatar.module.css`**

```css
.avatar { display: flex; justify-content: center; align-items: center; }
.wrap { position: relative; width: 240px; height: 320px; }
.stage { width: 100%; height: 100%; }
.stage canvas { width: 100% !important; height: 100% !important; }
.overlay {
  position: absolute; inset: 0; z-index: 2;
  display: flex; justify-content: center; align-items: center;
  font-size: 13px; color: #8b93a1;
  background: rgba(0, 0, 0, 0.25); border-radius: 12px;
}
.thinking { opacity: 0.96; }
.talking { opacity: 1; }
.error { filter: grayscale(0.4); }
```

- [ ] **Step 5：跑 CloudAvatar 测试确认通过**

Run: `npx vitest run tests/CloudAvatar.test.tsx`
Expected: 全 PASS。

- [ ] **Step 6：写 RouterAvatar 测试 + 重写 `index.tsx`（RouterAvatar）**

创建 `tests/RouterAvatar.test.tsx`：

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

// mock 两个子组件，避免拉入 PNG 资源 / 魔珐 SDK
vi.mock('../src/components/Avatar/LocalAvatar', () => ({
  LocalAvatar: () => <div data-testid="local-avatar" />,
}))
vi.mock('../src/components/Avatar/CloudAvatar', () => ({
  CloudAvatar: () => <div data-testid="cloud-avatar" />,
}))

import { Avatar } from '../src/components/Avatar'

describe('RouterAvatar', () => {
  beforeEach(() => { useAgentStore.setState(initialState) })

  it('renders CloudAvatar when renderMode is cloud (default)', () => {
    const { queryByTestId } = render(<Avatar />)
    expect(queryByTestId('cloud-avatar')).not.toBeNull()
    expect(queryByTestId('local-avatar')).toBeNull()
  })

  it('renders LocalAvatar when renderMode is local', () => {
    useAgentStore.setState({ renderMode: 'local' })
    const { queryByTestId } = render(<Avatar />)
    expect(queryByTestId('local-avatar')).not.toBeNull()
    expect(queryByTestId('cloud-avatar')).toBeNull()
  })
})
```

重写 `src/components/Avatar/index.tsx`：

```tsx
import { LocalAvatar } from './LocalAvatar'
import { CloudAvatar } from './CloudAvatar'
import { useAgentStore } from '../../store/agentStore'

export function Avatar() {
  const renderMode = useAgentStore(s => s.renderMode)
  return renderMode === 'cloud' ? <CloudAvatar /> : <LocalAvatar />
}
```

- [ ] **Step 7：跑两个组件测试 + 全量 tsc 确认全绿**

Run: `npx vitest run tests/CloudAvatar.test.tsx tests/RouterAvatar.test.tsx && npx tsc --noEmit`
Expected: 两个测试全 PASS；tsc 干净。

- [ ] **Step 8：commit（CloudAvatar + index.tsx + 两个测试一起，整体绿灯）**

```bash
git add src/components/Avatar/CloudAvatar.tsx src/components/Avatar/CloudAvatar.module.css src/components/Avatar/index.tsx tests/CloudAvatar.test.tsx tests/RouterAvatar.test.tsx
git commit -m "feat(avatar): add CloudAvatar (SDK container) + RouterAvatar routing by renderMode"
```

---

## Task 11：ModeToggle（极简 toggle + config 预查 + toast）

**Files:** Create `src/components/ModeToggle/index.tsx`, `src/components/ModeToggle/ModeToggle.module.css`, `tests/ModeToggle.test.tsx`

- [ ] **Step 1：先写失败测试** —— 创建 `tests/ModeToggle.test.tsx`：

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

const mockCloseNow = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../src/services/xingyun', () => ({
  sessionManager: { closeNow: mockCloseNow },
  XINGYUN_CONTAINER_ID: 'xingyun-stage',
}))

import { ModeToggle } from '../src/components/ModeToggle'

function setConfig(configured: boolean) {
  ;(window as unknown as { electronAPI: { xingyunGetConfig: () => Promise<unknown> } }).electronAPI = {
    xingyunGetConfig: vi.fn().mockResolvedValue(
      configured
        ? { configured: true, appId: 'a', appSecret: 's', gatewayServer: 'wss://gw' }
        : { configured: false, missingKey: true, errorReason: '未配置魔珐 — 请在 .env 填 XINGYUN_APP_ID / XINGYUN_APP_SECRET' },
    ),
  }
}

describe('ModeToggle', () => {
  beforeEach(() => { useAgentStore.setState(initialState); mockCloseNow.mockClear() })
  afterEach(() => { vi.clearAllMocks() })

  it('disables button + forces local when not configured', async () => {
    setConfig(false)
    let utils!: ReturnType<typeof render>
    await act(async () => { utils = render(<ModeToggle />); await Promise.resolve() })
    const btn = utils.container.querySelector('button')!
    expect(btn.disabled).toBe(true)
    expect(useAgentStore.getState().renderMode).toBe('local')
  })

  it('toggles cloud→local (calls closeNow) and local→cloud on click when configured', async () => {
    setConfig(true)
    let utils!: ReturnType<typeof render>
    await act(async () => { utils = render(<ModeToggle />); await Promise.resolve() })
    const btn = utils.container.querySelector('button')!
    expect(btn.disabled).toBe(false)
    expect(useAgentStore.getState().renderMode).toBe('cloud')

    await act(async () => { btn.click(); await Promise.resolve() })   // cloud → local
    expect(mockCloseNow).toHaveBeenCalled()
    expect(useAgentStore.getState().renderMode).toBe('local')

    await act(async () => { btn.click(); await Promise.resolve() })   // local → cloud
    expect(useAgentStore.getState().renderMode).toBe('cloud')
  })

  it('shows a toast when cloudLastError is set', async () => {
    setConfig(true)
    let utils!: ReturnType<typeof render>
    await act(async () => { utils = render(<ModeToggle />); await Promise.resolve() })
    act(() => { useAgentStore.getState().setCloudError('连接失败：超时') })
    expect(utils.getByText(/连接失败：超时/)).not.toBeNull()
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/ModeToggle.test.tsx`
Expected: FAIL `Cannot find module ...ModeToggle`。

- [ ] **Step 3：实现 `src/components/ModeToggle/index.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { sessionManager } from '../../services/xingyun'
import styles from './ModeToggle.module.css'

export function ModeToggle() {
  const renderMode = useAgentStore(s => s.renderMode)
  const cloudConn = useAgentStore(s => s.cloudConn)
  const cloudLastError = useAgentStore(s => s.cloudLastError)
  const setRenderMode = useAgentStore(s => s.setRenderMode)
  const setCloudError = useAgentStore(s => s.setCloudError)

  const [disabled, setDisabled] = useState(true)
  const [disabledReason, setDisabledReason] = useState('')

  // 配置预查：未配置 → 禁用 + 强制本地
  useEffect(() => {
    let alive = true
    window.electronAPI.xingyunGetConfig().then(cfg => {
      if (!alive) return
      if (cfg.configured) {
        setDisabled(false)
      } else {
        setDisabled(true)
        setDisabledReason(cfg.errorReason)
        useAgentStore.getState().setRenderMode('local')
      }
    })
    return () => { alive = false }
  }, [])

  // toast 自动消失
  useEffect(() => {
    if (!cloudLastError) return
    const t = setTimeout(() => setCloudError(null), 5000)
    return () => clearTimeout(t)
  }, [cloudLastError, setCloudError])

  const connecting = renderMode === 'cloud' && cloudConn === 'connecting'

  const label =
    renderMode === 'local' ? '🎭 本地模式'
    : cloudConn === 'connecting' ? '✨ 连接中…'
    : cloudConn === 'idle' ? '✨ 魔珐 · 待机'
    : '✨ 魔珐'

  const onClick = async () => {
    if (renderMode === 'cloud') {
      await sessionManager.closeNow()
      setRenderMode('local')
    } else {
      setRenderMode('cloud')
    }
  }

  return (
    <div className={styles.root}>
      <button
        className={styles.toggle}
        disabled={disabled || connecting}
        title={disabled ? disabledReason : ''}
        onClick={onClick}
      >
        {label}
      </button>
      {cloudLastError && (
        <div className={styles.toast} onClick={() => setCloudError(null)}>
          {cloudLastError}（点右上角可重试）
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4：实现 `src/components/ModeToggle/ModeToggle.module.css`**

```css
/* shell 是 -webkit-app-region: drag 区域；交互组件必须显式 no-drag 才能点击，否则会变成拖窗口 */
.root {
  position: absolute; top: 8px; right: 8px; z-index: 10;
  -webkit-app-region: no-drag;
}
.toggle {
  font-size: 12px; padding: 4px 10px; border: 0; border-radius: 999px;
  background: rgba(37, 99, 235, 0.9); color: #fff; cursor: pointer;
  -webkit-app-region: no-drag;
}
.toggle:disabled { opacity: 0.45; cursor: not-allowed; }
.toast {
  position: absolute; top: 32px; right: 0; width: 220px;
  font-size: 12px; padding: 8px 10px; border-radius: 8px;
  background: #b91c1c; color: #fff; cursor: pointer;
  -webkit-app-region: no-drag;
}
```

- [ ] **Step 5：跑测试确认通过** → 全 PASS。

- [ ] **Step 6：commit**

```bash
git add src/components/ModeToggle/ tests/ModeToggle.test.tsx
git commit -m "feat(toggle): add minimal ModeToggle (config preflight, no modal, error toast)"
```

---

## Task 12：useAI 改造（按 renderMode 分支 + fallback）

**Files:** Modify `src/hooks/useAI.ts`, `tests/useAI.test.ts`

- [ ] **Step 1：先扩展测试** —— 在 `tests/useAI.test.ts` 顶部 mock 块追加 sessionManager mock：

在现有 `vi.mock('../src/services/lipsync', ...)` 之后追加：

```ts
const mockEnsure = vi.hoisted(() => vi.fn())
const mockSessionSpeak = vi.hoisted(() => vi.fn())
const mockInterrupt = vi.hoisted(() => vi.fn())
const mockNotifyIdle = vi.hoisted(() => vi.fn())
const mockSessionClose = vi.hoisted(() => vi.fn())

vi.mock('../src/services/xingyun', () => ({
  sessionManager: {
    ensureConnected: mockEnsure,
    speak: mockSessionSpeak,
    interrupt: mockInterrupt,
    notifyIdle: mockNotifyIdle,
    closeNow: mockSessionClose,
  },
  XINGYUN_CONTAINER_ID: 'xingyun-stage',
}))
```

在 `beforeEach` 里（`useAgentStore.setState(initialState)` 之后）追加 cloud 默认 + 默认 resolved：

```ts
    mockEnsure.mockResolvedValue(undefined)
    mockSessionSpeak.mockResolvedValue('completed')
    mockSessionClose.mockResolvedValue(undefined)
```

> 注意：现有测试默认 `renderMode='cloud'`（store 新初值）。**现有那些断言 lipSync 的用例需要显式切到 local** 才仍成立——在每个现有 `it` 的 `sendMessage` 之前加 `useAgentStore.setState({ renderMode: 'local' })`，或在 `beforeEach` 统一加。**采用 beforeEach 统一加 `useAgentStore.setState({ renderMode: 'local' })`**，再为 cloud 路径单开 describe（下方）。

在 `beforeEach` 末尾追加：

```ts
    useAgentStore.setState({ renderMode: 'local' })   // 现有 local 路径用例保持成立
```

在文件末尾 `})`（最后一个 describe 收尾）之前追加 cloud describe：

```ts
  describe('cloud mode (魔珐)', () => {
    beforeEach(() => {
      useAgentStore.setState({ renderMode: 'cloud' })
    })

    it('cloud path calls sessionManager.speak, NOT lipSync', async () => {
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('摩擦力'); await vi.runAllTicks() })
      expect(mockSessionSpeak).toHaveBeenCalledWith(mockReply)
      expect(mockLipStart).not.toHaveBeenCalled()
    })

    it('completed speak calls notifyIdle and returns to idle', async () => {
      mockSessionSpeak.mockResolvedValue('completed')
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('摩擦力'); await vi.runAllTicks() })
      expect(mockNotifyIdle).toHaveBeenCalled()
      expect(useAgentStore.getState().mood).toBe('idle')
    })

    it('interrupted speak does NOT notifyIdle and does NOT fallback', async () => {
      mockSessionSpeak.mockResolvedValue('interrupted')
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('摩擦力'); await vi.runAllTicks() })
      expect(mockNotifyIdle).not.toHaveBeenCalled()
      expect(mockLipStart).not.toHaveBeenCalled()      // 没有本地补讲
      expect(useAgentStore.getState().renderMode).toBe('cloud')  // 没被翻回 local
    })

    it('rejected speak falls back to local: renderMode→local + local lipSync 补讲', async () => {
      mockSessionSpeak.mockRejectedValue({ code: 'XY_SPEAK', message: 'boom', recoverable: true })
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('摩擦力'); await vi.runAllTicks() })
      expect(useAgentStore.getState().renderMode).toBe('local')
      expect(useAgentStore.getState().cloudLastError).toBeTruthy()
      expect(mockLipStart).toHaveBeenCalledWith(mockReply, expect.any(Function))
    })

    it('new message interrupts current speak (cloud)', async () => {
      mockSessionSpeak.mockResolvedValueOnce('interrupted').mockResolvedValue('completed')
      const { result } = renderHook(() => useAI())
      await act(async () => { result.current.sendMessage('first'); await vi.runAllTicks() })
      await act(async () => { result.current.sendMessage('second'); await vi.runAllTicks() })
      expect(mockInterrupt).toHaveBeenCalled()
    })
  })
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/useAI.test.ts`
Expected: cloud describe 的用例 FAIL（useAI 尚未分支）。

- [ ] **Step 3：修改 `src/hooks/useAI.ts`** —— 替换整个文件为：

```ts
import { useCallback, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import { ttsProvider } from '../services/tts'
import { lipSyncController } from '../services/lipsync'
import { sessionManager } from '../services/xingyun'
import { isAppError } from '../services/ai/ElectronAIProvider'
import type { AppError } from '@shared/types'

export function useAI() {
  const generationRef = useRef(0)

  const sendMessage = useCallback(async (text: string) => {
    if (useAgentStore.getState().isLoading) return

    const myGen = ++generationRef.current

    // 新一轮开始：停掉上一条（两种模式都打断）
    ttsProvider.stop()
    lipSyncController.stop()
    if (useAgentStore.getState().renderMode === 'cloud') {
      sessionManager.interrupt()   // 魔珐真打断；让旧 speak resolve 成 'interrupted'
    }

    const store = useAgentStore.getState()
    store.setLastUserInput(text)
    store.setIsLoading(true)
    store.setMood('thinking')
    store.setError(null)
    store.addMessage({ role: 'user', content: text })

    const finishTalkingLocal = () => {
      if (generationRef.current !== myGen) return
      lipSyncController.stop()
      const st = useAgentStore.getState()
      st.setMood('idle')
      st.setIsPushing(false)
    }

    const handleCloudFailure = (err: unknown, reply: string) => {
      void sessionManager.closeNow()
      const st = useAgentStore.getState()
      const reason = isAppError(err) ? (err as AppError).message : '魔珐连接失败'
      st.setRenderMode('local')                 // 不变量：currentViseme 同步 closed
      st.setCloudError(`魔珐数字人连接失败：${reason}`)
      st.setCloudConn('idle')
      // 本地补讲，保证用户听到完整答案
      lipSyncController.start(reply, st.setCurrentViseme)
      ttsProvider.speak(reply).then(finishTalkingLocal, finishTalkingLocal)
    }

    try {
      const response = await aiProvider.chat(useAgentStore.getState().messages)

      const s = useAgentStore.getState()
      s.addMessage({ role: 'assistant', content: response.reply })
      s.setResourceCards(response.resourceCards)
      s.setIsPushing(response.resourceCards.length > 0)
      s.setMood('talking')
      s.setIsLoading(false)

      const mode = useAgentStore.getState().renderMode   // 按"决策时刻"的模式走

      if (mode === 'local') {
        lipSyncController.start(response.reply, useAgentStore.getState().setCurrentViseme)
        ttsProvider.speak(response.reply).then(finishTalkingLocal, finishTalkingLocal)
      } else {
        try {
          await sessionManager.ensureConnected()
          const result = await sessionManager.speak(response.reply)  // 'completed' | 'interrupted'
          if (generationRef.current !== myGen) return
          if (result === 'interrupted') return                       // 被打断/被切：不收尾、不计 idle
          sessionManager.notifyIdle()
          const st = useAgentStore.getState()
          st.setMood('idle')
          st.setIsPushing(false)
        } catch (cloudErr) {
          if (generationRef.current !== myGen) return
          handleCloudFailure(cloudErr, response.reply)
        }
      }
    } catch (err: unknown) {
      if (useAgentStore.getState().renderMode === 'cloud') {
        void sessionManager.closeNow()
      }
      const appError: AppError = isAppError(err)
        ? (err as AppError)
        : { code: 'AI_ERROR', message: err instanceof Error ? err.message : String(err), recoverable: true }

      ttsProvider.stop()
      lipSyncController.stop()
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
}
```

- [ ] **Step 4：跑全量 useAI 测试确认通过**

Run: `npx vitest run tests/useAI.test.ts`
Expected: 现有 local 用例 + 新 cloud 用例全 PASS。

- [ ] **Step 5：commit**

```bash
git add src/hooks/useAI.ts tests/useAI.test.ts
git commit -m "feat(useAI): branch by renderMode; cloud speak + auto-fallback to local"
```

---

## Task 13：App.tsx 挂载 ModeToggle

**Files:** Modify `src/App.tsx`

> 无独立单测——Task 11 已覆盖 ModeToggle 行为；此处仅挂载。

- [ ] **Step 1：修改 `src/App.tsx`** —— 在 import 块追加 `import { ModeToggle } from './components/ModeToggle'`，并在 `<div className={styles.shell}>` 内、`<Avatar />` 之前渲染 `<ModeToggle />`：

```tsx
import { useRef } from 'react'
import { Avatar } from './components/Avatar'
import { ModeToggle } from './components/ModeToggle'
import { ResourceCard } from './components/ResourceCard'
import { InputBar } from './components/InputBar'
import { useAgentStore } from './store/agentStore'
import { useAutoResizeWindow } from './hooks/useAutoResizeWindow'
import { useAI } from './hooks/useAI'
import styles from './App.module.css'

export default function App() {
  const resourceCards = useAgentStore(state => state.resourceCards)
  const shellRef = useRef<HTMLDivElement>(null)
  const { sendMessage, retry } = useAI()

  useAutoResizeWindow(shellRef)

  return (
    <div className={styles.shell} ref={shellRef}>
      <ModeToggle />
      <Avatar />

      {resourceCards.length > 0 && (
        <>
          <div className={styles.divider} />
          <div className={styles.cardArea}>
            <div className={styles.cardAreaLabel}>推送资源</div>
            {resourceCards.map(card => (
              <ResourceCard key={card.id} card={card} />
            ))}
          </div>
        </>
      )}

      <div className={styles.divider} />
      <InputBar sendMessage={sendMessage} retry={retry} />
    </div>
  )
}
```

- [ ] **Step 2：`npx tsc --noEmit && npx vitest run`** → tsc 干净；全量测试通过。

- [ ] **Step 3：commit**

```bash
git add src/App.tsx
git commit -m "feat(app): mount ModeToggle in shell"
```

---

## Task 14：全量验证 + 手动验收

**Files:** 无（验证任务）

- [ ] **Step 1：自动验收**

```bash
npx tsc --noEmit
npx vitest run
npm run build
```
Expected: tsc 无错；全部测试 PASS；三套产物（dist / dist-electron）构建通过，`dist/vendor/xmovAvatar.js` 存在。

- [ ] **Step 2：手动验收（dev 模式 `npm run dev` + Electron）** —— 逐条核对（详见 spec Section 15）：

1. `.env` 删 `XINGYUN_APP_ID` 重启 → toggle 禁用 + hover tooltip + 启动为本地模式（viseme 正常）。恢复 key。
2. 启动默认 ✨魔珐 · 待机；第一次发问题 → "连接中…" → 数秒后 3D 数字人讲这条回复、**中文口型对齐**。
3. 说话中再发一条 → 旧的**立刻被打断**，新的接管。
4. 60s 不发问题 → 控制台「消耗记录」停止增长（session 已断）。
5. 再发问题 → 自动重连 → 又能讲。
6. 点 toggle 切本地 → CloudAvatar 卸载、SDK destroy、LocalAvatar 挂载、嘴回 closed。
7. **说话中点 toggle 切本地** → 立刻停、**不弹"云端失败"toast、不本地重复补讲**。
8. **拔网线 / 改错 appSecret 重启** → toast 提示 + toggle 翻回本地 + 本地补讲这条 reply。
9. 关闭 App → 控制台无悬挂 session。
10. **DevTools 检查 CSP**：无被拦的请求；若有，按 Task 8 Step 2 注记收窄/补全域名，写回 `XINGYUN-API-CHECK.md`，重跑 `npm run build`。
11. **首日联调微调**：核对 `XingyunClient` 的 `READY_STATES` 与 `looksLikeError` 是否匹配真实 onStateChange/onMessage payload（DevTools 打印）；若不符，调整常量并补/改对应单测后重跑 `npx vitest run`。

- [ ] **Step 3：把首日微调写回 `XINGYUN-API-CHECK.md`（已 gitignore，不入库）；只显式提交代码侧真正改动的文件**

```bash
# 勿用 git add -A（dist/、dist-electron/ 虽已 ignore，仍按实际改动文件显式 add 更稳）
# 按本任务真正微调过的文件增删下面这一行：
git add src/services/xingyun/XingyunClient.ts index.html
git commit -m "chore(xingyun): first-day integration tweaks (ready-state / error-detection / CSP)"
```

---

## Self-Review（plan vs spec）

**Spec 覆盖：**
- Section 1 模式状态机 → Task 2（store，默认 cloud，setRenderMode 重置 viseme）✓
- Section 2 集成架构（config IPC / 进程职责）→ Task 3/4 ✓
- Section 3 session 生命周期（idle-timeout / pending speak 契约 / 打断）→ Task 6（契约）/ Task 7（idle）✓
- Section 4 CloudAvatar（容器 div / overlay / unmount closeNow）→ Task 10 ✓
- Section 5 LocalAvatar（原样搬）→ Task 9 ✓
- Section 6 RouterAvatar → Task 10 ✓
- Section 7 useAI 改造（分支 / interrupt / handleCloudFailure）→ Task 12 ✓
- Section 8 失败回本地 → Task 12（handleCloudFailure）✓
- Section 9 极简 toggle（config 预查 / 无 modal / toast）→ Task 11 ✓
- Section 10 错误处理 → Task 6（错误码）/ Task 12（fallback）✓
- Section 11 CSP + vendor 脚本 → Task 8 ✓
- Section 12 测试策略 → 各 Task 的 test 步骤 ✓
- Section 13 文件清单 → File Structure ✓
- Section 14 环境变量（gateway 可选默认）→ Task 3（DEFAULT_GATEWAY）✓
- Section 15 验收 → Task 14 ✓
- 三处 review 修订（pending speak 收尾 / idle 仅 completed / gateway 可选）→ Task 6 + Task 12 + Task 3 全部落实 ✓

**占位符扫描：** 无 TODO/TBD；两处"首日联调"（READY_STATES / looksLikeError / CSP 域名）是带具体代码 + 明确验证步骤（Task 14 Step 2.11、Task 8 Step 2）的延后核对，非空白。

**类型一致：** `XingyunConfig`/`XingyunConfigStatus`/`XingyunError`/`XingyunErrorCode`（Task 1）贯穿 Task 3/6/7；`XINGYUN_CONTAINER_ID`='xingyun-stage' 在 types.ts/sessionManager/CloudAvatar/测试一致；`sessionManager` 方法名（ensureConnected/speak/interrupt/notifyIdle/closeNow）在 Task 7/11/12 一致；speak 返回 `'completed'|'interrupted'` 在 Task 6/7/12 一致。

---

## Execution Handoff

Plan complete。建议执行方式：

1. **Subagent-Driven（推荐）** — 每个 Task 派新 subagent，Task 间 review，快速迭代。
2. **Inline Execution** — 本会话内按 executing-plans 批量执行 + 检查点。

按 CLAUDE.md 流程：先由 `superpowers:using-git-worktrees` 建 `feature/xingyun-streaming` worktree，再在 worktree 内逐 Task 执行；每 Task 跑测试；完成后 code review → verify → archive。
