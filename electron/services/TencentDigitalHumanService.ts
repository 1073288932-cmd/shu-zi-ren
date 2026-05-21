import crypto from 'crypto'
import type { AppError, AvatarVideoErrorCode } from '../../shared/types'

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024
export const POLL_INTERVAL_MS = 1500
export const POLL_TOTAL_TIMEOUT_MS = 60_000
export const DOWNLOAD_TIMEOUT_MS = 15_000

const SUBMIT_PATH = '/v2/ivh/videomaker/broadcastservice/phototovideonotrain'
const QUERY_PATH = '/v2/ivh/videomaker/broadcastservice/getprogress'
const POLICY_FAIL_CODES = new Set([801005, 802000])

export interface TencentDigitalHumanConfig {
  appkey: string
  accesstoken: string
  endpoint: string   // 'gw.tvs.qq.com'
}

export interface SubmitInput {
  refPhotoUrl: string
  ssml: string
}

function toAppError(code: AvatarVideoErrorCode, message: string): AppError {
  return { code, message, recoverable: code !== 'INVALID_INPUT' && code !== 'POLICY_VIOLATION' }
}

function buildSignedUrl(endpoint: string, path: string, appkey: string, accesstoken: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `appkey=${appkey}&timestamp=${timestamp}`
  const signature = crypto.createHmac('sha256', accesstoken).update(message, 'utf8').digest('base64')
  const params = new URLSearchParams({ appkey, timestamp: String(timestamp), signature })
  return `https://${endpoint}${path}?${params}`
}

export class TencentDigitalHumanService {
  constructor(private cfg: TencentDigitalHumanConfig) {}

  async submitPhotoToVideoNoTrain(input: SubmitInput, signal: AbortSignal): Promise<string> {
    const data = await this.call(SUBMIT_PATH, {
      Header: {},
      Payload: { RefPhotoUrl: input.refPhotoUrl, InputSsml: input.ssml, DriverType: 'Text' },
    }, signal)
    const jobId: unknown = data?.Payload?.JobId
    if (typeof jobId !== 'string' || !jobId) {
      throw toAppError('TENCENT_API_FAIL', 'IVH did not return JobId')
    }
    return jobId
  }

  async pollUntilDone(
    jobId: string,
    signal: AbortSignal,
    onAttempt: (attempt: number) => void,
  ): Promise<string> {
    const deadline = Date.now() + POLL_TOTAL_TIMEOUT_MS
    let attempt = 0
    while (true) {
      if (signal.aborted) throw toAppError('TENCENT_API_FAIL', 'aborted')
      if (Date.now() >= deadline) throw toAppError('TENCENT_TIMEOUT', 'Polling timed out')
      attempt++
      onAttempt(attempt)
      const data = await this.call(QUERY_PATH, { Header: {}, Payload: { JobId: jobId } }, signal)
      const payload = data?.Payload ?? {}
      const status: unknown = payload.Status
      const failCode: unknown = payload.FailCode

      if (status === 'FAIL' || payload.Progress === -1) {
        if (typeof failCode === 'number' && POLICY_FAIL_CODES.has(failCode)) {
          throw toAppError('POLICY_VIOLATION', `IVH policy denied (FailCode ${failCode})`)
        }
        throw toAppError('TENCENT_API_FAIL', `IVH job failed (FailCode ${failCode ?? 'unknown'})`)
      }
      if (status === 'SUCCESS') {
        const videoUrl: unknown = payload.VideoUrl
        if (typeof videoUrl === 'string' && videoUrl) return videoUrl
        throw toAppError('TENCENT_API_FAIL', 'IVH SUCCESS but no VideoUrl')
      }
      await this.sleep(POLL_INTERVAL_MS, signal)
    }
  }

  async downloadVideo(
    url: string,
    signal: AbortSignal,
  ): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
    const downloadController = new AbortController()
    const cancelOnOuter = () => downloadController.abort()
    signal.addEventListener('abort', cancelOnOuter, { once: true })

    let timeoutReject!: (e: AppError) => void
    const timeoutPromise = new Promise<never>((_, reject) => { timeoutReject = reject })
    const timer = setTimeout(() => {
      downloadController.abort()
      timeoutReject(toAppError('TENCENT_TIMEOUT', 'Download timed out'))
    }, DOWNLOAD_TIMEOUT_MS)

    try {
      let res: Response
      try {
        res = await Promise.race([
          fetch(url, { signal: downloadController.signal }),
          timeoutPromise,
        ])
      } catch (err: unknown) {
        const e = err as AppError
        if (e && e.code === 'TENCENT_TIMEOUT') throw err
        throw toAppError('NETWORK', err instanceof Error ? err.message : String(err))
      }
      if (!res.ok) throw toAppError('TENCENT_API_FAIL', `Download status ${res.status}`)
      const ct = (res.headers.get('Content-Type') ?? '').toLowerCase()
      if (!ct.startsWith('video/')) throw toAppError('TENCENT_API_FAIL', `Unexpected Content-Type: ${ct}`)
      const lenHeader = res.headers.get('Content-Length')
      if (lenHeader && Number(lenHeader) > MAX_VIDEO_BYTES) {
        throw toAppError('TENCENT_API_FAIL', `Video too large: ${lenHeader} bytes`)
      }
      const buffer = await res.arrayBuffer()
      if (buffer.byteLength > MAX_VIDEO_BYTES) {
        throw toAppError('TENCENT_API_FAIL', `Video too large after download: ${buffer.byteLength} bytes`)
      }
      return { buffer, mimeType: ct }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancelOnOuter)
    }
  }

  private async call(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<{ Header?: Record<string, unknown>; Payload?: Record<string, unknown> }> {
    const url = buildSignedUrl(this.cfg.endpoint, path, this.cfg.appkey, this.cfg.accesstoken)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err: unknown) {
      throw toAppError('NETWORK', err instanceof Error ? err.message : String(err))
    }
    if (!res.ok) throw toAppError('TENCENT_API_FAIL', `HTTP ${res.status}`)
    const data = await res.json().catch(() => ({})) as {
      Header?: { Code?: number; Message?: string }
      Payload?: Record<string, unknown>
    }
    const code = data?.Header?.Code
    if (typeof code === 'number' && code !== 0) {
      const failCode = data?.Payload?.FailCode
      if (typeof failCode === 'number' && POLICY_FAIL_CODES.has(failCode)) {
        throw toAppError('POLICY_VIOLATION', data.Header?.Message ?? 'IVH policy denied')
      }
      throw toAppError('TENCENT_API_FAIL', data.Header?.Message ?? `IVH error code ${code}`)
    }
    return data as { Header?: Record<string, unknown>; Payload?: Record<string, unknown> }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      const onAbort = () => { clearTimeout(t); reject(toAppError('TENCENT_API_FAIL', 'aborted during sleep')) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
