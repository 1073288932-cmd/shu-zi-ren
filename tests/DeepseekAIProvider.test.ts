// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DeepseekAIProvider } from '../electron/services/DeepseekAIProvider'
import { DeepseekHTTPError } from '../electron/services/mapDeepseekError'
import type { ResourceCatalogService } from '../electron/services/resourceCatalog'
import type { ResourceCard } from '../shared/types'

const mockCatalog: ResourceCatalogService = {
  cardMap: new Map<string, ResourceCard>([
    ['res-ext-001', { id: 'res-ext-001', kind: 'external', title: 'PhET', type: 'video', description: 'desc', url: 'https://phet.colorado.edu', tags: [] }],
    ['res-local-001', { id: 'res-local-001', kind: 'local', title: 'Book', type: 'doc', description: 'desc', tags: [] }],
    ['res-ext-002', { id: 'res-ext-002', kind: 'external', title: 'Link2', type: 'link', description: 'desc', url: 'https://example2.com', tags: [] }],
    ['res-ext-003', { id: 'res-ext-003', kind: 'external', title: 'Link3', type: 'link', description: 'desc', url: 'https://example3.com', tags: [] }],
    ['res-ext-004', { id: 'res-ext-004', kind: 'external', title: 'Link4', type: 'link', description: 'desc', url: 'https://example4.com', tags: [] }],
  ]),
  promptSnippet: '[res-ext-001] PhET — desc #tag',
  validateLocalIds: vi.fn().mockReturnValue([]),
}

function makeFetchResponse(content: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  }
}

describe('DeepseekAIProvider', () => {
  let provider: DeepseekAIProvider

  beforeEach(() => {
    provider = new DeepseekAIProvider('test-api-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns reply and mapped resource cards for valid JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeFetchResponse(JSON.stringify({ reply: 'Hello teacher', resourceIds: ['res-ext-001'] }))
    ))
    const result = await provider.chat([{ role: 'user', content: 'test' }], mockCatalog)
    expect(result.reply).toBe('Hello teacher')
    expect(result.resourceCards).toHaveLength(1)
    expect(result.resourceCards[0].id).toBe('res-ext-001')
  })

  it('filters out unknown resource ids silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeFetchResponse(JSON.stringify({ reply: 'Hello', resourceIds: ['unknown-id', 'res-ext-001'] }))
    ))
    const result = await provider.chat([{ role: 'user', content: 'test' }], mockCatalog)
    expect(result.resourceCards).toHaveLength(1)
    expect(result.resourceCards[0].id).toBe('res-ext-001')
  })

  it('truncates resource ids to maximum 3', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeFetchResponse(JSON.stringify({ reply: 'Hello', resourceIds: ['res-ext-001', 'res-local-001', 'res-ext-002', 'res-ext-003', 'res-ext-004'] }))
    ))
    const result = await provider.chat([{ role: 'user', content: 'test' }], mockCatalog)
    expect(result.resourceCards).toHaveLength(3)
  })

  it('falls back to raw content when JSON parse fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('not valid json at all')))
    const result = await provider.chat([{ role: 'user', content: 'test' }], mockCatalog)
    expect(result.reply).toBe('not valid json at all')
    expect(result.resourceCards).toEqual([])
  })

  it('falls back to error message when reply field is not a string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeFetchResponse(JSON.stringify({ reply: 123, resourceIds: [] }))
    ))
    const result = await provider.chat([{ role: 'user', content: 'test' }], mockCatalog)
    expect(result.reply).toContain('格式解析失败')
    expect(result.resourceCards).toEqual([])
  })

  it('falls back to error message when resourceIds is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeFetchResponse(JSON.stringify({ reply: 'ok', resourceIds: 'not-array' }))
    ))
    const result = await provider.chat([{ role: 'user', content: 'test' }], mockCatalog)
    expect(result.reply).toContain('格式解析失败')
  })

  it('throws DeepseekHTTPError with status 401 on 401 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    const err = await provider.chat([{ role: 'user', content: 'test' }], mockCatalog).catch(e => e)
    expect(err).toBeInstanceOf(DeepseekHTTPError)
    expect(err.status).toBe(401)
  })

  it('throws DeepseekHTTPError with status 429 on 429 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }))
    const err = await provider.chat([{ role: 'user', content: 'test' }], mockCatalog).catch(e => e)
    expect(err).toBeInstanceOf(DeepseekHTTPError)
    expect(err.status).toBe(429)
  })

  it('propagates network error when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')))
    await expect(
      provider.chat([{ role: 'user', content: 'test' }], mockCatalog)
    ).rejects.toThrow('network failure')
  })
})
