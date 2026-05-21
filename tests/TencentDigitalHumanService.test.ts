import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TencentDigitalHumanService, MAX_VIDEO_BYTES, DOWNLOAD_TIMEOUT_MS, POLL_INTERVAL_MS, POLL_TOTAL_TIMEOUT_MS } from '../electron/services/TencentDigitalHumanService'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const config = {
  appkey: 'testappkey',
  accesstoken: 'testaccesstoken',
  endpoint: 'gw.tvs.qq.com',
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' }, ...init,
  })
}

describe('TencentDigitalHumanService.submitPhotoToVideoNoTrain', () => {
  it('returns JobId on Header.Code=0', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Header: { Code: 0 }, Payload: { JobId: 'job-42' } }))
    const svc = new TencentDigitalHumanService(config)
    const jobId = await svc.submitPhotoToVideoNoTrain({
      refPhotoUrl: 'https://photo', ssml: '你好',
    }, new AbortController().signal)
    expect(jobId).toBe('job-42')
  })

  it('maps policy FailCode 801005 in Payload to POLICY_VIOLATION', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      Header: { Code: 1, Message: '内容审核不通过' }, Payload: { FailCode: 801005 },
    }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.submitPhotoToVideoNoTrain(
      { refPhotoUrl: 'u', ssml: 't' }, new AbortController().signal
    )).rejects.toMatchObject({ code: 'POLICY_VIOLATION' })
  })

  it('maps policy FailCode 802000 in Payload to POLICY_VIOLATION', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      Header: { Code: 1, Message: '图片审核失败' }, Payload: { FailCode: 802000 },
    }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.submitPhotoToVideoNoTrain(
      { refPhotoUrl: 'u', ssml: 't' }, new AbortController().signal
    )).rejects.toMatchObject({ code: 'POLICY_VIOLATION' })
  })

  it('maps other Header.Code errors to TENCENT_API_FAIL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      Header: { Code: 500, Message: '内部错误' }, Payload: {},
    }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.submitPhotoToVideoNoTrain(
      { refPhotoUrl: 'u', ssml: 't' }, new AbortController().signal
    )).rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })

  it('maps fetch failure to NETWORK', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.submitPhotoToVideoNoTrain(
      { refPhotoUrl: 'u', ssml: 't' }, new AbortController().signal
    )).rejects.toMatchObject({ code: 'NETWORK' })
  })
})

describe('TencentDigitalHumanService.pollUntilDone', () => {
  it('resolves VideoUrl when Payload.Status=SUCCESS', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ Header: { Code: 0 }, Payload: { Status: 'MAKING', Progress: 50 } }))
      .mockResolvedValueOnce(jsonResponse({ Header: { Code: 0 }, Payload: { Status: 'SUCCESS', Progress: 100, VideoUrl: 'https://video' } }))
    const svc = new TencentDigitalHumanService(config)
    const attempts: number[] = []
    const promise = svc.pollUntilDone('job-1', new AbortController().signal, n => attempts.push(n))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    const videoUrl = await promise
    expect(videoUrl).toBe('https://video')
    expect(attempts).toEqual([1, 2])
  })

  it('rejects TENCENT_TIMEOUT after POLL_TOTAL_TIMEOUT_MS', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Header: { Code: 0 }, Payload: { Status: 'MAKING', Progress: 10 } }))
    const svc = new TencentDigitalHumanService(config)
    const promise = svc.pollUntilDone('job-1', new AbortController().signal, () => {})
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(POLL_TOTAL_TIMEOUT_MS + 100)
    await expect(promise).rejects.toMatchObject({ code: 'TENCENT_TIMEOUT' })
  })

  it('FAIL status + FailCode 801005 → POLICY_VIOLATION', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      Header: { Code: 0 }, Payload: { Status: 'FAIL', Progress: -1, FailCode: 801005 },
    }))
    const svc = new TencentDigitalHumanService(config)
    const promise = svc.pollUntilDone('job-1', new AbortController().signal, () => {})
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await expect(promise).rejects.toMatchObject({ code: 'POLICY_VIOLATION' })
  })

  it('FAIL status without policy FailCode → TENCENT_API_FAIL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      Header: { Code: 0 }, Payload: { Status: 'FAIL', Progress: -1, FailCode: 999 },
    }))
    const svc = new TencentDigitalHumanService(config)
    const promise = svc.pollUntilDone('job-1', new AbortController().signal, () => {})
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await expect(promise).rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })

  it('aborts on signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Header: { Code: 0 }, Payload: { Status: 'MAKING', Progress: 10 } }))
    const svc = new TencentDigitalHumanService(config)
    const controller = new AbortController()
    const promise = svc.pollUntilDone('job-1', controller.signal, () => {})
    promise.catch(() => {})
    controller.abort()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await expect(promise).rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })
})

describe('TencentDigitalHumanService.downloadVideo', () => {
  function videoResponse(body: Uint8Array<ArrayBuffer>, contentLength?: number, contentType = 'video/mp4', status = 200) {
    const headers: Record<string, string> = { 'Content-Type': contentType }
    if (contentLength !== undefined) headers['Content-Length'] = String(contentLength)
    return new Response(body, { status, headers })
  }

  it('returns ArrayBuffer + mimeType on valid 2xx video/* response', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    fetchMock.mockResolvedValueOnce(videoResponse(bytes, 4))
    const svc = new TencentDigitalHumanService(config)
    const result = await svc.downloadVideo('https://video', new AbortController().signal)
    expect(result.mimeType).toBe('video/mp4')
    expect(new Uint8Array(result.buffer)).toEqual(bytes)
  })

  it('rejects TENCENT_API_FAIL on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('error', { status: 500 }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.downloadVideo('https://video', new AbortController().signal))
      .rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })

  it('rejects TENCENT_API_FAIL on non-video Content-Type', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>error</html>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.downloadVideo('https://video', new AbortController().signal))
      .rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })

  it('rejects TENCENT_API_FAIL when Content-Length exceeds MAX_VIDEO_BYTES', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', {
      status: 200,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(MAX_VIDEO_BYTES + 1) },
    }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.downloadVideo('https://video', new AbortController().signal))
      .rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })

  it('rejects TENCENT_TIMEOUT when download exceeds DOWNLOAD_TIMEOUT_MS', async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {/* never */}))
    const svc = new TencentDigitalHumanService(config)
    const promise = svc.downloadVideo('https://video', new AbortController().signal)
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS + 100)
    await expect(promise).rejects.toMatchObject({ code: 'TENCENT_TIMEOUT' })
  })
})
