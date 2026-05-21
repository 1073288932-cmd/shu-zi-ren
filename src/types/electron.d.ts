import type {
  AppError,
  AIResponse,
  AgentMessage,
  AvatarSegmentProgressEvent,
  AvatarSegmentDoneEvent,
  AvatarSegmentErrorEvent,
} from '@shared/types'

declare global {
  interface Window {
    electronAPI: {
      resizeWindow(height: number): void
      openExternal(url: string): Promise<AppError | undefined>
      openResource(resourceId: string): Promise<AppError | undefined>
      onError(cb: (err: AppError) => void): () => void
      chat(messages: AgentMessage[]): Promise<AIResponse | AppError>
      setApiKey(key: string): Promise<AppError | undefined>
      transcribeAudio(buffer: ArrayBuffer): Promise<AppError | string>
      generateAvatarSegment(ssml: string): Promise<{ ok: true; jobId: string } | { ok: false; error: AppError }>
      cancelAvatarSegment(jobId: string): void
      onAvatarSegmentProgress(cb: (e: AvatarSegmentProgressEvent) => void): () => void
      onAvatarSegmentDone(cb: (e: AvatarSegmentDoneEvent) => void): () => void
      onAvatarSegmentError(cb: (e: AvatarSegmentErrorEvent) => void): () => void
    }
  }
}

export {}
