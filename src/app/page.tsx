'use client'

import { useEffect, useRef } from 'react'

export default function Home() {
  const frameRef = useRef<HTMLIFrameElement>(null)

  // Keep keyboard focus inside the game frame (fallback path — normally
  // next.config rewrites "/" straight to the static /game.html document).
  useEffect(() => {
    const focusFrame = () => frameRef.current?.contentWindow?.focus()
    focusFrame()
    window.addEventListener('click', focusFrame)
    window.addEventListener('focus', focusFrame)
    return () => {
      window.removeEventListener('click', focusFrame)
      window.removeEventListener('focus', focusFrame)
    }
  }, [])

  return (
    <div className="fixed inset-0 bg-black">
      <iframe
        ref={frameRef}
        src="/game.html"
        title="Wings of Glory — Закат · авиасимулятор"
        className="h-full w-full border-0"
        allow="autoplay; fullscreen; gamepad"
        onLoad={focusFrameSafe}
      />
    </div>
  )
}

function focusFrameSafe(this: HTMLIFrameElement) {
  try { this.contentWindow?.focus() } catch { /* cross-origin no-op */ }
}
