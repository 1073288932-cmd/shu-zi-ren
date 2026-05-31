import { XingyunClient } from './XingyunClient'
import { XINGYUN_CONTAINER_ID, xyError } from './types'
import { useAgentStore } from '../../store/agentStore'

const IDLE_TIMEOUT_MS = 60_000  // 按会话时长计费，空闲 60s 自动断（省钱）；可调

type ClientFactory = () => XingyunClient

export class SessionManager {
  private client: XingyunClient | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private connectPromise: Promise<XingyunClient> | null = null

  constructor(private readonly clientFactory: ClientFactory = () => new XingyunClient()) {}

  async ensureConnected(): Promise<XingyunClient> {
    this.clearIdleTimer()
    if (this.client && this.client.isOpen()) return this.client
    // 建联中再次请求复用同一个在途 promise，避免并发造出第二个 SDK 实例
    // （双重渲染同一容器 + 双份会话计费）
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.connect()
    try {
      return await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private async connect(): Promise<XingyunClient> {
    // 旧 client 已失效（空闲断连等）但未销毁：重连前显式 destroy，避免泄漏
    if (this.client) {
      this.client.destroy()
      this.client = null
    }
    const cfg = await window.electronAPI.xingyunGetConfig()
    if (!cfg.configured) throw xyError('XY_NOT_CONFIGURED', cfg.errorReason)
    useAgentStore.getState().setCloudConn('connecting')
    const client = this.clientFactory()
    await client.open(cfg, XINGYUN_CONTAINER_ID)
    this.client = client
    useAgentStore.getState().setCloudConn('streaming')
    return client
  }

  async speak(text: string): Promise<'completed' | 'interrupted'> {
    if (!this.client) throw xyError('XY_SDK', 'no active client; call ensureConnected first')
    return this.client.speak(text)
  }

  interrupt(): void {
    this.client?.interrupt()
  }

  notifyIdle(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => { void this.closeNow() }, IDLE_TIMEOUT_MS)
  }

  async closeNow(): Promise<void> {
    this.clearIdleTimer()
    if (this.client) {
      // destroy() 内部先把 pending speak resolve 成 'interrupted'，再断 SDK
      this.client.destroy()
      this.client = null
    }
    useAgentStore.getState().setCloudConn('idle')
  }

  getClient(): XingyunClient | null { return this.client }

  private clearIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }
}

export const sessionManager = new SessionManager()
