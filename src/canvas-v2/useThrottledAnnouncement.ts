import { useEffect, useRef, useState } from 'react'

export function useThrottledAnnouncement(
  value: string,
  intervalMs = 700,
): string {
  const [published, setPublished] = useState(value)
  const latest = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPublishedAt = useRef<number | null>(null)

  useEffect(() => {
    latest.current = value
    if (value === published) return
    const now = Date.now()
    const elapsed = lastPublishedAt.current === null
      ? intervalMs
      : now - lastPublishedAt.current
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      lastPublishedAt.current = Date.now()
      setPublished(latest.current)
    }, Math.max(0, intervalMs - elapsed))
  }, [intervalMs, published, value])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  return published
}
