// Codex keeps each conversation in ~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl, whose first
// line names its folder. A Codex tab brought back after a restart resumes the newest conversation
// held in its folder since the tab opened (`codex resume <id>`), each conversation once.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Rollout {
  id: string
  cwd: string
  modified: number
}

const HEAD = 16 * 1024
const DAY_MS = 86_400_000
const LOOK_BACK_DAYS = 30

// The conversation id and folder from a rollout's first line (its session_meta).
export function parseRolloutHead(head: string): { id: string; cwd: string } | null {
  const line = head.split('\n')[0] ?? ''

  try {
    const meta = JSON.parse(line)
    const payload = meta?.type === 'session_meta' ? meta.payload : null

    return typeof payload?.id === 'string' && typeof payload.cwd === 'string' ? { id: payload.id, cwd: payload.cwd } : null
  } catch {
    return null
  }
}

function readHead(path: string): string {
  const fd = openSync(path, 'r')

  try {
    const buffer = Buffer.alloc(HEAD)
    const read = readSync(fd, buffer, 0, HEAD, 0)

    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')

// Rollouts from the day of `since` on (local dates, as Codex names its folders).
export function findRollouts(root: string, since: number, now: number): Rollout[] {
  const found: Rollout[] = []
  const start = Math.max(since, now - LOOK_BACK_DAYS * DAY_MS)

  for (let day = new Date(start); day.getTime() <= now + DAY_MS; day = new Date(day.getTime() + DAY_MS)) {
    const folder = join(root, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()))

    if (!existsSync(folder)) continue

    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.jsonl')) continue

      const path = join(folder, name)

      try {
        const modified = statSync(path).mtimeMs
        const head = modified >= since ? parseRolloutHead(readHead(path)) : null

        if (head !== null) found.push({ ...head, modified })
      } catch {
        // Being written or gone; the next one will do.
      }
    }
  }

  return found
}

// The newest conversation in `cwd` that no other tab took.
export function pickRollout(rollouts: Rollout[], cwd: string, taken: Set<string>): string | null {
  const key = cwd.toLowerCase().replace(/[\\/]+$/, '')
  let best: Rollout | null = null

  for (const rollout of rollouts) {
    if (taken.has(rollout.id) || rollout.cwd.toLowerCase().replace(/[\\/]+$/, '') !== key) continue

    if (best === null || rollout.modified > best.modified) best = rollout
  }

  return best?.id ?? null
}
