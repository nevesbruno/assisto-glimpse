import type { ServerResponse } from 'node:http'

const SSE_HEARTBEAT_INTERVAL_MS = 20_000

export function startSseHeartbeat(
  res: ServerResponse,
  intervalMs: number = SSE_HEARTBEAT_INTERVAL_MS,
): void {
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      stop()
      return
    }
    try {
      res.write(':\n\n')
    } catch {
      stop()
    }
  }, intervalMs)
  timer.unref()

  function stop(): void {
    clearInterval(timer)
    res.off('close', stop)
  }
  res.once('close', stop)
}
