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

// Mock textSegmentation to split on 。 per sentence for test control
vi.mock('../src/services/textSegmentation', () => ({
  textSegmentation: (text: string) =>
    text.trim()
      .split(/(?<=。)/)
      .map(s => s.trim())
      .filter(Boolean),
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

describe('useAvatarVideoQueue — multi-segment double buffer', () => {
  it('after first segment starts playing, prefetches segment 2', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    expect(mockGenerate).toHaveBeenNthCalledWith(1, '一段。')

    // First segment ready → playing → triggers prefetch of segment 2
    await act(async () => {
      doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' })
    })
    await vi.waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(2))
    expect(mockGenerate).toHaveBeenNthCalledWith(2, '二段。')
  })

  it('on ended with next ready: swaps URL, revokes old, plays next', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    mockCreateObjectURL.mockReturnValueOnce('blob:1').mockReturnValueOnce('blob:2')
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    await vi.waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(2))
    await act(async () => { doneSubs[0]({ jobId: 'j2', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })

    act(() => { result.current.handleVideoEnded() })

    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:1')
    expect(useAgentStore.getState().videoUrl).toBe('blob:2')
    expect(useAgentStore.getState().videoQueueState).toBe('playing')
  })

  it('on ended with next NOT ready: enters stalled state', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })
    expect(useAgentStore.getState().videoQueueState).toBe('stalled')
  })

  it('stalled then next ready: transitions to playing', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    mockCreateObjectURL.mockReturnValueOnce('blob:1').mockReturnValueOnce('blob:2')
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })
    expect(useAgentStore.getState().videoQueueState).toBe('stalled')
    await act(async () => { doneSubs[0]({ jobId: 'j2', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    expect(useAgentStore.getState().videoUrl).toBe('blob:2')
    expect(useAgentStore.getState().videoQueueState).toBe('playing')
  })

  it('after last segment ends: revokes and goes to idle', async () => {
    mockGenerate.mockResolvedValueOnce({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('独段。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })
    expect(useAgentStore.getState().videoUrl).toBeNull()
    expect(useAgentStore.getState().videoQueueState).toBe('idle')
  })
})

describe('useAvatarVideoQueue — fallback & blocked & circuit breaker', () => {
  it('first segment NETWORK error → fallback reads remaining (= all) via Web Speech', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'NETWORK', message: 'down', recoverable: true } })
    })
    expect(useAgentStore.getState().videoQueueState).toBe('fallback')
    expect(mockSpeak).toHaveBeenCalledWith('一段。二段。')
  })

  it('mid-stream error after first segment played: Web Speech reads only remaining', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('段一。段二。段三。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })  // played++ to 1
    await act(async () => {
      errorSubs[0]({ jobId: 'j2', error: { code: 'TENCENT_API_FAIL', message: 'oops', recoverable: true } })
    })
    expect(mockSpeak).toHaveBeenCalledWith('段二。段三。')
  })

  it('POLICY_VIOLATION → blocked, NO Web Speech', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('被审核。') })
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'POLICY_VIOLATION', message: '违规', recoverable: false } })
    })
    expect(useAgentStore.getState().videoQueueState).toBe('blocked')
    expect(useAgentStore.getState().avatarVideoError?.code).toBe('POLICY_VIOLATION')
    expect(mockSpeak).not.toHaveBeenCalled()
  })

  describe('first-segment 12s timeout → fallback', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })
    it('fires fallback after FIRST_SEGMENT_TIMEOUT_MS', async () => {
      mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
      const { result } = renderHook(() => useAvatarVideoQueue())
      await act(async () => { await result.current.enqueue('hi.') })
      await act(async () => { await vi.advanceTimersByTimeAsync(12_000 + 50) })
      expect(mockCancel).toHaveBeenCalledWith('j1')
      expect(useAgentStore.getState().videoQueueState).toBe('fallback')
      expect(mockSpeak).toHaveBeenCalledWith('hi.')
    })
  })

  it('circuit breaker: 3 consecutive failures → next enqueue goes straight to Web Speech', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    for (let i = 0; i < 3; i++) {
      await act(async () => { await result.current.enqueue(`第${i}条。`) })
      await act(async () => {
        errorSubs[0]({ jobId: 'j1', error: { code: 'NETWORK', message: 'down', recoverable: true } })
      })
    }
    mockGenerate.mockClear()
    mockSpeak.mockClear()
    await act(async () => { await result.current.enqueue('应直接走 Web Speech。') })
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockSpeak).toHaveBeenCalledWith('应直接走 Web Speech。')
  })

  it('first success after partial failures resets the counter', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一次。') })
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'NETWORK', message: '?', recoverable: true } })
    })
    await act(async () => { await result.current.enqueue('二次。') })
    await act(async () => {
      doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' })
    })
    // Two more failures shouldn't trip breaker because success reset it
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'NETWORK', message: '?', recoverable: true } })
    })
    await act(async () => { await result.current.enqueue('三次。') })
    mockGenerate.mockClear()
    await act(async () => { await result.current.enqueue('四次。') })
    expect(mockGenerate).toHaveBeenCalled()  // not skipped
  })

  it('POLICY_VIOLATION does NOT increment circuit breaker counter', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    for (let i = 0; i < 3; i++) {
      await act(async () => { await result.current.enqueue(`违规${i}。`) })
      await act(async () => {
        errorSubs[0]({ jobId: 'j1', error: { code: 'POLICY_VIOLATION', message: '!', recoverable: false } })
      })
    }
    mockGenerate.mockClear()
    await act(async () => { await result.current.enqueue('再来一次。') })
    expect(mockGenerate).toHaveBeenCalled()  // breaker not tripped
  })

  it('user cancel does NOT increment circuit breaker counter', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    for (let i = 0; i < 3; i++) {
      await act(async () => { await result.current.enqueue(`x${i}。`) })
      act(() => { result.current.cancel() })
    }
    mockGenerate.mockClear()
    await act(async () => { await result.current.enqueue('未熔断。') })
    expect(mockGenerate).toHaveBeenCalled()
  })

  it('next-round enqueue clears blocked state', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('违规。') })
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'POLICY_VIOLATION', message: '!', recoverable: false } })
    })
    expect(useAgentStore.getState().videoQueueState).toBe('blocked')
    await act(async () => { await result.current.enqueue('正常。') })
    expect(useAgentStore.getState().videoQueueState).not.toBe('blocked')
    expect(useAgentStore.getState().avatarVideoError).toBeNull()
  })
})
