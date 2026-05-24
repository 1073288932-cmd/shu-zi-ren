// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { validateChatMessages } from '../electron/services/validateChatMessages'

describe('validateChatMessages', () => {
  it('accepts valid messages', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    const result = validateChatMessages(msgs)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
  })

  it('rejects non-array input', () => {
    const result = validateChatMessages('not an array')
    expect('code' in (result as object)).toBe(true)
    expect((result as { code: string }).code).toBe('INVALID_CHAT_MESSAGES')
  })

  it('rejects null input', () => {
    const result = validateChatMessages(null)
    expect('code' in (result as object)).toBe(true)
  })

  it('rejects more than 20 messages', () => {
    const msgs = Array.from({ length: 21 }, (_, i) => ({ role: 'user', content: `msg ${i}` }))
    const result = validateChatMessages(msgs)
    expect('code' in (result as object)).toBe(true)
  })

  it('accepts exactly 20 messages', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `msg ${i}` }))
    const result = validateChatMessages(msgs)
    expect(Array.isArray(result)).toBe(true)
  })

  it('rejects invalid role', () => {
    const result = validateChatMessages([{ role: 'system', content: 'hello' }])
    expect('code' in (result as object)).toBe(true)
  })

  it('rejects non-string content', () => {
    const result = validateChatMessages([{ role: 'user', content: 123 }])
    expect('code' in (result as object)).toBe(true)
  })

  it('rejects content exceeding 2000 characters', () => {
    const result = validateChatMessages([{ role: 'user', content: 'a'.repeat(2001) }])
    expect('code' in (result as object)).toBe(true)
  })

  it('accepts content exactly 2000 characters', () => {
    const result = validateChatMessages([{ role: 'user', content: 'a'.repeat(2000) }])
    expect(Array.isArray(result)).toBe(true)
  })
})
