import type { Chunk } from './types'
import { KB_DEFAULTS } from './types'
import type { EmbeddingClient } from './embeddingClient'
import { search } from './knowledgeIndex'

export interface KbRetriever {
  retrieve(query: string): Promise<Chunk[]>
}

interface RetrieverOptions {
  topK: number
  similarityThreshold: number
  maxContextChars: number
}

export function createKbRetriever(
  embeddingClient: EmbeddingClient,
  chunks: Chunk[],
  opts: RetrieverOptions = KB_DEFAULTS,
): KbRetriever {
  return {
    async retrieve(query: string): Promise<Chunk[]> {
      if (!query.trim() || chunks.length === 0) return []
      try {
        const [queryVec] = await embeddingClient.embed([query])
        if (!queryVec || queryVec.length === 0) return []
        return search(chunks, queryVec, opts)
      } catch (err) {
        console.warn('[kb] retrieve failed, degrade to no-context:', err)
        return []
      }
    },
  }
}
