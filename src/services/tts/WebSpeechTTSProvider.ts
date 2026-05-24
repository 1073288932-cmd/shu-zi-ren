import type { TTSProvider } from './TTSProvider'

export class WebSpeechTTSProvider implements TTSProvider {
  private gen = 0

  speak(text: string): Promise<void> {
    if (!text) return Promise.resolve()
    const myGen = ++this.gen
    window.speechSynthesis.cancel()
    return new Promise(resolve => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'zh-CN'
      utterance.rate = 0.95
      const voices = window.speechSynthesis.getVoices()
      const zhVoice = voices.find(v => v.lang.startsWith('zh'))
      if (zhVoice) utterance.voice = zhVoice
      utterance.onend = () => { if (this.gen === myGen) resolve() }
      utterance.onerror = () => { if (this.gen === myGen) resolve() }
      window.speechSynthesis.speak(utterance)
    })
  }

  stop(): void {
    this.gen++
    window.speechSynthesis.cancel()
  }
}
