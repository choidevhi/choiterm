// Agents without hooks for ChoiTerm (Codex, Gemini, …) still get a "finished" notification: a turn
// is output that kept coming for a while (the agent working, its timer ticking) and then stopped.
// Typing makes only short bursts, so it never counts as a turn.
export interface TurnWatch {
  // One look at a session: busy (output in the last moment) or not. True when a turn just ended.
  see(id: string, busy: boolean, now: number): boolean
  forget(id: string): void
}

const MIN_TURN_MS = 6000
const QUIET_MS = 3000

export function createTurnWatch(minTurn = MIN_TURN_MS, quiet = QUIET_MS): TurnWatch {
  const turns = new Map<string, { since: number; last: number }>()

  return {
    see(id, busy, now) {
      const turn = turns.get(id)

      if (busy) {
        if (turn === undefined) turns.set(id, { since: now, last: now })
        else turn.last = now

        return false
      }

      if (turn === undefined || now - turn.last < quiet) return false

      turns.delete(id)

      return turn.last - turn.since >= minTurn
    },

    forget(id) {
      turns.delete(id)
    },
  }
}
