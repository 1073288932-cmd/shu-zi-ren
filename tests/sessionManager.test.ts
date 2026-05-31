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
    idle: vi.fn(),
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

  it('notifyIdle keeps the cloud avatar connected and asks SDK to enter idle', async () => {
    const client = fakeClient({ isOpen: vi.fn().mockReturnValue(true) })
    const sm = new SessionManager(() => client)
    await sm.ensureConnected()
    sm.notifyIdle()
    expect(client.idle).toHaveBeenCalled()
    expect(client.destroy).not.toHaveBeenCalled()
    expect(useAgentStore.getState().cloudConn).toBe('streaming')
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

  it('dedupes concurrent ensureConnected: opens exactly once while connecting', async () => {
    let resolveOpen!: () => void
    const client = fakeClient({
      isOpen: vi.fn().mockReturnValue(false),
      open: vi.fn().mockReturnValue(new Promise<void>(r => { resolveOpen = r })),
    })
    let factoryCalls = 0
    const sm = new SessionManager(() => { factoryCalls++; return client })
    const p1 = sm.ensureConnected()
    const p2 = sm.ensureConnected()   // 建联中再次请求 → 复用在途 promise
    resolveOpen()
    await Promise.all([p1, p2])
    expect(client.open).toHaveBeenCalledTimes(1)
    expect(factoryCalls).toBe(1)      // 不会并发造第二个 client
  })

  it('closeNow cancels an in-flight connect so remount starts a fresh SDK client', async () => {
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const c1 = fakeClient({
      isOpen: vi.fn().mockReturnValue(false),
      open: vi.fn().mockReturnValue(new Promise<void>(r => { resolveFirst = r })),
    })
    const c2 = fakeClient({
      isOpen: vi.fn().mockReturnValue(false),
      open: vi.fn().mockReturnValue(new Promise<void>(r => { resolveSecond = r })),
    })
    const queue = [c1, c2]
    const sm = new SessionManager(() => queue.shift()!)

    const first = sm.ensureConnected()
    const firstExpectation = expect(first).rejects.toMatchObject({ code: 'XY_CONNECT' })
    await vi.waitFor(() => expect(c1.open).toHaveBeenCalled())
    await sm.closeNow()
    expect(c1.destroy).toHaveBeenCalled()

    const second = sm.ensureConnected()
    resolveFirst()
    await firstExpectation
    resolveSecond()
    await expect(second).resolves.toBe(c2)

    expect(c2.open).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().cloudConn).toBe('streaming')
  })

  it('destroys a stale (closed) client before reconnecting', async () => {
    const c1 = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const c2 = fakeClient({ isOpen: vi.fn().mockReturnValue(false) })
    const queue = [c1, c2]
    const sm = new SessionManager(() => queue.shift()!)
    await sm.ensureConnected()   // 开 c1（isOpen=false）
    await sm.ensureConnected()   // c1 已失效 → 重连前必须 destroy c1，再开 c2
    expect(c1.destroy).toHaveBeenCalled()
    expect(c2.open).toHaveBeenCalledTimes(1)
  })
})
