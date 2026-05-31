import fs from 'fs'
import type { Chunk, KnowledgeIndexFile } from './types'
import { INDEX_VERSION, EMBEDDING_MODEL, EMBEDDING_DIM, KB_DEFAULTS } from './types'
import { cosineSimilarity } from './vector'

export function parseAndValidateIndex(raw: string): KnowledgeIndexFile | null {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (typeof data !== 'object' || data === null) return null
  const idx = data as Partial<KnowledgeIndexFile>
  if (idx.version !== INDEX_VERSION) { console.warn('[kb] index version mismatch, degrade'); return null }
  if (idx.embeddingModel !== EMBEDDING_MODEL) { console.warn('[kb] index model mismatch, degrade'); return null }
  if (idx.embeddingDim !== EMBEDDING_DIM) { console.warn('[kb] index dim mismatch, degrade'); return null }
  if (!Array.isArray(idx.chunks)) return null
  return idx as KnowledgeIndexFile
}

export function loadKnowledgeIndex(filePath: string): KnowledgeIndexFile | null {
  let raw: string
  try { raw = fs.readFileSync(filePath, 'utf-8') } catch { return null }
  return parseAndValidateIndex(raw)
}

interface SearchOptions {
  topK: number
  similarityThreshold: number
  maxContextChars: number
}

export function search(
  chunks: Chunk[],
  queryVec: number[],
  opts: SearchOptions = KB_DEFAULTS,
): Chunk[] {
  const scored = chunks
    .map(c => ({ c, score: c.vector ? cosineSimilarity(queryVec, c.vector) : 0 }))
    .filter(s => s.score >= opts.similarityThreshold)
    .sort((a, b) => b.score - a.score)

  const out: Chunk[] = []
  let chars = 0
  for (const { c } of scored) {
    if (out.length >= opts.topK) break
    if (chars + c.text.length > opts.maxContextChars && out.length > 0) break
    out.push({ id: c.id, text: c.text, textbook: c.textbook, heading: c.heading })
    chars += c.text.length
  }
  return out
}
