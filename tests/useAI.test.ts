import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAI } from '../src/hooks/useAI'
import { useAgentStore, initialState } from '../src/store/agentStore'
import type { AIResponse, Viseme } from '@shared/types'

const mockChat = vi.hoisted(() => vi.fn())
const mockSpeak = vi.hoisted(() => vi.fn())
const mockTtsStop = vi.hoisted(() => vi.fn())
const mockLipStart = vi.hoisted(() => vi.fn())
const mockLipStop = vi.hoisted(() => vi.fn())

vi.mock('../src/services/ai', () => ({
  aiProvider: { chat: mockChat },
}))
vi.mock('../src/services/tts', () => ({
  ttsProvider: { speak: mockSpeak, stop: mockTtsStop },
}))
vi.mock('../src/services/lipsync', () => ({
  lipSyncController: { start: mockLipStart, stop: mockLipStop },
}))

const mockReply = 'Test AI reply about friction'
const mockResponse: AIResponse = {
  reply: mockReply,
  resourceCards: [
    { id: 'c1', kind: 'external', title: 'Test', type: 'link', description: 'desc', url: 'https://example.com', tags: [] },
  ],
}

describe('useAI', () => {
  beforeEach(() => {
    mockChat.mockResolvedValue(mockResponse)
    mockSpeak.mockReturnValue(new Promise<void>(() => {}))
    vi.useFakeTimers()
    useAgentStore.setState(initialState)

    // mock 必须模拟真实 LipSyncController contract，否则 currentViseme 断言无意义：
    // start(text, cb) 立即用回调推一个非 closed viseme（真实是序列首帧）；
    // stop() 强制把 viseme 推回 closed（spec Section 5）。
    mockLipStart.mockImplementation((_text: string, cb: (v: Viseme) => void) => {
      cb('a')
    })
    mockLipStop.mockImplementation(() => {
      useAgentStore.getState().setCurrentViseme('closed')
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('sets mood to thinking then talking on success', async () => {
    const { result } = renderHook(() => useAI())
    expect(useAgentStore.getState().mood).toBe('idle')
    act(() => { result.current.sendMessage('摩擦力') })
    expect(useAgentStore.getState().mood).toBe('thinking')
    expect(useAgentStore.getState().isLoading).toBe(true)
    await act(async () => { await vi.runAllTicks() })
    expect(useAgentStore.getState().mood).toBe('talking')
    expect(useAgentStore.getState().isLoading).toBe(false)
    expect(useAgentStore.getState().isPushing).toBe(true)
  })

  it('does not submit when isLoading is true', () => {
    const { result } = renderHook(() => useAI())
    act(() => { result.current.sendMessage('first') })
    act(() => { result.current.sendMessage('second') })
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('sets mood to error and stores lastUserInput on failure', async () => {
    mockChat.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('摩擦力'); await vi.runAllTicks() })
    const s = useAgentStore.getState()
    expect(s.mood).toBe('error')
    expect(s.error?.code).toBe('AI_ERROR')
    expect(s.lastUserInput).toBe('摩擦力')
    expect(s.isLoading).toBe(false)
  })

  it('retry sends lastUserInput again', async () => {
    mockChat.mockRejectedValueOnce(new Error('fail'))
    mockChat.mockResolvedValueOnce(mockResponse)
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('摩擦力'); await vi.runAllTicks() })
    expect(useAgentStore.getState().mood).toBe('error')
    await act(async () => { result.current.retry(); await vi.runAllTicks() })
    expect(mockChat).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('starts lip-sync with the reply text on AI success', async () => {
    mockSpeak.mockReturnValue(new Promise<void>(() => {}))  // never resolves
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('牛顿第一定律'); await vi.runAllTicks() })
    expect(mockLipStart).toHaveBeenCalledWith(mockReply, expect.any(Function))
    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('stops lip-sync and returns to idle after TTS resolves', async () => {
    let resolveSpeak!: () => void
    mockSpeak.mockReturnValue(new Promise<void>(r => { resolveSpeak = r }))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('test'); await vi.runAllTicks() })
    // 讲话中应是非 closed（mockLipStart 通过回调推了 'a'），断言才有变化的起点
    expect(useAgentStore.getState().mood).toBe('talking')
    expect(useAgentStore.getState().currentViseme).toBe('a')
    await act(async () => { resolveSpeak(); await vi.runAllTicks() })
    expect(mockLipStop).toHaveBeenCalled()
    expect(useAgentStore.getState().currentViseme).toBe('closed')
    expect(useAgentStore.getState().mood).toBe('idle')
    expect(useAgentStore.getState().isPushing).toBe(false)
  })

  it('stops lip-sync and returns to idle after TTS rejects', async () => {
    let rejectSpeak!: () => void
    mockSpeak.mockReturnValue(new Promise<void>((_, rej) => { rejectSpeak = () => rej(new Error('tts fail')) }))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('test'); await vi.runAllTicks() })
    expect(useAgentStore.getState().currentViseme).toBe('a')
    await act(async () => { rejectSpeak(); await vi.runAllTicks() })
    expect(mockLipStop).toHaveBeenCalled()
    expect(useAgentStore.getState().currentViseme).toBe('closed')
    expect(useAgentStore.getState().mood).toBe('idle')
  })

  it('stops previous TTS and lip-sync at the start of a new message', async () => {
    mockSpeak.mockReturnValue(new Promise<void>(() => {}))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('first'); await vi.runAllTicks() })
    mockTtsStop.mockClear()
    mockLipStop.mockClear()
    await act(async () => { result.current.sendMessage('second'); await vi.runAllTicks() })
    expect(mockTtsStop).toHaveBeenCalled()
    expect(mockLipStop).toHaveBeenCalled()
  })

  it('stale TTS resolving after a new message does not clobber the current one', async () => {
    let resolveFirst!: () => void
    mockSpeak.mockReturnValueOnce(new Promise<void>(r => { resolveFirst = r }))
    mockSpeak.mockReturnValueOnce(new Promise<void>(() => {}))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('first'); await vi.runAllTicks() })
    await act(async () => { result.current.sendMessage('second'); await vi.runAllTicks() })
    expect(useAgentStore.getState().mood).toBe('talking')

    mockLipStop.mockClear()
    // 现在才 resolve 第一条（已过期的）speak promise
    await act(async () => { resolveFirst(); await vi.runAllTicks() })

    expect(mockLipStop).not.toHaveBeenCalled()       // stale finishTalking 必须是 no-op
    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('stops lip-sync on AI failure', async () => {
    mockChat.mockRejectedValueOnce(new Error('network error'))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('hi'); await vi.runAllTicks() })
    expect(mockLipStop).toHaveBeenCalled()
    expect(useAgentStore.getState().mood).toBe('error')
  })
})
