import type { Chunk } from './types'

interface ChunkOptions { chunkSize: number; chunkOverlap: number }
interface Section { heading: string; body: string }

function slugify(s: string): string {
  return s.replace(/\s+/g, '-').replace(/[^\w一-龥-]/g, '').slice(0, 40)
}

// 按 markdown 标题分节，heading 为从顶层到当前层的路径（' / ' 连接）。
function splitByHeadings(markdown: string, fallbackHeading: string): Section[] {
  const lines = markdown.split(/\r?\n/)
  const stack: string[] = []         // stack[level-1] = 该层标题
  const sections: Section[] = []
  let buf: string[] = []

  const flush = () => {
    const body = buf.join('\n')
    if (body.trim()) {
      const path = stack.filter(Boolean)
      sections.push({ heading: path.length ? path.join(' / ') : fallbackHeading, body })
    }
    buf = []
  }

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      flush()
      const level = m[1].length
      stack[level - 1] = m[2].trim()
      stack.length = level          // 截断更深层
    } else {
      buf.push(line)
    }
  }
  flush()
  return sections
}

// 单节正文按字数切，相邻块 overlap 字符。
function splitBySize(body: string, size: number, overlap: number): string[] {
  const text = body.trim()
  if (text.length <= size) return text ? [text] : []
  const step = Math.max(1, size - overlap)
  const pieces: string[] = []
  for (let start = 0; start < text.length; start += step) {
    pieces.push(text.slice(start, start + size))
    if (start + size >= text.length) break
  }
  return pieces
}

export function chunkMarkdown(markdown: string, textbook: string, opts: ChunkOptions): Chunk[] {
  const slug = slugify(textbook)
  const chunks: Chunk[] = []
  let seq = 0
  for (const section of splitByHeadings(markdown, textbook)) {
    for (const piece of splitBySize(section.body, opts.chunkSize, opts.chunkOverlap)) {
      const text = piece.trim()
      if (!text) continue
      chunks.push({ id: `${slug}#${seq++}`, text, textbook, heading: section.heading })
    }
  }
  return chunks
}
