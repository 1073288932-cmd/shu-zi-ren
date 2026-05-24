import type { TTSProvider } from './TTSProvider'

export class NoopTTSProvider implements TTSProvider {
  speak(text: string): Promise<void> {
    if (!text) return Promise.resolve()
    return new Promise(resolve =>
      setTimeout(resolve, Math.min(1500 + text.length * 40, 8000))
    )
  }

  stop(): void {}
}
