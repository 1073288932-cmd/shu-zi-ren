import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SessionManager } from '../src/services/xingyun/sessionManager'
import { useAgentStore, initialState } from '../src/store/agentStore'
import type { XingyunClient } from '../src/services/xingyun/XingyunClient'

function fakeClient(over: Partial<XingyunClient> = {}): XingyunClient {
  return {
    isOpen: vi.fn().mockReturnValue(false),
    open: vi.fn().mockResolvedValue(undefined),
    speak: vi.fn().mockResolvedValue('completed'),
    interrupt: vi.fn(),
    destroy: vi.fn(),
    ...over,
  } as unknown as XingyunClient
}

const okConfig = { configured: true, appId: 'a', appSecret: 's', gatewayServer: 'wss://gw' }

beforeEach(() => {
  useAgentStore.setState(initialState)
  ;(window as unknown as { electronAPI: { xingyunGetConfig: () => Promise<unknown> } }).electronAPI = {
    xingyunGetConfig: vi.fn().mockResolvedValue(okConfig),
  }
})
afterEach(() => { vi.clearAllMocks() })

describe('SessionManager', () => {
  it('ensureConnected opens a client and sets cloudConn connecting→streaming', async () => {
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()
    expect(client.open).toHaveBeenCalledWith(okConfig, 'xingyun-stage')
    expect(useAgentStore.getState().cloudConn).toBe('streaming')
  })

  it('ensureConnected opens once, then reuses the open client (no second open)', async () => {
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(true) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()   // client 为 null → 必然 open 一次
    await sm.ensureConnected()   // isOpen()=true → 复用，不再 open
    expect(client.open).toHaveBeenCalledTimes(1)
  })

  it('throws XY_NOT_CONFIGURED when config missing', async () => {
    ;(window as unknown as { electronAPI: { xingyunGetConfig: () => Promise<unknown> } }).electronAPI = {
      xingyunGetConfig: vi.fn().mockResolvedValue({ configured: false, missingKey: true, errorReason: 'no key' }),
    }
    const sm = new SessionManager(() => fakeClient())
    await expect(sm.ensureConnected()).rejects.toMatchObject({ code: 'XY_NOT_CONFIGURED' })
  })

  it('notifyIdle destroys the client after IDLE_TIMEOUT and sets cloudConn idle', async () => {
    vi.useFakeTimers()
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()
    sm.notifyIdle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.destroy).toHaveBeenCalled()
    expect(useAgentStore.getState().cloudConn).toBe('idle')
    vi.useRealTimers()
  })

  it('closeNow destroys the client and sets cloudConn idle', async () => {
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()
    await sm.closeNow()
    expect(client.destroy).toHaveBeenCalled()
    expect(useAgentStore.getState().cloudConn).toBe('idle')
  })

  it('interrupt delegates to the active client', async () => {
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()
    sm.interrupt()
    expect(client.interrupt).toHaveBeenCalled()
  })
})
