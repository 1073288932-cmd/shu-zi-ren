import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TencentAvatarVideoProvider } from '../src/services/avatarVideo/TencentAvatarVideoProvider'

const mockGenerate = vi.fn()
const mockCancel = vi.fn()
const mockOnProgress = vi.fn(() => () => {})
const mockOnDone = vi.fn(() => () => {})
const mockOnError = vi.fn(() => () => {})

beforeEach(() => {
  mockGenerate.mockReset()
  mockCancel.mockReset()
  mockOnProgress.mockClear()
  mockOnDone.mockClear()
  mockOnError.mockClear()
  ;(globalThis as any).window = {
    electronAPI: {
      generateAvatarSegment: mockGenerate,
      cancelAvatarSegment: mockCancel,
      onAvatarSegmentProgress: mockOnProgress,
      onAvatarSegmentDone: mockOnDone,
      onAvatarSegmentError: mockOnError,
    },
  }
})

describe('TencentAvatarVideoProvider', () => {
  it('delegates generate to electronAPI', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const p = new TencentAvatarVideoProvider()
    expect(await p.generate('你好')).toEqual({ ok: true, jobId: 'j1' })
    expect(mockGenerate).toHaveBeenCalledWith('你好')
  })

  it('delegates cancel to electronAPI', () => {
    new TencentAvatarVideoProvider().cancel('j2')
    expect(mockCancel).toHaveBeenCalledWith('j2')
  })

  it('subscribes to all three event channels', () => {
    const p = new TencentAvatarVideoProvider()
    p.onProgress(() => {})
    p.onDone(() => {})
    p.onError(() => {})
    expect(mockOnProgress).toHaveBeenCalled()
    expect(mockOnDone).toHaveBeenCalled()
    expect(mockOnError).toHaveBeenCalled()
  })
})
