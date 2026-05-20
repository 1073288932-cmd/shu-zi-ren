import type { ASRProvider } from './ASRProvider'
import type { AppError } from '@shared/types'

type ASRStatus = 'idle' | 'starting' | 'recording' | 'transcribing'

function isAppError(v: unknown): v is AppError {
  return typeof v === 'object' && v !== null && 'code' in v
}

function selectMimeType(): string {
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm']) {
    if (typeof MediaRecorder !== 'undefined' &&
        typeof MediaRecorder.isTypeSupported === 'function' &&
        MediaRecorder.isTypeSupported(mime)) {
      return mime
    }
  }
  return ''
}

export class RecorderASRProvider implements ASRProvider {
  private status: ASRStatus = 'idle'
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private mimeType = ''
  private chunks: Blob[] = []
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  private resultCb: ((text: string, isFinal: boolean) => void) | null = null
  private errorCb: ((code: string) => void) | null = null
  private endCb: (() => void) | null = null

  readonly available: boolean =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'

  onResult(cb: (text: string, isFinal: boolean) => void): void { this.resultCb = cb }
  onError(cb: (code: string) => void): void { this.errorCb = cb }
  onEnd(cb: () => void): void { this.endCb = cb }

  start(): void {
    if (this.status !== 'idle') return
    this.status = 'starting'
    this.chunks = []

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      this.stream = stream
      try {
        const mimeType = selectMimeType()
        this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        this.mimeType = this.recorder.mimeType

        this.recorder.ondataavailable = (e: BlobEvent) => {
          if (e.data.size > 0) this.chunks.push(e.data)
        }

        this.recorder.onstop = () => { void this.handleStop() }

        this.recorder.start()
        this.status = 'recording'

        this.timeoutId = setTimeout(() => { this.stop() }, 15_000)
      } catch {
        stream.getTracks().forEach(t => t.stop())
        this.stream = null
        this.recorder = null
        this.status = 'idle'
        this.errorCb?.('start-failed')
      }
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
      const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' })
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
