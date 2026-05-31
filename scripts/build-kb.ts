import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { chunkMarkdown } from '../electron/services/knowledge/chunker'
import { EmbeddingClient } from '../electron/services/knowledge/embeddingClient'
import type { Chunk, KnowledgeIndexFile } from '../electron/services/knowledge/types'
import { INDEX_VERSION, EMBEDDING_MODEL, EMBEDDING_DIM, KB_DEFAULTS } from '../electron/services/knowledge/types'

const TEXTBOOKS_DIR = path.join(process.cwd(), 'knowledge', 'textbooks')
const OUT_PATH = path.join(process.cwd(), 'knowledge', 'index.json')
const BATCH = 32

function die(msg: string): never {
  console.error(`[build-kb] 失败：${msg}`)
  process.exit(1)
}

function textbookName(file: string, content: string): string {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content)
  if (fm) {
    const m = /^textbook:\s*(.+)$/m.exec(fm[1])
    if (m) return m[1].trim()
  }
  return path.basename(file, '.md')
}

async function main() {
  const apiKey = process.env.SILICONFLOW_API_KEY ?? ''
  if (!apiKey) die('缺 SILICONFLOW_API_KEY，请在 .env 配置')

  let files: string[]
  try {
    files = fs.readdirSync(TEXTBOOKS_DIR).filter(f => f.endsWith('.md'))
  } catch {
    die(`读不到教材目录 ${TEXTBOOKS_DIR}（先放入 *.md）`)
  }
  if (files.length === 0) die(`${TEXTBOOKS_DIR} 下没有 .md 教材`)

  const allChunks: Chunk[] = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(TEXTBOOKS_DIR, file), 'utf-8')
    const tb = textbookName(file, content)
    const chunks = chunkMarkdown(content, tb, {
      chunkSize: KB_DEFAULTS.chunkSize,
      chunkOverlap: KB_DEFAULTS.chunkOverlap,
    })
    console.log(`[build-kb] ${file} -> ${chunks.length} chunks（${tb}）`)
    allChunks.push(...chunks)
  }
  if (allChunks.length === 0) die('切块结果为空')

  const client = new EmbeddingClient(apiKey)
  const t0 = Date.now()
  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH)
    let vectors: number[][]
    try {
      vectors = await client.embed(batch.map(c => c.text))
    } catch (err) {
      die(`embedding 调用失败 @${i}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (vectors.length !== batch.length) die(`embedding 数量不符 @${i}`)
    batch.forEach((c, j) => { c.vector = vectors[j] })
    console.log(`[build-kb] embedded ${Math.min(i + BATCH, allChunks.length)}/${allChunks.length}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  const index: KnowledgeIndexFile = {
    version: INDEX_VERSION,
    embeddingModel: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIM,
    chunkSize: KB_DEFAULTS.chunkSize,
    chunkOverlap: KB_DEFAULTS.chunkOverlap,
    builtAt: new Date().toISOString(),
    chunks: allChunks,
  }
  try {
    fs.writeFileSync(OUT_PATH, JSON.stringify(index), 'utf-8')
  } catch (err) {
    die(`写 index.json 失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  console.log(`[build-kb] 完成：${allChunks.length} chunks -> ${OUT_PATH}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
}

main()
