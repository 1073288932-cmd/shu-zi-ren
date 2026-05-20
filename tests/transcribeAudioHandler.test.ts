// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { handleTranscribeAudio } from '../electron/services/transcribeAudioHandler'
import { ASRTimeoutError, ASRHTTPError } from '../electron/services/SiliconFlowWhisperService'
import type { AppError } from '../shared/types'

describe('handleTranscribeAudio — validation', () => {
  it('returns ASR_INVALID when sender is invalid', async () => {
    const r = await handleTranscribeAudio(new ArrayBuffer(100), false, 'key')
    expect((r as AppError).code).toBe('ASR_INVALID')
  })

  it('returns ASR_INVALID for non-ArrayBuffer input', async () => {
    const r = await handleTranscribeAudio('not-a-buffer', true, 'key')
    expect((r as AppError).code).toBe('ASR_INVALID')
  })

  it('returns empty-transcript for byteLength === 0', async () => {
    const r = await handleTranscribeAudio(new ArrayBuffer(0), true, 'key')
    expect((r as AppError).code).toBe('empty-transcript')
  })

  it('returns ASR_TOO_LARGE for byteLength > 10MB', async () => {
    const r = await handleTranscribeAudio(new ArrayBuffer(10 * 1024 * 1024 + 1), true, 'key')
    expect((r as AppError).code).toBe('ASR_TOO_LARGE')
  })

  it('returns ASR_UNAVAILABLE when apiKey is empty', async () => {
    const r = await handleTranscribeAudio(new ArrayBuffer(100), true, '')
    expect((r as AppError).code).toBe('ASR_UNAVAILABLE')
  })
})

describe('handleTranscribeAudio — service dispatch (injected factory)', () => {
  it('returns transcribed string on success', async () => {
    const factory = () => ({ transcribe: vi.fn().mockResolvedValue('摩擦力是什么') })
    const r = await handleTranscribeAudio(new ArrayBuffer(100), true, 'key', factory)
    expect(r).toBe('摩擦力是什么')
  })

  it('maps ASRTimeoutError to ASR_TIMEOUT AppError', async () => {
    const factory = () => ({ transcribe: vi.fn().mockRejectedValue(new ASRTimeoutError()) })
    const r = await handleTranscribeAudio(new ArrayBuffer(100), true, 'key', factory)
    expect((r as AppError).code).toBe('ASR_TIMEOUT')
  })

  it('maps ASRHTTPError to its code', async () => {
    const factory = () => ({ transcribe: vi.fn().mockRejectedValue(new ASRHTTPError(500, 'ASR_ERROR')) })
    const r = await handleTranscribeAudio(new ArrayBuffer(100), true, 'key', factory)
    expect((r as AppError).code).toBe('ASR_ERROR')
  })
})
