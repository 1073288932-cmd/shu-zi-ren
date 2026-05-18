import { useAgentStore } from '../../store/agentStore'
import type { ResourceCard as ResourceCardType } from '@shared/types'
import styles from './ResourceCard.module.css'

const TYPE_ICONS: Record<string, string> = {
  video: '🎬',
  doc: '📄',
  exercise: '📝',
  experiment: '🧪',
  link: '🔗',
}

interface ResourceCardProps {
  card: ResourceCardType
}

export function ResourceCard({ card }: ResourceCardProps) {
  const removeResourceCard = useAgentStore(state => state.removeResourceCard)

  async function handleOpen() {
    if (card.kind === 'external') {
      const err = await window.electronAPI.openExternal(card.url)
      if (err) console.error('openExternal error:', err)
    } else {
      const err = await window.electronAPI.openResource(card.id)
      if (err) console.error('openResource error:', err)
    }
  }

  function handleClose(e: React.MouseEvent) {
    e.stopPropagation()
    removeResourceCard(card.id)
  }

  return (
    <div
      className={styles.card}
      onClick={handleOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleOpen()
      }}
      role="button"
      tabIndex={0}
    >
      <span className={styles.icon}>{TYPE_ICONS[card.type] ?? '📎'}</span>

      <div className={styles.body}>
        <div className={styles.title}>{card.title}</div>
        <div className={styles.description}>{card.description}</div>
        {card.tags.length > 0 && (
          <div className={styles.tags}>
            {card.tags.map(tag => (
              <span key={tag} className={styles.tag}>{tag}</span>
            ))}
          </div>
        )}
      </div>

      <button
        className={styles.close}
        onClick={handleClose}
        aria-label="关闭卡片"
      >
        ✕
      </button>
    </div>
  )
}
