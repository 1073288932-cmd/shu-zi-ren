import { useCallback, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import type { AppError } from '@shared/types'

function calcTalkingDuration(replyLength: number): number {
  return Math.min(1500 + replyLength * 40, 8000)
}

export function useAI() {
  const talkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTalkingTimer = () => {
    if (talkingTimerRef.current !== null) {
      clearTimeout(talkingTimerRef.current)
      talkingTimerRef.current = null
    }
  }

  const sendMessage = useCallback(async (text: string) => {
    if (useAgentStore.getState().isLoading) return

    clearTalkingTimer()

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

      const duration = calcTalkingDuration(response.reply.length)
      talkingTimerRef.current = setTimeout(() => {
        useAgentStore.getState().setMood('idle')
        talkingTimerRef.current = null
      }, duration)
    } catch (err) {
      const error: AppError = {
        code: 'AI_ERROR',
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      }
      const s = useAgentStore.getState()
      s.setMood('error')
      s.setError(error)
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
