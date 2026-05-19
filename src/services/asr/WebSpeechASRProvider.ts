import type { ASRProvider } from './ASRProvider'

export class WebSpeechASRProvider implements ASRProvider {
  readonly available = true

  private recognition: SpeechRecognition | null = null
  private resultCb: ((text: string, isFinal: boolean) => void) | null = null
  private errorCb: ((code: string) => void) | null = null
  private endCb: (() => void) | null = null

  onResult(cb: (text: string, isFinal: boolean) => void): void {
    this.resultCb = cb
  }

  onError(cb: (code: string) => void): void {
    this.errorCb = cb
  }

  onEnd(cb: () => void): void {
    this.endCb = cb
  }

  start(): void {
    this.stop()

    const SR = window.SpeechRecognition ?? (window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition
    this.recognition = new SR()
    this.recognition.lang = 'zh-CN'
    this.recognition.interimResults = true
    this.recognition.continuous = false

    this.recognition.onresult = (e: SpeechRecognitionEvent) => {
      const result = e.results[e.results.length - 1]
      const text = result[0].transcript
      const isFinal = result.isFinal
      this.resultCb?.(text, isFinal)
    }

    this.recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
      this.errorCb?.(e.error)
    }

    this.recognition.onend = () => {
      this.endCb?.()
    }

    this.recognition.start()
  }

  stop(): void {
    if (this.recognition) {
      this.recognition.stop()
      this.recognition = null
    }
  }
}
