import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { freemem, homedir, totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import nodePty from 'node-pty'
import { agentLabel, agentOf, createAgentCheck } from './agents.ts'
import { findRollouts, pickRollout } from './codex.ts'
import { createGallery } from './gallery.ts'
import { createMeta } from './meta.ts'
import { httpAddress, parseProcessTable, readProcessTable } from './ports.ts'
import { createPreviews, tailscaleServe, tailscaleUnserve } from './previews.ts'
import { startProxy } from './proxy.ts'
import { codexUsage } from './usage.ts'
import { createTurnWatch } from './turns.ts'
import { addWorktree, createProject, createRepoLookup, listBranches, listWorktrees, mergeBranch, removeWorktree } from './repo.ts'
import { pickFolder } from './folder-picker.ts'
import { autoCommit, commitsAhead, createdNote, createRelay, mergeInto, mergeToProject, turnNote } from './teamwork.ts'
import { createDrafts, retype } from './drafts.ts'
import { createProjects } from './projects.ts'
import { createMachines, parseTailnet, probeMachine, readTailnet } from './machines.ts'
import { configFor, packageVersion, SERVER_PORT } from './setup.ts'
import { createNotices } from './notices.ts'
import { createSessions, type Resume, type SessionKind } from './sessions.ts'
import { launchFolder, loadSessions, saveSessions } from './store.ts'
import { CLAUDE_CONFIG, trustFolders, trustRoot } from './trust.ts'
import { loadStaticFiles, parseSettings, startServer, type Download } from './server.ts'
import type { ServerMessage } from './sessions.ts'

const here = dirname(fileURLToPath(import.meta.url))
const modules = join(here, 'node_modules')
// Where config.json, data/ and the log live: beside the code in a clone, and in ~/.choiterm when the
// PC program installed the server (install.ts), so updating the code never touches them.
const home = process.env.CHOITERM_HOME ?? here

mkdirSync(home, { recursive: true })

function log(line: string): void {
  try {
    appendFileSync(join(home, 'choiterm.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging must never take the server down.
  }
}

// Claude Code's `auto` theme reads COLORFGBG to tell a light background from a dark one, so a new
// session follows the Windows app theme at the moment it starts.
function windowsIsLight(): boolean {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'],
      { encoding: 'utf8', windowsHide: true },
    )

    return /AppsUseLightTheme\s+REG_DWORD\s+0x1/.test(out)
  } catch {
    return false
  }
}

// The shell's prompt also reports its folder (OSC 7) before drawing as usual, so a restart opens
// the session where it was. Passed encoded, so no quoting can break it.
const REPORT_FOLDER = [
  '$global:__choitermPrompt = $function:prompt',
  'function global:prompt {',
  '  $here = $executionContext.SessionState.Path.CurrentLocation',
  "  if ($here.Provider.Name -eq 'FileSystem') {",
  "    [Console]::Write(\"$([char]27)]7;file:///$($here.ProviderPath -replace '\\\\', '/')$([char]7)\")",
  '  }',
  '  & $global:__choitermPrompt',
  '}',
  // `claude` typed here first trusts the folder (its repository root), so the trust question never
  // stops it; then runs the real one.
  'function global:claude {',
  '  if ($env:CHOITERM_TRUST) { & $env:CHOITERM_NODE --no-warnings $env:CHOITERM_TRUST $executionContext.SessionState.Path.CurrentLocation.ProviderPath 2>$null }',
  '  & (Get-Command claude -CommandType Application | Select-Object -First 1).Source @args',
  '}',
].join('\n')

// Every session is a PowerShell with the folder-reporting prompt; an agent's tab then runs the
// agent in it, so quitting the agent leaves a shell in the same folder.
function shellArgs(line: string | null): string[] {
  const script = line === null ? REPORT_FOLDER : `${REPORT_FOLDER}\n${line}`

  return ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

// Agents that start on a prompt given after their name; others get it typed in once they are up.
const PROMPT_ON_COMMAND_LINE = new Set(['claude', 'codex'])
const TYPE_PROMPT_AFTER_MS = 5000

// Codex conversations already resumed by a tab, so two tabs in one folder do not share one.
const codexTaken = new Set<string>()
const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions')

// The command a tab starts with: the agent, resuming its conversation when one is known.
function startLine(kind: SessionKind, claudeConversation: string | null, resume: Resume | null, cwd: string): string | null {
  if (claudeConversation !== null) return `claude --resume ${claudeConversation}`

  const agent = agentOf(kind)

  if (agent === undefined || agent.command === null) return null

  // A task's prompt goes on the command line for agents that take one there, quoted for PowerShell.
  if (resume?.prompt !== undefined && PROMPT_ON_COMMAND_LINE.has(kind)) return `${agent.command} '${resume.prompt.replaceAll("'", "''")}'`

  if (kind === 'codex' && resume !== null && resume.createdAt !== undefined) {
    const id = pickRollout(findRollouts(CODEX_SESSIONS, resume.createdAt, Date.now()), cwd, codexTaken)

    if (id !== null && /^[0-9a-f-]{36}$/i.test(id)) {
      codexTaken.add(id)

      return `codex resume ${id}`
    }
  }

  return agent.command
}

// Markers a running Claude Code leaves in its children. Started from inside one (by hand while
// developing), they would make every new session think it is a subprocess and skip transcripts.
const INHERITED = new Set([
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
])

function sessionEnv(id: string): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !INHERITED.has(key.toUpperCase())) env[key] = value
  }

  // Without TERM (a logon task has none) Claude Code assumes a console without Unicode and draws
  // `>`, `-` and `X` instead of its symbols.
  // Read by hook.ts to tell ChoiTerm which session finished or asked something.
  env.CHOITERM_SESSION = id
  env.CHOITERM_PORT = String(settings.port)
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.COLORFGBG = windowsIsLight() ? '0;15' : '15;0'
  // Claude Code's classic renderer writes the conversation into the terminal's own history, so a
  // phone scrolls it locally (smooth, no round trip) and search and copy reach all of it. In full
  // screen every swipe was a wheel event to the PC, which Claude accelerates when they come fast.
  env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
  // Used by the shell's `claude` wrapper to trust the folder before Claude starts.
  env.CHOITERM_TRUST = join(here, 'trust.ts')
  // The Node running this server, for that wrapper: a PC set up by the PC program has no other.
  env.CHOITERM_NODE = process.execPath

  return env
}

// A Claude Code session brought back after a restart resumes its conversation in its own folder
// (conversations are kept per folder); the id was checked to be a UUID when it was loaded.
// A session that was opened but never used has no transcript, and resuming it would only fail; one
// that has one resumes in the folder it started in (launchFolder says why).
function spawnPty(kind: SessionKind, cols: number, rows: number, id: string, resume: Resume | null): nodePty.IPty {
  const conversation = kind === 'claude' && resume?.conversation ? resume.conversation : null
  const started = conversation === null ? null : launchFolder(join(homedir(), '.claude', 'projects'), conversation)
  const wanted = started || resume?.cwd
  const cwd = wanted !== null && wanted !== undefined && existsSync(wanted) ? wanted : homedir()
  const args = shellArgs(startLine(kind, started !== null ? conversation : null, resume, cwd))

  // The owner trusts every folder: a Claude session opening somewhere new must not stop at the
  // trust question (a repository needs its own root marked).
  if (kind === 'claude') {
    try {
      trustFolders(CLAUDE_CONFIG, [trustRoot(cwd)])
    } catch (error) {
      log(`trusting ${cwd} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const pty = nodePty.spawn('powershell.exe', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: sessionEnv(id),
  })
  const prompt = resume?.prompt

  if (prompt !== undefined && !PROMPT_ON_COMMAND_LINE.has(kind) && agentOf(kind)?.command) {
    setTimeout(() => {
      try {
        pty.write(`\x1b[200~${prompt}\x1b[201~\r`)
      } catch {
        // Gone already.
      }
    }, TYPE_PROMPT_AFTER_MS)
  }

  return pty
}

// The first start writes config.json from Tailscale: this PC's tailnet name and its owner, who alone
// may open the page over the tailnet. Edit it to change either.
const configFile = join(home, 'config.json')

if (!existsSync(configFile)) {
  const made = configFor(parseTailnet((await readTailnet()) ?? ''), SERVER_PORT)

  writeFileSync(configFile, `${JSON.stringify(made, null, 2)}\n`)
  console.log(made.hosts.length > 0 ? `wrote ${configFile} for ${made.hosts[0]}` : `wrote ${configFile}; Tailscale did not answer, so only this PC can open the page`)
}

const configured = parseSettings(readFileSync(configFile, 'utf8'))
const version = packageVersion(here) ?? ''

// A second copy for trying changes runs beside the real one without touching its sessions.
const settings = process.env.CHOITERM_PORT === undefined ? configured : { ...configured, port: Number(process.env.CHOITERM_PORT) }

// A test copy may serve a page still being worked on (CHOITERM_WEB=web-next) while the real one
// keeps serving web/, which phones reload on their own.
const web = join(here, process.env.CHOITERM_WEB ?? 'web')
const files = loadStaticFiles({
  '/index.html': join(web, 'index.html'),
  '/app.js': join(web, 'app.js'),
  '/icons.js': join(web, 'icons.js'),
  '/docs.js': join(web, 'docs.js'),
  '/mini-term.js': join(web, 'mini-term.js'),
  '/style.css': join(web, 'style.css'),
  '/manifest.webmanifest': join(web, 'manifest.webmanifest'),
  '/icon.svg': join(web, 'icon.svg'),
  '/fonts/MonoplexKR-Medium.ttf': join(web, 'fonts', 'MonoplexKR-Medium.ttf'),
  '/fonts/MonoplexKR-Bold.ttf': join(web, 'fonts', 'MonoplexKR-Bold.ttf'),
  '/fonts/Geist-Variable.woff2': join(modules, '@fontsource-variable', 'geist', 'files', 'geist-latin-wght-normal.woff2'),
  '/fonts/symbols.woff2': join(modules, '@fontsource', 'noto-sans-symbols-2', 'files', 'noto-sans-symbols-2-symbols-400-normal.woff2'),
  '/vendor/xterm.mjs': join(modules, '@xterm', 'xterm', 'lib', 'xterm.mjs'),
  '/vendor/xterm.css': join(modules, '@xterm', 'xterm', 'css', 'xterm.css'),
  '/vendor/addon-fit.mjs': join(modules, '@xterm', 'addon-fit', 'lib', 'addon-fit.mjs'),
  '/vendor/addon-unicode11.mjs': join(modules, '@xterm', 'addon-unicode11', 'lib', 'addon-unicode11.mjs'),
  '/vendor/addon-search.mjs': join(modules, '@xterm', 'addon-search', 'lib', 'addon-search.mjs'),
  '/vendor/marked.mjs': join(modules, 'marked', 'lib', 'marked.esm.js'),
  '/vendor/highlight.mjs': join(modules, '@highlightjs', 'cdn-assets', 'es', 'highlight.min.js'),
})

// Read on each request, so a newly built APK or installer is served without a restart.
function newest(folder: string, pattern: RegExp): Download | undefined {
  try {
    const names: string[] = []

    for (const name of readdirSync(folder)) {
      if (pattern.test(name)) names.push(name)
    }

    names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))

    const name = names.at(-1)

    return name === undefined ? undefined : { name, body: readFileSync(join(folder, name)) }
  } catch {
    return undefined
  }
}

const latestApk = (): Download | undefined => newest(join(here, 'android', 'dist'), /^ChoiTerm-[\d.]+\.apk$/)
const latestInstaller = (): Download | undefined => newest(join(here, 'desktop', 'dist'), /^ChoiTerm_[\d.]+_x64-setup\.exe$/)

let announce: (message: ServerMessage) => void = () => {}

// A second copy keeps its own lists, so trying changes never touches the real sessions or gallery.
const MACHINE_REPORT_KEEP = 100_000
const dataFile = (name: string): string => join(home, 'data', process.env.CHOITERM_PORT === undefined ? `${name}.json` : `${name}-${settings.port}.json`)
const sessionsFile = dataFile('sessions')
const galleryFile = dataFile('gallery')
const EXIT_SAVE_DELAY_MS = 5000
let stopping = false
let exitSave: NodeJS.Timeout | undefined

function persist(): void {
  if (stopping) return

  try {
    saveSessions(sessionsFile, sessions.list())
  } catch (error) {
    log(`saving sessions failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// An exit is saved a moment later: when Windows shuts down, the sessions' processes may end
// before this one, and the list must still hold them for the next start.
const sessions = createSessions(
  spawnPty,
  (list, why) => {
    announce({ t: 'list', sessions: list })
    void meta.refresh(false)

    if (why === 'change') {
      persist()

      return
    }

    clearTimeout(exitSave)
    exitSave = setTimeout(persist, EXIT_SAVE_DELAY_MS)
  },
  agentLabel,
)
const uploadFolder = join(homedir(), 'Downloads', 'ChoiTerm')
const tailnetHost = settings.hosts[0]?.split(':')[0] ?? ''
// The script a preview's pages get, read on each request like the page itself.
const annotateScript = (): string => {
  try {
    return readFileSync(join(web, 'annotate.js'), 'utf8')
  } catch {
    return ''
  }
}
// html2canvas for the preview's element pictures, read once.
let shotSource: string | null = null
const shotLibrary = (): string => {
  try {
    shotSource ??= readFileSync(join(modules, 'html2canvas', 'dist', 'html2canvas.min.js'), 'utf8')
  } catch {
    shotSource = ''
  }

  return shotSource
}
const previews = createPreviews({
  file: dataFile('previews'),
  host: tailnetHost,
  proxy: (target) => startProxy(target, annotateScript, shotLibrary),
  serve: tailscaleServe,
  unserve: tailscaleUnserve,
  now: Date.now,
})
const repoLookup = createRepoLookup()
const projects = createProjects({ file: dataFile('projects'), repo: repoLookup, worktrees: (project) => listWorktrees(project) })
const meta = createMeta({
  sessions,
  repo: repoLookup,
  table: async () => {
    const text = await readProcessTable()

    return text === null ? null : parseProcessTable(text)
  },
  http: httpAddress,
  previews,
  skip: new Set([settings.port]),
  now: Date.now,
})
const notices = createNotices()
// What each session has typed and not sent, for after a restart (drafts.ts).
const drafts = createDrafts(dataFile('drafts'))
const running = startServer(settings, sessions, files, log, {
  latestApk,
  latestInstaller,
  uploadFolder,
  notices,
  gallery: createGallery(galleryFile, uploadFolder, log),
  machines: createMachines({ file: dataFile('machines'), read: readTailnet, probe: probeMachine, now: Date.now }),
  version,
  agents: createAgentCheck(),
  meta,
  openPreview: async (port) => {
    const target = meta.target(port)
    const links = target === null ? null : await previews.open(port, target)

    if (links !== null) {
      log(`preview of port ${port} at ${links.local} and ${links.tailnet ?? 'no tailnet'}`)
      void meta.refresh(false)
    }

    return links
  },
  codexUsage: () => codexUsage(CODEX_SESSIONS, Date.now()),
  system: () => ({ memTotal: totalmem(), memFree: freemem() }),
  notesFolder: join(home, 'notes'),
  // Kept short: only the latest reports of each PC matter.
  machineReport: (machine, text) => {
    const folder = join(home, 'data', 'reports')
    const file = join(folder, `${machine}.log`)
    const before = existsSync(file) ? readFileSync(file, 'utf8').slice(-MACHINE_REPORT_KEEP) : ''

    mkdirSync(folder, { recursive: true })
    writeFileSync(file, `${before}--- ${new Date().toISOString()}\n${text}\n`)
    log(`report from ${machine}: ${text.split('\n')[0].slice(0, 200)}`)
  },
  projects,
  seenProjects: () => {
    const seen: string[] = []

    for (const item of meta.latest()) {
      if (item.repo !== null) seen.push(item.repo.project)
    }

    return seen
  },
  mergeBranch: async (project, branch, squash) => {
    const merged = await mergeToProject(project, branch, squash)

    log(`merge ${branch} into ${project}${squash ? ' (squash)' : ''}: ${merged ? 'done' : 'refused'}`)

    return merged
  },
  mergeInto: async (folder, branch) => {
    const merged = await mergeInto(folder, branch)

    log(`merge ${branch} into ${folder}: ${merged ? 'done' : 'refused'}`)

    return merged
  },
  worktreeCreated: (info) => {
    const main = mainAgentOf(info.project, info.session)
    const text = createdNote({ branch: info.branch, base: info.base, agent: agentLabel(info.kind), folder: info.folder })

    if (main !== null) relay.post(main, text)

    notices.add({ session: info.session, kind: 'attention', text: `새 워크트리 ${info.branch}를 만들었어요` }, basename(info.project))
  },
  branches: (project) => listBranches(project),
  typed: (id, data) => drafts.feed(id, data),
  closed: (id) => drafts.forget(id),
  createProject: async (name) => {
    const folder = await createProject(homedir(), name)

    log(folder === null ? `project ${name} refused` : `project created at ${folder}`)

    return folder === null ? null : projects.add(folder)
  },
  pickFolder: (start) => pickFolder(start || homedir(), 'ChoiTerm 폴더 선택'),
  removeWorktree: async (project, path) => {
    const removed = await removeWorktree(project, path)

    log(`remove worktree ${path}: ${removed ? 'done' : 'refused'}`)

    return removed
  },
  addWorktree: async (project, branch, base) => {
    const folder = await addWorktree(project, branch, base)

    log(folder === null ? `worktree ${branch} in ${project} failed` : `worktree ${branch} from ${base ?? 'HEAD'} at ${folder}`)

    return folder
  },
})

announce = running.announce

// Busy marks and last lines every couple of seconds; web servers less often, since finding them
// asks Windows for every process.
const META_MS = 2000
const PORTS_EVERY = 3
let metaTick = 0

// Agents with no hooks for ChoiTerm (all but Claude Code; a plain shell has no turns) get their
// "finished" notification from their output: a long run of it, then quiet.
const turns = createTurnWatch()
const NO_HOOKS = new Set(['claude', 'shell'])

// ---- Worktrees working together (teamwork.ts). The project's own agent: one working in the
// project's main checkout (an agent before a plain shell, the latest first).
const relay = createRelay({
  busy: (id) => meta.latest().some((item) => item.id === id && item.busy),
  alive: (id) => sessions.list().some((info) => info.id === id && !info.archived),
  deliver: (id, text) => {
    sessions.input(id, `\x1b[200~${text}\x1b[201~`)
    drafts.feed(id, `\x1b[200~${text}\x1b[201~`)
    log(`note delivered to ${id}`)
  },
})

function mainAgentOf(project: string, besides: string): string | null {
  const infos = new Map(sessions.list().map((info) => [info.id, info]))
  let best: { id: string; agent: boolean; at: number } | null = null

  for (const item of meta.latest()) {
    const info = infos.get(item.id)

    if (info === undefined || info.archived || item.id === besides || item.repo === null || item.repo.worktree || item.repo.project.toLowerCase() !== project.toLowerCase()) continue

    const candidate = { id: item.id, agent: info.kind !== 'shell', at: info.createdAt }

    if (best === null || Number(candidate.agent) > Number(best.agent) || (candidate.agent === best.agent && candidate.at > best.at)) best = candidate
  }

  return best?.id ?? null
}

// A worktree's agent finished a turn: its changes are committed, and the project's agent hears of it.
async function afterTurn(id: string): Promise<void> {
  const repo = meta.latest().find((item) => item.id === id)?.repo

  if (!repo?.worktree) return

  const saved = await autoCommit(repo.root, Date.now())
  const base = (await listWorktrees(repo.project))?.find((tree) => tree.primary)?.branch ?? 'main'
  const ahead = await commitsAhead(repo.root, base)
  const kind = sessions.list().find((info) => info.id === id)?.kind ?? 'shell'

  log(`turn end in ${repo.root}: ${saved === null ? 'nothing to commit' : `committed ${saved.files} files`}`)

  const main = mainAgentOf(repo.project, id)

  if (main !== null) relay.post(main, turnNote({ name: basename(repo.root), branch: repo.branch, agent: agentLabel(kind), folder: repo.root, saved, ahead, base }))
}

notices.subscribe((notice) => {
  if (notice.kind === 'done') void afterTurn(notice.session)
})

function watchTurns(now: number): void {
  const infos = new Map(sessions.list().map((info) => [info.id, info]))

  for (const { id, busy } of sessions.activity(now)) {
    const info = infos.get(id)

    if (info === undefined || NO_HOOKS.has(info.kind)) continue

    if (!turns.see(id, busy, now) || info.muted) continue

    const title = info.name ?? (info.title.replace(/^[^\p{L}\p{N}]+/u, '') || info.title)

    notices.add({ session: id, kind: 'done', text: `${agentLabel(info.kind)} 작업이 끝났어요` }, title)
  }
}

setInterval(() => {
  metaTick += 1
  void meta.refresh(metaTick % PORTS_EVERY === 0)
  watchTurns(Date.now())
  relay.tick()
}, META_MS)

// Sessions come back only once the port is ours, so a second start that fails to listen never
// spawns copies of them.
// install.ts stops an installed server by this id before replacing its code.
const pidFile = join(home, `server-${settings.port}.pid`)

running.server.on('listening', () => {
  log(`listening on 127.0.0.1:${settings.port} (version ${version})`)

  try {
    writeFileSync(pidFile, String(process.pid))
  } catch {
    // Only updates need it.
  }

  const saved = loadSessions(sessionsFile)

  for (const session of saved) sessions.create(session.kind, 120, 40, session)

  if (saved.length > 0) log(`restored ${saved.length} sessions`)

  for (const session of saved) {
    if (drafts.get(session.id) !== '') retypeWhenReady(session.id)
  }
})

running.server.on('error', (error) => {
  log(`server error: ${error.message}`)
  process.exit(1)
})

// The scheduled task runs us under `conhost --headless`. Stopping the task ends conhost but not
// this process, so follow the parent out and take the sessions with us. A server install.ts started
// (CHOITERM_DETACHED) runs on its own after the script that started it has ended.
const parent = process.ppid

// A restored agent prints its past conversation, then waits: once its output has gone quiet, the
// text typed before the restart goes back into its input (not sent).
const RETYPE_CHECK_MS = 500
const RETYPE_GIVE_UP_MS = 90_000

function retypeWhenReady(id: string): void {
  const started = Date.now()
  let spoke = false
  const timer = setInterval(() => {
    const state = sessions.activity(Date.now()).find((item) => item.id === id)

    if (state === undefined || Date.now() - started > RETYPE_GIVE_UP_MS) {
      clearInterval(timer)

      return
    }

    if (state.busy) {
      spoke = true

      return
    }

    if (!spoke) return

    clearInterval(timer)

    const text = drafts.get(id)

    if (text === '') return

    sessions.input(id, retype(text))
    log(`typed back ${[...text].length} characters into ${id}`)
  }, RETYPE_CHECK_MS)
}

function stopWithParent(): void {
  try {
    process.kill(parent, 0)
  } catch {
    log('parent process ended, exiting')
    drafts.flush()
    rmSync(pidFile, { force: true })
    stopping = true
    sessions.closeAll()
    process.exit(0)
  }
}

if (process.env.CHOITERM_DETACHED === undefined) setInterval(stopWithParent, 3000)
