import { useEffect, useState } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { sessionManager } from '../../services/xingyun'
import styles from './ModeToggle.module.css'

export function ModeToggle() {
  const renderMode = useAgentStore(s => s.renderMode)
  const cloudConn = useAgentStore(s => s.cloudConn)
  const cloudLastError = useAgentStore(s => s.cloudLastError)
  const setRenderMode = useAgentStore(s => s.setRenderMode)
  const setCloudError = useAgentStore(s => s.setCloudError)

  const [disabled, setDisabled] = useState(true)
  const [disabledReason, setDisabledReason] = useState('')

  // 配置预查：未配置 → 禁用 + 强制本地
  useEffect(() => {
    let alive = true
    window.electronAPI.xingyunGetConfig().then(cfg => {
      if (!alive) return
      if (cfg.configured) {
        setDisabled(false)
      } else {
        setDisabled(true)
        setDisabledReason(cfg.errorReason)
        useAgentStore.getState().setRenderMode('local')
      }
    })
    return () => { alive = false }
  }, [])

  // toast 自动消失
  useEffect(() => {
    if (!cloudLastError) return
    const t = setTimeout(() => setCloudError(null), 5000)
    return () => clearTimeout(t)
  }, [cloudLastError, setCloudError])

  const connecting = renderMode === 'cloud' && cloudConn === 'connecting'

  const label =
    renderMode === 'local' ? '🎭 本地模式'
    : cloudConn === 'connecting' ? '✨ 连接中…'
    : cloudConn === 'idle' ? '✨ 魔珐 · 待机'
    : '✨ 魔珐'

  const onClick = async () => {
    if (renderMode === 'cloud') {
      await sessionManager.closeNow()
      setRenderMode('local')
      // 切本地会让正在等待的 cloud speak resolve 成 'interrupted'，useAI 据此早退、
      // 不复位 mood；这里显式收尾，避免 LocalAvatar 残留"说话中"状态
      const st = useAgentStore.getState()
      st.setMood('idle')
      st.setIsPushing(false)
    } else {
      setRenderMode('cloud')
    }
  }

  return (
    <div className={styles.root}>
      <button
        className={styles.toggle}
        disabled={disabled || connecting}
        title={disabled ? disabledReason : ''}
        onClick={onClick}
      >
        {label}
      </button>
      {cloudLastError && (
        <div className={styles.toast} onClick={() => setCloudError(null)}>
          {cloudLastError}（点右上角可重试）
        </div>
      )}
    </div>
  )
}
