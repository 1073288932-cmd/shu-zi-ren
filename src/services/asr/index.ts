import type { ASRProvider } from './ASRProvider'
import { RecorderASRProvider } from './RecorderASRProvider'
import { NoopASRProvider } from './NoopASRProvider'

export const asrProvider: ASRProvider =
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getUserMedia === 'function' &&
  typeof MediaRecorder !== 'undefined'
    ? new RecorderASRProvider()
    : new NoopASRProvider()
