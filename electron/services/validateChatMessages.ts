import type { AgentMessage, AppError } from '../../shared/types'

const MAX_MESSAGES = 20
const MAX_CONTENT_LENGTH = 2000
const VALID_ROLES = new Set(['user', 'assistant'])

const INVALID: AppError = {
  code: 'INVALID_CHAT_MESSAGES',
  message: 'Invalid chat messages',
  recoverable: false,
}

export function validateChatMessages(raw: unknown): AgentMessage[] | AppError {
  if (!Array.isArray(raw)) return INVALID
  if (raw.length > MAX_MESSAGES) return INVALID
  for (const msg of raw) {
    if (typeof msg !== 'object' || msg === null) return INVALID
    const { role, content } = msg as Record<string, unknown>
    if (!VALID_ROLES.has(role as string)) return INVALID
    if (typeof content !== 'string') return INVALID
    if (content.length > MAX_CONTENT_LENGTH) return INVALID
  }
  return raw as AgentMessage[]
}
