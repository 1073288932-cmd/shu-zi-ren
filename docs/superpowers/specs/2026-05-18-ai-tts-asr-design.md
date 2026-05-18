# 教学智能体 AI + TTS/ASR 接入 — Design Doc

Date: 2026-05-18
Status: Approved

---

## 概述

在已有 Electron + React + TypeScript 桌面 MVP 基础上，接入真实 AI 对话（Deepseek）、Web Speech TTS/ASR，并将资源推送从硬编码改为本地资源库 + AI 选择。整体保持安全边界不变：API key 和资源路径留在 main process，renderer 只通过 preload 受控桥接拿结果。

---

## 范围

**本 spec**：
- 真实 AI 对话（Deepseek，主进程代理）
- Web Speech TTS（renderer）
- Web Speech ASR（renderer）
- 本地资源库（catalog.json）+ AI resourceId 选择

**本 spec 不包含**：
- 2D Avatar 嘴型帧动画（后续独立 spec）
- Live2D / VRM（后续评估）
- 云端 TTS/ASR（后续按需替换）

---

## 技术栈

- Deepseek Chat API（OpenAI 兼容格式，JSON mode）
- Web Speech API（`speechSynthesis` TTS + `SpeechRecognition` ASR）
- 现有：Electron 28 + Vite 5 + React 18 + TypeScript 5 + Zustand 4

---

## 架构与数据流

### 整体调用链路

```
renderer
  InputBar（文字 / ASR）
    → useAI.sendMessage(text)
      → ElectronAIProvider.chat(messages)
        → window.electronAPI.chat(messages)   ← preload IPC bridge

main process
  ipcMain.handle('chat', ...)
    → validateChatMessages(raw)              ← 完整 schema 校验
    → resourceCatalog.load()                 ← Map<id, ResourceCard> + promptSnippet
    → DeepseekAIProvider.chat(messages, catalog)
        → fetch Deepseek API（JSON mode）
        → parseAndValidate(rawJson)          ← schema 校验 + 降级
        → filterResourceIds(ids, catalog)    ← 过滤未知 id，限 3 张
        → id → ResourceCard 映射
    → 返回 { reply, resourceCards }

renderer（返回路径）
  useAI
    → agentStore: mood=talking, resourceCards 更新
    → WebSpeechTTSProvider.speak(reply)
    → utterance.onend → agentStore: mood=idle, isPushing=false
```

### 主进程 / Preload / Renderer 职责边界

| 层 | 持有 | 不可见 |
|----|------|--------|
| **main process** | `DEEPSEEK_API_KEY`（`process.env`）、catalog 完整数据（含本地路径）、Deepseek fetch、schema 校验、id 映射 | key 不出进程、路径不过 IPC |
| **preload** | `ipcRenderer.invoke('chat', messages)` 封装 | 不持有 key，不传原始 ipcRenderer |
| **renderer** | 发 `AgentMessage[]`，收 `AIResponse \| AppError`，驱动 TTS/ASR，更新 store | 不知道 key、路径、catalog 内部结构 |

---

## 资源库（`resources/catalog.json`）

### 格式

```json
{
  "version": "1.0.0",
  "resources": [
    {
      "id": "res-ext-001",
      "kind": "external",
      "title": "摩擦力 PhET 模拟实验",
      "type": "video",
      "description": "可交互的摩擦力演示，适合课堂导入",
      "url": "https://phet.colorado.edu/sims/html/friction/latest/friction_zh_CN.html",
      "tags": ["摩擦力", "实验", "八年级"]
    },
    {
      "id": "res-local-001",
      "kind": "local",
      "title": "苏科版物理八年级下册",
      "type": "doc",
      "description": "苏科版教材，含摩擦力、压强等章节",
      "tags": ["教材", "八年级下"]
    }
  ]
}
```

**约束**：
- `local` 类型不存 `path`，路径由 `electron/main.ts` 的 `resourceWhitelist` 单独管理，通过 `id` 关联
- `external` 类型必须有 `url`
- `local` 类型不得有 `url` 字段
- `id` 不得重复
- `kind` 枚举：`'external' | 'local'`
- `type` 枚举：`'video' | 'doc' | 'exercise' | 'experiment' | 'link'`

### local id 双表校验

启动时调用 `catalog.validateLocalIds(resourceWhitelist)`，结果非空则 `console.warn`（MVP 不阻塞启动，CI 测试可断言 warn）。

---

## `electron/services/resourceCatalog.ts`

```ts
interface ResourceCatalogService {
  readonly cardMap: ReadonlyMap<string, ResourceCard>   // id → ResourceCard（local 无 path）
  readonly promptSnippet: string                        // 注入 system prompt，不含 url / path
  validateLocalIds(whitelist: Map<string, string>): string[]
}
```

**promptSnippet 格式**（只含 id、标题、描述、标签，不含 url 或路径）：
```
[res-ext-001] 摩擦力 PhET 模拟实验 — 可交互的摩擦力演示，适合课堂导入 #摩擦力 #实验 #八年级
[res-local-001] 苏科版物理八年级下册 — 苏科版教材，含摩擦力、压强等章节 #教材 #八年级下
```

---

## `electron/services/DeepseekAIProvider.ts`

### System prompt 模板

```
你是一位物理教学助手，帮助教师备课和课堂资源调用。
根据对话上下文给出简洁专业的回复，并从以下资源库中选出最相关的资源（最多3个）。

资源库：
${catalog.promptSnippet}

严格按以下 JSON 格式返回，不要包含任何其他文字：
{"reply":"你的回复","resourceIds":["id1"]}
如不需要推送资源，resourceIds 返回空数组。
```

### fetch 参数

```ts
{
  url: 'https://api.deepseek.com/chat/completions',
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: {
    model: 'deepseek-chat',
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  },
  signal: AbortSignal.timeout(15_000),
}
```

### 错误处理与降级（硬性分层）

```
HTTP 失败（非 2xx）/ 超时 / 网络中断
  → throw DeepseekHTTPError(status)
  → IPC handler catch → 返回对应 AppError（见错误码表）
  → UI 进入 error 状态

JSON 解析失败
  → 降级：{ reply: rawContent, resourceCards: [] }
  → 不抛异常，对话继续

schema 校验失败（reply 非 string / resourceIds 非数组）
  → 降级：{ reply: '我已收到问题，但资源推荐格式解析失败，请重试。', resourceCards: [] }
  → 不抛异常

resourceId 过滤
  → 未知 id 静默丢弃
  → slice(0, 3)
  → id → ResourceCard 映射
```

---

## IPC `chat` Handler（`electron/main.ts`）

### 输入校验（`validateChatMessages`，纯函数）

```ts
const MAX_MESSAGES = 20
const MAX_CONTENT_LENGTH = 2000
const VALID_ROLES = new Set(['user', 'assistant'])

// 拆开写，避免 messages.length 前未确认是数组
if (!Array.isArray(raw)) return INVALID_CHAT_MESSAGES_ERROR
if (raw.length > MAX_MESSAGES) return INVALID_CHAT_MESSAGES_ERROR
// 逐条校验 role 枚举、content 类型和长度
```

### Handler 结构

```ts
ipcMain.handle('chat', async (event, messages: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) return AI_ERROR
  if (!process.env.DEEPSEEK_API_KEY)                return AI_UNAVAILABLE_ERROR
  const validated = validateChatMessages(messages)
  if ('code' in validated) return validated
  try {
    return await deepseekProvider.chat(validated, catalog)
  } catch (err) {
    return mapDeepseekError(err)   // HTTP status → AppError code
  }
})
```

---

## Preload 变更

新增 `chat`，前置两步校验（可读性优先，拆开写）：

```ts
chat: (messages: unknown): Promise<AIResponse | AppError> => {
  if (!Array.isArray(messages)) {
    return Promise.resolve({ code: 'INVALID_CHAT_MESSAGES', message: '...', recoverable: false })
  }
  if (messages.length > 20) {
    return Promise.resolve({ code: 'INVALID_CHAT_MESSAGES', message: '...', recoverable: false })
  }
  return ipcRenderer.invoke('chat', messages)
}
```

完整 schema 校验在 main process `validateChatMessages` 里完成。

---

## 错误码表

| code | recoverable | 触发场景 | UI 行为 |
|------|-------------|---------|---------|
| `AI_ERROR` | true | HTTP 5xx、超时、网络中断 | error 状态 + 重试按钮 |
| `AI_AUTH_ERROR` | false | HTTP 401 | error 状态，无重试按钮 |
| `AI_RATE_LIMITED` | true | HTTP 429 | error 状态 + 重试按钮 |
| `AI_UNAVAILABLE` | false | API key 未配置 | error 状态，无重试按钮 |
| `INVALID_CHAT_MESSAGES` | false | IPC 输入非法 | error 状态，无重试按钮 |

---

## `src/services/ai/ElectronAIProvider.ts`

renderer 唯一 AI provider，UI 不感知 IPC：

```ts
export class ElectronAIProvider implements AIProvider {
  async chat(messages: AgentMessage[]): Promise<AIResponse> {
    const result = await window.electronAPI.chat(messages)
    if ('code' in result) throw result   // AppError 直接 throw，保留 code
    return result
  }
}
```

`useAI` catch 块区分 AppError 和普通 Error：

```ts
catch (err: unknown) {
  const appError: AppError = isAppError(err)
    ? err
    : { code: 'AI_ERROR', message: String(err), recoverable: true }
  store.setMood('error')
  store.setIsPushing(false)
  ttsProvider.stop()          // catch 路径也 stop TTS，防残留语音
  store.setError(appError)
  store.setIsLoading(false)
}
```

`isAppError`：`typeof err === 'object' && err !== null && 'code' in err`

---

## Web Speech TTS（`src/services/tts/WebSpeechTTSProvider.ts`）

**竞态防护**：内部 `gen` 计数器，`onend/onerror` 只在代数匹配时触发。

```ts
speak(text: string): Promise<void> {
  if (!text) return Promise.resolve()        // 空文本直接 resolve
  const myGen = ++this.gen
  window.speechSynthesis.cancel()           // 先停旧的
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.rate = 0.95
    const voices = window.speechSynthesis.getVoices()
    const zhVoice = voices.find(v => v.lang.startsWith('zh'))
    if (zhVoice) utterance.voice = zhVoice
    utterance.onend  = () => { if (this.gen === myGen) resolve() }
    utterance.onerror = () => { if (this.gen === myGen) resolve() }  // 静默失败
    window.speechSynthesis.speak(utterance)
  })
}

stop(): void {
  this.gen++                                // 使挂起的 resolve 失效
  window.speechSynthesis.cancel()
}
```

**`NoopTTSProvider` 更新**：`speak(text)` 返回延迟 Promise（`Math.min(1500 + text.length * 40, 8000) ms`），保持 `useAI` 统一路径，无 TTS 环境下 Avatar 仍有合理 talking 时长。

**`src/services/tts/index.ts`**：
```ts
export const ttsProvider: TTSProvider =
  typeof window !== 'undefined' && 'speechSynthesis' in window
    ? new WebSpeechTTSProvider()
    : new NoopTTSProvider()
```

---

## Web Speech ASR（`src/services/asr/WebSpeechASRProvider.ts`）

- `lang: 'zh-CN'`，`interimResults: true`，`continuous: false`
- `start()` 前先 `stop()` 旧实例，防多个 recognition 并发写 InputBar
- `onresult`：`isFinal=true` 时调 `onResult(text, true)`；过程中调 `onResult(text, false)`
- `onerror`：调 `onError(e.error)`
- `onend`：自然结束时通知 InputBar 重置按钮

**`src/services/asr/index.ts`**：
```ts
const SR = typeof window !== 'undefined'
  ? (window.SpeechRecognition ?? (window as any).webkitSpeechRecognition)
  : undefined
export const asrProvider: ASRProvider = SR
  ? new WebSpeechASRProvider()
  : new NoopASRProvider()
```

---

## `src/hooks/useAI.ts` 改造

用 `ttsGenRef`（生成计数器）替换 `talkingTimerRef`，TTS Promise 解析驱动 `mood=idle`：

```
sendMessage(text):
  1. ttsGenRef.current++; ttsProvider.stop()       ← 取消上一轮 TTS（防竞态）
  2. store: mood=thinking, isLoading=true, lastUserInput=text
  3. await aiProvider.chat(messages)
     ├─ 成功:
     │   store: messages 追加, resourceCards 更新
     │   store: mood=talking, isPushing=(cards.length>0), isLoading=false
     │   const myGen = ttsGenRef.current
     │   ttsProvider.speak(reply).then(() => {
     │     if (ttsGenRef.current === myGen) {
     │       store: mood=idle, isPushing=false
     │     }
     │   })
     └─ 失败:
         ttsProvider.stop()                        ← catch 路径也 stop
         store: mood=error, isPushing=false, error=AppError, isLoading=false
```

**NoopTTSProvider 兼容**：`speak()` 返回延迟 Promise，`useAI` 代码路径完全一致，无 `instanceof` 分支。

---

## `src/components/InputBar/index.tsx` 麦克风接入

新增本地状态 `isListening: boolean`，不入 store。

```
点击麦克风（非 isLoading）→ asrProvider.start(); setIsListening(true)
onResult(text, isFinal):
  → setInterimText(text)
  → isFinal && text.trim() → sendMessage(text.trim()); setIsListening(false); setInterimText('')
onError(code) → setIsListening(false)
onend（自然结束）→ setIsListening(false)

ASR 不可用（NoopASRProvider）→ 按钮 disabled（保持现状）
isLoading=true → 按钮 disabled
isListening=true → 脉冲动画，点击可提前 stop
```

---

## `electron/main.ts` 麦克风权限

```ts
session.defaultSession.setPermissionRequestHandler(
  (webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone')
  }
)
```

> 实现时按 Electron 28 实际 `permission` 枚举值做手动验收，名称不保证与上述完全一致。

打包时（`electron-builder.json`）需在 `mac.extendInfo` 加 `NSMicrophoneUsageDescription`，开发阶段系统会自动弹权限请求。

---

## `.env.example`

```
# Deepseek API key — 仅供主进程读取，不得出现在 renderer 代码、日志或错误信息中
# 申请地址：https://platform.deepseek.com
DEEPSEEK_API_KEY=
```

`.env` 已在 `.gitignore` 中，不提交。

---

## 测试覆盖

### 新增测试文件

| 文件 | 关键用例 |
|------|---------|
| `tests/resourceCatalog.test.ts` | 加载合法 catalog；promptSnippet 不含 url/路径；validateLocalIds 全匹配返回空数组、缺失返回缺失列表；重复 id / external 缺 url / local 带 url / kind 非法 / type 非法 → 拒绝加载 |
| `tests/DeepseekAIProvider.test.ts` | 合法 JSON 响应；未知 id 过滤；超 3 条截断；reply 非 string → 降级；JSON 失败 → 降级；HTTP 401 → AI_AUTH_ERROR；HTTP 429 → AI_RATE_LIMITED；超时 → handler 映射为 AI_ERROR |
| `tests/validateChatMessages.test.ts` | 合法输入；非数组；length > 20；非法 role；content 超 2000 字符 |
| `tests/WebSpeechTTSProvider.test.ts` | speak('') 直接 resolve；speak 前 cancel；onend → resolve；onerror → resolve（静默）；stop 后旧回调忽略；连续 speak 第一次 onend 忽略 |
| `tests/WebSpeechASRProvider.test.ts` | start 前 stop 旧实例；lang=zh-CN；onresult isFinal=true → onResult(text,true)；onerror → onError；stop 调用 recognition.stop() |

### 修改现有测试

| 文件 | 补充用例 |
|------|---------|
| `tests/useAI.test.ts` | TTS speak 完成后 mood=idle；新请求调用 ttsProvider.stop()；旧 gen resolve 不影响新请求 mood；catch 路径调用 ttsProvider.stop() |

---

## 文件变动总览

```
resources/
  catalog.json                          新建

electron/
  services/
    DeepseekAIProvider.ts               新建
    resourceCatalog.ts                  新建
  main.ts                               修改（chat IPC、麦克风权限、catalog 启动校验）
  preload.ts                            修改（暴露 chat，前置双步校验）

src/
  types/
    electron.d.ts                       修改（补 chat 类型）
  services/
    ai/
      ElectronAIProvider.ts             新建
      index.ts                          修改（切换到 ElectronAIProvider）
    tts/
      WebSpeechTTSProvider.ts           新建
      NoopTTSProvider.ts                修改（speak 返回延迟 Promise）
      index.ts                          新建（运行时检测，导出单例）
    asr/
      WebSpeechASRProvider.ts           新建
      index.ts                          新建（运行时检测，导出单例）
  hooks/
    useAI.ts                            修改（ttsGenRef，catch 补 stop）
  components/
    InputBar/index.tsx                  修改（ASR，isListening，trim 校验）

tests/
  resourceCatalog.test.ts              新建
  DeepseekAIProvider.test.ts           新建
  validateChatMessages.test.ts         新建
  WebSpeechTTSProvider.test.ts         新建
  WebSpeechASRProvider.test.ts         新建
  useAI.test.ts                        修改（补 4 条 TTS 用例）

.env.example                            新建
```
