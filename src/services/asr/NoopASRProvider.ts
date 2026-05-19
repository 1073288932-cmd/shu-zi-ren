import type { ASRProvider } from './ASRProvider'

export class NoopASRProvider implements ASRProvider {
  readonly available = false
  start(): void {}
  stop(): void {}
  onResult(_cb: (text: string, isFinal: boolean) => void): void {}
  onError(_cb: (code: string) => void): void {}
  onEnd(_cb: () => void): void {}
}
