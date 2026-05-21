import { describe, it, expect } from 'vitest'
import { textSegmentation, MAX_SEGMENT_CHARS } from '../src/services/textSegmentation'

describe('textSegmentation', () => {
  it('exports MAX_SEGMENT_CHARS = 240', () => {
    expect(MAX_SEGMENT_CHARS).toBe(240)
  })

  it('returns single segment for short text', () => {
    expect(textSegmentation('简短答复。')).toEqual(['简短答复。'])
  })

  it('returns empty array for empty/whitespace input', () => {
    expect(textSegmentation('')).toEqual([])
    expect(textSegmentation('   ')).toEqual([])
  })

  it('splits on 。！？ but not 、，；', () => {
    const text = '第一句。第二句！第三句？第四句，仍是第四句、还是第四句；最后。'
    expect(textSegmentation(text)).toEqual([
      '第一句。第二句！第三句？第四句，仍是第四句、还是第四句；最后。',
    ])
  })

  it('combines adjacent short sentences up to limit', () => {
    const text = 'A。' + 'B。' + 'C。'
    expect(textSegmentation(text)).toEqual(['A。B。C。'])
  })

  it('starts new segment when adding next sentence exceeds limit', () => {
    const seg1 = '一'.repeat(200) + '。'
    const seg2 = '二'.repeat(100) + '。'
    const result = textSegmentation(seg1 + seg2)
    expect(result).toEqual([seg1, seg2])
    expect(result[0].length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    expect(result[1].length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
  })

  it('falls back to comma-level split when single sentence exceeds limit', () => {
    const long = '前半部分'.repeat(40) + '，' + '后半部分'.repeat(40) + '。'
    const result = textSegmentation(long)
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const s of result) expect(s.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
  })

  it('hard-splits on character when no punctuation available', () => {
    const text = '字'.repeat(500)
    const result = textSegmentation(text)
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const s of result) expect(s.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    expect(result.join('')).toBe(text)
  })

  it('merges trailing tiny segment (<4 chars) into previous', () => {
    const text = '一'.repeat(100) + '。' + '是。'
    expect(textSegmentation(text)).toEqual(['一'.repeat(100) + '。是。'])
  })

  it('does NOT merge tiny trailing segment if result would exceed MAX_SEGMENT_CHARS', () => {
    // '一'.repeat(239) + '。' = 240 chars; + '是。' (2 chars) = 242 > 240 → must NOT merge
    const seg = '一'.repeat(239) + '。'
    const tail = '是。'
    expect(seg.length).toBe(240)
    expect(tail.length).toBe(2)
    const result = textSegmentation(seg + tail)
    expect(result).toHaveLength(2)
    for (const s of result) expect(s.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
  })

  it('handles English mixed with Chinese punctuation', () => {
    const text = '物理公式 F=ma。在牛顿力学中，F 表示力，m 表示质量。'
    expect(textSegmentation(text)).toEqual([text])
  })

  it('preserves leading/trailing whitespace within segments but trims overall', () => {
    expect(textSegmentation('  hello.  ')).toEqual(['hello.'])
  })
})
