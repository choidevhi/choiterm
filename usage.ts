// Codex's own limits (5-hour and weekly windows), for the status line beside Claude's. Codex writes
// them into its conversation files with every reply (`token_count` events carry `rate_limits`); the
// newest file holds the latest figures.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Limit {
  kind: 'five_hour' | 'seven_day'
  percent: number
  resetsAt: string | null
}

export interface AgentUsage {
  limits: Limit[]
  at: number
}

const TAIL = 256 * 1024
const DAY_MS = 86_400_000

// The last `rate_limits` in a rollout's tail, as limits.
export function parseCodexLimits(tail: string): Limit[] | null {
  const lines = tail.split('\n')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''

    if (!line.includes('"rate_limits"')) continue

    try {
      const limits = JSON.parse(line)?.payload?.rate_limits
      const out: Limit[] = []

      for (const window of [limits?.primary, limits?.secondary]) {
        if (typeof window?.used_percent !== 'number') continue

        const minutes = Number(window.window_minutes)

        out.push({
          kind: minutes > 24 * 60 ? 'seven_day' : 'five_hour',
          percent: window.used_percent,
          resetsAt: Number.isFinite(window.resets_at) ? new Date(window.resets_at * 1000).toISOString() : null,
        })
      }

      if (out.length > 0) return out
    } catch {
      // A line cut by the tail's start: look further up.
    }
  }

  return null
}

// Figures from before a window reset say nothing about now: that window starts again at zero.
export function currentLimit(limit: Limit, now: number): Limit {
  return limit.resetsAt !== null && Date.parse(limit.resetsAt) <= now ? { ...limit, percent: 0, resetsAt: null } : limit
}

function readTail(path: string): string {
  const size = statSync(path).size
  const start = Math.max(0, size - TAIL)
  const fd = openSync(path, 'r')

  try {
    const buffer = Buffer.alloc(size - start)
    const read = readSync(fd, buffer, 0, buffer.length, start)

    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')

// The newest rollouts of the last week, newest first.
function recentRollouts(root: string, now: number): { path: string; modified: number }[] {
  const found: { path: string; modified: number }[] = []

  for (let back = 0; back < 8; back += 1) {
    const day = new Date(now - back * DAY_MS)
    const folder = join(root, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()))

    if (!existsSync(folder)) continue

    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.jsonl')) continue

      try {
        found.push({ path: join(folder, name), modified: statSync(join(folder, name)).mtimeMs })
      } catch {
        // Gone meanwhile.
      }
    }
  }

  return found.sort((a, b) => b.modified - a.modified)
}

export function codexUsage(root: string, now: number): AgentUsage | null {
  for (const rollout of recentRollouts(root, now).slice(0, 5)) {
    try {
      const limits = parseCodexLimits(readTail(rollout.path))

      if (limits !== null) return { limits: limits.map((limit) => currentLimit(limit, now)), at: rollout.modified }
    } catch {
      // Unreadable: try the next.
    }
  }

  return null
}
