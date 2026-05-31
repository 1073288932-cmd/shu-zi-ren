// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest'
import { EmbeddingClient } from '../../electron/services/knowledge/embeddingClient'

function okFetch(vectors: number[][]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: vectors.map(v => ({ embedding: v })) }),
  } as unknown as Response)
}

describe('EmbeddingClient', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts model + input and returns embeddings in order', async () => {
    const fetchImpl = okFetch([[0.1, 0.2], [0.3, 0.4]])
    const client = new EmbeddingClient('sk-test', fetchImpl as unknown as typeof fetch)
    const out = await client.embed(['a', 'b'])
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toContain('/v1/embeddings')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('BAAI/bge-m3')
    expect(body.input).toEqual(['a', 'b'])
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' })
  })

  it('returns [] for empty input without calling fetch', async () => {
    const fetchImpl = okFetch([])
    const client = new EmbeddingClient('sk-test', fetchImpl as unknown as typeof fetch)
    expect(await client.embed([])).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws on non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response)
    const client = new EmbeddingClient('sk-test', fetchImpl as unknown as typeof fetch)
    await expect(client.embed(['a'])).rejects.toThrow(/401/)
  })

  it('uses custom timeout when provided', async () => {
    const signal = new AbortController().signal
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    const fetchImpl = okFetch([[0.1, 0.2]])
    const client = new EmbeddingClient('sk-test', fetchImpl as unknown as typeof fetch, 4_000)
    await client.embed(['a'])
    expect(timeoutSpy).toHaveBeenCalledWith(4_000)
    expect((fetchImpl.mock.calls[0][1] as RequestInit).signal).toBe(signal)
  })
})
