// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebSpeechTTSProvider } from '../src/services/tts/WebSpeechTTSProvider'

interface MockUtterance {
  lang: string
  rate: number
  voice: SpeechSynthesisVoice | null
  onend: (() => void) | null
  onerror: (() => void) | null
  readonly text: string
}

describe('WebSpeechTTSProvider', () => {
  const speakMock = vi.fn()
  const cancelMock = vi.fn()
  const getVoicesMock = vi.fn()
  let lastUtterance: MockUtterance | null = null

  beforeEach(() => {
    lastUtterance = null
    speakMock.mockReset()
    speakMock.mockImplementation((u: MockUtterance) => { lastUtterance = u })
    cancelMock.mockReset()
    getVoicesMock.mockReset()
    getVoicesMock.mockReturnValue([])

    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: speakMock, cancel: cancelMock, getVoices: getVoicesMock },
      writable: true,
      configurable: true,
    })

    // jsdom doesn't have SpeechSynthesisUtterance — provide a minimal mock
    if (typeof SpeechSynthesisUtterance === 'undefined') {
      ;(globalThis as Record<string, unknown>).SpeechSynthesisUtterance = class {
        lang = ''
        rate = 1
        voice: SpeechSynthesisVoice | null = null
        onend: (() => void) | null = null
        onerror: (() => void) | null = null
        constructor(public readonly text: string) {}
      }
    }
  })

  it('resolves immediately for empty text', async () => {
    const provider = new WebSpeechTTSProvider()
    await provider.speak('')
    expect(speakMock).not.toHaveBeenCalled()
  })

  it('cancels then speaks', async () => {
    const provider = new WebSpeechTTSProvider()
    const p = provider.speak('hello')
    expect(cancelMock).toHaveBeenCalledOnce()
    expect(speakMock).toHaveBeenCalledOnce()
    lastUtterance!.onend!()
    await p
  })

  it('sets lang zh-CN and rate 0.95', async () => {
    const provider = new WebSpeechTTSProvider()
    const p = provider.speak('test')
    expect(lastUtterance!.lang).toBe('zh-CN')
    expect(lastUtterance!.rate).toBe(0.95)
    lastUtterance!.onend!()
    await p
  })

  it('resolves on onend', async () => {
    const provider = new WebSpeechTTSProvider()
    const p = provider.speak('hi')
    lastUtterance!.onend!()
    await expect(p).resolves.toBeUndefined()
  })

  it('resolves on onerror', async () => {
    const provider = new WebSpeechTTSProvider()
    const p = provider.speak('hi')
    lastUtterance!.onerror!()
    await expect(p).resolves.toBeUndefined()
  })

  it('stop() prevents in-flight onend from resolving', async () => {
    const provider = new WebSpeechTTSProvider()
    const p = provider.speak('hi')
    provider.stop()
    lastUtterance!.onend!()
    const result = await Promise.race([
      p.then(() => 'resolved'),
      new Promise<string>(r => setTimeout(() => r('pending'), 50)),
    ])
    expect(result).toBe('pending')
  })

  it('stop() calls speechSynthesis.cancel()', () => {
    const provider = new WebSpeechTTSProvider()
    provider.stop()
    expect(cancelMock).toHaveBeenCalledOnce()
  })

  it('second speak() wins over first', async () => {
    const provider = new WebSpeechTTSProvider()
    const utterances: MockUtterance[] = []
    speakMock.mockImplementation((u: MockUtterance) => utterances.push(u))

    const p1 = provider.speak('first')
    const p2 = provider.speak('second')

    // Resolve first utterance's onend — should NOT resolve p1 (gen mismatch)
    utterances[0].onend!()
    const r1 = await Promise.race([
      p1.then(() => 'resolved'),
      new Promise<string>(r => setTimeout(() => r('pending'), 50)),
    ])
    expect(r1).toBe('pending')

    // Resolve second utterance — resolves p2
    utterances[1].onend!()
    await expect(p2).resolves.toBeUndefined()
  })
})
