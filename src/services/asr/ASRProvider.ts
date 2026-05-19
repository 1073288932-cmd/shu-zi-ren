export interface ASRProvider {
  readonly available: boolean
  start(): void
  stop(): void
  onResult(cb: (text: string, isFinal: boolean) => void): void
  onError(cb: (code: string) => void): void
  onEnd(cb: () => void): void
}
