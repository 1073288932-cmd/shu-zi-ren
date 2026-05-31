import { LocalAvatar } from './LocalAvatar'
import { CloudAvatar } from './CloudAvatar'
import { useAgentStore } from '../../store/agentStore'

export function Avatar() {
  const renderMode = useAgentStore(s => s.renderMode)
  return renderMode === 'cloud' ? <CloudAvatar /> : <LocalAvatar />
}
