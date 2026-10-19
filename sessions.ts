import { randomUUID } from 'node:crypto'
import type { GalleryItem } from './gallery.ts'
import type { Notice } from './notices.ts'
import type { SessionStatus } from './status.ts'
import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'
import unicode11 from '@xterm/addon-unicode11'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { Terminal } from '@xterm/headless'

// Which agent runs in it (see agents.ts): 'claude', 'codex', … or 'shell' for plain PowerShell.
export type SessionKind = string

export interface SessionInfo {
  id: string
  kind: SessionKind
  title: string
  // What the owner named it; shown instead of the title while set.
  name: string | null
  // Put away: still running, but out of the tabs and down in the list's archive.
  archived: boolean
  // No phone notifications from it (a long job that would only say "done" again and again).
  muted: boolean
  // The Claude Code conversation running in it and its folder, so a restart can resume it.
  conversation: string | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
}

export type ServerMessage =
  | { t: 'list'; sessions: SessionInfo[] }
  | { t: 'snapshot'; id: string; d: string; cols: number; rows: number }
  | { t: 'out'; id: string; d: string }
  | { t: 'size'; id: string; cols: number; rows: number }
  | { t: 'exit'; id: string }
  | { t: 'notice'; notice: Notice }
  | { t: 'gallery'; items: GalleryItem[] }
  | { t: 'status'; id: string; status: SessionStatus }
  | { t: 'meta'; meta: SessionMeta[] }
  | { t: 'error'; text: string }

// What the side list shows besides the name: the git project and branch, whether output is
// arriving, the last line printed, and web servers it started (see meta.ts).
export interface SessionMeta {
  id: string
  repo: { project: string; name: string; root: string; branch: string; worktree: boolean } | null
  busy: boolean
  line: string
  ports: { port: number; url: string | null }[]
}

export interface Activity {
  id: string
  busy: boolean
  line: string
}

// The slice of node-pty a session uses, so tests can hand in a fake.
export interface Pty {
  // The PowerShell's process id, to find what it started (web servers).
  readonly pid: number
  onData(listener: (data: string) => void): void
  onExit(listener: () => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

// The id goes into the session's environment, so Claude Code's hooks can say which session spoke.
// A session brought back after a restart passes its conversation, to be resumed in its folder.
export type SpawnPty = (kind: SessionKind, cols: number, rows: number, id: string, resume: Resume | null) => Pty

export interface Resume {
  conversation: string | null
  cwd: string | null
  // When the tab first opened: conversations an agent kept since then are this tab's (codex.ts).
  createdAt?: number
  // A task's first prompt for a new agent tab.
  prompt?: string
}

// What is kept on disk for each session, to open it again after a restart.
export interface SavedSession {
  id: string
  kind: SessionKind
  title: string
  name: string | null
  archived: boolean
  muted: boolean
  conversation: string | null
  cwd: string | null
  createdAt: number
}

// Why the list changed: an exit may be the PC shutting down around us, so it is saved a little later.
export type ListChange = 'change' | 'exit'

export interface Viewer {
  send(message: ServerMessage): void
}

const SCROLLBACK = 5000
const MIN_COLS = 20
const MAX_COLS = 400
const MIN_ROWS = 5
const MAX_ROWS = 200

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

interface Session {
  info: SessionInfo
  pty: Pty
  screen: Terminal
  serializer: SerializeAddon
  viewers: Set<Viewer>
  // Viewers that joined while the screen was still parsing older output: their live output waits
  // here until their snapshot has gone out, so nothing is shown twice or lost.
  joining: Map<Viewer, string[]>
}

export interface Sessions {
  list(): SessionInfo[]
  create(kind: SessionKind, cols: number, rows: number, saved?: SavedSession, cwd?: string, prompt?: string): SessionInfo
  setConversation(id: string, conversation: string, cwd: string | null): void
  attach(id: string, viewer: Viewer): boolean
  detach(viewer: Viewer): void
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  rename(id: string, name: string | null): void
  archive(id: string, archived: boolean): void
  mute(id: string, muted: boolean): void
  close(id: string): void
  closeAll(): void
  // Busy (output in the last moment) and the last line on screen, per session.
  activity(now: number): Activity[]
  pids(): Map<string, number>
}

const BUSY_MS = 1500
const MAX_LINE = 160

// Rows Claude Code padded to the edge (diff lines, boxes) make the terminal think the next row
// continues them, and a wider terminal then glues two or three narrow lines into one: after a phone
// used the session, the PC saw them side by side. A row after one ending in padding (two or more
// spaces) starts its own line again; a real long line, cut mid-word, still joins up.
interface WrapLines {
  length: number
  get(index: number): { isWrapped: boolean } | undefined
}

function isWrapLines(value: unknown): value is WrapLines {
  return typeof value === 'object' && value !== null && 'length' in value && typeof value.length === 'number' && 'get' in value && typeof value.get === 'function'
}

// @xterm's own buffer lines, whose isWrapped can be cleared (the public API only reads it).
function bufferLines(screen: Terminal): WrapLines | null {
  const core = '_core' in screen ? screen._core : null
  const buffer = typeof core === 'object' && core !== null && 'buffer' in core ? core.buffer : null
  const lines = typeof buffer === 'object' && buffer !== null && 'lines' in buffer ? buffer.lines : null

  return isWrapLines(lines) ? lines : null
}

export function unwrapPadded(screen: Terminal): void {
  const lines = bufferLines(screen)
  const view = screen.buffer.active

  if (lines === null) return

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines.get(index)

    if (line?.isWrapped && /\s{2,}$/.test(view.getLine(index - 1)?.translateToString(false) ?? '')) line.isWrapped = false
  }
}

// The last line with something on it, as plain text.
function lastLine(screen: Terminal): string {
  const buffer = screen.buffer.active

  for (let y = buffer.baseY + buffer.cursorY; y >= Math.max(0, buffer.baseY + buffer.cursorY - 50); y -= 1) {
    const text = buffer.getLine(y)?.translateToString(true).trim() ?? ''

    if (text !== '') return text.slice(0, MAX_LINE)
  }

  return ''
}

const MAX_NAME = 80

// The shell's prompt reports its folder as OSC 7 (file://host/C:/path); a restart opens it there.
export function cwdFromOsc7(data: string): string | null {
  const match = data.match(/^file:\/\/[^/]*\/(.+)$/)

  if (match === null) return null

  let path

  try {
    path = decodeURIComponent(match[1] ?? '')
  } catch {
    return null
  }

  return /^[A-Za-z]:\//.test(path) ? path.replaceAll('/', '\\') : null
}

// One trimmed line, or null (back to the title) when nothing is left.
export function cleanName(name: string | null): string | null {
  const clean = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)

  return clean === '' ? null : clean
}

// `labelOf` names a new session after its agent until the program running in it sets a title.
export function createSessions(spawnPty: SpawnPty, onListChange: (sessions: SessionInfo[], why: ListChange) => void, labelOf: (kind: SessionKind) => string = (kind) => kind): Sessions {
  const sessions = new Map<string, Session>()
  const lastOutput = new Map<string, number>()

  const list = (): SessionInfo[] => [...sessions.values()].map((session) => ({ ...session.info }))
  const announce = (why: ListChange = 'change'): void => onListChange(list(), why)

  const broadcast = (session: Session, message: ServerMessage): void => {
    for (const viewer of session.viewers) viewer.send(message)
  }

  const remove = (session: Session, why: ListChange): void => {
    if (!sessions.delete(session.info.id)) return

    lastOutput.delete(session.info.id)

    broadcast(session, { t: 'exit', id: session.info.id })
    session.viewers.clear()
    session.joining.clear()
    session.screen.dispose()
    announce(why)
  }

  return {
    list,

    create(kind, cols, rows, saved, cwd, prompt) {
      const width = clamp(cols, MIN_COLS, MAX_COLS)
      const height = clamp(rows, MIN_ROWS, MAX_ROWS)
      const screen = new headless.Terminal({ cols: width, rows: height, scrollback: SCROLLBACK, allowProposedApi: true })
      const serializer = new serialize.SerializeAddon()

      screen.loadAddon(serializer)
      screen.loadAddon(new unicode11.Unicode11Addon())
      screen.unicode.activeVersion = '11'

      const id = saved?.id ?? randomUUID()
      const session: Session = {
        info: {
          id,
          kind,
          title: saved?.title ?? labelOf(kind),
          name: saved?.name ?? null,
          archived: saved?.archived ?? false,
          muted: saved?.muted ?? false,
          conversation: saved?.conversation ?? null,
          cwd: saved?.cwd ?? cwd ?? null,
          cols: width,
          rows: height,
          createdAt: saved?.createdAt ?? Date.now(),
        },
        pty: spawnPty(kind, width, height, id, saved !== undefined ? { conversation: saved.conversation, cwd: saved.cwd, createdAt: saved.createdAt } : cwd === undefined ? null : { conversation: null, cwd, prompt }),
        screen,
        serializer,
        viewers: new Set(),
        joining: new Map(),
      }

      screen.onTitleChange((title) => {
        const trimmed = title.trim()

        // PowerShell titles its window with its own exe path, which says nothing as a tab name.
        if (trimmed === '' || trimmed === session.info.title || /\.exe$/i.test(trimmed)) return

        session.info.title = trimmed
        announce()
      })

      screen.parser.registerOscHandler(7, (data) => {
        const cwd = cwdFromOsc7(data)

        if (cwd !== null && cwd !== session.info.cwd) {
          session.info.cwd = cwd
          announce()
        }

        return true
      })

      session.pty.onData((data) => {
        screen.write(data)
        lastOutput.set(id, Date.now())

        for (const [viewer, waiting] of session.joining) {
          if (session.viewers.has(viewer)) waiting.push(data)
        }

        for (const viewer of session.viewers) {
          if (!session.joining.has(viewer)) viewer.send({ t: 'out', id: session.info.id, d: data })
        }
      })

      session.pty.onExit(() => remove(session, 'exit'))
      sessions.set(session.info.id, session)
      announce()

      return { ...session.info }
    },

    attach(id, viewer) {
      const session = sessions.get(id)

      if (session === undefined) return false

      session.viewers.add(viewer)
      session.joining.set(viewer, [])

      // The empty write resolves after everything queued before it is parsed, so the snapshot
      // holds exactly the output this viewer did not get live.
      session.screen.write('', () => {
        const waiting = session.joining.get(viewer)

        session.joining.delete(viewer)

        if (!session.viewers.has(viewer) || waiting === undefined) return

        const { cols, rows } = session.info

        viewer.send({ t: 'snapshot', id, d: session.serializer.serialize({ scrollback: SCROLLBACK }), cols, rows })

        for (const data of waiting) viewer.send({ t: 'out', id, d: data })
      })

      return true
    },

    detach(viewer) {
      for (const session of sessions.values()) {
        session.viewers.delete(viewer)
        session.joining.delete(viewer)
      }
    },

    input(id, data) {
      sessions.get(id)?.pty.write(data)
    },

    resize(id, cols, rows) {
      const session = sessions.get(id)

      if (session === undefined) return

      const width = clamp(cols, MIN_COLS, MAX_COLS)
      const height = clamp(rows, MIN_ROWS, MAX_ROWS)

      if (width === session.info.cols && height === session.info.rows) return

      session.info.cols = width
      session.info.rows = height
      session.pty.resize(width, height)
      unwrapPadded(session.screen)
      session.screen.resize(width, height)
      broadcast(session, { t: 'size', id, cols: width, rows: height })
    },

    setConversation(id, conversation, cwd) {
      const session = sessions.get(id)

      if (session === undefined || (session.info.conversation === conversation && session.info.cwd === cwd)) return

      session.info.conversation = conversation
      session.info.cwd = cwd
      announce()
    },

    rename(id, name) {
      const session = sessions.get(id)

      if (session === undefined) return

      session.info.name = cleanName(name)
      announce()
    },

    archive(id, archived) {
      const session = sessions.get(id)

      if (session === undefined || session.info.archived === archived) return

      session.info.archived = archived
      announce()
    },

    mute(id, muted) {
      const session = sessions.get(id)

      if (session === undefined || session.info.muted === muted) return

      session.info.muted = muted
      announce()
    },

    close(id) {
      const session = sessions.get(id)

      if (session === undefined) return

      session.pty.kill()
      remove(session, 'change')
    },

    activity(now) {
      const out: Activity[] = []

      for (const [id, session] of sessions) out.push({ id, busy: now - (lastOutput.get(id) ?? 0) < BUSY_MS, line: lastLine(session.screen) })

      return out
    },

    pids() {
      const out = new Map<string, number>()

      for (const [id, session] of sessions) out.set(id, session.pty.pid)

      return out
    },

    // Only when the server itself stops: the sessions are saved and come back on the next start.
    closeAll() {
      for (const session of [...sessions.values()]) {
        session.pty.kill()
        remove(session, 'exit')
      }
    },
  }
}
