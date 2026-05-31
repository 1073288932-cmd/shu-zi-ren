import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

// mock 两个子组件，避免拉入 PNG 资源 / 魔珐 SDK
vi.mock('../src/components/Avatar/LocalAvatar', () => ({
  LocalAvatar: () => <div data-testid="local-avatar" />,
}))
vi.mock('../src/components/Avatar/CloudAvatar', () => ({
  CloudAvatar: () => <div data-testid="cloud-avatar" />,
}))

import { Avatar } from '../src/components/Avatar'

describe('RouterAvatar', () => {
  beforeEach(() => { useAgentStore.setState(initialState) })

  it('renders CloudAvatar when renderMode is cloud (default)', () => {
    const { queryByTestId } = render(<Avatar />)
    expect(queryByTestId('cloud-avatar')).not.toBeNull()
    expect(queryByTestId('local-avatar')).toBeNull()
  })

  it('renders LocalAvatar when renderMode is local', () => {
    useAgentStore.setState({ renderMode: 'local' })
    const { queryByTestId } = render(<Avatar />)
    expect(queryByTestId('local-avatar')).not.toBeNull()
    expect(queryByTestId('cloud-avatar')).toBeNull()
  })
})
