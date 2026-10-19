// The session list on disk. Every change is written right away, so a crash, a restart or a reboot
// finds the sessions as they were; each comes back with the same id (phones keep their tabs), name
// and archive state, and Claude Code sessions resume their conversation.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isAgentId } from './agents.ts'
import type { SavedSession, SessionInfo } from './sessions.ts'

// Claude Code conversation ids are UUIDs. Anything else is dropped, since the id ends up on a
// PowerShell command line.
const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isConversationId(value: string): boolean {
  return CONVERSATION.test(value)
}

export function parseSavedSessions(text: string): SavedSession[] {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }

  const saved: SavedSession[] = []

  for (const entry of Array.isArray(raw?.sessions) ? raw.sessions : []) {
    if (typeof entry?.id !== 'string' || typeof entry.kind !== 'string' || !isAgentId(entry.kind) || !Number.isFinite(entry.createdAt)) continue

    saved.push({
      id: entry.id,
      kind: entry.kind,
      title: typeof entry.title === 'string' ? entry.title : entry.kind === 'claude' ? 'Claude Code' : 'PowerShell',
      name: typeof entry.name === 'string' ? entry.name : null,
      archived: entry.archived === true,
      muted: entry.muted === true,
      conversation: typeof entry.conversation === 'string' && isConversationId(entry.conversation) ? entry.conversation : null,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      createdAt: entry.createdAt,
    })
  }

  return saved
}

export function toSaved(info: SessionInfo): SavedSession {
  return {
    id: info.id,
    kind: info.kind,
    title: info.title,
    name: info.name,
    archived: info.archived,
    muted: info.muted,
    conversation: info.conversation,
    cwd: info.cwd,
    createdAt: info.createdAt,
  }
}

const TRANSCRIPT_HEAD = 256 * 1024

// Where a Claude Code conversation started: the `cwd` of the first transcript entry that has one.
// Conversations are kept per starting folder, so --resume must run there; the folder a hook last
// reported is wherever Claude had cd'd to, and opening there brings up the folder trust question.
// Null when the conversation has no transcript (opened but never used).
export function launchFolder(projects: string, conversation: string): string | null {
  let folders: string[]

  try {
    folders = readdirSync(projects)
  } catch {
    return null
  }

  for (const folder of folders) {
    const file = join(projects, folder, `${conversation}.jsonl`)

    if (!existsSync(file)) continue

    const head = Buffer.alloc(TRANSCRIPT_HEAD)
    const handle = openSync(file, 'r')
    const read = readSync(handle, head, 0, TRANSCRIPT_HEAD, 0)

    closeSync(handle)

    for (const line of head.subarray(0, read).toString('utf8').split('\n')) {
      let entry

      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }

      if (typeof entry?.cwd === 'string' && entry.cwd !== '') return entry.cwd
    }

    // A transcript without a folder in its head still exists: resume where the session last was.
    return ''
  }

  return null
}

export function loadSessions(file: string): SavedSession[] {
  return existsSync(file) ? parseSavedSessions(readFileSync(file, 'utf8')) : []
}

export function saveSessions(file: string, list: SessionInfo[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify({ sessions: list.map(toSaved) }, null, 1))
  renameSync(`${file}.tmp`, file)
}
