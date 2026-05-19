import type { AIProvider } from './AIProvider'
import type { AIResponse, AgentMessage, AppError } from '@shared/types'

export function isAppError(err: unknown): err is AppError {
  return typeof err === 'object' && err !== null && 'code' in err
}

export class ElectronAIProvider implements AIProvider {
  async chat(messages: AgentMessage[]): Promise<AIResponse> {
    const result = await window.electronAPI.chat(messages)
    if (isAppError(result)) throw result
    return result as AIResponse
  }
}
