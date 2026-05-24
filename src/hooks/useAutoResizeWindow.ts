import { useEffect, useRef } from 'react'

export function useAutoResizeWindow(containerRef: React.RefObject<HTMLElement>) {
  const observerRef = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof window === 'undefined' || !window.electronAPI) return

    observerRef.current = new ResizeObserver(entries => {
      for (const entry of entries) {
        const height = Math.ceil(entry.contentRect.height)
        window.electronAPI.resizeWindow(height)
      }
    })

    observerRef.current.observe(el)

    return () => {
      observerRef.current?.disconnect()
    }
  }, [containerRef])
}
