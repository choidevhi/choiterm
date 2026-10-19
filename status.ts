// What the choiterm-status mod reports from inside a Claude Code session: usage windows, context,
// prompt cache, model and effort, for the status bar under the tabs. Only the latest per session is
// kept; it is gone with the server, and the mod sends it again on the next change.

export interface StatusLimit {
  kind: string
  percent: number
  resetsAt: string | null
}

export interface StatusCache {
  at: number
  read: number
  written: number
  ttlMs: number
}

export interface SessionStatus {
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  limits: StatusLimit[]
  model: string | null
  effort: string | null
  cache: StatusCache | null
}

export interface StatusReport {
  session: string
  status: SessionStatus
}

// Usage warnings: each window warns once per threshold until it resets (a new resetsAt).
const WARN_AT = [95, 80]
const WINDOW_NAMES: Record<string, string> = { five_hour: '5시간', seven_day: '주간' }

function untilReset(resetsAt: string | null, now: number): string {
  const left = resetsAt === null ? Number.NaN : Date.parse(resetsAt) - now

  if (!Number.isFinite(left) || left <= 0) return ''

  const minutes = Math.round(left / 60_000)
  const hours = Math.floor(minutes / 60)

  if (hours >= 24) return ` · ${Math.floor(hours / 24)}일 ${hours % 24}시간 뒤 초기화`

  return hours > 0 ? ` · ${hours}시간 ${minutes % 60}분 뒤 초기화` : ` · ${minutes}분 뒤 초기화`
}

// The warnings this status calls for that were not given yet; `warned` remembers them.
export function usageWarnings(status: SessionStatus, warned: Set<string>, now: number): string[] {
  const texts: string[] = []

  for (const limit of status.limits) {
    const name = WINDOW_NAMES[limit.kind]
    const reached = WARN_AT.find((threshold) => limit.percent >= threshold)

    if (name === undefined || reached === undefined) continue

    const key = (threshold: number): string => `${limit.kind}|${limit.resetsAt}|${threshold}`

    if (warned.has(key(reached))) continue

    // Reaching 95 at once also counts as having passed 80.
    for (const threshold of WARN_AT) {
      if (threshold <= reached) warned.add(key(threshold))
    }

    texts.push(`${name} 사용량 ${Math.round(limit.percent)}%${untilReset(limit.resetsAt, now)}`)
  }

  return texts
}

const MAX_LIMITS = 10
const MAX_TEXT = 80

function numberOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function shortText(value: string): string | null {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : null
}

export function parseStatusReport(text: string): StatusReport | null {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  const status = raw?.status

  if (typeof raw?.session !== 'string' || status === null || typeof status !== 'object') return null

  const limits: StatusLimit[] = []

  for (const limit of Array.isArray(status.limits) ? status.limits.slice(0, MAX_LIMITS) : []) {
    if (typeof limit?.kind !== 'string' || !Number.isFinite(limit.percent)) continue

    limits.push({ kind: limit.kind.slice(0, MAX_TEXT), percent: limit.percent, resetsAt: shortText(limit.resetsAt) })
  }

  const cache = status.cache

  return {
    session: raw.session,
    status: {
      contextPercent: numberOrNull(status.contextPercent),
      contextTokens: numberOrNull(status.contextTokens),
      contextWindow: numberOrNull(status.contextWindow),
      limits,
      model: shortText(status.model),
      // Effort is a level name, or a number on models that take a budget.
      effort: Number.isFinite(status.effort) ? String(status.effort) : shortText(status.effort),
      cache:
        cache !== null && typeof cache === 'object' && Number.isFinite(cache.at) && Number.isFinite(cache.ttlMs)
          ? { at: cache.at, read: Number(cache.read) || 0, written: Number(cache.written) || 0, ttlMs: cache.ttlMs }
          : null,
    },
  }
}
