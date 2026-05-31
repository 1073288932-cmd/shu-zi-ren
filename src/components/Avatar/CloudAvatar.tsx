import { useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { sessionManager, XINGYUN_CONTAINER_ID } from '../../services/xingyun'
import styles from './CloudAvatar.module.css'

export function CloudAvatar() {
  const cloudConn = useAgentStore(s => s.cloudConn)
  const mood = useAgentStore(s => s.mood)

  // 魔珐模式打开即连接，让首屏直接出现 3D 数字人；卸载时断开 SDK，停止计费。
  useEffect(() => {
    let alive = true
    void sessionManager.ensureConnected()
      .then(() => {
        if (!alive) void sessionManager.closeNow()
      })
      .catch(() => {
        if (!alive) return
        const st = useAgentStore.getState()
        st.setCloudError('魔珐连接失败，已切回本地模式')
        st.setRenderMode('local')
        void sessionManager.closeNow()
      })
    return () => {
      alive = false
      void sessionManager.closeNow()
    }
  }, [])

  const wrapClass = [
    styles.wrap,
    mood === 'thinking' ? styles.thinking : '',
    mood === 'talking' ? styles.talking : '',
    mood === 'error' ? styles.error : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.avatar}>
      <div className={wrapClass}>
        {cloudConn === 'connecting' && <div className={styles.overlay}>连接中…</div>}
        {/* 魔珐 SDK 把 3D 自绘进这个容器；非 <video>，无 MediaStream */}
        <div id={XINGYUN_CONTAINER_ID} className={styles.stage} />
      </div>
    </div>
  )
}
