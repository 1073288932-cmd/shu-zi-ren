// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createKbRetriever } from '../../electron/services/knowledge/retriever'
import type { Chunk } from '../../electron/services/knowledge/types'

const chunks: Chunk[] = [
  { id: 'c1', text: 'near', textbook: 'tb', heading: 'h1', vector: [1, 0] },
  { id: 'c2', text: 'far', textbook: 'tb', heading: 'h2', vector: [0, 1] },
]

function fakeClient(embed: (texts: string[]) => Promise<number[][]>) {
  return { embed: vi.fn(embed) } as unknown as import('../../electron/services/knowledge/embeddingClient').EmbeddingClient
}

const opts = { topK: 5, similarityThreshold: 0.45, maxContextChars: 3500 }

describe('createKbRetriever', () => {
  it('embeds the query and returns matching chunks', async () => {
    const r = createKbRetriever(fakeClient(async () => [[1, 0]]), chunks, opts)
    const out = await r.retrieve('摩擦力')
    expect(out.map(c => c.id)).toEqual(['c1'])
  })

  it('returns [] for blank query without embedding', async () => {
    const client = fakeClient(async () => [[1, 0]])
    const r = createKbRetriever(client, chunks, opts)
    expect(await r.retrieve('   ')).toEqual([])
    expect(client.embed).not.toHaveBeenCalled()
  })

  it('degrades to [] when embedding throws', async () => {
    const r = createKbRetriever(fakeClient(async () => { throw new Error('network') }), chunks, opts)
    expect(await r.retrieve('摩擦力')).toEqual([])
  })

  it('returns [] when index has no chunks', async () => {
    const r = createKbRetriever(fakeClient(async () => [[1, 0]]), [], opts)
    expect(await r.retrieve('摩擦力')).toEqual([])
  })
})
