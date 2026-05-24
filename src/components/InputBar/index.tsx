import { useState, useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { asrProvider } from '../../services/asr'
import styles from './InputBar.module.css'

interface InputBarProps {
  sendMessage: (text: string) => Promise<void>
  retry: () => void
}

export function InputBar({ sendMessage, retry }: InputBarProps) {
  const inputText = useAgentStore(state => state.inputText)
  const setInputText = useAgentStore(state => state.setInputText)
  const mood = useAgentStore(state => state.mood)
  const error = useAgentStore(state => state.error)
  const isLoading = useAgentStore(state => state.isLoading)

  const [isListening, setIsListening] = useState(false)
  const [interimText, setInterimText] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [isSavingKey, setIsSavingKey] = useState(false)

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

  function handleMicPointerDown(e: React.PointerEvent) {
    e.preventDefault()
    if (isLoading || !asrProvider.available) return
    asrProvider.start()
    setIsListening(true)
  }

  function handleMicPointerUp() {
    if (!isListening) return
    asrProvider.stop()
    // isListening stays true until onEnd fires (after transcription completes)
  }

  async function handleSaveApiKey() {
    const key = apiKeyInput.trim()
    if (!key || isSavingKey) return
    setIsSavingKey(true)
    setApiKeyError(null)
    const result = await window.electronAPI.setApiKey(key)
    setIsSavingKey(false)
    if (result) {
      setApiKeyError(result.message)
    } else {
      setApiKeyInput('')
      retry()
    }
  }

  function handleApiKeyKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleSaveApiKey()
  }

  const displayText = isListening && interimText ? interimText : inputText

  return (
    <div className={styles.inputBar}>
      {mood === 'error' && error && error.code === 'AI_UNAVAILABLE' && (
        <div className={styles.retryRow}>
          <span className={styles.errorText}>{error.message}</span>
          <div className={styles.apiKeyRow}>
            <input
              className={styles.apiKeyInput}
              type="password"
              placeholder="sk-…"
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              onKeyDown={handleApiKeyKeyDown}
              disabled={isSavingKey}
              aria-label="Deepseek API Key"
            />
            <button
              className={styles.retryBtn}
              onClick={handleSaveApiKey}
              disabled={!apiKeyInput.trim() || isSavingKey}
            >
              {isSavingKey ? '…' : '保存'}
            </button>
          </div>
          {apiKeyError && <span className={styles.errorText}>{apiKeyError}</span>}
        </div>
      )}

      {mood === 'error' && error && error.code !== 'AI_UNAVAILABLE' && (
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
          onPointerDown={handleMicPointerDown}
          onPointerUp={handleMicPointerUp}
          onPointerCancel={handleMicPointerUp}
          onPointerLeave={handleMicPointerUp}
          disabled={!asrProvider.available || isLoading}
          title={asrProvider.available ? (isListening ? '转写中…' : '按住说话') : '语音输入（不支持）'}
          aria-label={isListening ? '转写中' : '按住说话'}
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
