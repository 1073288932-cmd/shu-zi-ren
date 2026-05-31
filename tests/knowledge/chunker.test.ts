// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from '../../electron/services/knowledge/chunker'

const TB = '人教版 八年级下'

describe('chunkMarkdown', () => {
  it('splits by headings and records heading path + textbook', () => {
    const md = `# 第八章 运动和力
## 8.3 摩擦力
摩擦力是阻碍相对运动的力。
## 8.1 牛顿第一定律
一切物体保持匀速直线运动或静止。`
    const chunks = chunkMarkdown(md, TB, { chunkSize: 800, chunkOverlap: 120 })
    expect(chunks.length).toBe(2)
    expect(chunks[0].textbook).toBe(TB)
    expect(chunks[0].heading).toBe('第八章 运动和力 / 8.3 摩擦力')
    expect(chunks[0].text).toContain('摩擦力是阻碍')
    expect(chunks[1].heading).toBe('第八章 运动和力 / 8.1 牛顿第一定律')
    expect(chunks[0].id).not.toBe(chunks[1].id)
  })

  it('splits an oversized section into overlapping pieces', () => {
    const body = 'A'.repeat(2000)
    const md = `## 长节\n${body}`
    const chunks = chunkMarkdown(md, TB, { chunkSize: 800, chunkOverlap: 120 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(c => c.text.length <= 800)).toBe(true)
    const tail = chunks[0].text.slice(-120)
    expect(chunks[1].text.startsWith(tail)).toBe(true)
  })

  it('falls back to textbook name as heading when no headings present', () => {
    const chunks = chunkMarkdown('没有任何标题的一段正文。', TB, { chunkSize: 800, chunkOverlap: 120 })
    expect(chunks.length).toBe(1)
    expect(chunks[0].heading).toBe(TB)
  })

  it('drops empty/whitespace-only sections', () => {
    const chunks = chunkMarkdown('## 空节\n\n   \n## 实节\n有内容', TB, { chunkSize: 800, chunkOverlap: 120 })
    expect(chunks.map(c => c.heading)).toEqual(['实节'])   // 空节被丢弃
  })
})
