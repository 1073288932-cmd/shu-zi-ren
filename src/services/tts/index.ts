import { NoopTTSProvider } from './NoopTTSProvider'
import { WebSpeechTTSProvider } from './WebSpeechTTSProvider'
import type { TTSProvider } from './TTSProvider'

export const ttsProvider: TTSProvider =
  typeof window !== 'undefined' && 'speechSynthesis' in window
    ? new WebSpeechTTSProvider()
    : new NoopTTSProvider()

export { NoopTTSProvider, WebSpeechTTSProvider }
export type { TTSProvider }
