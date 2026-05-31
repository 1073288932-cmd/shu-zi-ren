import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore, initialState } from '../src/store/agentStore'
import type { AppError, ResourceCard } from '@shared/types'

const mockError: AppError = { code: 'AI_ERROR', message: 'fail', recoverable: true }

const mockCards: ResourceCard[] = [
  {
    id: 'c1',
    kind: 'external',
    title: 'Test',
    type: 'link',
    description: 'desc',
    url: 'https://example.com',
    tags: [],
  },
]

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.setState(initialState)
  })

  it('starts with idle mood and empty state', () => {
    const s = useAgentStore.getState()
    expect(s.mood).toBe('idle')
    expect(s.isPushing).toBe(false)
    expect(s.isLoading).toBe(false)
    expect(s.messages).toHaveLength(0)
    expect(s.resourceCards).toHaveLength(0)
    expect(s.error).toBeNull()
  })

  it('setMood changes mood', () => {
    useAgentStore.getState().setMood('thinking')
    expect(useAgentStore.getState().mood).toBe('thinking')
  })

  it('setIsLoading toggles loading flag', () => {
    useAgentStore.getState().setIsLoading(true)
    expect(useAgentStore.getState().isLoading).toBe(true)
  })

  it('setError writes error', () => {
    useAgentStore.getState().setError(mockError)
    expect(useAgentStore.getState().error).toEqual(mockError)
  })

  it('addMessage appends to messages array', () => {
    useAgentStore.getState().addMessage({ role: 'user', content: 'hello' })
    useAgentStore.getState().addMessage({ role: 'assistant', content: 'hi' })
    expect(useAgentStore.getState().messages).toHaveLength(2)
    expect(useAgentStore.getState().messages[0].content).toBe('hello')
  })

  it('setResourceCards replaces cards', () => {
    useAgentStore.getState().setResourceCards(mockCards)
    expect(useAgentStore.getState().resourceCards).toHaveLength(1)
  })

  it('setIsPushing reflects push state', () => {
    useAgentStore.getState().setIsPushing(true)
    expect(useAgentStore.getState().isPushing).toBe(true)
  })

  it('removeResourceCard removes by id', () => {
    useAgentStore.getState().setResourceCards(mockCards)
    useAgentStore.getState().removeResourceCard('c1')
    expect(useAgentStore.getState().resourceCards).toHaveLength(0)
  })

  it('reset returns to initialState', () => {
    useAgentStore.getState().setMood('error')
    useAgentStore.getState().addMessage({ role: 'user', content: 'x' })
    useAgentStore.getState().reset()
    const s = useAgentStore.getState()
    expect(s.mood).toBe('idle')
    expect(s.messages).toHaveLength(0)
  })

  it('currentViseme starts as closed', () => {
    expect(useAgentStore.getState().currentViseme).toBe('closed')
  })

  it('setCurrentViseme updates the viseme', () => {
    useAgentStore.getState().setCurrentViseme('a')
    expect(useAgentStore.getState().currentViseme).toBe('a')
  })

  it('reset restores currentViseme to closed', () => {
    useAgentStore.getState().setCurrentViseme('o')
    useAgentStore.getState().reset()
    expect(useAgentStore.getState().currentViseme).toBe('closed')
  })

  it('initial renderMode is cloud, cloudConn idle, cloudLastError null', () => {
    const s = useAgentStore.getState()
    expect(s.renderMode).toBe('cloud')
    expect(s.cloudConn).toBe('idle')
    expect(s.cloudLastError).toBeNull()
  })

  it('setRenderMode("local") resets currentViseme to "closed"', () => {
    useAgentStore.setState({ renderMode: 'cloud', currentViseme: 'a' })
    useAgentStore.getState().setRenderMode('local')
    expect(useAgentStore.getState().renderMode).toBe('local')
    expect(useAgentStore.getState().currentViseme).toBe('closed')
  })

  it('setRenderMode("cloud") does NOT touch currentViseme', () => {
    useAgentStore.setState({ renderMode: 'local', currentViseme: 'a' })
    useAgentStore.getState().setRenderMode('cloud')
    expect(useAgentStore.getState().currentViseme).toBe('a')
  })

  it('setCloudConn updates cloudConn', () => {
    useAgentStore.getState().setCloudConn('connecting')
    expect(useAgentStore.getState().cloudConn).toBe('connecting')
  })

  it('setCloudError sets and clears cloudLastError', () => {
    useAgentStore.getState().setCloudError('boom')
    expect(useAgentStore.getState().cloudLastError).toBe('boom')
    useAgentStore.getState().setCloudError(null)
    expect(useAgentStore.getState().cloudLastError).toBeNull()
  })

  it('reset restores renderMode=cloud, cloudConn=idle, cloudLastError=null', () => {
    useAgentStore.setState({ renderMode: 'local', cloudConn: 'streaming', cloudLastError: 'x' })
    useAgentStore.getState().reset()
    const s = useAgentStore.getState()
    expect(s.renderMode).toBe('cloud')
    expect(s.cloudConn).toBe('idle')
    expect(s.cloudLastError).toBeNull()
  })
})
