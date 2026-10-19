import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { WebSocketServer, type WebSocket } from 'ws'
import { isImagePath, type Gallery, type GalleryItem } from './gallery.ts'
import { parseNoticeInput, type Notice, type Notices } from './notices.ts'
import { parseStatusReport, usageWarnings, type SessionStatus } from './status.ts'
import { isConversationId } from './store.ts'
import type { Machine, Machines } from './machines.ts'
import { isAgentId, type AgentState } from './agents.ts'
import { listFolder, rawHeaders, readText, writeText, type Entry, type TextFile, type WriteResult } from './files.ts'
import type { PreviewLinks } from './previews.ts'
import type { AgentUsage } from './usage.ts'
import { findFileNames, githubTasks, gitDiff, gitStatus, searchFiles, type Change, type Hit, type Task } from './work.ts'
import type { Meta } from './meta.ts'
import { cleanBranch } from './repo.ts'
import type { Project, Projects } from './projects.ts'
import type { Github, GithubRepo, GithubState, SignIn } from './github.ts'
import type { ServerMessage, SessionKind, Sessions, Viewer } from './sessions.ts'

export interface Settings {
  owner: string
  hosts: string[]
  port: number
}

export interface StaticFile {
  type: string
  body: Buffer
  immutable: boolean
  path?: string
}

export type ClientMessage =
  | { t: 'attach'; id: string }
  | { t: 'in'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'new'; kind: SessionKind; cols: number; rows: number; cwd: string | null }
  | { t: 'worktree'; kinds: SessionKind[]; project: string; branch: string; base: string | null; prompt: string | null; cols: number; rows: number }
  | { t: 'close'; id: string }
  | { t: 'rename'; id: string; name: string | null }
  | { t: 'archive'; id: string; archived: boolean }
  | { t: 'mute'; id: string; muted: boolean }

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
}

const MAX_INPUT = 1 << 20
const MAX_FAN_OUT = 6
const MAX_PROMPT = 20_000

export function parseSettings(text: string): Settings {
  const raw = JSON.parse(text)

  if (typeof raw?.owner !== 'string' || !Array.isArray(raw.hosts) || !Number.isInteger(raw.port)) {
    throw new Error('config.json needs owner, hosts and port')
  }

  const hosts: string[] = []

  for (const host of raw.hosts) {
    if (typeof host !== 'string') throw new Error('config.json hosts must be strings')

    hosts.push(host)
  }

  return { owner: raw.owner, hosts, port: raw.port }
}

// Maps each served path to a file on disk; fonts and vendored libraries never change between
// restarts, so the browser may keep them. The app's own files are read again on every request, so
// a fix to the page never needs a restart (which would end the open sessions).
export function loadStaticFiles(paths: Record<string, string>): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>()

  for (const [route, path] of Object.entries(paths)) {
    files.set(route, {
      type: TYPES[extname(path)] ?? 'application/octet-stream',
      body: readFileSync(path),
      immutable: route.startsWith('/vendor/') || route.startsWith('/fonts/'),
      path,
    })
  }

  return files
}

function isCount(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < 10000
}

export function parseClientMessage(text: string): ClientMessage | null {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (raw === null || typeof raw.t !== 'string') return null

  if (raw.t === 'new') {
    if (typeof raw.kind !== 'string' || !isAgentId(raw.kind) || !isCount(raw.cols) || !isCount(raw.rows)) return null

    // A folder to start in: an absolute path, else the home folder.
    const cwd = typeof raw.cwd === 'string' && isAbsolute(raw.cwd) && raw.cwd.length < 1000 ? raw.cwd : null

    return { t: 'new', kind: raw.kind, cols: raw.cols, rows: raw.rows, cwd }
  }

  // A task: one worktree per agent (fanned out when several), each started on the same prompt.
  if (raw.t === 'worktree') {
    const branch = typeof raw.branch === 'string' ? cleanBranch(raw.branch) : null
    const asked: string[] = Array.isArray(raw.kinds) ? raw.kinds : typeof raw.kind === 'string' ? [raw.kind] : []
    const kinds: string[] = []

    for (const kind of asked) {
      if (typeof kind === 'string' && isAgentId(kind) && !kinds.includes(kind)) kinds.push(kind)
    }

    if (kinds.length === 0 || kinds.length > MAX_FAN_OUT || typeof raw.project !== 'string' || !isAbsolute(raw.project) || branch === null) return null

    if (!isCount(raw.cols) || !isCount(raw.rows)) return null

    const prompt = typeof raw.prompt === 'string' && raw.prompt.trim() !== '' ? raw.prompt.slice(0, MAX_PROMPT) : null

    // The branch to start from ("Create From"); none means the project's current one.
    const base = typeof raw.base === 'string' && raw.base.trim() !== '' ? cleanBranch(raw.base) : null

    if (typeof raw.base === 'string' && raw.base.trim() !== '' && base === null) return null

    return { t: 'worktree', kinds, project: raw.project, branch, base, prompt, cols: raw.cols, rows: raw.rows }
  }

  if (typeof raw.id !== 'string') return null

  if (raw.t === 'attach' || raw.t === 'close') return { t: raw.t, id: raw.id }

  if (raw.t === 'rename') {
    if (raw.name !== null && (typeof raw.name !== 'string' || raw.name.length > 1000)) return null

    return { t: 'rename', id: raw.id, name: raw.name }
  }

  if (raw.t === 'archive') {
    if (typeof raw.archived !== 'boolean') return null

    return { t: 'archive', id: raw.id, archived: raw.archived }
  }

  if (raw.t === 'mute') {
    if (typeof raw.muted !== 'boolean') return null

    return { t: 'mute', id: raw.id, muted: raw.muted }
  }

  if (raw.t === 'in') {
    if (typeof raw.d !== 'string' || raw.d.length > MAX_INPUT) return null

    return { t: 'in', id: raw.id, d: raw.d }
  }

  if (raw.t === 'resize') {
    if (!isCount(raw.cols) || !isCount(raw.rows)) return null

    return { t: 'resize', id: raw.id, cols: raw.cols, rows: raw.rows }
  }

  return null
}

// Through `tailscale serve` only the owner's requests pass; directly on 127.0.0.1 anything on
// this PC may connect. The Host check stops DNS rebinding.
export function fromOwner(req: IncomingMessage, settings: Settings): boolean {
  const host = req.headers.host

  if (host === undefined) return false

  if (settings.hosts.includes(host)) return req.headers['tailscale-user-login'] === settings.owner

  return host === `127.0.0.1:${settings.port}` || host === `localhost:${settings.port}`
}

// Browsers let any web page open a WebSocket to 127.0.0.1, so the socket also has to come from
// this app's own page.
export function sameOrigin(req: IncomingMessage): boolean {
  const { host, origin } = req.headers

  return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`)
}

function serveFile(req: IncomingMessage, res: ServerResponse, files: Map<string, StaticFile>): void {
  const path = new URL(req.url ?? '/', 'http://local').pathname
  const file = files.get(path === '/' ? '/index.html' : path)

  if (req.method !== 'GET' || file === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')

    return
  }

  let body = file.body

  if (!file.immutable && file.path !== undefined) {
    try {
      body = readFileSync(file.path)
    } catch {
      // Mid-save or deleted: the copy read at start still works.
    }
  }

  res.writeHead(200, {
    'content-type': file.type,
    'cache-control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

export interface Download {
  name: string
  body: Buffer
}

export const APK_PATH = '/ChoiTerm.apk'
export const INSTALLER_PATH = '/ChoiTerm-setup.exe'

function serveDownload(res: ServerResponse, download: Download | undefined, type: string): void {
  if (download === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not built yet')

    return
  }

  res.writeHead(200, {
    'content-type': type,
    'content-disposition': `attachment; filename="${download.name}"`,
    'cache-control': 'no-store',
  })
  res.end(download.body)
}

export const UPLOAD_PATH = '/upload'

const MAX_UPLOAD = 512 * 1024 * 1024

// Keeps only a plain file name: no folders, no characters Windows refuses, no spaces (so the path
// can be typed into a prompt without quotes).
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? ''
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/\s+/g, '_').replace(/^\.+/, '').slice(-120)

  return cleaned === '' ? 'file' : cleaned
}

function uploadStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')

  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

type JsonBody =
  | { path: string }
  | { error: string }
  | { answered: string }
  | { items: GalleryItem[] }
  | { item: GalleryItem }
  | { removed: string[] }
  | { app: 'choiterm'; version: string; url: string; sessions: number; busy: number }
  | { branches: string[]; base: string }
  | { picked: string | null }
  | { machines: Machine[] }
  | { agents: AgentState[] }
  | { entries: Entry[] }
  | { file: TextFile }
  | { url: string | null; local: string }
  | { codex: AgentUsage | null }
  | { memTotal: number; memFree: number }
  | { changes: Change[] }
  | { diff: string }
  | { hits: Hit[] }
  | { tasks: Task[] }
  | { saved: WriteResult }
  | { folder: string; entries: Entry[] }
  | { projects: Project[] }
  | { files: string[] }
  | { ok: boolean; project?: string; error?: string }
  | GithubState
  | { repos: GithubRepo[] | null }
  | { signIn: SignIn | null }

function sendJson(res: ServerResponse, status: number, body: JsonBody): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// Saves the request body as a file in the uploads folder and answers with its full path, which the
// page then puts in the prompt. Images also go into the gallery, under the session they were sent to.
async function receiveUpload(
  req: IncomingMessage,
  res: ServerResponse,
  folder: string,
  log: (line: string) => void,
  gallery: Gallery | undefined,
): Promise<void> {
  const params = new URL(req.url ?? '/', 'http://local').searchParams
  const name = params.get('name') ?? 'file'
  const length = Number(req.headers['content-length'])

  if (!Number.isInteger(length) || length < 0 || length > MAX_UPLOAD) {
    sendJson(res, 413, { error: 'file too large or size unknown' })
    req.resume()

    return
  }

  mkdirSync(folder, { recursive: true })

  const path = join(folder, `${uploadStamp(new Date())}-${safeFileName(name)}`)

  try {
    await pipeline(req, createWriteStream(path, { flags: 'wx' }))
  } catch (error) {
    rmSync(path, { force: true })
    log(`upload failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)

    if (!res.headersSent) sendJson(res, 500, { error: 'upload failed' })

    return
  }

  log(`uploaded ${path} (${length} bytes)`)
  gallery?.add(path, 'me', params.get('session'))
  sendJson(res, 200, { path })
}

export interface Extras {
  latestApk?: () => Download | undefined
  latestInstaller?: () => Download | undefined
  uploadFolder?: string
  notices?: Notices
  gallery?: Gallery
  machines?: Machines
  version?: string
  agents?: () => Promise<AgentState[]>
  meta?: Meta
  // Sets up a dev server's preview (previews.ts): this PC's address and the tailnet's.
  openPreview?: (port: number) => Promise<PreviewLinks | null>
  codexUsage?: () => AgentUsage | null
  system?: () => { memTotal: number; memFree: number }
  // Where notes are kept (markdown files).
  notesFolder?: string
  // Another of the owner's PCs reporting how setting up or restarting its server went.
  machineReport?: (machine: string, text: string) => void
  // A new git worktree's folder, or null when git refused.
  addWorktree?: (project: string, branch: string, base: string | null) => Promise<string | null>
  // A project's branches and the one new work starts from by default.
  branches?: (project: string) => Promise<{ branches: string[]; base: string } | null>
  // A new project folder (in the home folder), added to the list; null when the name is refused.
  createProject?: (name: string) => Promise<string | null>
  // Windows' folder picker on this PC's screen; null when cancelled.
  pickFolder?: (start: string) => Promise<string | null>
  // GitHub through gh: signed in or not, the account's repositories, cloning one as a project.
  github?: Github
  // Every project with its worktrees, adding a project, merging a branch, removing a worktree.
  projects?: Projects
  seenProjects?: () => string[]
  mergeBranch?: (project: string, branch: string, squash: boolean) => Promise<boolean>
  // Another worktree's branch into this worktree.
  mergeInto?: (folder: string, branch: string) => Promise<boolean>
  // Every key typed into a session, and a session ended (drafts.ts keeps what was not sent).
  typed?: (id: string, data: string) => void
  closed?: (id: string) => void
  // A worktree just made and its agent started (teamwork.ts tells the project's own agent).
  worktreeCreated?: (info: { session: string; project: string; branch: string; base: string | null; kind: string; folder: string }) => void
  removeWorktree?: (project: string, path: string) => Promise<boolean>
}

export const AGENTS_PATH = '/agents'
export const FS_LIST_PATH = '/fs/list'
export const FS_READ_PATH = '/fs/read'
export const FS_RAW_PATH = '/fs/raw'
export const PREVIEW_OPEN_PATH = '/preview-open'
export const FS_WRITE_PATH = '/fs/write'
const MAX_WRITE = 4 * 1024 * 1024

export const HELLO_PATH = '/hello'
export const MACHINES_PATH = '/machines'

export const PREVIEW_PATH = '/preview'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

// Shows an image file from this PC that a session printed the path of. Images only, so a stray
// tap can never hand out a key file or a document.
function servePreview(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://local').searchParams.get('path') ?? ''
  const type = IMAGE_TYPES[extname(path).toLowerCase()]

  if (type === undefined || !isAbsolute(path)) {
    sendJson(res, 400, { error: 'not an image path' })

    return
  }

  let body: Buffer
  let tag: string

  try {
    const info = statSync(path)

    // The same path may be written again (a fresh screenshot), so the browser asks each time but
    // gets a short "unchanged" answer while size and time stay the same.
    tag = `"${info.size.toString(36)}-${Math.trunc(info.mtimeMs).toString(36)}"`

    if (req.headers['if-none-match'] === tag) {
      res.writeHead(304, { etag: tag, 'cache-control': 'no-cache' })
      res.end()

      return
    }

    body = readFileSync(path)
  } catch {
    sendJson(res, 404, { error: 'no such file' })

    return
  }

  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', etag: tag, 'x-content-type-options': 'nosniff' })
  res.end(body)
}

// Any file as itself for the file view (images, PDFs, media), streamed, under rawHeaders' rules.
function serveRaw(res: ServerResponse, path: string): void {
  let size: number

  try {
    const info = statSync(path)

    if (!info.isFile()) throw new Error('not a file')

    size = info.size
  } catch {
    sendJson(res, 404, { error: 'no such file' })

    return
  }

  res.writeHead(200, { ...rawHeaders(path), 'content-length': String(size) })
  createReadStream(path).on('error', () => res.destroy()).pipe(res)
}

export const GALLERY_PATH = '/gallery'

const MAX_GALLERY_BODY = 256 * 1024

export type GalleryRequest =
  | { t: 'add'; path: string; session: string | null }
  | { t: 'tags'; id: string; tags: string[] }
  | { t: 'delete'; ids: string[] }
  | { t: 'unpin'; ids: string[]; session: string }

export function parseGalleryRequest(action: string, text: string): GalleryRequest | null {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (raw === null || typeof raw !== 'object') return null

  if (action === 'add') {
    if (typeof raw.path !== 'string' || !isImagePath(raw.path)) return null

    return { t: 'add', path: raw.path, session: typeof raw.session === 'string' ? raw.session : null }
  }

  if (action === 'tags') {
    if (typeof raw.id !== 'string' || !Array.isArray(raw.tags)) return null

    const tags: string[] = []

    for (const tag of raw.tags) {
      if (typeof tag !== 'string') return null

      tags.push(tag)
    }

    return { t: 'tags', id: raw.id, tags }
  }

  if (action === 'delete' || action === 'unpin') {
    if (!Array.isArray(raw.ids) || (action === 'unpin' && typeof raw.session !== 'string')) return null

    const ids: string[] = []

    for (const id of raw.ids) {
      if (typeof id !== 'string') return null

      ids.push(id)
    }

    return action === 'unpin' ? { t: 'unpin', ids, session: raw.session } : { t: 'delete', ids }
  }

  return null
}

async function changeGallery(req: IncomingMessage, res: ServerResponse, action: string, gallery: Gallery): Promise<void> {
  const body = await readBody(req, MAX_GALLERY_BODY)
  const request = body === null ? null : parseGalleryRequest(action, body)

  if (request === null) {
    sendJson(res, 400, { error: 'bad gallery request' })

    return
  }

  switch (request.t) {
    case 'add': {
      const item = gallery.add(request.path, 'claude', request.session)

      if (item === null) sendJson(res, 404, { error: 'no such image' })
      else sendJson(res, 200, { item })

      return
    }
    case 'tags': {
      const item = gallery.setTags(request.id, request.tags)

      if (item === null) sendJson(res, 404, { error: 'no such item' })
      else sendJson(res, 200, { item })

      return
    }
    case 'delete':
      sendJson(res, 200, { removed: gallery.remove(request.ids) })

      return
    case 'unpin':
      gallery.unpin(request.ids, request.session)
      sendJson(res, 200, { removed: [] })
  }
}

export const NOTIFY_PATH = '/notify'
export const MACHINE_REPORT_PATH = '/machine-report'

// {machine, text}: a PC name safe as a file name, and the report itself.
export function parseMachineReport(body: string): { machine: string; text: string } | null {
  try {
    const raw = JSON.parse(body)

    if (typeof raw?.machine !== 'string' || typeof raw.text !== 'string' || !/^[\w.-]{1,64}$/.test(raw.machine)) return null

    return { machine: raw.machine, text: raw.text }
  } catch {
    return null
  }
}
export const ANSWER_PATH = '/answer'

const ANSWER_ENTER_DELAY_MS = 150
// A question left this long is likely answered some other way.
const ANSWER_OPEN_MS = 30 * 60 * 1000

interface OpenAnswer {
  session: string
  label: string
  keys: string
}

// The questions a phone may still answer from its notification: the latest one per session, until
// it is answered, the session gets other input or reports something else, or it grows old.
export interface Answers {
  note(notice: Notice): void
  forget(session: string): void
  take(notice: number, index: number, now: number): OpenAnswer | null
}

export function createAnswers(): Answers {
  const open = new Map<string, Notice>()

  return {
    note(notice) {
      if (notice.answers.length > 0) open.set(notice.session, notice)
      else open.delete(notice.session)
    },

    forget(session) {
      open.delete(session)
    },

    take(id, index, now) {
      for (const notice of open.values()) {
        if (notice.id !== id) continue

        const answer = notice.answers[index]

        if (answer === undefined || now - notice.at > ANSWER_OPEN_MS) return null

        open.delete(notice.session)

        return { session: notice.session, label: answer.label, keys: answer.keys }
      }

      return null
    },
  }
}

export function parseAnswerChoice(text: string): { notice: number; index: number } | null {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (!Number.isInteger(raw?.notice) || !Number.isInteger(raw.index) || raw.index < 0) return null

  return { notice: raw.notice, index: raw.index }
}
export const CONVERSATION_PATH = '/conversation'
export const STATUS_PATH = '/status'

export interface ConversationReport {
  session: string
  conversation: string
  cwd: string | null
}

export function parseConversationReport(text: string): ConversationReport | null {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (typeof raw?.session !== 'string' || typeof raw.conversation !== 'string' || !isConversationId(raw.conversation)) return null

  return { session: raw.session, conversation: raw.conversation, cwd: typeof raw.cwd === 'string' ? raw.cwd : null }
}
export const EVENTS_PATH = '/events'

const MAX_NOTIFY = 64 * 1024
const PING_MS = 25_000

// Only hook.ts, running inside a session on this PC, reports: straight to 127.0.0.1 and with no
// Origin, which a browser always sends on a POST.
function fromHook(req: IncomingMessage, settings: Settings): boolean {
  return req.headers.host === `127.0.0.1:${settings.port}` && req.headers.origin === undefined
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    // SAFETY: an IncomingMessage without setEncoding yields Buffers.
    const piece = chunk as Buffer

    size += piece.length

    if (size > limit) return null

    chunks.push(piece)
  }

  return Buffer.concat(chunks).toString('utf8')
}

async function receiveNotice(req: IncomingMessage, res: ServerResponse, sessions: Sessions, notices: Notices, answers: Answers): Promise<void> {
  const body = await readBody(req, MAX_NOTIFY)
  const input = body === null ? null : parseNoticeInput(body)

  if (input === null) {
    sendJson(res, 400, { error: 'bad notice' })

    return
  }

  const session = sessions.list().find((info) => info.id === input.session)

  if (session === undefined) {
    sendJson(res, 404, { error: 'no such session' })

    return
  }

  if (session.muted) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ id: 0, muted: true }))

    return
  }

  // Claude Code starts its title with a status mark (✳, ◐ …); a notification needs only the words.
  const notice = notices.add(input, session.name ?? (session.title.replace(/^[^\p{L}\p{N}]+/u, '') || session.title))

  answers.note(notice)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ id: notice.id }))
}

// Server-sent events for the phone app's background service: what it missed since its last id,
// then each new notice, with a comment line now and then so idle connections stay up.
function streamNotices(req: IncomingMessage, res: ServerResponse, notices: Notices): void {
  const last = Number(req.headers['last-event-id'] ?? new URL(req.url ?? '/', 'http://local').searchParams.get('after') ?? 0)
  const write = (notice: Notice): void => {
    res.write(`id: ${notice.id}\ndata: ${JSON.stringify(notice)}\n\n`)
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')

  for (const notice of notices.since(Number.isFinite(last) ? last : 0)) write(notice)

  const unsubscribe = notices.subscribe(write)
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)

  req.on('close', () => {
    clearInterval(ping)
    unsubscribe()
  })
}

export function startServer(
  settings: Settings,
  sessions: Sessions,
  files: Map<string, StaticFile>,
  log: (line: string) => void,
  extras: Extras = {},
): { server: Server; announce: (message: ServerMessage) => void } {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT * 2 })
  const viewers = new Set<Viewer>()

  const notices = extras.notices

  notices?.subscribe((notice) => {
    for (const viewer of viewers) viewer.send({ t: 'notice', notice })
  })

  const gallery = extras.gallery
  const statuses = new Map<string, SessionStatus>()
  const answers = createAnswers()
  const warned = new Set<string>()

  gallery?.subscribe((items) => {
    for (const viewer of viewers) viewer.send({ t: 'gallery', items })
  })

  extras.meta?.subscribe((meta) => {
    for (const viewer of viewers) viewer.send({ t: 'meta', meta })
  })

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname

    if (req.method === 'POST' && path === NOTIFY_PATH) {
      if (notices === undefined || !fromHook(req, settings)) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      void receiveNotice(req, res, sessions, notices, answers)

      return
    }

    // The PC program on another of the owner's PCs (install.ts) says how its server is doing, so a
    // server that will not stay up there can be looked into from here.
    if (req.method === 'POST' && path === MACHINE_REPORT_PATH) {
      if (extras.machineReport === undefined || !fromOwner(req, settings)) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      void readBody(req, MAX_NOTIFY).then((body) => {
        const report = body === null ? null : parseMachineReport(body)

        if (report === null) {
          sendJson(res, 400, { error: 'bad report' })

          return
        }

        extras.machineReport?.(report.machine, report.text)
        sendJson(res, 200, { ok: true })
      })

      return
    }

    // The choiterm-status mod reports usage, context, cache, model and effort from inside a session.
    if (req.method === 'POST' && path === STATUS_PATH) {
      if (!fromHook(req, settings)) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      void readBody(req, MAX_NOTIFY).then((body) => {
        const report = body === null ? null : parseStatusReport(body)

        if (report === null || !sessions.list().some((info) => info.id === report.session)) {
          sendJson(res, 400, { error: 'bad status' })

          return
        }

        statuses.set(report.session, report.status)

        for (const viewer of viewers) viewer.send({ t: 'status', id: report.session, status: report.status })

        // Every session reports the same account limits; `warned` makes each warning go out once.
        for (const text of usageWarnings(report.status, warned, Date.now())) {
          notices?.add({ session: report.session, kind: 'attention', text }, '사용량 경고')
        }

        sendJson(res, 200, { path: report.session })
      })

      return
    }

    // hook.ts tells which Claude Code conversation runs in a session, so a restart can resume it.
    if (req.method === 'POST' && path === CONVERSATION_PATH) {
      if (!fromHook(req, settings)) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      void readBody(req, MAX_NOTIFY).then((body) => {
        const report = body === null ? null : parseConversationReport(body)

        if (report === null) {
          sendJson(res, 400, { error: 'bad report' })

          return
        }

        sessions.setConversation(report.session, report.conversation, report.cwd)
        sendJson(res, 200, { path: report.conversation })
      })

      return
    }

    if (!fromOwner(req, settings)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')

      return
    }

    if (req.method === 'GET' && req.url === APK_PATH) {
      serveDownload(res, extras.latestApk?.(), 'application/vnd.android.package-archive')

      return
    }

    // The PC program's installer, for setting ChoiTerm up on another computer on the tailnet.
    if (req.method === 'GET' && req.url === INSTALLER_PATH) {
      serveDownload(res, extras.latestInstaller?.(), 'application/vnd.microsoft.portable-executable')

      return
    }

    // Says "ChoiTerm runs here" to the owner's other PCs looking for it, and to the PC program.
    if (req.method === 'GET' && path === HELLO_PATH) {
      // How many sessions run here and how many are working, for the other PCs' lists.
      const running = sessions.list().filter((info) => !info.archived)
      const working = new Set(extras.meta?.latest().filter((item) => item.busy).map((item) => item.id) ?? [])

      sendJson(res, 200, {
        app: 'choiterm',
        version: extras.version ?? '',
        url: settings.hosts[0] === undefined ? '' : `https://${settings.hosts[0]}/`,
        sessions: running.length,
        busy: running.filter((info) => working.has(info.id)).length,
      })

      return
    }

    if (req.method === 'GET' && path === AGENTS_PATH) {
      void (extras.agents?.() ?? Promise.resolve([])).then((agents) => sendJson(res, 200, { agents }))

      return
    }

    // The file tree and file view: read only, for the owner.
    if (req.method === 'GET' && (path === FS_LIST_PATH || path === FS_READ_PATH || path === FS_RAW_PATH)) {
      const target = new URL(req.url ?? '/', 'http://local').searchParams.get('path') ?? ''

      if (!isAbsolute(target)) {
        sendJson(res, 400, { error: 'path must be absolute' })

        return
      }

      if (path === FS_LIST_PATH) {
        void listFolder(target).then((entries) => (entries === null ? sendJson(res, 404, { error: 'no such folder' }) : sendJson(res, 200, { entries })))
      } else if (path === FS_READ_PATH) {
        void readText(target).then(
          (file) => (file === null ? sendJson(res, 404, { error: 'no such file' }) : sendJson(res, 200, { file })),
          () => sendJson(res, 500, { error: 'could not read' }),
        )
      } else {
        serveRaw(res, target)
      }

      return
    }

    // A dev server's port, opened on the tailnet for the owner's other devices.
    if (req.method === 'POST' && path === PREVIEW_OPEN_PATH) {
      if (!sameOrigin(req) || extras.openPreview === undefined) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      const open = extras.openPreview

      void readBody(req, MAX_NOTIFY).then(async (body) => {
        const port = Number(body === null ? NaN : JSON.parse(body)?.port)
        const links = Number.isInteger(port) ? await open(port) : null

        if (links === null) sendJson(res, 409, { error: 'that port is not a running web server' })
        else sendJson(res, 200, { url: links.tailnet, local: links.local })
      }).catch(() => sendJson(res, 400, { error: 'bad request' }))

      return
    }

    if (req.method === 'GET' && path === '/projects' && extras.projects !== undefined) {
      void extras.projects.list(extras.seenProjects?.() ?? []).then((projects) => sendJson(res, 200, { projects }))

      return
    }

    if (req.method === 'GET' && path === '/github' && extras.github !== undefined) {
      void extras.github.state().then((state) => sendJson(res, 200, state))

      return
    }

    if (req.method === 'GET' && path === '/github/repos' && extras.github !== undefined) {
      const fresh = new URL(req.url ?? '/', 'http://local').searchParams.get('fresh') === '1'

      void extras.github.repos(fresh).then((repos) => sendJson(res, repos === null ? 409 : 200, { repos }))

      return
    }

    // Changes to projects and worktrees: from this app's page only.
    if (req.method === 'POST' && (path === '/projects' || path === '/projects/create' || path === '/pick-folder' || path === '/git/merge' || path === '/git/merge-into' || path === '/git/worktree-remove' || path === '/github/sign-in' || path === '/github/clone')) {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      void readBody(req, MAX_NOTIFY).then(async (body) => {
        let raw

        try {
          raw = body === null ? null : JSON.parse(body)
        } catch {
          raw = null
        }

        // The picker opens on this PC's screen, so only a page opened on this PC may ask for it.
        const onThisPc = /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')

        if (path === '/pick-folder' && onThisPc && extras.pickFolder !== undefined) {
          sendJson(res, 200, { picked: await extras.pickFolder(typeof raw?.start === 'string' && isAbsolute(raw.start) ? raw.start : '') })
        } else if (path === '/projects/create' && typeof raw?.name === 'string' && extras.createProject !== undefined) {
          const project = await extras.createProject(raw.name)

          sendJson(res, project === null ? 400 : 200, project === null ? { ok: false } : { ok: true, project })
        } else if (path === '/github/sign-in' && extras.github !== undefined) {
          sendJson(res, 200, { signIn: await extras.github.signIn() })
        } else if (path === '/github/clone' && typeof raw?.repo === 'string' && extras.github !== undefined && extras.projects !== undefined) {
          const cloned = await extras.github.clone(raw.repo)
          const project = cloned.ok ? await extras.projects.add(cloned.folder) : null

          sendJson(res, project === null ? 409 : 200, project === null ? { ok: false, error: cloned.ok ? '프로젝트로 넣지 못했어요' : cloned.error } : { ok: true, project })
        } else if (path === '/projects' && typeof raw?.path === 'string' && isAbsolute(raw.path) && extras.projects !== undefined) {
          const project = await extras.projects.add(raw.path)

          sendJson(res, project === null ? 404 : 200, project === null ? { ok: false } : { ok: true, project })
        } else if (path === '/git/merge' && typeof raw?.project === 'string' && isAbsolute(raw.project) && typeof raw.branch === 'string' && cleanBranch(raw.branch) === raw.branch && extras.mergeBranch !== undefined) {
          sendJson(res, 200, { ok: await extras.mergeBranch(raw.project, raw.branch, raw.squash === true) })
        } else if (path === '/git/merge-into' && typeof raw?.folder === 'string' && isAbsolute(raw.folder) && typeof raw.branch === 'string' && cleanBranch(raw.branch) === raw.branch && extras.mergeInto !== undefined) {
          sendJson(res, 200, { ok: await extras.mergeInto(raw.folder, raw.branch) })
        } else if (path === '/git/worktree-remove' && typeof raw?.project === 'string' && isAbsolute(raw.project) && typeof raw.path === 'string' && isAbsolute(raw.path) && extras.removeWorktree !== undefined) {
          sendJson(res, 200, { ok: await extras.removeWorktree(raw.project, raw.path) })
        } else {
          sendJson(res, 400, { error: 'bad request' })
        }
      })

      return
    }

    if (req.method === 'GET' && path === '/usage') {
      sendJson(res, 200, { codex: extras.codexUsage?.() ?? null })

      return
    }

    if (req.method === 'GET' && path === '/system') {
      sendJson(res, 200, extras.system?.() ?? { memTotal: 0, memFree: 0 })

      return
    }

    if (req.method === 'GET' && path === '/notes' && extras.notesFolder !== undefined) {
      const folder = extras.notesFolder

      mkdirSync(folder, { recursive: true })
      void listFolder(folder).then((entries) => sendJson(res, 200, { folder, entries: (entries ?? []).filter((entry) => !entry.dir && /\.md$/i.test(entry.name)) }))

      return
    }

    // Changes, search and GitHub tasks of a checkout (work.ts).
    if (req.method === 'GET' && (path === '/git/status' || path === '/git/diff' || path === '/search' || path === '/tasks' || path === '/files' || path === '/git/branches')) {
      const params = new URL(req.url ?? '/', 'http://local').searchParams
      const checkout = params.get('root') ?? ''

      if (!isAbsolute(checkout)) {
        sendJson(res, 400, { error: 'root must be absolute' })

        return
      }

      const failed = (): void => sendJson(res, 500, { error: 'failed' })

      if (path === '/git/branches') {
        const look = extras.branches

        if (look === undefined) failed()
        else void look(checkout).then((found) => (found === null ? failed() : sendJson(res, 200, found)))
      } else if (path === '/git/status') void gitStatus(checkout).then((changes) => (changes === null ? failed() : sendJson(res, 200, { changes })))
      else if (path === '/git/diff') void gitDiff(checkout, params.get('path') ?? '').then((diff) => (diff === null ? failed() : sendJson(res, 200, { diff })))
      else if (path === '/search') void searchFiles(checkout, params.get('q') ?? '').then((hits) => (hits === null ? failed() : sendJson(res, 200, { hits })))
      else if (path === '/files') void findFileNames(checkout, params.get('q') ?? '').then((files) => (files === null ? failed() : sendJson(res, 200, { files })))
      else void githubTasks(checkout).then((tasks) => (tasks === null ? failed() : sendJson(res, 200, { tasks })))

      return
    }

    // Saving a file from the editor; like uploads, only from this app's own page.
    if (req.method === 'POST' && path === FS_WRITE_PATH) {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      void readBody(req, MAX_WRITE).then(async (body) => {
        let raw

        try {
          raw = body === null ? null : JSON.parse(body)
        } catch {
          raw = null
        }

        if (typeof raw?.path !== 'string' || !isAbsolute(raw.path) || typeof raw.text !== 'string') {
          sendJson(res, 400, { error: 'bad request' })

          return
        }

        const saved = await writeText(raw.path, raw.text, Number.isFinite(raw.expected) ? raw.expected : null).catch(() => null)

        if (saved === null) sendJson(res, 404, { error: 'could not write there' })
        else sendJson(res, 'conflict' in saved ? 409 : 200, { saved })
      })

      return
    }

    if (req.method === 'GET' && path === MACHINES_PATH) {
      const machines = extras.machines

      if (machines === undefined) {
        sendJson(res, 200, { machines: [] })

        return
      }

      void machines.list().then(
        (list) => sendJson(res, 200, { machines: list }),
        () => sendJson(res, 200, { machines: [] }),
      )

      return
    }

    if (req.method === 'GET' && path === PREVIEW_PATH) {
      servePreview(req, res)

      return
    }

    if (req.method === 'GET' && path === EVENTS_PATH && notices !== undefined) {
      streamNotices(req, res, notices)

      return
    }

    if (req.method === 'POST' && path === ANSWER_PATH) {
      // Like uploads, only this app (its page, or the phone app sending the page's origin).
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      void readBody(req, MAX_NOTIFY).then((body) => {
        const choice = body === null ? null : parseAnswerChoice(body)
        const answer = choice === null ? null : answers.take(choice.notice, choice.index, Date.now())

        if (answer === null) {
          sendJson(res, 409, { error: 'that question is no longer open' })

          return
        }

        sessions.input(answer.session, answer.keys)

        // A number picks the option; Enter after it confirms where the picker waits for one, and is
        // an empty line (nothing) where the number already answered.
        if (/^[1-9]$/.test(answer.keys)) setTimeout(() => sessions.input(answer.session, '\r'), ANSWER_ENTER_DELAY_MS)

        log(`answered ${answer.label} in ${answer.session}`)
        sendJson(res, 200, { answered: answer.label })
      })

      return
    }

    if (req.method === 'POST' && path === UPLOAD_PATH) {
      // A web page elsewhere may post to 127.0.0.1 too, so uploads must come from this app's page.
      if (extras.uploadFolder === undefined || !sameOrigin(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      void receiveUpload(req, res, extras.uploadFolder, log, gallery)

      return
    }

    if (gallery !== undefined && req.method === 'GET' && path === GALLERY_PATH) {
      sendJson(res, 200, { items: gallery.list() })

      return
    }

    if (gallery !== undefined && req.method === 'POST' && path.startsWith(`${GALLERY_PATH}/`)) {
      // Changes delete files, so like uploads they must come from this app's page.
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        req.resume()

        return
      }

      void changeGallery(req, res, path.slice(GALLERY_PATH.length + 1), gallery)

      return
    }

    serveFile(req, res, files)
  })

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !fromOwner(req, settings) || !sameOrigin(req)) {
      log(`refused socket from host=${req.headers.host} origin=${req.headers.origin}`)
      socket.destroy()

      return
    }

    sockets.handleUpgrade(req, socket, head, (ws) => accept(ws))
  })

  const accept = (ws: WebSocket): void => {
    const viewer: Viewer = {
      send(message) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
      },
    }

    viewers.add(viewer)
    viewer.send({ t: 'list', sessions: sessions.list() })

    if (gallery !== undefined) viewer.send({ t: 'gallery', items: gallery.list() })

    for (const info of sessions.list()) {
      const status = statuses.get(info.id)

      if (status !== undefined) viewer.send({ t: 'status', id: info.id, status })
    }

    if (extras.meta !== undefined) viewer.send({ t: 'meta', meta: extras.meta.latest() })

    ws.on('message', (data, isBinary) => {
      if (isBinary) return

      const message = parseClientMessage(data.toString())

      if (message === null) return

      switch (message.t) {
        case 'attach':
          sessions.detach(viewer)

          if (!sessions.attach(message.id, viewer)) viewer.send({ t: 'exit', id: message.id })

          break
        case 'in':
          answers.forget(message.id)
          sessions.input(message.id, message.d)
          extras.typed?.(message.id, message.d)
          break
        case 'resize':
          sessions.resize(message.id, message.cols, message.rows)
          break
        case 'new': {
          const created = sessions.create(message.kind, message.cols, message.rows, undefined, message.cwd ?? undefined)

          sessions.detach(viewer)
          sessions.attach(created.id, viewer)
          break
        }
        case 'worktree': {
          const add = extras.addWorktree

          if (add === undefined) break

          // Fanned out, each agent gets its own branch: <branch>-<agent>.
          void (async () => {
            let first: string | null = null

            for (const kind of message.kinds) {
              const branch = message.kinds.length > 1 ? `${message.branch}-${kind}` : message.branch
              const folder = await add(message.project, branch, message.base)

              if (folder === null) {
                viewer.send({ t: 'error', text: `워크트리를 만들지 못했어요: ${branch}` })
                continue
              }

              const created = sessions.create(kind, message.cols, message.rows, undefined, folder, message.prompt ?? undefined)

              extras.worktreeCreated?.({ session: created.id, project: message.project, branch, base: message.base, kind, folder })

              first ??= created.id
            }

            if (first !== null) {
              sessions.detach(viewer)
              sessions.attach(first, viewer)
            }
          })()
          break
        }
        case 'close':
          sessions.close(message.id)
          extras.closed?.(message.id)
          break
        case 'rename':
          sessions.rename(message.id, message.name)
          break
        case 'archive':
          sessions.archive(message.id, message.archived)
          break
        case 'mute':
          sessions.mute(message.id, message.muted)
          break
      }
    })

    ws.on('close', () => {
      viewers.delete(viewer)
      sessions.detach(viewer)
    })
  }

  server.listen(settings.port, '127.0.0.1')

  return {
    server,
    announce(message) {
      for (const viewer of viewers) viewer.send(message)
    },
  }
}
