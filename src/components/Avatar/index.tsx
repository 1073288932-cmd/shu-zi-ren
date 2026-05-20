import { useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { lipSyncController } from '../../services/lipsync'
import type { MouthShape } from '../../../shared/types'
import characterImg from '../../assets/avatar/character.png'
import styles from './Avatar.module.css'

const MOUTH_CLASSES: Record<MouthShape, string> = {
  closed: styles.mouthClosed,
  slightlyOpen: styles.mouthSlightlyOpen,
  ee: styles.mouthEe,
  oh: styles.mouthOh,
  ah: styles.mouthAh,
  wide: styles.mouthWide,
}

interface AvatarProps {
  children?: React.ReactNode
}

export function Avatar({ children }: AvatarProps) {
  const mood = useAgentStore(state => state.mood)
  const isPushing = useAgentStore(state => state.isPushing)
  const mouthShape = useAgentStore(state => state.mouthShape)
  const speakingIntensity = useAgentStore(state => state.speakingIntensity)

  useEffect(() => {
    return () => { lipSyncController.stop() }
  }, [])

  const overlayScaleY = mouthShape === 'closed' ? 1 : speakingIntensity
  const overlayOpacity = mouthShape === 'closed' ? 1 : Math.max(0.2, speakingIntensity)

  const wrapClass = [
    styles.characterWrap,
    mood === 'thinking' ? styles.thinking : '',
    mood === 'talking' ? styles.talking : '',
    mood === 'error' ? styles.error : '',
    isPushing ? styles.pushing : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.avatar}>
      <div className={wrapClass}>
        <img
          className={styles.characterImg}
          src={characterImg}
          alt="avatar"
          draggable={false}
        />
        {mood === 'talking' && (
          <div
            className={`${styles.mouthOverlay} ${MOUTH_CLASSES[mouthShape]}`}
            style={{
              transform: `translateX(-50%) scaleY(${overlayScaleY})`,
              opacity: overlayOpacity,
            }}
          />
        )}
      </div>
      {children}
    </div>
  )
}
