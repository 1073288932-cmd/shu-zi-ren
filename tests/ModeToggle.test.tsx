import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

const mockCloseNow = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../src/services/xingyun', () => ({
  sessionManager: { closeNow: mockCloseNow },
  XINGYUN_CONTAINER_ID: 'xingyun-stage',
}))

import { ModeToggle } from '../src/components/ModeToggle'

function setConfig(configured: boolean) {
  ;(window as unknown as { electronAPI: { xingyunGetConfig: () => Promise<unknown> } }).electronAPI = {
    xingyunGetConfig: vi.fn().mockResolvedValue(
      configured
        ? { configured: true, appId: 'a', appSecret: 's', gatewayServer: 'wss://gw' }
        : { configured: false, missingKey: true, errorReason: '未配置魔珐 — 请在 .env 填 XINGYUN_APP_ID / XINGYUN_APP_SECRET' },
    ),
  }
}

describe('ModeToggle', () => {
  beforeEach(() => { useAgentStore.setState(initialState); mockCloseNow.mockClear() })
  afterEach(() => { vi.clearAllMocks() })

  it('disables button + forces local when not configured', async () => {
    setConfig(false)
    let utils!: ReturnType<typeof render>
    await act(async () => { utils = render(<ModeToggle />); await Promise.resolve() })
    const btn = utils.container.querySelector('button')!
    expect(btn.disabled).toBe(true)
    expect(useAgentStore.getState().renderMode).toBe('local')
  })

  it('toggles cloud→local (calls closeNow) and local→cloud on click when configured', async () => {
    setConfig(true)
    let utils!: ReturnType<typeof render>
    await act(async () => { utils = render(<ModeToggle />); await Promise.resolve() })
    const btn = utils.container.querySelector('button')!
    expect(btn.disabled).toBe(false)
    expect(useAgentStore.getState().renderMode).toBe('cloud')

    await act(async () => { btn.click(); await Promise.resolve() })   // cloud → local
    expect(mockCloseNow).toHaveBeenCalled()
    expect(useAgentStore.getState().renderMode).toBe('local')

    await act(async () => { btn.click(); await Promise.resolve() })   // local → cloud
    expect(useAgentStore.getState().renderMode).toBe('cloud')
  })

  it('shows a toast when cloudLastError is set', async () => {
    setConfig(true)
    let utils!: ReturnType<typeof render>
    await act(async () => { utils = render(<ModeToggle />); await Promise.resolve() })
    act(() => { useAgentStore.getState().setCloudError('连接失败：超时') })
    expect(utils.getByText(/连接失败：超时/)).not.toBeNull()
  })
})
