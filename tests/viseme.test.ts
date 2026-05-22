import { describe, it, expect } from 'vitest'
import { textToVisemes } from '../src/services/lipsync/viseme'

describe('textToVisemes', () => {
  it('maps Chinese characters to vowel-based visemes', () => {
    // 你 ni→i, 好 hao→a
    expect(textToVisemes('你好')).toEqual(['i', 'a'])
  })

  it('maps multi-character Chinese correctly', () => {
    // 数 shu→u, 字 zi→i, 人 ren→e
    expect(textToVisemes('数字人')).toEqual(['u', 'i', 'e'])
  })

  it('inserts 3 closed frames for sentence-ending punctuation', () => {
    expect(textToVisemes('好。')).toEqual(['a', 'closed', 'closed', 'closed'])
  })

  it('inserts 1 closed frame for clause punctuation', () => {
    expect(textToVisemes('好，')).toEqual(['a', 'closed'])
  })

  it('inserts 1 closed frame for a space', () => {
    expect(textToVisemes('a b')).toEqual(['a', 'closed', 'e'])
  })

  it('maps ASCII vowels directly', () => {
    expect(textToVisemes('aeiou')).toEqual(['a', 'e', 'i', 'o', 'u'])
  })

  it('maps digits to the a viseme', () => {
    expect(textToVisemes('7')).toEqual(['a'])
  })

  it('returns an empty array for empty string', () => {
    expect(textToVisemes('')).toEqual([])
  })

  it('alternates e/i for consecutive ASCII consonants', () => {
    expect(textToVisemes('bcdf')).toEqual(['e', 'i', 'e', 'i'])
  })

  it('inserts 2 closed frames for a newline', () => {
    expect(textToVisemes('好\n好')).toEqual(['a', 'closed', 'closed', 'a'])
  })

  it('inserts 4 closed frames for an ellipsis', () => {
    expect(textToVisemes('好…')).toEqual(['a', 'closed', 'closed', 'closed', 'closed'])
  })
})
