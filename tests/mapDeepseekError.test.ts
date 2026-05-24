// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { mapDeepseekError, DeepseekHTTPError } from '../electron/services/mapDeepseekError'

describe('mapDeepseekError', () => {
  it('maps HTTP 401 to AI_AUTH_ERROR (non-recoverable)', () => {
    const err = mapDeepseekError(new DeepseekHTTPError(401))
    expect(err.code).toBe('AI_AUTH_ERROR')
    expect(err.recoverable).toBe(false)
  })

  it('maps HTTP 429 to AI_RATE_LIMITED (recoverable)', () => {
    const err = mapDeepseekError(new DeepseekHTTPError(429))
    expect(err.code).toBe('AI_RATE_LIMITED')
    expect(err.recoverable).toBe(true)
  })

  it('maps HTTP 500 to AI_ERROR (recoverable)', () => {
    const err = mapDeepseekError(new DeepseekHTTPError(500))
    expect(err.code).toBe('AI_ERROR')
    expect(err.recoverable).toBe(true)
  })

  it('maps generic Error to AI_ERROR', () => {
    const err = mapDeepseekError(new Error('network failure'))
    expect(err.code).toBe('AI_ERROR')
    expect(err.recoverable).toBe(true)
    expect(err.message).toContain('network failure')
  })

  it('maps unknown thrown value to AI_ERROR', () => {
    const err = mapDeepseekError('timeout')
    expect(err.code).toBe('AI_ERROR')
    expect(err.recoverable).toBe(true)
  })
})
