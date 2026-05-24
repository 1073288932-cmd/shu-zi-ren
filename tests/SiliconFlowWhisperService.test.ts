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

  it('maps ASRHTTPError(401) to ASR_AUTH_ERROR with recoverable: false', () => {
    const err = mapASRError(new ASRHTTPError(401, 'ASR_AUTH_ERROR'))
    expect(err.code).toBe('ASR_AUTH_ERROR')
    expect(err.recoverable).toBe(false)
  })

  it('maps ASRHTTPError(500) to ASR_ERROR with recoverable: true', () => {
    const err = mapASRError(new ASRHTTPError(500, 'ASR_ERROR'))
    expect(err.code).toBe('ASR_ERROR')
    expect(err.recoverable).toBe(true)
  })

  it('maps unknown errors to ASR_ERROR', () => {
    expect(mapASRError(new Error('net::ERR_NAME_NOT_RESOLVED')).code).toBe('ASR_ERROR')
  })
})
