export interface ASRProvider {
  start(): void
  stop(): void
  onResult(cb: (text: string) => void): void
  onError(cb: (err: Error) => void): void
}
