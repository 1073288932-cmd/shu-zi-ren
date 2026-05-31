import type {
  AppError,
  AIResponse,
  AgentMessage,
  XingyunConfigStatus,
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
      xingyunGetConfig(): Promise<XingyunConfigStatus>
    }
  }
}

export {}
