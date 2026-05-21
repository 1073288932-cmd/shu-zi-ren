import { useCallback, useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { avatarVideoProvider } from '../services/avatarVideo'
import { ttsProvider } from '../services/tts'
import { textSegmentation } from '../services/textSegmentation'
import type { AppError } from '@shared/types'

export const FIRST_SEGMENT_TIMEOUT_MS = 12_000
export const CIRCUIT_BREAK_THRESHOLD = 3
export const CIRCUIT_BREAK_DURATION_MS = 10 * 60 * 1000

interface PendingNext {
  jobId: string
  url: string | null
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
  const firstSegmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstSegmentReceivedRef = useRef(false)
  const consecutiveFailureCountRef = useRef(0)
  const circuitBreakerUntilRef = useRef<number | null>(null)

  function clearFirstSegmentWatchdog(): void {
    if (firstSegmentTimerRef.current) {
      clearTimeout(firstSegmentTimerRef.current)
      firstSegmentTimerRef.current = null
    }
  }

  function clearBuffers(): void {
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    if (nextRef.current?.url) URL.revokeObjectURL(nextRef.current.url)
    currentUrlRef.current = null
    nextRef.current = null
  }

  function fallbackRemaining(error: AppError): void {
    consecutiveFailureCountRef.current++
    if (consecutiveFailureCountRef.current >= CIRCUIT_BREAK_THRESHOLD) {
      circuitBreakerUntilRef.current = Date.now() + CIRCUIT_BREAK_DURATION_MS
    }
    if (currentJobIdRef.current) avatarVideoProvider.cancel(currentJobIdRef.current)
    if (nextRef.current) avatarVideoProvider.cancel(nextRef.current.jobId)
    clearBuffers()
    currentJobIdRef.current = null
    clearFirstSegmentWatchdog()
    const remaining = segmentsRef.current.slice(playedCountRef.current).join('')
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'fallback', avatarVideoError: error })
    if (remaining) {
      void ttsProvider.speak(remaining)
    }
  }

  function enterBlocked(error: AppError): void {
    if (currentJobIdRef.current) avatarVideoProvider.cancel(currentJobIdRef.current)
    if (nextRef.current) avatarVideoProvider.cancel(nextRef.current.jobId)
    clearBuffers()
    currentJobIdRef.current = null
    clearFirstSegmentWatchdog()
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'blocked', avatarVideoError: error })
  }

  const prefetchNextIfNeeded = useCallback(async () => {
    const nextIdx = playedCountRef.current + 1
    if (nextIdx >= segmentsRef.current.length) return
    if (nextRef.current) return
    const myGen = genRef.current
    const text = segmentsRef.current[nextIdx]
    const result = await avatarVideoProvider.generate(text)
    if (myGen !== genRef.current) return
    if (result.ok) {
      nextRef.current = { jobId: result.jobId, url: null }
    }
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

  useEffect(() => {
    const offDone = avatarVideoProvider.onDone(e => {
      if (e.jobId === currentJobIdRef.current) {
        firstSegmentReceivedRef.current = true
        clearFirstSegmentWatchdog()
        consecutiveFailureCountRef.current = 0
        circuitBreakerUntilRef.current = null
        const blob = new Blob([e.buffer], { type: e.mimeType })
        const url = URL.createObjectURL(blob)
        currentUrlRef.current = url
        useAgentStore.setState({ videoUrl: url, videoQueueState: 'playing' })
        prefetchNextIfNeeded()
        return
      }
      if (nextRef.current && e.jobId === nextRef.current.jobId) {
        const blob = new Blob([e.buffer], { type: e.mimeType })
        nextRef.current.url = URL.createObjectURL(blob)
        if (useAgentStore.getState().videoQueueState === 'stalled') {
          promoteNext()
        }
      }
    })
    const offError = avatarVideoProvider.onError(e => {
      if (e.jobId !== currentJobIdRef.current && (!nextRef.current || e.jobId !== nextRef.current.jobId)) {
        return  // stale
      }
      if (e.error.code === 'POLICY_VIOLATION') {
        enterBlocked(e.error)
      } else if (e.error.code === 'INVALID_INPUT') {
        useAgentStore.setState({ videoQueueState: 'idle', avatarVideoError: e.error })
      } else {
        fallbackRemaining(e.error)
      }
    })
    return () => {
      offDone()
      offError()
      clearFirstSegmentWatchdog()
      clearBuffers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const enqueue = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    genRef.current++
    clearFirstSegmentWatchdog()
    firstSegmentReceivedRef.current = false
    clearBuffers()
    useAgentStore.setState({ avatarVideoError: null, videoUrl: null, videoQueueState: 'idle' })

    segmentsRef.current = textSegmentation(trimmed)
    playedCountRef.current = 0
    if (segmentsRef.current.length === 0) return

    // Circuit breaker check
    if (circuitBreakerUntilRef.current && Date.now() < circuitBreakerUntilRef.current) {
      useAgentStore.setState({ videoQueueState: 'fallback' })
      const onEnd = () => useAgentStore.setState({ videoQueueState: 'idle' })
      ttsProvider.speak(trimmed).then(onEnd, onEnd)
      return
    }

    useAgentStore.setState({ videoQueueState: 'generating' })
    const result = await avatarVideoProvider.generate(segmentsRef.current[0])
    if (!result.ok) {
      fallbackRemaining(result.error)
      return
    }
    currentJobIdRef.current = result.jobId

    // 12s watchdog for first segment
    firstSegmentTimerRef.current = setTimeout(() => {
      if (!firstSegmentReceivedRef.current) {
        fallbackRemaining({ code: 'TENCENT_TIMEOUT', message: 'First segment exceeded 12s', recoverable: true })
      }
    }, FIRST_SEGMENT_TIMEOUT_MS)
  }, [])

  const handleVideoEnded = useCallback(() => {
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    currentUrlRef.current = null
    playedCountRef.current++
    const lastEnded = playedCountRef.current >= segmentsRef.current.length
    if (lastEnded) {
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
    clearFirstSegmentWatchdog()
    if (currentJobIdRef.current) avatarVideoProvider.cancel(currentJobIdRef.current)
    if (nextRef.current) avatarVideoProvider.cancel(nextRef.current.jobId)
    clearBuffers()
    currentJobIdRef.current = null
    segmentsRef.current = []
    playedCountRef.current = 0
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
  }, [])

  return { enqueue, cancel, handleVideoEnded }
}
