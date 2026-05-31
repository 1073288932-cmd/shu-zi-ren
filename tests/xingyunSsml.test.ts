import { describe, it, expect } from 'vitest'
import { buildSSML, escapeXml } from '../src/services/xingyun/ssml'

describe('xingyun ssml', () => {
  it('escapes & < > in order', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('wraps text in <speak> with escaping', () => {
    expect(buildSSML('1 < 2 & true')).toBe('<speak>1 &lt; 2 &amp; true</speak>')
  })

  it('handles plain Chinese text', () => {
    expect(buildSSML('你好世界')).toBe('<speak>你好世界</speak>')
  })
})
