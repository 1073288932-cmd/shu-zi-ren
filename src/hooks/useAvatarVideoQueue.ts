import { useCallback, useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { avatarVideoProvider } from '../services/avatarVideo'
import { textSegmentation } from '../services/textSegmentation'

interface PendingNext {
  jobId: string
  url: string | null  // resolved when done event fires
}

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
  const nextRef = useRef<PendingNext | null>(null)
  const genRef = useRef(0)

  const prefetchNextIfNeeded = useCallback(async () => {
    const nextIdx = playedCountRef.current + 1
    if (nextIdx >= segmentsRef.current.length) return
    if (nextRef.current) return  // already prefetching
    const myGen = genRef.current
    const text = segmentsRef.current[nextIdx]
    const result = await avatarVideoProvider.generate(text)
    if (myGen !== genRef.current) return  // stale
    if (result.ok) {
      nextRef.current = { jobId: result.jobId, url: null }
    }
  }, [])

  useEffect(() => {
    const offDone = avatarVideoProvider.onDone(e => {
      // Current segment done?
      if (e.jobId === currentJobIdRef.current) {
        const blob = new Blob([e.buffer], { type: e.mimeType })
        const url = URL.createObjectURL(blob)
        currentUrlRef.current = url
        useAgentStore.setState({ videoUrl: url, videoQueueState: 'playing' })
        prefetchNextIfNeeded()
        return
      }
      // Pending next segment done?
      if (nextRef.current && e.jobId === nextRef.current.jobId) {
        const blob = new Blob([e.buffer], { type: e.mimeType })
        nextRef.current.url = URL.createObjectURL(blob)
        // If we're stalled waiting for this, transition to playing
        if (useAgentStore.getState().videoQueueState === 'stalled') {
          promoteNext()
        }
      }
    })
    return () => {
      offDone()
      if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
      if (nextRef.current?.url) URL.revokeObjectURL(nextRef.current.url)
      currentUrlRef.current = null
      nextRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function promoteNext(): void {
    const next = nextRef.current
    if (!next || !next.url) return
    const oldUrl = currentUrlRef.current
    currentJobIdRef.current = next.jobId
    currentUrlRef.current = next.url
    nextRef.current = null
    useAgentStore.setState({ videoUrl: next.url, videoQueueState: 'playing' })
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    prefetchNextIfNeeded()
  }

  const enqueue = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    genRef.current++
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    if (nextRef.current?.url) URL.revokeObjectURL(nextRef.current.url)
    currentUrlRef.current = null
    nextRef.current = null
    useAgentStore.setState({ avatarVideoError: null, videoUrl: null, videoQueueState: 'idle' })

    segmentsRef.current = textSegmentation(trimmed)
    playedCountRef.current = 0
    if (segmentsRef.current.length === 0) return

    useAgentStore.setState({ videoQueueState: 'generating' })
    const result = await avatarVideoProvider.generate(segmentsRef.current[0])
    if (result.ok) {
      currentJobIdRef.current = result.jobId
    } else {
      useAgentStore.setState({ videoQueueState: 'idle', avatarVideoError: result.error })
    }
  }, [])

  const handleVideoEnded = useCallback(() => {
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    currentUrlRef.current = null
    playedCountRef.current++
    const lastSegmentEnded = playedCountRef.current >= segmentsRef.current.length
    if (lastSegmentEnded) {
      currentJobIdRef.current = null
      segmentsRef.current = []
      playedCountRef.current = 0
      useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
      return
    }
    if (nextRef.current?.url) {
      promoteNext()
    } else {
      currentJobIdRef.current = null
      useAgentStore.setState({ videoUrl: null, videoQueueState: 'stalled' })
    }
  }, [])

  const cancel = useCallback(() => {
    genRef.current++
    if (currentJobIdRef.current) avatarVideoProvider.cancel(currentJobIdRef.current)
    if (nextRef.current) avatarVideoProvider.cancel(nextRef.current.jobId)
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    if (nextRef.current?.url) URL.revokeObjectURL(nextRef.current.url)
    currentJobIdRef.current = null
    currentUrlRef.current = null
    nextRef.current = null
    segmentsRef.current = []
    playedCountRef.current = 0
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
  }, [])

  return { enqueue, cancel, handleVideoEnded }
}
