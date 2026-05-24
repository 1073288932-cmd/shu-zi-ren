import { useCallback, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import { ttsProvider } from '../services/tts'
import { lipSyncController } from '../services/lipsync'
import { isAppError } from '../services/ai/ElectronAIProvider'
import type { AppError } from '@shared/types'

export function useAI() {
  const generationRef = useRef(0)

  const sendMessage = useCallback(async (text: string) => {
    if (useAgentStore.getState().isLoading) return

    // generation guard：防止过期 TTS 回调清掉新一轮的口型/状态
    const myGen = ++generationRef.current

    // 新一轮开始前，停掉上一条的 TTS 与口型（spec Section 9 约束 1）
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

      // 立即启动口型，再说话；speak() 的 resolve/reject 是唯一收尾信号
      lipSyncController.start(response.reply, useAgentStore.getState().setCurrentViseme)

      const finishTalking = () => {
        // 过期回调（已开始更新的一轮）直接忽略，避免清掉当前口型/状态
        if (generationRef.current !== myGen) return
        lipSyncController.stop()
        const st = useAgentStore.getState()
        st.setMood('idle')
        st.setIsPushing(false)
      }
      ttsProvider.speak(response.reply).then(finishTalking, finishTalking)
    } catch (err: unknown) {
      // 此 catch 全程在 isLoading=true 下串行，不会 stale —— 不加 generation guard
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
  }, [])

  const retry = useCallback(() => {
    const { lastUserInput } = useAgentStore.getState()
    if (lastUserInput) sendMessage(lastUserInput)
  }, [sendMessage])

  return { sendMessage, retry }
}
