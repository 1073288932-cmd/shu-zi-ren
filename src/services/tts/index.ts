import type { TTSProvider } from './TTSProvider'
import { NoopTTSProvider } from './NoopTTSProvider'

// WebSpeechTTSProvider is created in Task 8 and replaces this placeholder
export const ttsProvider: TTSProvider = new NoopTTSProvider()
