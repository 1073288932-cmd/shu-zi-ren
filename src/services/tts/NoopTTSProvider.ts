import type { TTSProvider } from './TTSProvider'

export class NoopTTSProvider implements TTSProvider {
  async speak(_text: string): Promise<void> {}
  cancel(): void {}
}
