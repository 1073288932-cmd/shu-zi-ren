// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { MockAIProvider } from '../src/services/ai/MockAIProvider'

describe('MockAIProvider', () => {
  it('returns an AIResponse with correct shape', async () => {
    const provider = new MockAIProvider()
    const result = await provider.chat([{ role: 'user', content: '摩擦力' }])

    expect(typeof result.reply).toBe('string')
    expect(result.reply.length).toBeGreaterThan(0)
    expect(Array.isArray(result.resourceCards)).toBe(true)
  })

  it('resource cards have required fields', async () => {
    const provider = new MockAIProvider()
    const result = await provider.chat([{ role: 'user', content: '摩擦力' }])

    for (const card of result.resourceCards) {
      expect(card).toHaveProperty('id')
      expect(card).toHaveProperty('kind')
      expect(['external', 'local']).toContain(card.kind)
      expect(card).toHaveProperty('title')
      expect(card).toHaveProperty('type')
      expect(card).toHaveProperty('description')
      expect(Array.isArray(card.tags)).toBe(true)
    }
  })

  it('external cards have url starting with http', async () => {
    const provider = new MockAIProvider()
    const result = await provider.chat([{ role: 'user', content: 'test' }])

    const externalCards = result.resourceCards.filter(c => c.kind === 'external')
    for (const card of externalCards) {
      if (card.kind === 'external') {
        expect(card.url).toMatch(/^https?:\/\//)
      }
    }
  })

  it('local cards do NOT have a url field', async () => {
    const provider = new MockAIProvider()
    const result = await provider.chat([{ role: 'user', content: 'test' }])

    const localCards = result.resourceCards.filter(c => c.kind === 'local')
    for (const card of localCards) {
      expect(card).not.toHaveProperty('url')
    }
  })

  it('throws when shouldFail is true', async () => {
    const provider = new MockAIProvider()
    provider.shouldFail = true

    await expect(
      provider.chat([{ role: 'user', content: 'test' }])
    ).rejects.toThrow('Mock AI failure')
  })
})
