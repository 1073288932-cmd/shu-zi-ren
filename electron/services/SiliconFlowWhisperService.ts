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
    if (err.code === 'ASR_AUTH_ERROR') {
      return { code: 'ASR_AUTH_ERROR', message: '语音识别配置无效', recoverable: false }
    }
    return { code: err.code, message: '转写失败，请重试', recoverable: true }
  }
  return { code: 'ASR_ERROR', message: '转写失败，请重试', recoverable: true }
}
