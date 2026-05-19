export interface TTSProvider {
  speak(text: string): Promise<void>
  stop(): void
}
