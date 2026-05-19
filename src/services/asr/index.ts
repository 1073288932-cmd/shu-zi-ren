import type { ASRProvider } from './ASRProvider'
import { WebSpeechASRProvider } from './WebSpeechASRProvider'
import { NoopASRProvider } from './NoopASRProvider'

const SR = typeof window !== 'undefined'
  ? (window.SpeechRecognition ?? (window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition)
  : undefined

export const asrProvider: ASRProvider = SR
  ? new WebSpeechASRProvider()
  : new NoopASRProvider()
