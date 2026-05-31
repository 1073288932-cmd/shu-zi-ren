export type AvatarMood = 'idle' | 'thinking' | 'talking' | 'error'

export type Viseme = 'closed' | 'a' | 'o' | 'e' | 'i' | 'u'

export interface AvatarState {
  mood: AvatarMood
  isPushing: boolean
}

export type ResourceCard =
  | {
      id: string
      kind: 'external'
      title: string
      type: 'video' | 'doc' | 'exercise' | 'experiment' | 'link'
      description: string
      url: string
      tags: string[]
    }
  | {
      id: string
      kind: 'local'
      title: string
      type: 'video' | 'doc' | 'exercise' | 'experiment' | 'link'
      description: string
      tags: string[]
    }

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AIResponse {
  reply: string
  resourceCards: ResourceCard[]
}

export interface AppError {
  code: string
  message: string
  recoverable: boolean
}

// ============= 魔珐星云 具身驱动 =============

export type RenderMode = 'cloud' | 'local'

// 失败时状态机直接翻回 local（conn=idle）+ toast，从不停在独立的 'error' 态
export type CloudConnectionState = 'idle' | 'connecting' | 'streaming'

export type XingyunErrorCode =
  | 'XY_NOT_CONFIGURED'   // .env 缺 APP_ID/APP_SECRET
  | 'XY_SCRIPT'           // SDK 脚本未加载
  | 'XY_CONNECT'          // 建联超时 / 就绪前致命错
  | 'XY_SPEAK'            // speak 期致命错
  | 'XY_SDK'              // 其他 SDK 错误

export type XingyunError = AppError & { code: XingyunErrorCode }

export interface XingyunConfig {
  appId: string
  appSecret: string
  gatewayServer: string
}

export type XingyunConfigStatus =
  | ({ configured: true } & XingyunConfig)
  | { configured: false; missingKey: true; errorReason: string }
