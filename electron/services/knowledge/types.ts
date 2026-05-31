export interface Chunk {
  id: string          // `${textbookSlug}#${序号}`
  text: string        // chunk 正文
  textbook: string    // 如「人教版 八年级下」
  heading: string     // 章节路径，如「第八章 运动和力 / 8.3 摩擦力」
  vector?: number[]   // 仅 index.json 内含；search 结果省略
}

export interface KnowledgeIndexFile {
  version: number
  embeddingModel: string
  embeddingDim: number
  chunkSize: number
  chunkOverlap: number
  builtAt: string
  chunks: Chunk[]
}

export const INDEX_VERSION = 1
export const EMBEDDING_MODEL = 'BAAI/bge-m3'
export const EMBEDDING_DIM = 1024

export const KB_DEFAULTS = {
  chunkSize: 800,
  chunkOverlap: 120,
  topK: 5,
  similarityThreshold: 0.45,
  maxContextChars: 3500,
} as const
