import { useState, useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { asrProvider } from '../../services/asr'
import styles from './InputBar.module.css'

interface InputBarProps {
  sendMessage: (text: string) => Promise<void>
  retry: () => void
}

// ASR 错误码 → 面向用户的提示。之前 onError 把错误全吞了，
// 导致缺 key / 权限被拒等故障静默无反馈。
const ASR_ERROR_MESSAGES: Record<string, string> = {
  'permission-denied': '麦克风权限被拒绝，请在系统设置中允许',
  'start-failed': '麦克风启动失败，请重试',
  'empty-transcript': '没有听到声音，请重试',
  'ASR_TOO_LARGE': '录音太长，请重试',
  'ASR_UNAVAILABLE': '语音识别未配置',
  'ASR_INVALID': '录音数据异常，请重试',
}

function asrErrorMessage(code: string): string {
  return ASR_ERROR_MESSAGES[code] ?? '语音识别失败，请重试'
}

export function InputBar({ sendMessage, retry }: InputBarProps) {
  const inputText = useAgentStore(state => state.inputText)
  const setInputText = useAgentStore(state => state.setInputText)
  const mood = useAgentStore(state => state.mood)
  const error = useAgentStore(state => state.error)
  const isLoading = useAgentStore(state => state.isLoading)

  const [isListening, setIsListening] = useState(false)
  const [interimText, setInterimText] = useState('')
  const [asrError, setAsrError] = useState<string | null>(null)
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
    asrProvider.onError((code: string) => {
      setIsListening(false)
      setAsrError(asrErrorMessage(code))
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
    setAsrError(null)
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

      {asrError && (
        <div className={styles.retryRow}>
          <span className={styles.errorText}>{asrError}</span>
        </div>
      )}

      <div className={styles.row}>
        <textarea
          className={styles.input}
          placeholder={isListening ? '正在聆听…' : '问我任何物理问题…'}
          value={displayText}
          onChange={e => { if (!isListening) { setAsrError(null); setInputText(e.target.value) } }}
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
