import { useRef } from 'react'
import { Avatar } from './components/Avatar'
import { ResourceCard } from './components/ResourceCard'
import { InputBar } from './components/InputBar'
import { useAgentStore } from './store/agentStore'
import { useAutoResizeWindow } from './hooks/useAutoResizeWindow'
import { useAI } from './hooks/useAI'
import styles from './App.module.css'

export default function App() {
  const resourceCards = useAgentStore(state => state.resourceCards)
  const shellRef = useRef<HTMLDivElement>(null)
  const { sendMessage, retry, handleVideoEnded } = useAI()

  useAutoResizeWindow(shellRef)

  return (
    <div className={styles.shell} ref={shellRef}>
      <Avatar onVideoEnded={handleVideoEnded} />

      {resourceCards.length > 0 && (
        <>
          <div className={styles.divider} />
          <div className={styles.cardArea}>
            <div className={styles.cardAreaLabel}>推送资源</div>
            {resourceCards.map(card => (
              <ResourceCard key={card.id} card={card} />
            ))}
          </div>
        </>
      )}

      <div className={styles.divider} />
      <InputBar sendMessage={sendMessage} retry={retry} />
    </div>
  )
}
