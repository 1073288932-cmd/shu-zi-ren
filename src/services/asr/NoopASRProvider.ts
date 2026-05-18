import type { ASRProvider } from './ASRProvider'

export class NoopASRProvider implements ASRProvider {
  start(): void {}
  stop(): void {}
  onResult(_cb: (text: string) => void): void {}
  onError(_cb: (err: Error) => void): void {}
}
