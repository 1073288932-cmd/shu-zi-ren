import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RecorderASRProvider } from '../src/services/asr/RecorderASRProvider'
import type { AppError } from '../shared/types'

// --- Mocks ---

type MockRecorder = {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
}

let mockRecorderInstance: MockRecorder
const MockMediaRecorder = vi.fn().mockImplementation(() => {
  mockRecorderInstance = {
    start: vi.fn(),
    stop: vi.fn(),
    mimeType: 'audio/webm;codecs=opus',
    ondataavailable: null,
    onstop: null,
  }
  return mockRecorderInstance
})
// Static method — checked by selectMimeType() inside RecorderASRProvider
;(MockMediaRecorder as unknown as Record<string, unknown>).isTypeSupported = vi.fn().mockReturnValue(true)

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
  it('available is true when navigator.mediaDevices.getUserMedia and MediaRecorder both exist', () => {
    const provider = new RecorderASRProvider()
    expect(provider.available).toBe(true)
  })

  it('available is false when MediaRecorder is not defined', () => {
    vi.stubGlobal('MediaRecorder', undefined)
    const provider = new RecorderASRProvider()
    expect(provider.available).toBe(false)
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
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
    mockRecorderInstance.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
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
    mockRecorderInstance.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
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

  it('recorder.start() throws → stream tracks stopped, onError(start-failed)', async () => {
    MockMediaRecorder.mockImplementationOnce(() => {
      mockRecorderInstance = {
        start: vi.fn().mockImplementation(() => { throw new Error('not supported') }),
        stop: vi.fn(),
        mimeType: 'audio/webm',
        ondataavailable: null,
        onstop: null,
      }
      return mockRecorderInstance
    })
    const provider = new RecorderASRProvider()
    const errorCb = vi.fn()
    provider.onError(errorCb)

    await startAndWait(provider)

    expect(mockTrackStop).toHaveBeenCalled()
    expect(errorCb).toHaveBeenCalledWith('start-failed')
  })

  it('15s timeout automatically calls stop()', async () => {
    vi.useFakeTimers()
    const provider = new RecorderASRProvider()

    provider.start()
    await flush()

    expect(mockRecorderInstance.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(15_001)
    expect(mockRecorderInstance.stop).toHaveBeenCalled()

    vi.useRealTimers()
  })
})
