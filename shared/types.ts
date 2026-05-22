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

// ── Avatar video lifecycle (Tencent digital human integration) ────

export type AvatarVideoErrorCode =
  | 'INVALID_INPUT'      // 主进程 IPC 校验失败；不调腾讯，不计入熔断
  | 'TENCENT_API_FAIL'   // 通用 API 错误 / 下载校验失败 → fallback 剩余段
  | 'TENCENT_TIMEOUT'    // 轮询/下载超时 / 首段 12s → fallback 剩余段
  | 'NETWORK'            // fetch/网络失败 → fallback 剩余段
  | 'COS_NOT_READY'      // 启动时 COS 上传失败 → fallback 剩余段
  | 'POLICY_VIOLATION'   // 内容审核拒绝 → blocked，不 fallback

export type VideoQueueState =
  | 'idle' | 'generating' | 'playing' | 'stalled' | 'fallback' | 'blocked'

export type AvatarSegmentProgressEvent = {
  jobId: string
  stage: 'submitting' | 'polling' | 'downloading'
  pollAttempt?: number
}

export type AvatarSegmentDoneEvent = {
  jobId: string
  buffer: ArrayBuffer
  mimeType: string
}

export type AvatarSegmentErrorEvent = {
  jobId: string
  error: AppError
}
