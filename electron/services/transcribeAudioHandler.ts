import type { AppError } from '../../shared/types'
import { SiliconFlowWhisperService, mapASRError } from './SiliconFlowWhisperService'

const MAX_BYTES = 10 * 1024 * 1024

type TranscribeService = { transcribe(buffer: ArrayBuffer): Promise<string> }

export async function handleTranscribeAudio(
  buffer: unknown,
  isValidSender: boolean,
  apiKey: string,
  serviceFactory: (key: string) => TranscribeService = (key) => new SiliconFlowWhisperService(key),
): Promise<string | AppError> {
  if (!isValidSender) {
    return { code: 'ASR_INVALID', message: '录音数据异常，请重试', recoverable: false }
  }
  if (!(buffer instanceof ArrayBuffer)) {
    return { code: 'ASR_INVALID', message: '录音数据异常，请重试', recoverable: false }
  }
  if (buffer.byteLength === 0) {
    return { code: 'empty-transcript', message: '没有听到声音，请重试', recoverable: true }
  }
  if (buffer.byteLength > MAX_BYTES) {
    return { code: 'ASR_TOO_LARGE', message: '录音数据过大，请重试', recoverable: true }
  }
  if (!apiKey) {
    return { code: 'ASR_UNAVAILABLE', message: '语音识别未配置', recoverable: true }
  }
  try {
    return await serviceFactory(apiKey).transcribe(buffer)
  } catch (err) {
    return mapASRError(err)
  }
}
