import type { AIResponse, AgentMessage } from '@shared/types'

export interface AIProvider {
  chat(messages: AgentMessage[]): Promise<AIResponse>
}
