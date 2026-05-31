import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

const mockEnsureConnected = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const mockCloseNow = vi.hoisted(() => vi.fn())
vi.mock('../src/services/xingyun', () => ({
  sessionManager: { ensureConnected: mockEnsureConnected, closeNow: mockCloseNow },
  XINGYUN_CONTAINER_ID: 'xingyun-stage',
}))

import { CloudAvatar } from '../src/components/Avatar/CloudAvatar'

describe('CloudAvatar', () => {
  beforeEach(() => {
    useAgentStore.setState(initialState)
    mockEnsureConnected.mockClear()
    mockCloseNow.mockClear()
  })

  it('always renders the SDK container div', () => {
    const { container } = render(<CloudAvatar />)
    expect(container.querySelector('#xingyun-stage')).not.toBeNull()
  })

  it('connects the cloud session on mount so the 3D avatar appears on first screen', () => {
    render(<CloudAvatar />)
    expect(mockEnsureConnected).toHaveBeenCalledTimes(1)
  })

  it('falls back to local mode when mount connection fails', async () => {
    mockEnsureConnected.mockRejectedValueOnce(new Error('boom'))
    render(<CloudAvatar />)
    await waitFor(() => {
      expect(useAgentStore.getState().renderMode).toBe('local')
    })
    expect(useAgentStore.getState().cloudLastError).toBe('魔珐连接失败，已切回本地模式')
  })

  it('shows connecting overlay when cloudConn=connecting', () => {
    useAgentStore.setState({ cloudConn: 'connecting' })
    const { getByText } = render(<CloudAvatar />)
    expect(getByText('连接中…')).not.toBeNull()
  })

  it('calls sessionManager.closeNow on unmount', () => {
    const { unmount } = render(<CloudAvatar />)
    unmount()
    expect(mockCloseNow).toHaveBeenCalled()
  })
})
