import { useEffect, useRef } from 'react'
import { useAgentStore } from '../../store/agentStore'
import characterImg from '../../assets/avatar/character.png'
import styles from './Avatar.module.css'

interface AvatarProps {
  onVideoEnded?: () => void
  children?: React.ReactNode
}

export function Avatar({ onVideoEnded, children }: AvatarProps) {
  const mood = useAgentStore(s => s.mood)
  const isPushing = useAgentStore(s => s.isPushing)
  const videoUrl = useAgentStore(s => s.videoUrl)
  const videoQueueState = useAgentStore(s => s.videoQueueState)
  const avatarVideoError = useAgentStore(s => s.avatarVideoError)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // When videoUrl changes, ensure the video element loads + plays the new source
  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoUrl) return
    v.load()
    v.play().catch(() => {/* autoplay rejection is fine; user gesture is in input chain */})
  }, [videoUrl])

  const wrapClass = [
    styles.characterWrap,
    mood === 'thinking' ? styles.thinking : '',
    mood === 'talking' ? styles.talking : '',
    mood === 'error' ? styles.error : '',
    isPushing ? styles.pushing : '',
  ].filter(Boolean).join(' ')

  const showVideo = videoUrl && (videoQueueState === 'playing' || videoQueueState === 'stalled')

  return (
    <div className={styles.avatar}>
      <div className={wrapClass}>
        {showVideo ? (
          <video
            ref={videoRef}
            className={styles.characterVideo}
            src={videoUrl}
            autoPlay
            playsInline
            onEnded={onVideoEnded}
          />
        ) : (
          <img
            className={styles.characterImg}
            src={characterImg}
            alt="avatar"
            draggable={false}
          />
        )}
        {videoQueueState === 'stalled' && <div className={styles.stalledDots}>…</div>}
      </div>
      {videoQueueState === 'blocked' && avatarVideoError?.code === 'POLICY_VIOLATION' && (
        <div className={styles.blockedNotice}>
          此回答未通过数字人内容审核，请调整提问后重试
        </div>
      )}
      {children}
    </div>
  )
}
