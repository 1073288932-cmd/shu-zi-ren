import { useAgentStore } from '../../store/agentStore'
import styles from './Avatar.module.css'

interface AvatarProps {
  /** Slot for Live2D canvas, VRM, or Live Avatar video stream */
  children?: React.ReactNode
}

const MOOD_LABELS: Record<string, string> = {
  idle: '',
  thinking: '🤔 思考中…',
  talking: '🔊 讲解中',
  error: '⚠️ 出错了',
}

export function Avatar({ children }: AvatarProps) {
  const mood = useAgentStore(state => state.mood)
  const isPushing = useAgentStore(state => state.isPushing)

  return (
    <div
      className={styles.avatar}
      data-mood={mood}
      data-pushing={isPushing}
    >
      {isPushing && <span className={styles.pushingFlag}>📢</span>}

      {children ?? (
        <span className={styles.character} role="img" aria-label="教学助手">
          👩‍🏫
        </span>
      )}

      <span className={styles.statusBadge}>
        {MOOD_LABELS[mood]}
      </span>
    </div>
  )
}
