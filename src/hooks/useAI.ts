import { useCallback, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import { ttsProvider } from '../services/tts'
import { lipSyncController } from '../services/lipsync'
import { isAppError } from '../services/ai/ElectronAIProvider'
import type { AppError } from '@shared/types'

export function useAI() {
  const ttsGenRef = useRef(0)

  const sendMessage = useCallback(async (text: string) => {
    if (useAgentStore.getState().isLoading) return

    ttsGenRef.current++
    ttsProvider.stop()
    lipSyncController.stop()

    const store = useAgentStore.getState()
    store.setLastUserInput(text)
    store.setIsLoading(true)
    store.setMood('thinking')
    store.setError(null)
    store.addMessage({ role: 'user', content: text })

    try {
      const response = await aiProvider.chat(useAgentStore.getState().messages)

      const s = useAgentStore.getState()
      s.addMessage({ role: 'assistant', content: response.reply })
      s.setResourceCards(response.resourceCards)
      s.setIsPushing(response.resourceCards.length > 0)
      s.setMood('talking')
      s.setIsLoading(false)

      const myGen = ttsGenRef.current

      lipSyncController.start(response.reply, state => {
        if (ttsGenRef.current === myGen) useAgentStore.getState().setMouthState(state)
      })

      const finishTalking = () => {
        if (ttsGenRef.current === myGen) {
          lipSyncController.stop()
          useAgentStore.getState().setMouthState({ shape: 'closed', intensity: 0 })
          useAgentStore.getState().setMood('idle')
          useAgentStore.getState().setIsPushing(false)
        }
      }

      try {
        ttsProvider.speak(response.reply).then(finishTalking).catch(finishTalking)
      } catch {
        finishTalking()
      }
    } catch (err: unknown) {
      const appError: AppError = isAppError(err)
        ? (err as AppError)
        : { code: 'AI_ERROR', message: err instanceof Error ? err.message : String(err), recoverable: true }
      ttsProvider.stop()
      lipSyncController.stop()
      const s = useAgentStore.getState()
      s.setMood('error')
      s.setIsPushing(false)
      s.setError(appError)
      s.setIsLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const retry = useCallback(() => {
    const { lastUserInput } = useAgentStore.getState()
    if (lastUserInput) sendMessage(lastUserInput)
  }, [sendMessage])

  return { sendMessage, retry }
}
