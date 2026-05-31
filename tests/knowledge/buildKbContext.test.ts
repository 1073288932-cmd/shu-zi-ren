// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildKbContext } from '../../electron/services/knowledge/buildKbContext'
import type { Chunk } from '../../electron/services/knowledge/types'

const chunks: Chunk[] = [
  { id: 'c1', text: '摩擦力是阻碍相对运动的力。', textbook: '人教版 八年级下', heading: '8.3 摩擦力' },
]

describe('buildKbContext', () => {
  it('returns empty string when no chunks', () => {
    expect(buildKbContext([])).toBe('')
  })
  it('includes textbook/heading label and chunk text', () => {
    const out = buildKbContext(chunks)
    expect(out).toContain('人教版 八年级下 · 8.3 摩擦力')
    expect(out).toContain('摩擦力是阻碍相对运动的力。')
  })
  it('states the four answering rules incl. no-leak', () => {
    const out = buildKbContext(chunks)
    expect(out).toContain('教材优先')
    expect(out).toContain('可补充')
    expect(out).toContain('不过度超纲')
    expect(out).toContain('不暴露检索过程')
  })
})
