import { useState, useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { useAI } from '../../hooks/useAI'
import { asrProvider } from '../../services/asr'
import styles from './InputBar.module.css'

export function InputBar() {
  const inputText = useAgentStore(state => state.inputText)
  const setInputText = useAgentStore(state => state.setInputText)
  const mood = useAgentStore(state => state.mood)
  const error = useAgentStore(state => state.error)
  const isLoading = useAgentStore(state => state.isLoading)
  const { sendMessage, retry } = useAI()

  const [isListening, setIsListening] = useState(false)
  const [interimText, setInterimText] = useState('')

  useEffect(() => {
    asrProvider.onResult((text, isFinal) => {
      setInterimText(text)
      if (isFinal && text.trim()) {
        sendMessage(text.trim())
        setIsListening(false)
        setInterimText('')
      }
    })
    asrProvider.onError(() => {
      setIsListening(false)
    })
    asrProvider.onEnd(() => {
      setIsListening(false)
    })
  }, [sendMessage])

  function handleSubmit() {
    const text = inputText.trim()
    if (!text || isLoading) return
    setInputText('')
    sendMessage(text)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  function handleMic() {
    if (isListening) {
      asrProvider.stop()
      setIsListening(false)
      setInterimText('')
    } else {
      asrProvider.start()
      setIsListening(true)
    }
  }

  const displayText = isListening && interimText ? interimText : inputText

  return (
    <div className={styles.inputBar}>
      {mood === 'error' && error && (
        <div className={styles.retryRow}>
          <span className={styles.errorText}>{error.message}</span>
          <button className={styles.retryBtn} onClick={retry}>
            重试
          </button>
        </div>
      )}

      <div className={styles.row}>
        <textarea
          className={styles.input}
          placeholder={isListening ? '正在聆听…' : '问我任何物理问题…'}
          value={displayText}
          onChange={e => { if (!isListening) setInputText(e.target.value) }}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          rows={1}
        />

        <button
          className={`${styles.micBtn}${isListening ? ` ${styles.micBtnActive}` : ''}`}
          onClick={handleMic}
          disabled={!asrProvider.available || isLoading}
          title={asrProvider.available ? (isListening ? '停止录音' : '语音输入') : '语音输入（不支持）'}
          aria-label={isListening ? '停止录音' : '语音输入'}
        >
          🎙
        </button>

        <button
          className={styles.sendBtn}
          onClick={handleSubmit}
          disabled={isLoading || !inputText.trim()}
          aria-label="发送"
        >
          ↑
        </button>
      </div>
    </div>
  )
}
