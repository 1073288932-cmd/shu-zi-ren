import { useRef } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { useAI } from '../../hooks/useAI'
import styles from './InputBar.module.css'

export function InputBar() {
  const inputText = useAgentStore(state => state.inputText)
  const setInputText = useAgentStore(state => state.setInputText)
  const mood = useAgentStore(state => state.mood)
  const error = useAgentStore(state => state.error)
  const isLoading = useAgentStore(state => state.isLoading)
  const { sendMessage, retry } = useAI()
  const inputRef = useRef<HTMLTextAreaElement>(null)

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

  return (
    <div className={styles.inputBar}>
      {mood === 'error' && error && (
        <div className={styles.retryRow}>
          <span className={styles.errorText}>{error.message}</span>
          {error.recoverable && (
            <button className={styles.retryBtn} onClick={retry}>
              重试
            </button>
          )}
        </div>
      )}

      <div className={styles.row}>
        <textarea
          ref={inputRef}
          className={styles.input}
          placeholder="问我任何物理问题…"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          rows={1}
        />

        <button
          className={styles.micBtn}
          disabled
          title="语音输入（即将支持）"
          aria-label="语音输入（暂未开放）"
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
