# RecorderASR（Push-to-Talk + Silicon Flow Whisper）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent-failing WebSpeechASRProvider with a push-to-talk recorder that sends audio to Silicon Flow Whisper via Electron IPC, returning transcribed text to the InputBar.

**Architecture:** Renderer records audio with MediaRecorder (push-to-talk, 15s max), sends the ArrayBuffer to main process via IPC, main process calls Silicon Flow Whisper API and returns transcribed text or an AppError. The ASRProvider interface (`start/stop/onResult/onError/onEnd`) stays unchanged; only the implementation and InputBar interaction model change.

**Tech Stack:** Electron 28, React 18, TypeScript 5.9, Vitest 1.6, MediaRecorder API, Silicon Flow Whisper (`FunAudioLLM/SenseVoiceSmall`)

**Worktree:** `/Users/baofeng/Desktop/shu-zi-ren/.worktrees/feature-mvp-implementation`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `electron/services/SiliconFlowWhisperService.ts` | Create | POST to Whisper API, AbortController timeout, error classes |
| `electron/services/transcribeAudioHandler.ts` | Create | Pure validation + dispatch function (no Electron imports, fully testable) |
| `electron/main.ts` | Modify | Add `transcribe-audio` IPC handler (3 lines) |
| `electron/preload.ts` | Modify | Expose `transcribeAudio(buffer)` |
| `src/types/electron.d.ts` | Modify | Add `transcribeAudio` type declaration |
| `src/services/asr/RecorderASRProvider.ts` | Create | MediaRecorder + IPC call + ASRProvider impl |
| `src/services/asr/index.ts` | Modify | Replace WebSpeechASRProvider with RecorderASRProvider |
| `src/components/InputBar/index.tsx` | Modify | mic button: click/toggle → onPointerDown/Up/Cancel/Leave |
| `.env.example` | Modify | Add `SILICONFLOW_API_KEY=` entry |
| `tests/SiliconFlowWhisperService.test.ts` | Create | Unit tests (mock fetch) |
| `tests/transcribeAudioHandler.test.ts` | Create | Unit tests for validation + error mapping |
| `tests/RecorderASRProvider.test.ts` | Create | Unit tests (mock MediaRecorder + mock IPC) |

---

## Task 1: SiliconFlowWhisperService

**Files:**
- Create: `electron/services/SiliconFlowWhisperService.ts`
- Create: `tests/SiliconFlowWhisperService.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/SiliconFlowWhisperService.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SiliconFlowWhisperService, ASRTimeoutError, ASRHTTPError, mapASRError } from '../electron/services/SiliconFlowWhisperService'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SiliconFlowWhisperService', () => {
  it('returns transcribed text on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '摩擦力是什么' }),
    })
    const service = new SiliconFlowWhisperService('test-key')
    const result = await service.transcribe(new ArrayBuffer(100))
    expect(result).toBe('摩擦力是什么')
  })

  it('throws ASRTimeoutError when fetch rejects with AbortError', async () => {
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    fetchMock.mockRejectedValueOnce(abortErr)
    const service = new SiliconFlowWhisperService('test-key')
    await expect(service.transcribe(new ArrayBuffer(100))).rejects.toBeInstanceOf(ASRTimeoutError)
  })

  it('throws ASRHTTPError on HTTP 500', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    const service = new SiliconFlowWhisperService('test-key')
    await expect(service.transcribe(new ArrayBuffer(100))).rejects.toBeInstanceOf(ASRHTTPError)
  })

  it('returns empty string when response has no text field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })
    const service = new SiliconFlowWhisperService('test-key')
    const result = await service.transcribe(new ArrayBuffer(100))
    expect(result).toBe('')
  })
})

describe('mapASRError', () => {
  it('maps ASRTimeoutError to ASR_TIMEOUT', () => {
    expect(mapASRError(new ASRTimeoutError()).code).toBe('ASR_TIMEOUT')
  })

  it('maps ASRHTTPError to its embedded code', () => {
    expect(mapASRError(new ASRHTTPError(500, 'ASR_ERROR')).code).toBe('ASR_ERROR')
  })

  it('maps unknown errors to ASR_ERROR', () => {
    expect(mapASRError(new Error('net::ERR_NAME_NOT_RESOLVED')).code).toBe('ASR_ERROR')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/baofeng/Desktop/shu-zi-ren/.worktrees/feature-mvp-implementation
npx vitest run tests/SiliconFlowWhisperService.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement SiliconFlowWhisperService**

Create `electron/services/SiliconFlowWhisperService.ts`:

```ts
import type { AppError } from '../../shared/types'

const WHISPER_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions'

export class ASRTimeoutError extends Error {
  constructor() {
    super('ASR request timed out')
    this.name = 'ASRTimeoutError'
  }
}

export class ASRHTTPError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`ASR HTTP ${status}`)
    this.name = 'ASRHTTPError'
  }
}

export class SiliconFlowWhisperService {
  constructor(private readonly apiKey: string) {}

  async transcribe(buffer: ArrayBuffer): Promise<string> {
    const blob = new Blob([buffer], { type: 'audio/webm' })
    const form = new FormData()
    form.append('file', blob, 'recording.webm')
    form.append('model', 'FunAudioLLM/SenseVoiceSmall')
    form.append('language', 'zh')
    form.append('response_format', 'json')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30_000)

    let response: Response
    try {
      response = await fetch(WHISPER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw new ASRTimeoutError()
      throw err
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const code = response.status === 401 ? 'ASR_AUTH_ERROR' : 'ASR_ERROR'
      throw new ASRHTTPError(response.status, code)
    }

    const data = await response.json() as { text?: string }
    return data.text ?? ''
  }
}

export function mapASRError(err: unknown): AppError {
  if (err instanceof ASRTimeoutError) {
    return { code: 'ASR_TIMEOUT', message: '转写超时，请重试', recoverable: true }
  }
  if (err instanceof ASRHTTPError) {
    return { code: err.code, message: '转写失败，请重试', recoverable: true }
  }
  return { code: 'ASR_ERROR', message: '转写失败，请重试', recoverable: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/SiliconFlowWhisperService.test.ts
```

Expected: 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add electron/services/SiliconFlowWhisperService.ts tests/SiliconFlowWhisperService.test.ts
git commit -m "feat: add SiliconFlowWhisperService + mapASRError"
```

---

## Task 2: handleTranscribeAudio (extracted testable handler)

**Files:**
- Create: `electron/services/transcribeAudioHandler.ts`
- Create: `tests/transcribeAudioHandler.test.ts`

This pure function encapsulates all IPC validation and dispatch logic so it can be tested without mocking Electron.

- [ ] **Step 1: Write failing tests**

Create `tests/transcribeAudioHandler.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { handleTranscribeAudio } from '../electron/services/transcribeAudioHandler'
import { ASRTimeoutError, ASRHTTPError } from '../electron/services/SiliconFlowWhisperService'
import type { AppError } from '../shared/types'

describe('handleTranscribeAudio — validation', () => {
  it('returns ASR_INVALID when sender is invalid', async () => {
    const r = await handleTranscribeAudio(new ArrayBuffer(100), false, 'key')
    expect((r as AppError).code).toBe('ASR_INVALID')
  })

  it('returns ASR_INVALID for non-ArrayBuffer input', async () => {
    const r = await handleTranscribeAudio('not-a-buffer', true, 'key')
    expect((r as AppError).code).toBe('ASR_INVALID')
  })

  it('returns empty-transcript for byteLength === 0', async () => {
    const r = await handleTranscribeAudio(new ArrayBuffer(0), true, 'key')
    expect((r as AppError).code).toBe('empty-transcript')
  })

  it('returns ASR_TOO_LARGE for byteLength > 10MB', async () => {
    const r = await handleTranscribeAudio(new ArrayBuffer(10 * 1024 * 1024 + 1), true, 'key')
    expect((r as AppError).code).toBe('ASR_TOO_LARGE')
  })

  it('returns ASR_UNAVAILABLE when apiKey is empty', async () => {
    const r = await handleTranscribeAudio(new ArrayBuffer(100), true, '')
    expect((r as AppError).code).toBe('ASR_UNAVAILABLE')
  })
})

describe('handleTranscribeAudio — service dispatch (injected factory)', () => {
  it('returns transcribed string on success', async () => {
    const factory = () => ({ transcribe: vi.fn().mockResolvedValue('摩擦力是什么') })
    const r = await handleTranscribeAudio(new ArrayBuffer(100), true, 'key', factory)
    expect(r).toBe('摩擦力是什么')
  })

  it('maps ASRTimeoutError to ASR_TIMEOUT AppError', async () => {
    const factory = () => ({ transcribe: vi.fn().mockRejectedValue(new ASRTimeoutError()) })
    const r = await handleTranscribeAudio(new ArrayBuffer(100), true, 'key', factory)
    expect((r as AppError).code).toBe('ASR_TIMEOUT')
  })

  it('maps ASRHTTPError to its code', async () => {
    const factory = () => ({ transcribe: vi.fn().mockRejectedValue(new ASRHTTPError(500, 'ASR_ERROR')) })
    const r = await handleTranscribeAudio(new ArrayBuffer(100), true, 'key', factory)
    expect((r as AppError).code).toBe('ASR_ERROR')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/transcribeAudioHandler.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement handleTranscribeAudio**

Create `electron/services/transcribeAudioHandler.ts`:

```ts
import type { AppError } from '../../shared/types'
import { SiliconFlowWhisperService, mapASRError } from './SiliconFlowWhisperService'

const MAX_BYTES = 10 * 1024 * 1024

type TranscribeService = { transcribe(buffer: ArrayBuffer): Promise<string> }

export async function handleTranscribeAudio(
  buffer: unknown,
  isValidSender: boolean,
  apiKey: string,
  serviceFactory: (key: string) => TranscribeService = (key) => new SiliconFlowWhisperService(key),
): Promise<string | AppError> {
  if (!isValidSender) {
    return { code: 'ASR_INVALID', message: '录音数据异常，请重试', recoverable: false }
  }
  if (!(buffer instanceof ArrayBuffer)) {
    return { code: 'ASR_INVALID', message: '录音数据异常，请重试', recoverable: false }
  }
  if (buffer.byteLength === 0) {
    return { code: 'empty-transcript', message: '没有听到声音，请重试', recoverable: true }
  }
  if (buffer.byteLength > MAX_BYTES) {
    return { code: 'ASR_TOO_LARGE', message: '录音数据过大，请重试', recoverable: true }
  }
  if (!apiKey) {
    return { code: 'ASR_UNAVAILABLE', message: '语音识别未配置', recoverable: true }
  }
  try {
    return await serviceFactory(apiKey).transcribe(buffer)
  } catch (err) {
    return mapASRError(err)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/transcribeAudioHandler.test.ts
```

Expected: 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add electron/services/transcribeAudioHandler.ts tests/transcribeAudioHandler.test.ts
git commit -m "feat: add handleTranscribeAudio with validation and error mapping"
```

---

## Task 3: IPC Wiring

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/electron.d.ts`

- [ ] **Step 1: Add IPC handler in main.ts**

Open `electron/main.ts`. After the existing imports at the top, add:

```ts
import { handleTranscribeAudio } from './services/transcribeAudioHandler'
```

Then after the `ipcMain.handle('set-api-key', ...)` block (around line 172), add:

```ts
// IPC: transcribe audio via Silicon Flow Whisper
ipcMain.handle('transcribe-audio', async (event, buffer: unknown) => {
  const isValidSender = BrowserWindow.fromWebContents(event.sender) !== null
  return handleTranscribeAudio(buffer, isValidSender, process.env.SILICONFLOW_API_KEY ?? '')
})
```

- [ ] **Step 2: Expose transcribeAudio in preload.ts**

Open `electron/preload.ts`. Inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, add after the existing `setApiKey` entry:

```ts
  transcribeAudio(buffer: ArrayBuffer): Promise<import('../shared/types').AppError | string> {
    return ipcRenderer.invoke('transcribe-audio', buffer)
  },
```

- [ ] **Step 3: Add type declaration in electron.d.ts**

Open `src/types/electron.d.ts`. Inside the `electronAPI` interface, add after `setApiKey`:

```ts
      transcribeAudio(buffer: ArrayBuffer): Promise<AppError | string>
```

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: all existing tests still pass (no regressions), total count same as before

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/preload.ts src/types/electron.d.ts
git commit -m "feat: expose transcribe-audio IPC (main→preload→type declaration)"
```

---

## Task 4: RecorderASRProvider

**Files:**
- Create: `src/services/asr/RecorderASRProvider.ts`
- Create: `tests/RecorderASRProvider.test.ts`
- Modify: `src/services/asr/index.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/RecorderASRProvider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RecorderASRProvider } from '../src/services/asr/RecorderASRProvider'
import type { AppError } from '../shared/types'

// --- Mocks ---

type MockRecorder = {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
}

let mockRecorderInstance: MockRecorder
const MockMediaRecorder = vi.fn().mockImplementation(() => {
  mockRecorderInstance = {
    start: vi.fn(),
    stop: vi.fn(),
    ondataavailable: null,
    onstop: null,
  }
  return mockRecorderInstance
})

const mockTrackStop = vi.fn()
const mockStream = { getTracks: () => [{ stop: mockTrackStop }] }
const getUserMediaMock = vi.fn()
const transcribeAudioMock = vi.fn()

// Flush microtask queue — lets async chains inside onstop handlers complete
const flush = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve())

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('MediaRecorder', MockMediaRecorder)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: getUserMediaMock } })
  ;(globalThis as Record<string, unknown>).electronAPI = { transcribeAudio: transcribeAudioMock }
  getUserMediaMock.mockResolvedValue(mockStream)
  transcribeAudioMock.mockResolvedValue('摩擦力是什么')
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).electronAPI
})

// --- Helper: start provider and wait for getUserMedia to resolve ---
async function startAndWait(provider: RecorderASRProvider) {
  provider.start()
  await flush()
}

// --- Helper: trigger onstop and wait for handleStop to complete ---
async function triggerOnstoAndWait() {
  mockRecorderInstance.onstop?.()
  await flush()
}

// --- Tests ---

describe('RecorderASRProvider', () => {
  it('available is true when navigator.mediaDevices is defined', () => {
    const provider = new RecorderASRProvider()
    expect(provider.available).toBe(true)
  })

  it('normal flow: onResult(text, true) then onEnd called, status → idle', async () => {
    const provider = new RecorderASRProvider()
    const resultCb = vi.fn()
    const endCb = vi.fn()
    provider.onResult(resultCb)
    provider.onEnd(endCb)

    await startAndWait(provider)
    mockRecorderInstance.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })

    provider.stop()
    await triggerOnstoAndWait()

    expect(transcribeAudioMock).toHaveBeenCalled()
    expect(resultCb).toHaveBeenCalledWith('摩擦力是什么', true)
    expect(endCb).toHaveBeenCalled()
  })

  it('getUserMedia failure → onError(permission-denied), no recorder created', async () => {
    getUserMediaMock.mockRejectedValueOnce(new Error('NotAllowedError'))
    const provider = new RecorderASRProvider()
    const errorCb = vi.fn()
    provider.onError(errorCb)

    await startAndWait(provider)

    expect(errorCb).toHaveBeenCalledWith('permission-denied')
    expect(MockMediaRecorder).not.toHaveBeenCalled()
  })

  it('IPC returns AppError → onError(error.code), onEnd called', async () => {
    const appErr: AppError = { code: 'ASR_UNAVAILABLE', message: '语音识别未配置', recoverable: true }
    transcribeAudioMock.mockResolvedValueOnce(appErr)
    const provider = new RecorderASRProvider()
    const errorCb = vi.fn()
    const endCb = vi.fn()
    provider.onError(errorCb)
    provider.onEnd(endCb)

    await startAndWait(provider)
    provider.stop()
    await triggerOnstoAndWait()

    expect(errorCb).toHaveBeenCalledWith('ASR_UNAVAILABLE')
    expect(endCb).toHaveBeenCalled()
  })

  it('IPC returns empty string → onError(empty-transcript), onEnd called', async () => {
    transcribeAudioMock.mockResolvedValueOnce('')
    const provider = new RecorderASRProvider()
    const errorCb = vi.fn()
    const endCb = vi.fn()
    provider.onError(errorCb)
    provider.onEnd(endCb)

    await startAndWait(provider)
    provider.stop()
    await triggerOnstoAndWait()

    expect(errorCb).toHaveBeenCalledWith('empty-transcript')
    expect(endCb).toHaveBeenCalled()
  })

  it('onstop with byteLength=0 → onError(empty-transcript), IPC not called', async () => {
    // No ondataavailable → chunks empty → Blob.byteLength === 0
    const provider = new RecorderASRProvider()
    const errorCb = vi.fn()
    provider.onError(errorCb)

    await startAndWait(provider)
    provider.stop()
    await triggerOnstoAndWait()

    expect(transcribeAudioMock).not.toHaveBeenCalled()
    expect(errorCb).toHaveBeenCalledWith('empty-transcript')
  })

  it('onstop with byteLength > 10MB → onError(ASR_TOO_LARGE), IPC not called', async () => {
    const bigBuffer = new ArrayBuffer(11 * 1024 * 1024)
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockResolvedValueOnce(bigBuffer)
    const provider = new RecorderASRProvider()
    const errorCb = vi.fn()
    provider.onError(errorCb)

    await startAndWait(provider)
    mockRecorderInstance.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) })
    provider.stop()
    await triggerOnstoAndWait()

    expect(transcribeAudioMock).not.toHaveBeenCalled()
    expect(errorCb).toHaveBeenCalledWith('ASR_TOO_LARGE')
  })

  it('onstop finally: stream tracks stopped, status idle, onEnd called regardless of error', async () => {
    transcribeAudioMock.mockRejectedValueOnce(new Error('network'))
    const provider = new RecorderASRProvider()
    const endCb = vi.fn()
    provider.onEnd(endCb)

    await startAndWait(provider)
    mockRecorderInstance.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
    provider.stop()
    await triggerOnstoAndWait()

    expect(mockTrackStop).toHaveBeenCalled()
    expect(endCb).toHaveBeenCalled()
    // Provider should accept a new start() (status is idle again)
    provider.start()
    await flush()
    expect(MockMediaRecorder).toHaveBeenCalledTimes(2)
  })

  it('stop() in non-recording state is a no-op', async () => {
    const provider = new RecorderASRProvider()
    provider.stop() // idle state
    expect(MockMediaRecorder).not.toHaveBeenCalled()
  })

  it('start() while already recording is ignored (no second recorder created)', async () => {
    const provider = new RecorderASRProvider()
    await startAndWait(provider)
    provider.start() // status is recording, should be ignored
    await flush()
    expect(MockMediaRecorder).toHaveBeenCalledTimes(1)
  })

  it('15s timeout automatically calls stop()', async () => {
    vi.useFakeTimers()
    const provider = new RecorderASRProvider()

    provider.start()
    await vi.runAllMicrotasksAsync()

    expect(mockRecorderInstance.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(15_001)
    expect(mockRecorderInstance.stop).toHaveBeenCalled()

    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/RecorderASRProvider.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement RecorderASRProvider**

Create `src/services/asr/RecorderASRProvider.ts`:

```ts
import type { ASRProvider } from './ASRProvider'
import type { AppError } from '@shared/types'

type ASRStatus = 'idle' | 'starting' | 'recording' | 'transcribing'

function isAppError(v: unknown): v is AppError {
  return typeof v === 'object' && v !== null && 'code' in v
}

export class RecorderASRProvider implements ASRProvider {
  private status: ASRStatus = 'idle'
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  private resultCb: ((text: string, isFinal: boolean) => void) | null = null
  private errorCb: ((code: string) => void) | null = null
  private endCb: (() => void) | null = null

  readonly available: boolean =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices !== 'undefined'

  onResult(cb: (text: string, isFinal: boolean) => void): void { this.resultCb = cb }
  onError(cb: (code: string) => void): void { this.errorCb = cb }
  onEnd(cb: () => void): void { this.endCb = cb }

  start(): void {
    if (this.status !== 'idle') return
    this.status = 'starting'
    this.chunks = []

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      this.stream = stream
      this.recorder = new MediaRecorder(stream)

      this.recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) this.chunks.push(e.data)
      }

      this.recorder.onstop = () => { void this.handleStop() }

      this.recorder.start()
      this.status = 'recording'

      this.timeoutId = setTimeout(() => { this.stop() }, 15_000)
    }).catch(() => {
      this.status = 'idle'
      this.errorCb?.('permission-denied')
    })
  }

  stop(): void {
    if (this.status !== 'recording') return
    this.status = 'transcribing'
    this.recorder?.stop()
  }

  private async handleStop(): Promise<void> {
    try {
      const blob = new Blob(this.chunks, { type: 'audio/webm' })
      const buffer = await blob.arrayBuffer()

      if (buffer.byteLength === 0) {
        this.errorCb?.('empty-transcript')
        return
      }
      if (buffer.byteLength > 10 * 1024 * 1024) {
        this.errorCb?.('ASR_TOO_LARGE')
        return
      }

      const result = await window.electronAPI.transcribeAudio(buffer)

      if (isAppError(result)) {
        this.errorCb?.(result.code)
        return
      }
      if (!result) {
        this.errorCb?.('empty-transcript')
        return
      }

      this.resultCb?.(result, true)
    } catch {
      this.errorCb?.('ASR_ERROR')
    } finally {
      if (this.timeoutId !== null) {
        clearTimeout(this.timeoutId)
        this.timeoutId = null
      }
      this.stream?.getTracks().forEach(t => t.stop())
      this.recorder = null
      this.stream = null
      this.chunks = []
      this.status = 'idle'
      this.endCb?.()
    }
  }
}
```

- [ ] **Step 4: Update asr/index.ts to use RecorderASRProvider**

Replace the entire content of `src/services/asr/index.ts`:

```ts
import type { ASRProvider } from './ASRProvider'
import { RecorderASRProvider } from './RecorderASRProvider'
import { NoopASRProvider } from './NoopASRProvider'

export const asrProvider: ASRProvider =
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices !== 'undefined'
    ? new RecorderASRProvider()
    : new NoopASRProvider()
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/RecorderASRProvider.test.ts
```

Expected: 10 tests pass

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/services/asr/RecorderASRProvider.ts src/services/asr/index.ts tests/RecorderASRProvider.test.ts
git commit -m "feat: add RecorderASRProvider (push-to-talk via IPC)"
```

---

## Task 5: InputBar Push-to-Talk + .env.example

**Files:**
- Modify: `src/components/InputBar/index.tsx`
- Modify: `.env.example`

The current mic button uses `onClick` / toggle. This task changes it to `onPointerDown` (start) / `onPointerUp | onPointerCancel | onPointerLeave` (stop).

- [ ] **Step 1: Update InputBar**

Open `src/components/InputBar/index.tsx`. Make the following changes:

**Remove** the `handleMic` function (lines 52–61):
```ts
function handleMic() {
  if (isListening) {
    asrProvider.stop()
    setIsListening(false)
    setInterimText('')
  } else {
    asrProvider.start()
    setIsListening(true)
  }
}
```

**Add** these two functions in its place:
```ts
function handleMicPointerDown(e: React.PointerEvent) {
  e.preventDefault()
  if (isLoading || !asrProvider.available) return
  asrProvider.start()
  setIsListening(true)
}

function handleMicPointerUp() {
  if (!isListening) return
  asrProvider.stop()
  // isListening stays true until onEnd fires (after transcription completes)
}
```

**Replace** the mic `<button>` element. Change from:
```tsx
<button
  className={`${styles.micBtn}${isListening ? ` ${styles.micBtnActive}` : ''}`}
  onClick={handleMic}
  disabled={!asrProvider.available || isLoading}
  title={asrProvider.available ? (isListening ? '停止录音' : '语音输入') : '语音输入（不支持）'}
  aria-label={isListening ? '停止录音' : '语音输入'}
>
  🎙
</button>
```

To:
```tsx
<button
  className={`${styles.micBtn}${isListening ? ` ${styles.micBtnActive}` : ''}`}
  onPointerDown={handleMicPointerDown}
  onPointerUp={handleMicPointerUp}
  onPointerCancel={handleMicPointerUp}
  onPointerLeave={handleMicPointerUp}
  disabled={!asrProvider.available || isLoading}
  title={asrProvider.available ? (isListening ? '转写中…' : '按住说话') : '语音输入（不支持）'}
  aria-label={isListening ? '转写中' : '按住说话'}
>
  🎙
</button>
```

- [ ] **Step 2: Update .env.example**

Open `.env.example`. Add after the existing `DEEPSEEK_API_KEY=` line:

```
# Silicon Flow Whisper API key — 用于语音转写（push-to-talk）
# 申请地址：https://cloud.siliconflow.cn
# env-only，不写入 userData/config.json，不可在运行时通过 UI 修改
SILICONFLOW_API_KEY=
```

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/components/InputBar/index.tsx .env.example
git commit -m "feat: InputBar push-to-talk mic + SILICONFLOW_API_KEY in .env.example"
```

---

## Final Verification

After all 5 tasks complete:

```bash
npx vitest run
```

Expected output: all tests pass, count increases by at least 25 (7 + 8 + 10 new tests)

```bash
npx tsc --noEmit
```

Expected: no errors

Manual smoke test (requires `SILICONFLOW_API_KEY` in `.env`):
1. Launch app: `npm run dev`
2. Press and hold the 🎙 button — button pulses, title shows "转写中…"
3. Speak "摩擦力是什么" — release button
4. Transcribed text appears in input / sends as message
5. Without `SILICONFLOW_API_KEY` set: hold + release → error toast "语音识别未配置"
