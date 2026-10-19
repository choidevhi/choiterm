// What has been typed into each session and not sent yet, from every screen, kept on disk: when the
// server restarts, an agent comes back with an empty input box, and this text is typed into it
// again once the agent is ready. Followed from the keys themselves (Enter sends and clears, LF is
// a new line in Claude Code, Backspace, Ctrl+U/C/W); cursor moves inside the line are not followed,
// so text edited mid-line comes back as typed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const MAX_DRAFT = 20_000
const SAVE_AFTER_MS = 800

function dropLast(text: string): string {
  return [...text].slice(0, -1).join('')
}

// `text` after `data` was typed after it.
export function applyInput(text: string, data: string): string {
  let out = text
  let at = 0

  while (at < data.length) {
    if (data.startsWith(PASTE_START, at)) {
      const end = data.indexOf(PASTE_END, at + PASTE_START.length)
      const stop = end < 0 ? data.length : end

      out += data.slice(at + PASTE_START.length, stop).replace(/\r\n?/g, '\n')
      at = end < 0 ? data.length : end + PASTE_END.length
      continue
    }

    const char = data[at]

    if (char === '\x1b') {
      const next = data[at + 1]

      if (next === '[' || next === 'O') {
        // A cursor or function key: skip to the sequence's final byte.
        let end = at + 2

        while (end < data.length && !/[@-~]/.test(data[end] ?? '')) end += 1

        at = end + 1
      } else {
        // Esc alone, or Alt with a key.
        at += next === undefined ? 1 : 2
      }

      continue
    }

    if (char === '\r' || char === '\x15' || char === '\x03') out = ''
    else if (char === '\n') out += '\n'
    else if (char === '\x7f') out = dropLast(out)
    else if (char === '\x17' || char === '\x08') out = out.replace(/\S+\s*$/u, '')
    else if (char !== undefined && char >= ' ') out += char

    at += 1
  }

  return out.length > MAX_DRAFT ? out.slice(-MAX_DRAFT) : out
}

// How a draft goes back into a fresh input box: typed as is, LF for its new lines.
export function retype(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export interface Drafts {
  feed(id: string, data: string): void
  get(id: string): string
  forget(id: string): void
  // Writes now (the server is stopping).
  flush(): void
}

export function createDrafts(file: string): Drafts {
  const drafts = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null

    for (const [id, text] of Object.entries(raw?.drafts ?? {})) {
      if (typeof text === 'string' && text !== '') drafts.set(id, text)
    }
  } catch {
    // Start without.
  }

  const write = (): void => {
    timer = null

    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify({ drafts: Object.fromEntries(drafts) }))
      renameSync(`${file}.tmp`, file)
    } catch {
      // Kept in memory until the next write.
    }
  }

  const later = (): void => {
    if (timer === null) timer = setTimeout(write, SAVE_AFTER_MS)
  }

  return {
    feed(id, data) {
      const before = drafts.get(id) ?? ''
      const after = applyInput(before, data)

      if (after === before) return

      if (after === '') drafts.delete(id)
      else drafts.set(id, after)

      later()
    },

    get(id) {
      return drafts.get(id) ?? ''
    },

    forget(id) {
      if (drafts.delete(id)) later()
    },

    flush() {
      if (timer !== null) clearTimeout(timer)

      write()
    },
  }
}
