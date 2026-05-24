import { useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import type { Viseme } from '@shared/types'
import characterImg from '../../assets/avatar/character.png'
import closedPng from '../../assets/avatar/visemes/closed.png'
import aPng from '../../assets/avatar/visemes/a.png'
import oPng from '../../assets/avatar/visemes/o.png'
import ePng from '../../assets/avatar/visemes/e.png'
import iPng from '../../assets/avatar/visemes/i.png'
import uPng from '../../assets/avatar/visemes/u.png'
import styles from './Avatar.module.css'

const VISEME_SRC: Record<Viseme, string> = {
  closed: closedPng,
  a: aPng,
  o: oPng,
  e: ePng,
  i: iPng,
  u: uPng,
}

export function Avatar() {
  const mood = useAgentStore(s => s.mood)
  const isPushing = useAgentStore(s => s.isPushing)
  const currentViseme = useAgentStore(s => s.currentViseme)
  const setCurrentViseme = useAgentStore(s => s.setCurrentViseme)

  // 防御性 cleanup：Avatar 是常驻组件，实际只在热重载 / 应用退出时触发。
  // controller 生命周期由 useAI 负责（spec Section 9 约束 1），此处不调 stop()。
  useEffect(() => {
    return () => { setCurrentViseme('closed') }
  }, [setCurrentViseme])

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
        <img className={styles.characterImg} src={characterImg} alt="avatar" draggable={false} />
        <img className={styles.mouthOverlay} src={VISEME_SRC[currentViseme]} alt="" draggable={false} />
      </div>
    </div>
  )
}
