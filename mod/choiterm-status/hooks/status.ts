// The figures ChoiTerm's status bar shows, kept apart from the hooks so tests can build them.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

export interface Limit {
  kind: string
  percent: number
  resetsAt: string | null
}

export interface Cache {
  at: number
  read: number
  written: number
  ttlMs: number
}

export interface Status {
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  limits: Limit[]
  model: string | null
  effort: Effort | null
  cache: Cache | null
}

export const EMPTY: Status = {
  contextPercent: null,
  contextTokens: null,
  contextWindow: null,
  limits: [],
  model: null,
  effort: null,
  cache: null,
}

const HOUR_MS = 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000

// The prompt cache lives an hour on this plan; once a limit is spent, requests fall back to the
// five-minute cache.
export function cacheTtlMs(limits: readonly Limit[]): number {
  return limits.some((limit) => limit.percent >= 100) ? FIVE_MINUTES_MS : HOUR_MS
}

export function withUsage(
  status: Status,
  context: { percent?: number; tokens?: number; window: number },
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): Status {
  const limits: Limit[] = []

  for (const limit of rateLimits) limits.push({ kind: limit.kind, percent: limit.percentUsed, resetsAt: limit.resetsAt ?? null })

  return {
    ...status,
    contextPercent: context.percent ?? status.contextPercent,
    contextTokens: context.tokens ?? status.contextTokens,
    contextWindow: context.window,
    limits: limits.length > 0 ? limits : status.limits,
  }
}

// A response that touched the prompt cache restarts its clock; one that did not leaves it.
export function withCache(status: Status, at: number, read: number, written: number): Status {
  if (read + written === 0) return status

  return { ...status, cache: { at, read, written, ttlMs: cacheTtlMs(status.limits) } }
}
