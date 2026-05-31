import { useCallback, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import { ttsProvider } from '../services/tts'
import { lipSyncController } from '../services/lipsync'
import { sessionManager } from '../services/xingyun'
import { isAppError } from '../services/ai/ElectronAIProvider'
import type { AppError } from '@shared/types'

export function useAI() {
  const generationRef = useRef(0)

  const sendMessage = useCallback(async (text: string) => {
    if (useAgentStore.getState().isLoading) return

    const myGen = ++generationRef.current

    // 新一轮开始：停掉上一条（两种模式都打断）
    ttsProvider.stop()
    lipSyncController.stop()
    if (useAgentStore.getState().renderMode === 'cloud') {
      sessionManager.interrupt()   // 魔珐真打断；让旧 speak resolve 成 'interrupted'
    }

    const store = useAgentStore.getState()
    store.setLastUserInput(text)
    store.setIsLoading(true)
    store.setMood('thinking')
    store.setError(null)
    store.addMessage({ role: 'user', content: text })

    const finishTalkingLocal = () => {
      if (generationRef.current !== myGen) return
      lipSyncController.stop()
      const st = useAgentStore.getState()
      st.setMood('idle')
      st.setIsPushing(false)
    }

    const handleCloudFailure = (err: unknown, reply: string) => {
      void sessionManager.closeNow()
      const st = useAgentStore.getState()
      const reason = isAppError(err) ? (err as AppError).message : '魔珐连接失败'
      st.setRenderMode('local')                 // 不变量：currentViseme 同步 closed
      st.setCloudError(`魔珐数字人连接失败：${reason}`)
      st.setCloudConn('idle')
      // 本地补讲，保证用户听到完整答案
      lipSyncController.start(reply, st.setCurrentViseme)
      ttsProvider.speak(reply).then(finishTalkingLocal, finishTalkingLocal)
    }

    try {
      const response = await aiProvider.chat(useAgentStore.getState().messages)

      const s = useAgentStore.getState()
      s.addMessage({ role: 'assistant', content: response.reply })
      s.setResourceCards(response.resourceCards)
      s.setIsPushing(response.resourceCards.length > 0)
      s.setMood('talking')
      s.setIsLoading(false)

      const mode = useAgentStore.getState().renderMode   // 按"决策时刻"的模式走

      if (mode === 'local') {
        lipSyncController.start(response.reply, useAgentStore.getState().setCurrentViseme)
        ttsProvider.speak(response.reply).then(finishTalkingLocal, finishTalkingLocal)
      } else {
        try {
          await sessionManager.ensureConnected()
          const result = await sessionManager.speak(response.reply)  // 'completed' | 'interrupted'
          if (generationRef.current !== myGen) return
          if (result === 'interrupted') return                       // 被打断/被切：不收尾、不计 idle
          sessionManager.notifyIdle()
          const st = useAgentStore.getState()
          st.setMood('idle')
          st.setIsPushing(false)
        } catch (cloudErr) {
          if (generationRef.current !== myGen) return
          handleCloudFailure(cloudErr, response.reply)
        }
      }
    } catch (err: unknown) {
      if (useAgentStore.getState().renderMode === 'cloud') {
        void sessionManager.closeNow()
      }
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
