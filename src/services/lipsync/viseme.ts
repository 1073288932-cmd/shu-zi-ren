import { pinyin } from 'pinyin-pro'
import type { Viseme } from '@shared/types'

const SENTENCE_END = /[。！？]/
const ELLIPSIS = /…/
const CLAUSE = /[，、；：]/
const CJK = /[一-鿿]/
const ASCII_LETTER = /[a-z]/i
const ASCII_VOWEL = /[aeiou]/i
const DIGIT = /[0-9]/

// 主元音优先级：a > o > e > i > u（ü/v 并入 u）
const VOWEL_PRIORITY: ReadonlyArray<readonly [RegExp, Viseme]> = [
  [/a/, 'a'],
  [/o/, 'o'],
  [/e/, 'e'],
  [/i/, 'i'],
  [/u/, 'u'],
  [/[üv]/, 'u'],
]

function syllableToViseme(syllable: string): Viseme {
  const lower = syllable.toLowerCase()
  for (const [re, v] of VOWEL_PRIORITY) {
    if (re.test(lower)) return v
  }
  return 'closed'
}

export function textToVisemes(text: string): Viseme[] {
  const out: Viseme[] = []
  let asciiConsonantIdx = 0

  for (const ch of text) {
    if (SENTENCE_END.test(ch)) { out.push('closed', 'closed', 'closed'); continue }
    if (ELLIPSIS.test(ch))     { out.push('closed', 'closed', 'closed', 'closed'); continue }
    if (CLAUSE.test(ch))       { out.push('closed'); continue }
    if (ch === '\n')           { out.push('closed', 'closed'); continue }
    if (/\s/.test(ch))         { out.push('closed'); continue }

    if (CJK.test(ch)) {
      const py = pinyin(ch, { toneType: 'none', type: 'array' })[0] ?? ''
      out.push(py ? syllableToViseme(py) : 'closed')
      continue
    }

    if (ASCII_LETTER.test(ch)) {
      if (ASCII_VOWEL.test(ch)) {
        out.push(syllableToViseme(ch))
      } else {
        out.push((['e', 'i'] as const)[asciiConsonantIdx % 2])
        asciiConsonantIdx++
      }
      continue
    }

    if (DIGIT.test(ch)) { out.push('a'); continue }

    out.push('closed')
  }

  return out
}
