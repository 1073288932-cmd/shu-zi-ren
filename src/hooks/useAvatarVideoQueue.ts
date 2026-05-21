import { useCallback, useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { avatarVideoProvider } from '../services/avatarVideo'
import { textSegmentation } from '../services/textSegmentation'

export interface UseAvatarVideoQueue {
  enqueue: (text: string) => Promise<void>
  cancel: () => void
  handleVideoEnded: () => void
}

export function useAvatarVideoQueue(): UseAvatarVideoQueue {
  const segmentsRef = useRef<string[]>([])
  const playedCountRef = useRef(0)
  const currentJobIdRef = useRef<string | null>(null)
  const currentUrlRef = useRef<string | null>(null)
  const genRef = useRef(0)

  // Wire up provider event subscriptions once
  useEffect(() => {
    const offDone = avatarVideoProvider.onDone(e => {
      if (e.jobId !== currentJobIdRef.current) return
      const blob = new Blob([e.buffer], { type: e.mimeType })
      const url = URL.createObjectURL(blob)
      currentUrlRef.current = url
      useAgentStore.setState({ videoUrl: url, videoQueueState: 'playing' })
    })
    return () => {
      offDone()
      // Cleanup any lingering URL on unmount
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = null
      }
    }
  }, [])

  const enqueue = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    genRef.current++
    useAgentStore.setState({ avatarVideoError: null, videoUrl: null, videoQueueState: 'idle' })

    segmentsRef.current = textSegmentation(trimmed)
    playedCountRef.current = 0
    if (segmentsRef.current.length === 0) return

    const first = segmentsRef.current[0]
    useAgentStore.setState({ videoQueueState: 'generating' })
    const result = await avatarVideoProvider.generate(first)
    if (result.ok) {
      currentJobIdRef.current = result.jobId
    } else {
      useAgentStore.setState({
        videoQueueState: 'idle',
        avatarVideoError: result.error,
      })
    }
  }, [])

  const handleVideoEnded = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current)
      currentUrlRef.current = null
    }
    playedCountRef.current++
    currentJobIdRef.current = null
    // Single-segment path only at this task; reset to idle.
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
  }, [])

  const cancel = useCallback(() => {
    genRef.current++
    if (currentJobIdRef.current) {
      avatarVideoProvider.cancel(currentJobIdRef.current)
      currentJobIdRef.current = null
    }
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current)
      currentUrlRef.current = null
    }
    segmentsRef.current = []
    playedCountRef.current = 0
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
  }, [])

  return { enqueue, cancel, handleVideoEnded }
}
