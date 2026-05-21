import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAI } from '../src/hooks/useAI'
import { useAgentStore, initialState } from '../src/store/agentStore'
import type { AIResponse } from '@shared/types'

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockQueueCancel = vi.hoisted(() => vi.fn())
const mockHandleVideoEnded = vi.hoisted(() => vi.fn())

vi.mock('../src/hooks/useAvatarVideoQueue', () => ({
  useAvatarVideoQueue: () => ({
    enqueue: mockEnqueue,
    cancel: mockQueueCancel,
    handleVideoEnded: mockHandleVideoEnded,
  }),
}))

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
    mockEnqueue.mockResolvedValue(undefined)
    mockQueueCancel.mockReset()
    mockHandleVideoEnded.mockReset()
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

  it('enqueues reply into avatar video queue on AI success', async () => {
    mockChat.mockResolvedValueOnce({ reply: '牛顿第一定律：物体保持静止或匀速直线运动。', resourceCards: [] })
    const { result } = renderHook(() => useAI())
    await act(async () => { await result.current.sendMessage('牛顿第一定律') })
    expect(mockEnqueue).toHaveBeenCalledWith('牛顿第一定律：物体保持静止或匀速直线运动。')
  })

  it('cancels queue at the start of a new sendMessage', async () => {
    mockChat.mockResolvedValueOnce({ reply: 'ok', resourceCards: [] })
    const { result } = renderHook(() => useAI())
    await act(async () => { await result.current.sendMessage('hi') })
    expect(mockQueueCancel).toHaveBeenCalled()
  })

  it('cancels queue on AI failure', async () => {
    mockChat.mockRejectedValueOnce(new Error('network error'))
    const { result } = renderHook(() => useAI())
    await act(async () => { await result.current.sendMessage('hi') })
    expect(mockQueueCancel).toHaveBeenCalled()
  })
})
