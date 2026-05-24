import type { AppError } from '../../shared/types'

export class DeepseekHTTPError extends Error {
  constructor(public readonly status: number) {
    super(`Deepseek HTTP error: ${status}`)
    this.name = 'DeepseekHTTPError'
  }
}

export function mapDeepseekError(err: unknown): AppError {
  if (err instanceof DeepseekHTTPError) {
    if (err.status === 401) return { code: 'AI_AUTH_ERROR', message: 'Authentication failed. Check DEEPSEEK_API_KEY.', recoverable: false }
    if (err.status === 429) return { code: 'AI_RATE_LIMITED', message: 'Rate limited. Please retry later.', recoverable: true }
    return { code: 'AI_ERROR', message: `HTTP error ${err.status}`, recoverable: true }
  }
  return {
    code: 'AI_ERROR',
    message: err instanceof Error ? err.message : String(err),
    recoverable: true,
  }
}
