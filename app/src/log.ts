// An on-page event log. The prototype's real output is "what happened in a
// partitioned iframe", so every step gets written down where you can see it.

type Listener = (line: string) => void
const listeners = new Set<Listener>()
const lines: string[] = []

export function log(event: string, detail?: unknown) {
  const time = new Date().toLocaleTimeString()
  const line = detail === undefined ? `${time}  ${event}` : `${time}  ${event}  ${safe(detail)}`
  lines.push(line)
  console.log('[demo-app]', event, detail ?? '')
  for (const l of listeners) l(line)
}

export function onLog(l: Listener) {
  listeners.add(l)
  for (const line of lines) l(line)
}

function safe(v: unknown) {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    return String(v)
  }
}
