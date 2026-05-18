export interface TTSProvider {
  speak(text: string): Promise<void>
  cancel(): void
}
