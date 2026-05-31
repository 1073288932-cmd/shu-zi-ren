import { XingyunClient } from './XingyunClient'
import { XINGYUN_CONTAINER_ID, xyError } from './types'
import { useAgentStore } from '../../store/agentStore'

type ClientFactory = () => XingyunClient

export class SessionManager {
  private client: XingyunClient | null = null
  private connectPromise: Promise<XingyunClient> | null = null
  private connectGeneration = 0

  constructor(private readonly clientFactory: ClientFactory = () => new XingyunClient()) {}

  async ensureConnected(): Promise<XingyunClient> {
    if (this.client && this.client.isOpen()) return this.client
    // 建联中再次请求复用同一个在途 promise，避免并发造出第二个 SDK 实例
    // （双重渲染同一容器 + 双份会话计费）
    if (this.connectPromise) return this.connectPromise
    const promise = this.connect()
    this.connectPromise = promise
    try {
      return await promise
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null
    }
  }

  private async connect(): Promise<XingyunClient> {
    const generation = ++this.connectGeneration
    // 旧 client 已失效（空闲断连等）但未销毁：重连前显式 destroy，避免泄漏
    if (this.client) {
      this.client.destroy()
      this.client = null
    }
    const cfg = await window.electronAPI.xingyunGetConfig()
    if (generation !== this.connectGeneration) throw xyError('XY_CONNECT', 'connection cancelled')
    if (!cfg.configured) throw xyError('XY_NOT_CONFIGURED', cfg.errorReason)
    useAgentStore.getState().setCloudConn('connecting')
    const client = this.clientFactory()
    this.client = client
    await client.open(cfg, XINGYUN_CONTAINER_ID)
    if (generation !== this.connectGeneration) {
      client.destroy()
      throw xyError('XY_CONNECT', 'connection cancelled')
    }
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
    this.client?.idle()
    useAgentStore.getState().setCloudConn(this.client?.isOpen() ? 'streaming' : 'idle')
  }

  async closeNow(): Promise<void> {
    this.connectGeneration++
    this.connectPromise = null
    if (this.client) {
      // destroy() 内部先把 pending speak resolve 成 'interrupted'，再断 SDK
      this.client.destroy()
      this.client = null
    }
    useAgentStore.getState().setCloudConn('idle')
  }

  getClient(): XingyunClient | null { return this.client }
}

export const sessionManager = new SessionManager()
