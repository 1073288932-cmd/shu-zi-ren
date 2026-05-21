import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

// Mock the provider singleton before importing the hook
const mockGenerate = vi.hoisted(() => vi.fn())
const mockCancel = vi.hoisted(() => vi.fn())
const progressSubs = vi.hoisted<((e: any) => void)[]>(() => [])
const doneSubs = vi.hoisted<((e: any) => void)[]>(() => [])
const errorSubs = vi.hoisted<((e: any) => void)[]>(() => [])
vi.mock('../src/services/avatarVideo', () => ({
  avatarVideoProvider: {
    generate: mockGenerate,
    cancel: mockCancel,
    onProgress: (cb: any) => { progressSubs.push(cb); return () => {} },
    onDone: (cb: any) => { doneSubs.push(cb); return () => {} },
    onError: (cb: any) => { errorSubs.push(cb); return () => {} },
  },
}))

// Mock Web Speech TTS provider
const mockSpeak = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockTtsStop = vi.hoisted(() => vi.fn())
vi.mock('../src/services/tts', () => ({
  ttsProvider: { speak: mockSpeak, stop: mockTtsStop },
}))

import { useAvatarVideoQueue } from '../src/hooks/useAvatarVideoQueue'

const mockCreateObjectURL = vi.fn(() => 'blob:abc')
const mockRevokeObjectURL = vi.fn()

beforeEach(() => {
  mockGenerate.mockReset()
  mockCancel.mockReset()
  mockSpeak.mockReset().mockResolvedValue(undefined)
  mockTtsStop.mockReset()
  progressSubs.length = 0
  doneSubs.length = 0
  errorSubs.length = 0
  mockCreateObjectURL.mockClear()
  mockRevokeObjectURL.mockClear()
  vi.stubGlobal('URL', { createObjectURL: mockCreateObjectURL, revokeObjectURL: mockRevokeObjectURL })
  useAgentStore.setState(initialState)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAvatarVideoQueue — single segment', () => {
  it('enqueue triggers generate with first segment ssml and sets state=generating', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('简短答复。') })
    expect(mockGenerate).toHaveBeenCalledWith('简短答复。')
    expect(useAgentStore.getState().videoQueueState).toBe('generating')
  })

  it('on done event for current job: creates blob URL and sets state=playing', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    act(() => {
      doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' })
    })
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().videoUrl).toBe('blob:abc')
    expect(useAgentStore.getState().videoQueueState).toBe('playing')
  })

  it('ignores done events for stale jobIds', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    act(() => {
      doneSubs[0]({ jobId: 'stale-job', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' })
    })
    expect(mockCreateObjectURL).not.toHaveBeenCalled()
    expect(useAgentStore.getState().videoUrl).toBeNull()
  })

  it('onVideoEnded revokes current URL and resets to idle when no more segments', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    act(() => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:abc')
    expect(useAgentStore.getState().videoUrl).toBeNull()
    expect(useAgentStore.getState().videoQueueState).toBe('idle')
  })

  it('cancel sends cancelAvatarSegment and revokes any pending URL', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    act(() => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' }) })
    act(() => { result.current.cancel() })
    expect(mockCancel).toHaveBeenCalledWith('j1')
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:abc')
    expect(useAgentStore.getState().videoUrl).toBeNull()
    expect(useAgentStore.getState().videoQueueState).toBe('idle')
  })

  it('enqueue with empty text is a no-op', async () => {
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('   ') })
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(useAgentStore.getState().videoQueueState).toBe('idle')
  })

  it('clears previous avatarVideoError on new enqueue', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    useAgentStore.setState({ avatarVideoError: { code: 'NETWORK', message: 'old', recoverable: true } })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    expect(useAgentStore.getState().avatarVideoError).toBeNull()
  })
})
