# RecorderASR（Push-to-Talk + Silicon Flow Whisper）设计文档

**日期：** 2026-05-20  
**背景：** Web Speech API 在 Electron 28 中静默失效（Chromium 需要 Google API Key），需替换为可工作的语音输入方案。  
**目标：** 实现 push-to-talk 模型：用户按住 mic 按钮录音，松开后发送到 Silicon Flow Whisper API 转写，结果填入输入框。

---

## Section 1：架构

**交互模型：** Push-to-talk（按住录音，松开转写）。不做实时流式识别，等录音结束后一次性提交。

**安全边界：** Silicon Flow API Key 只存在于主进程（`process.env.SILICONFLOW_API_KEY`），不写入 `userData/config.json`，不通过 IPC 下发到 renderer。Renderer 传 ArrayBuffer，主进程负责调 API。

**现有接口保持不变：**  
`ASRProvider { start(), stop(), onResult(cb), onError(cb), onEnd(cb), available }`  
`InputBar` 中的 mic 按钮逻辑无需修改，只替换 `asrProvider` 实例。

**废弃：** `WebSpeechASRProvider` 不再作为 fallback，直接替换为 `RecorderASRProvider`。

---

## Section 2：文件与接口

### 新增 / 修改文件

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/services/asr/RecorderASRProvider.ts` | 新增 | 录音 + IPC 调用 + ASRProvider 实现 |
| `electron/services/SiliconFlowWhisperService.ts` | 新增 | Whisper HTTP 请求（含校验） |
| `electron/main.ts` | 修改 | 新增 `transcribe-audio` IPC handler |
| `electron/preload.ts` | 修改 | 暴露 `transcribeAudio(buffer)` |
| `src/types/electron.d.ts` | 修改 | 添加 `transcribeAudio` 类型声明 |
| `tests/RecorderASRProvider.test.ts` | 新增 | 单元测试（mock MediaRecorder + mock IPC） |
| `tests/SiliconFlowWhisperService.test.ts` | 新增 | 单元测试（mock fetch） |

### RecorderASRProvider 状态机

```
idle ──start()──→ starting ──getUserMedia 成功──→ recording
                     │                                │
               getUserMedia 失败              stop() 调用
                     │                                │
                   idle ←──────── transcribing ←─────┘
                                  转写完成/失败
                                       │
                                     idle
```

- `start()` 只在 `idle` 状态执行，其他状态直接返回（防止重复录音）
- `stop()` 只在 `recording` 状态执行
- `stop()` 必须清理 MediaStream：`stream.getTracks().forEach(t => t.stop())`

### RecorderASRProvider 接口

```ts
type ASRStatus = 'idle' | 'starting' | 'recording' | 'transcribing'

class RecorderASRProvider implements ASRProvider {
  private status: ASRStatus = 'idle'
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private timeoutId: ReturnType<typeof setTimeout> | null = null

  readonly available: boolean = typeof navigator.mediaDevices !== 'undefined'

  start(): void        // idle → starting → recording
  stop(): void         // recording → transcribing → idle
  onResult(cb): void
  onError(cb): void
  onEnd(cb): void
}
```

### SiliconFlowWhisperService 接口

```ts
class SiliconFlowWhisperService {
  constructor(private apiKey: string) {}
  async transcribe(buffer: ArrayBuffer): Promise<string>  // 抛出时由 handler 捕获
}
```

---

## Section 3：IPC 数据流与校验

```
[Renderer — RecorderASRProvider]
  onPointerDown → start()
    status: idle → starting
    navigator.mediaDevices.getUserMedia({ audio: true })
      失败 → onError('permission-denied'), status → idle, return
    MediaRecorder(stream) + chunks = []
    recorder.start()
    status → recording
    启动 15 秒计时器 → 超时自动调 stop()

  onPointerUp → stop()
    status: recording → transcribing
    recorder.stop()                         // 触发 onstop
    stream.getTracks().forEach(t => t.stop()) // 释放麦克风

  recorder.ondataavailable → chunks.push(event.data)

  recorder.onstop:
    blob = new Blob(chunks, { type: 'audio/webm' })
    buffer = await blob.arrayBuffer()
    校验: buffer.byteLength === 0 → onError('empty-transcript'), status → idle
    校验: buffer.byteLength > 10MB → onError('ASR_TOO_LARGE'), status → idle
    result = await window.electronAPI.transcribeAudio(buffer)
    若 result 为 AppError → onError(result.code), status → idle
    若 result 为空字符串 → onError('empty-transcript'), status → idle
    否则 → onResult(result, true), status → idle
    onEnd()

[IPC 边界 — ArrayBuffer 直接传输（Structured Clone），无 base64]

[Main — transcribe-audio handler]
  校验: BrowserWindow.fromWebContents(event.sender) 存在（防伪造 IPC）
  校验: buffer 为 ArrayBuffer
  校验: 0 < buffer.byteLength ≤ 10MB → 否则返回 AppError { code: 'ASR_INVALID' }
  读取: process.env.SILICONFLOW_API_KEY
  若无 key → 返回 AppError { code: 'ASR_UNAVAILABLE', message: '语音识别未配置', recoverable: true }
  SiliconFlowWhisperService.transcribe(buffer)
    → multipart/form-data POST https://api.siliconflow.cn/v1/audio/transcriptions
    → model: 'FunAudioLLM/SenseVoiceSmall'
    → language: 'zh'
    → response_format: 'json'
    → AbortController timeout: 30 秒
  返回 string 或抛出（handler catch → AppError）
```

**主进程硬限制：**
- 文件大小：10MB（异常保护；正常 15 秒 Opus/WebM 通常 < 1MB）
- HTTP 超时：30 秒（`AbortController`）
- 只接受来自已注册 BrowserWindow 的 IPC（`BrowserWindow.fromWebContents` 检查）

---

## Section 4：错误处理

| 错误来源 | code | UI 提示文案 |
|---------|------|-----------|
| `getUserMedia` 被拒绝 | `permission-denied` | 请授权麦克风访问 |
| 录音为空（byteLength=0） | `empty-transcript` | 没有听到声音，请重试 |
| 转写返回空字符串 | `empty-transcript` | 没有听到声音，请重试 |
| 超过 10MB（异常保护） | `ASR_TOO_LARGE` | 录音数据过大，请重试 |
| 无 Silicon Flow Key | `ASR_UNAVAILABLE` | 语音识别未配置 |
| HTTP 超时（30s） | `ASR_TIMEOUT` | 转写超时，请重试 |
| HTTP 4xx/5xx | `ASR_ERROR` | 转写失败，请重试 |
| buffer 校验失败 | `ASR_INVALID` | 录音数据异常，请重试 |

**`available` 与 mic 按钮状态：**
- `available = typeof navigator.mediaDevices !== 'undefined'`（只检查浏览器能力，不检查 key）
- mic 按钮 disabled 条件：`!asrProvider.available || isLoading`
- key 缺失：按钮可点，录完后 UI 收到 `ASR_UNAVAILABLE` 错误，显示"语音识别未配置"
- MVP 不新增 key 存在检查 IPC（renderer 不该知道 key 是否存在）

**15 秒超时行为：**
- Renderer 侧计时器：15 秒自动调 `stop()`
- 不产生独立错误码——超时等同于用户松手，正常走转写流程

---

## Section 5：测试计划

### RecorderASRProvider.test.ts（mock MediaRecorder + mock IPC）

1. 正常录音 + 转写成功 → `onResult(text, true)`，status → idle
2. `getUserMedia` 拒绝 → `onError('permission-denied')`，status → idle
3. IPC 返回 AppError → `onError(error.code)`，status → idle
4. 转写返回空字符串 → `onError('empty-transcript')`，status → idle
5. `stop()` 在非 recording 状态调用 → 无副作用
6. `stop()` 调用 `stream.getTracks()[*].stop()`（验证麦克风释放）
7. `start()` 在非 idle 状态调用 → 被忽略（防重入）
8. 15 秒超时 → 自动调 `stop()`（用 fake timer）

### SiliconFlowWhisperService.test.ts（mock fetch）

1. 正常响应 → 返回转写文本
2. HTTP 超时（AbortError）→ 抛出 `ASR_TIMEOUT`
3. HTTP 4xx → 抛出 `ASR_ERROR`
4. 响应 text 为空 → 返回空字符串（由 handler/provider 层处理）

---

## 不在范围内（MVP）

- 实时流式识别
- 本地 Whisper 模型（无网环境）
- Silicon Flow Key 的运行时 UI 配置（需环境变量，无 InputBar 输入框）
- 连续对话模式（说完自动发送）
