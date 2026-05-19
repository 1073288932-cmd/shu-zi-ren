import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSpeechASRProvider } from '../src/services/asr/WebSpeechASRProvider'

type MockRecognition = {
  lang: string
  interimResults: boolean
  continuous: boolean
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  onresult: ((e: { results: Array<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

let mockInstance: MockRecognition

const MockSpeechRecognition = vi.fn().mockImplementation(() => {
  mockInstance = {
    lang: '',
    interimResults: false,
    continuous: false,
    start: vi.fn(),
    stop: vi.fn(),
    onresult: null,
    onerror: null,
    onend: null,
  }
  return mockInstance
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WebSpeechASRProvider', () => {
  it('available is true', () => {
    const provider = new WebSpeechASRProvider()
    expect(provider.available).toBe(true)
  })

  it('calls stop() on old instance before start() to prevent duplicates', () => {
    const provider = new WebSpeechASRProvider()
    provider.start()
    const firstInstance = mockInstance

    provider.start()
    expect(firstInstance.stop).toHaveBeenCalled()
  })

  it('sets lang to zh-CN', () => {
    const provider = new WebSpeechASRProvider()
    provider.start()
    expect(mockInstance.lang).toBe('zh-CN')
  })

  it('sets interimResults to true', () => {
    const provider = new WebSpeechASRProvider()
    provider.start()
    expect(mockInstance.interimResults).toBe(true)
  })

  it('onresult with isFinal=true calls onResult callback with (text, true)', () => {
    const provider = new WebSpeechASRProvider()
    const resultCb = vi.fn()
    provider.onResult(resultCb)
    provider.start()

    mockInstance.onresult?.({
      results: [{ 0: { transcript: 'hello world' }, isFinal: true }],
    })

    expect(resultCb).toHaveBeenCalledWith('hello world', true)
  })

  it('onresult with isFinal=false calls onResult callback with (text, false)', () => {
    const provider = new WebSpeechASRProvider()
    const resultCb = vi.fn()
    provider.onResult(resultCb)
    provider.start()

    mockInstance.onresult?.({
      results: [{ 0: { transcript: 'hel' }, isFinal: false }],
    })

    expect(resultCb).toHaveBeenCalledWith('hel', false)
  })

  it('onerror calls onError callback with error code string', () => {
    const provider = new WebSpeechASRProvider()
    const errorCb = vi.fn()
    provider.onError(errorCb)
    provider.start()

    mockInstance.onerror?.({ error: 'network' })

    expect(errorCb).toHaveBeenCalledWith('network')
  })

  it('onend calls onEnd callback', () => {
    const provider = new WebSpeechASRProvider()
    const endCb = vi.fn()
    provider.onEnd(endCb)
    provider.start()

    mockInstance.onend?.()

    expect(endCb).toHaveBeenCalled()
  })

  it('stop() calls recognition.stop() and clears instance', () => {
    const provider = new WebSpeechASRProvider()
    provider.start()
    const instance = mockInstance

    provider.stop()

    expect(instance.stop).toHaveBeenCalled()
  })
})
