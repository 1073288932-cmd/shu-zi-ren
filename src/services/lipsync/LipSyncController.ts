import type { Viseme } from '@shared/types'
import { textToVisemes } from './viseme'

export const STEP_INTERVAL = 180  // ms，相邻 viseme 的步进间隔

export class LipSyncController {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private onViseme: ((v: Viseme) => void) | null = null
  private sequence: Viseme[] = []
  private idx = 0

  start(text: string, onViseme: (v: Viseme) => void): void {
    this.stop()
    this.onViseme = onViseme
    this.sequence = textToVisemes(text)
    this.idx = 0
    if (this.sequence.length === 0) {
      onViseme('closed')
      this.onViseme = null
      return
    }
    // 立即 emit 首帧，避免开口前有一帧空档
    onViseme(this.sequence[0])
    this.idx = 1
    this.intervalId = setInterval(() => this.tick(), STEP_INTERVAL)
  }

  private tick(): void {
    if (!this.onViseme || this.sequence.length === 0) return
    this.onViseme(this.sequence[this.idx % this.sequence.length])
    this.idx++
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    // 强制闭口：无论当前处于什么 viseme
    this.onViseme?.('closed')
    this.onViseme = null
    this.sequence = []
    this.idx = 0
  }
}
