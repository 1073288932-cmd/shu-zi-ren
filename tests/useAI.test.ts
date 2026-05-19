import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAI } from '../src/hooks/useAI'
import { useAgentStore, initialState } from '../src/store/agentStore'
import type { AIResponse } from '@shared/types'

const mockReply = 'Test AI reply about friction'
const mockResponse: AIResponse = {
  reply: mockReply,
  resourceCards: [
    {
      id: 'c1',
      kind: 'external',
      title: 'Test',
      type: 'link',
      description: 'desc',
      url: 'https://example.com',
      tags: [],
    },
  ],
}

const mockChat = vi.hoisted(() => vi.fn())

vi.mock('../src/services/ai', () => ({
  aiProvider: { chat: mockChat },
}))

const mockSpeak = vi.hoisted(() => vi.fn())
const mockStop = vi.hoisted(() => vi.fn())

vi.mock('../src/services/tts', () => ({
  ttsProvider: { speak: mockSpeak, stop: mockStop },
}))

describe('useAI', () => {
  beforeEach(() => {
    mockChat.mockResolvedValue(mockResponse)
    vi.useFakeTimers()
    useAgentStore.setState(initialState)
    mockSpeak.mockReturnValue(new Promise<void>(() => {}))  // pending by default
    mockStop.mockReset()
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

  it('mood returns to idle after talking duration (TTS resolves)', async () => {
    let resolveTts!: () => void
    mockSpeak.mockReturnValue(new Promise<void>(r => { resolveTts = r }))

    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('test')
      await vi.runAllTicks()
    })

    expect(useAgentStore.getState().mood).toBe('talking')

    await act(async () => { resolveTts() })

    expect(useAgentStore.getState().mood).toBe('idle')
  })

  it('does not submit when isLoading is true', async () => {
    const { result } = renderHook(() => useAI())

    act(() => { result.current.sendMessage('first') })
    act(() => { result.current.sendMessage('second') })

    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('sets mood to error and stores lastUserInput on failure', async () => {
    mockChat.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('摩擦力')
      await vi.runAllTicks()
    })

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

    await act(async () => {
      result.current.sendMessage('摩擦力')
      await vi.runAllTicks()
    })

    expect(useAgentStore.getState().mood).toBe('error')

    await act(async () => {
      result.current.retry()
      await vi.runAllTicks()
    })

    expect(mockChat).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('new request increments gen so first TTS resolve is ignored', async () => {
    let resolveFirst!: () => void
    mockSpeak
      .mockReturnValueOnce(new Promise<void>(r => { resolveFirst = r }))
      .mockReturnValue(new Promise<void>(() => {}))

    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('first')
      await vi.runAllTicks()
    })

    useAgentStore.setState({ isLoading: false })

    await act(async () => {
      result.current.sendMessage('second')
      await vi.runAllTicks()
    })

    expect(useAgentStore.getState().mood).toBe('talking')

    await act(async () => { resolveFirst() })

    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('mood returns to idle after ttsProvider.speak() resolves', async () => {
    let resolveTts!: () => void
    mockSpeak.mockReturnValue(new Promise<void>(r => { resolveTts = r }))

    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('test')
      await vi.runAllTicks()
    })

    expect(useAgentStore.getState().mood).toBe('talking')

    await act(async () => { resolveTts() })

    expect(useAgentStore.getState().mood).toBe('idle')
    expect(useAgentStore.getState().isPushing).toBe(false)
  })

  it('new request calls ttsProvider.stop() before chat', async () => {
    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('first')
      await vi.runAllTicks()
    })

    useAgentStore.setState({ isLoading: false })

    await act(async () => {
      result.current.sendMessage('second')
      await vi.runAllTicks()
    })

    expect(mockStop).toHaveBeenCalledTimes(2)
  })

  it('old gen TTS resolve does not change mood after new request starts', async () => {
    let resolveFirst!: () => void
    mockSpeak
      .mockReturnValueOnce(new Promise<void>(r => { resolveFirst = r }))
      .mockReturnValue(new Promise<void>(() => {}))

    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('first')
      await vi.runAllTicks()
    })

    useAgentStore.setState({ isLoading: false })

    await act(async () => {
      result.current.sendMessage('second')
      await vi.runAllTicks()
    })

    expect(useAgentStore.getState().mood).toBe('talking')

    await act(async () => { resolveFirst() })

    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('catch path calls ttsProvider.stop()', async () => {
    mockChat.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('test')
      await vi.runAllTicks()
    })

    expect(mockStop).toHaveBeenCalled()
    expect(useAgentStore.getState().mood).toBe('error')
  })
})
