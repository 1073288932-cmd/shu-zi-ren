// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseAndValidateIndex, search } from '../../electron/services/knowledge/knowledgeIndex'
import type { Chunk, KnowledgeIndexFile } from '../../electron/services/knowledge/types'

function validIndex(): KnowledgeIndexFile {
  return {
    version: 1,
    embeddingModel: 'BAAI/bge-m3',
    embeddingDim: 1024,
    chunkSize: 800,
    chunkOverlap: 120,
    builtAt: '2026-05-31T00:00:00.000Z',
    chunks: [{ id: 'a#0', text: 'x', textbook: 'tb', heading: 'h', vector: [1, 0] }],
  }
}

describe('parseAndValidateIndex', () => {
  it('parses a valid index', () => {
    expect(parseAndValidateIndex(JSON.stringify(validIndex()))?.chunks.length).toBe(1)
  })
  it('returns null on bad json', () => {
    expect(parseAndValidateIndex('{not json')).toBeNull()
  })
  it('returns null on version mismatch', () => {
    expect(parseAndValidateIndex(JSON.stringify({ ...validIndex(), version: 99 }))).toBeNull()
  })
  it('returns null on model mismatch', () => {
    expect(parseAndValidateIndex(JSON.stringify({ ...validIndex(), embeddingModel: 'other' }))).toBeNull()
  })
  it('returns null on dim mismatch', () => {
    expect(parseAndValidateIndex(JSON.stringify({ ...validIndex(), embeddingDim: 512 }))).toBeNull()
  })
})

describe('search', () => {
  const chunks: Chunk[] = [
    { id: 'c1', text: 'near', textbook: 'tb', heading: 'h1', vector: [1, 0] },
    { id: 'c2', text: 'mid', textbook: 'tb', heading: 'h2', vector: [0.7, 0.7] },
    { id: 'c3', text: 'far', textbook: 'tb', heading: 'h3', vector: [0, 1] },
  ]
  const opts = { topK: 5, similarityThreshold: 0.45, maxContextChars: 3500 }

  it('ranks by cosine and filters below threshold', () => {
    const r = search(chunks, [1, 0], opts)
    expect(r.map(c => c.id)).toEqual(['c1', 'c2'])   // c3 cosine 0 < 0.45 被过滤
  })
  it('caps to topK', () => {
    const r = search(chunks, [1, 0], { ...opts, topK: 1 })
    expect(r.map(c => c.id)).toEqual(['c1'])
  })
  it('respects maxContextChars budget (keeps at least one)', () => {
    const r = search(chunks, [1, 0], { ...opts, maxContextChars: 1 })
    expect(r.map(c => c.id)).toEqual(['c1'])
  })
  it('strips vectors from results', () => {
    const r = search(chunks, [1, 0], opts)
    expect(r[0].vector).toBeUndefined()
  })
})
