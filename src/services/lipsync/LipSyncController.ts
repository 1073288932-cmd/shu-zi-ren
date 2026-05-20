import type { MouthShape, MouthState } from '@shared/types'

const INTERVAL = 110  // ms between mouth state updates

const CJK_SHAPES: MouthShape[] = ['ah', 'oh', 'ee', 'wide', 'slightlyOpen']
const ASCII_SHAPES: MouthShape[] = ['slightlyOpen', 'ee', 'oh']
const CJK_MAX_INTENSITY = 1.0
const ASCII_MAX_INTENSITY = 0.55

type SegType = 'cjk' | 'ascii' | 'pause' | 'silence'

interface Segment {
  type: SegType
  char: string
}

function segmentText(text: string): Segment[] {
  return [...text].map(ch => {
    if (/[。！？，、；…\n]/.test(ch)) return { type: 'pause' as const,   char: ch }
    if (/\s/.test(ch))                return { type: 'silence' as const, char: ch }
    if (/[一-鿿぀-ヿ가-힯]/.test(ch)) return { type: 'cjk' as const,     char: ch }
    return                                   { type: 'ascii' as const,   char: ch }
  })
}

function pauseFrames(char: string): number {
  if (/[。！？]/.test(char)) return 3  // 1 trigger + 3 = 4 × 110ms ≈ 440ms
  if (/[，、；]/.test(char)) return 1  // 1 trigger + 1 = 2 × 110ms ≈ 220ms
  if (/[…]/.test(char))      return 4  // 1 trigger + 4 = 5 × 110ms ≈ 550ms
  return 0
}

export class LipSyncController {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private onState: ((state: MouthState) => void) | null = null
  private segments: Segment[] = []
  private segIdx = 0
  private remainingPauseFrames = 0

  start(text: string, onState: (state: MouthState) => void): void {
    this.stop()
    this.onState = onState
    this.segments = segmentText(text)
    this.segIdx = 0
    this.remainingPauseFrames = 0
    const hasSpeaking = this.segments.some(s => s.type === 'cjk' || s.type === 'ascii')
    if (!hasSpeaking) return
    this.intervalId = setInterval(() => this._tick(), INTERVAL)
  }

  private _tick(): void {
    if (!this.onState) return

    if (this.remainingPauseFrames > 0) {
      this.remainingPauseFrames--
      this.onState({ shape: 'closed', intensity: 0 })
      return
    }

    const seg = this.segments[this.segIdx % this.segments.length]
    this.segIdx++

    if (seg.type === 'silence') {
      this.onState({ shape: 'closed', intensity: 0 })
      return
    }

    if (seg.type === 'pause') {
      this.remainingPauseFrames = pauseFrames(seg.char)
      this.onState({ shape: 'closed', intensity: 0 })
      return
    }

    const shapes = seg.type === 'cjk' ? CJK_SHAPES : ASCII_SHAPES
    const maxIntensity = seg.type === 'cjk' ? CJK_MAX_INTENSITY : ASCII_MAX_INTENSITY

    // Deterministic variation: avoids mechanical repetition without true randomness
    const shapeIdx = (this.segIdx * 2 + (this.segIdx >> 3)) % shapes.length
    const intensityVariation = 0.7 + 0.3 * Math.abs(Math.sin(this.segIdx * 0.618))
    const intensity = Math.min(1, maxIntensity * intensityVariation)

    this.onState({ shape: shapes[shapeIdx], intensity })
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.onState?.({ shape: 'closed', intensity: 0 })
    this.onState = null
    this.segments = []
    this.segIdx = 0
    this.remainingPauseFrames = 0
  }
}
