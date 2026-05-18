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

describe('useAI', () => {
  beforeEach(() => {
    mockChat.mockResolvedValue(mockResponse)
    vi.useFakeTimers()
    useAgentStore.setState(initialState)
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

  it('mood returns to idle after talking duration', async () => {
    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('test')
      await vi.runAllTicks()
    })

    expect(useAgentStore.getState().mood).toBe('talking')

    act(() => { vi.runAllTimers() })

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

  it('clears old talking timer when new request starts', async () => {
    const { result } = renderHook(() => useAI())

    // First request completes
    await act(async () => {
      result.current.sendMessage('first')
      await vi.runAllTicks()
    })
    expect(useAgentStore.getState().mood).toBe('talking')

    // Advance partway into first talking timer
    act(() => { vi.advanceTimersByTime(500) })

    // Reset isLoading to allow second send
    useAgentStore.setState({ isLoading: false })

    // Second request — should clear first timer
    await act(async () => {
      result.current.sendMessage('second')
      await vi.runAllTicks()
    })
    expect(useAgentStore.getState().mood).toBe('talking')

    // Run all remaining timers — only second timer should fire
    act(() => { vi.runAllTimers() })
    expect(useAgentStore.getState().mood).toBe('idle')
  })
})
