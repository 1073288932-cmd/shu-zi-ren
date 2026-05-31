import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

const mockCloseNow = vi.hoisted(() => vi.fn())
vi.mock('../src/services/xingyun', () => ({
  sessionManager: { closeNow: mockCloseNow },
  XINGYUN_CONTAINER_ID: 'xingyun-stage',
}))

import { CloudAvatar } from '../src/components/Avatar/CloudAvatar'

describe('CloudAvatar', () => {
  beforeEach(() => { useAgentStore.setState(initialState); mockCloseNow.mockClear() })

  it('always renders the SDK container div', () => {
    const { container } = render(<CloudAvatar />)
    expect(container.querySelector('#xingyun-stage')).not.toBeNull()
  })

  it('shows connecting overlay when cloudConn=connecting', () => {
    useAgentStore.setState({ cloudConn: 'connecting' })
    const { getByText } = render(<CloudAvatar />)
    expect(getByText('连接中…')).not.toBeNull()
  })

  it('shows error overlay when cloudConn=error', () => {
    useAgentStore.setState({ cloudConn: 'error' })
    const { getByText } = render(<CloudAvatar />)
    expect(getByText('连接失败')).not.toBeNull()
  })

  it('calls sessionManager.closeNow on unmount', () => {
    const { unmount } = render(<CloudAvatar />)
    unmount()
    expect(mockCloseNow).toHaveBeenCalled()
  })
})
