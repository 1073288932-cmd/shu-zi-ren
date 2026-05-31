import type { XingyunConfig } from '@shared/types'
import type { XmovAvatarOptions, XmovAvatarInstance } from '../../types/xingyun-sdk'
import { xyError } from './types'
import { buildSSML } from './ssml'

type SdkFactory = (options: XmovAvatarOptions) => XmovAvatarInstance

// 首连含 3D 资源下载；真机首日联调可超过 60s，复用连接后无此问题
const CONNECT_TIMEOUT_MS = 180_000
// 就绪态：onStateChange 进入运行态即视为连上（实现首日按真实取值确认/收窄）
const READY_STATES = new Set(['idle', 'interactiveidle', 'interactive_idle', 'listen', 'think'])

// 魔珐错误码段 10001–50004；onMessage 也会带 widget/info 等非错误消息，需甄别
function looksLikeError(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Record<string, unknown>
  const code = m.code ?? m.errorCode ?? m.error_code
  const numericCode = typeof code === 'number' ? code : Number(code)
  if (numericCode === 40007) return false
  if (Number.isFinite(numericCode) && numericCode >= 10000) return true
  return m.type === 'error'
}
function describeMsg(msg: unknown): string {
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>
    return String(m.msg ?? m.message ?? JSON.stringify(m))
  }
  return String(msg)
}

function defaultSdkFactory(options: XmovAvatarOptions): XmovAvatarInstance {
  if (typeof window.XmovAvatar !== 'function') {
    throw xyError('XY_SCRIPT', 'window.XmovAvatar 未加载（vendor 脚本未引入或加载失败）')
  }
  return new window.XmovAvatar(options)
}

export class XingyunClient {
  private sdk: XmovAvatarInstance | null = null
  private opened = false
  private pendingSpeak: {
    resolve: (r: 'completed' | 'interrupted') => void
    reject: (e: unknown) => void
  } | null = null

  constructor(private readonly sdkFactory: SdkFactory = defaultSdkFactory) {}

  isOpen(): boolean { return this.opened }

  open(config: XingyunConfig, containerId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let downloadComplete = false
      let stateReady = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.destroy()
        reject(xyError('XY_CONNECT', `建联超时（>${CONNECT_TIMEOUT_MS}ms）`))
      }, CONNECT_TIMEOUT_MS)

      const finishOpen = (err?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) { reject(err); return }
        this.opened = true
        resolve()
      }

      const maybeFinishOpen = () => {
        if (downloadComplete && stateReady) finishOpen()
      }

      try {
        this.sdk = this.sdkFactory({
          containerId: `#${containerId}`,
          appId: config.appId,
          appSecret: config.appSecret,
          gatewayServer: config.gatewayServer,
          enableLogger: false,
          onStateChange: (state: string) => {
            if (READY_STATES.has(state)) {
              stateReady = true
              maybeFinishOpen()
            }
          },
          onVoiceStateChange: (status: string) => {
            if (status === 'end' && this.pendingSpeak) {
              const p = this.pendingSpeak
              this.pendingSpeak = null
              p.resolve('completed')
            }
          },
          onMessage: (msg: unknown) => {
            if (!looksLikeError(msg)) return
            const reason = describeMsg(msg)
            if (!settled) { finishOpen(xyError('XY_CONNECT', reason)); return }
            // 就绪后致命错：优先 reject 正在等待的 speak（→ useAI fallback）
            if (this.pendingSpeak) {
              const p = this.pendingSpeak
              this.pendingSpeak = null
              p.reject(xyError('XY_SPEAK', reason))
            }
            // 无 pending speak（空闲期断连）：标记失效，下次 ensureConnected 重建
            this.opened = false
          },
        })
        const initResult = this.sdk.init({
          onDownloadProgress: (progress: number) => {
            if (progress >= 100) {
              downloadComplete = true
              maybeFinishOpen()
            }
          },
        })
        void Promise.resolve(initResult).catch(finishOpen)
      } catch (e) {
        finishOpen(e)
      }
    })
  }

  speak(text: string): Promise<'completed' | 'interrupted'> {
    const sdk = this.sdk
    if (!sdk) return Promise.reject(xyError('XY_SDK', 'no active sdk'))
    this.settleInterrupted()  // 防御：上一条未收尾先结算
    return new Promise<'completed' | 'interrupted'>((resolve, reject) => {
      this.pendingSpeak = { resolve, reject }
      try {
        sdk.speak(buildSSML(text), true, true)
      } catch (e) {
        this.pendingSpeak = null
        reject(xyError('XY_SPEAK', e instanceof Error ? e.message : String(e)))
      }
    })
  }

  interrupt(): void {
    this.settleInterrupted()        // 先把 pending speak resolve 成 'interrupted'
    try { this.sdk?.interactiveidle() } catch { /* ignore */ }
  }

  idle(): void {
    try { this.sdk?.idle() } catch { /* ignore */ }
  }

  destroy(): void {
    this.settleInterrupted()        // 主动断开绝不 reject pending（避免误判失败）
    try { this.sdk?.destroy() } catch { /* ignore */ }
    this.sdk = null
    this.opened = false
  }

  // 把挂起的 speak 干净 resolve 成 'interrupted'（用于 interrupt/destroy）
  private settleInterrupted(): void {
    if (this.pendingSpeak) {
      const p = this.pendingSpeak
      this.pendingSpeak = null
      p.resolve('interrupted')
    }
  }
}
