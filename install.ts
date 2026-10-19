// Sets ChoiTerm's server up on this PC, run by the PC program (with the Node it ships) each time it
// starts. The first time, and after each update, it copies the server and its Node into
// ~/.choiterm/app, writes ~/.choiterm/config.json from the tailnet, opens the tailnet port
// (`tailscale serve`), adds hook.ts to Claude Code's hooks (settings.json backed up first), installs
// the choiterm-status mod and restarts the server (always, so an update never leaves the old one
// running). Otherwise it only starts the server when it is down or answers as another version.
// A PC that already runs ChoiTerm from a clone (the scheduled task `ChoiTerm`) is left alone.
// Prints one JSON line saying what it did, for the program's log.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTailnet, readTailnet, tailscaleCli, TAILNET_PORT } from './machines.ts'
import { configFor, isObject, listenerPids, packageVersion, parseJsonObject, SERVER_PORT, withOurHooks, type JsonObject } from './setup.ts'

// A sandbox for trying this out (CHOITERM_INSTALL_HOME, CHOITERM_SETTINGS, CHOITERM_INSTALL_PORT)
// never touches tailscale serve, the mod, or a real server.
const sandbox = process.env.CHOITERM_INSTALL_HOME !== undefined
const HOME = process.env.CHOITERM_INSTALL_HOME ?? join(homedir(), '.choiterm')
const APP = join(HOME, 'app')
const SOURCE = dirname(fileURLToPath(import.meta.url))
const SETTINGS = process.env.CHOITERM_SETTINGS ?? join(homedir(), '.claude', 'settings.json')
const PORT = Number(process.env.CHOITERM_INSTALL_PORT ?? SERVER_PORT)
const MODS = join(homedir(), '.claude', 'local-mods')
const MOD = 'choiterm-status'
const START_WAIT_MS = 20_000
const SERVER_OUT = 'server-out.log'
const REPORT_LINES = 40
const REPORT_WAIT_MS = 5000

type Step = 'ok' | 'skipped' | string

const result: Record<string, Step> = {}

async function hello(): Promise<string | null> {
  try {
    const body = await (await fetch(`http://127.0.0.1:${PORT}/hello`, { signal: AbortSignal.timeout(1500) })).json()

    return body?.app === 'choiterm' && typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(300)) {
    if (await check()) return true
  }

  return false
}

// The PC's own ChoiTerm from a clone runs as this scheduled task.
function cloneRunsHere(): boolean {
  return spawnSync('schtasks', ['/query', '/tn', 'ChoiTerm'], { windowsHide: true }).status === 0
}

// Only a server that answers as ChoiTerm is stopped: whatever listens on its port, else the id it
// wrote at start (an older server may have left none, or a stale one). Its sessions' processes go
// with it (`/T`), so nothing keeps its folder from being moved; the sessions come back on start.
async function stopServer(): Promise<Step> {
  if ((await hello()) === null) return 'not running'

  const pidFile = join(HOME, `server-${PORT}.pid`)
  const netstat = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout ?? ''
  const listening = listenerPids(netstat, PORT)
  const saved = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0
  const pids = listening.length > 0 ? listening : [saved]

  for (const pid of pids) {
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  }

  return (await until(async () => (await hello()) === null, 10_000)) ? 'ok' : 'still answering'
}

// A running node.exe or loaded native module can't be overwritten on Windows, but can be moved;
// a process that is still ending may hold the folder for a moment.
async function setAside(path: string): Promise<void> {
  for (let tries = 0; existsSync(path); tries += 1) {
    try {
      renameSync(path, `${path}.old-${Date.now()}`)
    } catch (error) {
      if (tries >= 20) throw error

      await wait(500)
    }
  }
}

function removeSetAside(folder: string, name: string): void {
  for (const entry of existsSync(folder) ? readdirSync(folder) : []) {
    if (entry.startsWith(`${name}.old-`)) rmSync(join(folder, entry), { recursive: true, force: true })
  }
}

async function copyApp(): Promise<{ node: string; server: string }> {
  const nodeDir = join(APP, 'node')
  const node = join(nodeDir, 'node.exe')
  const server = join(APP, 'server')

  mkdirSync(nodeDir, { recursive: true })
  removeSetAside(nodeDir, 'node.exe')
  removeSetAside(APP, 'server')

  if (process.execPath !== node) {
    await setAside(node)
    copyFileSync(process.execPath, node)
  }

  await setAside(server)
  cpSync(SOURCE, server, { recursive: true })

  return { node, server }
}

async function writeConfig(): Promise<void> {
  const file = join(HOME, 'config.json')
  const before = existsSync(file) ? parseJsonObject(readFileSync(file, 'utf8')) : null
  const hosts = before?.hosts

  // Kept once it names this PC on the tailnet; written again while Tailscale was off at install.
  if (Array.isArray(hosts) && hosts.length > 0 && before?.port === PORT) {
    result.config = 'kept'

    return
  }

  const config = configFor(parseTailnet((await readTailnet()) ?? ''), PORT)

  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  result.config = config.hosts.length > 0 ? `ok ${config.hosts[0]}` : 'no tailnet: this PC only'
}

function serveOnTailnet(): Step {
  if (sandbox) return 'skipped'

  const cli = tailscaleCli()
  const status = spawnSync(cli, ['serve', 'status', '--json'], { encoding: 'utf8', windowsHide: true })

  if (status.status === 0 && status.stdout.includes(`:${TAILNET_PORT}"`)) return 'already'

  const serve = spawnSync(cli, ['serve', '--bg', `--https=${TAILNET_PORT}`, `http://127.0.0.1:${PORT}`], { encoding: 'utf8', windowsHide: true })

  return serve.status === 0 ? 'ok' : `failed: ${(serve.stderr || serve.stdout || String(serve.error)).trim().slice(0, 300)}`
}

function addHooks(node: string, server: string): Step {
  const text = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : '{}'
  const settings = parseJsonObject(text)

  if (settings === null) return 'settings.json is not JSON: left alone'

  const hooks = isObject(settings.hooks) ? settings.hooks : {}
  const next: JsonObject = { ...settings, hooks: withOurHooks(hooks, APP, node, join(server, 'hook.ts')) }
  const out = `${JSON.stringify(next, null, 2)}\n`

  if (out === text) return 'already'

  mkdirSync(dirname(SETTINGS), { recursive: true })

  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.choiterm-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)

  writeFileSync(SETTINGS, out)

  return 'ok'
}

// One `claude` command may wait on the network or a prompt; it never holds the rest up for long.
const CLAUDE_WAIT_MS = 60_000

function claude(args: string[]): boolean {
  return spawnSync('claude', args, { encoding: 'utf8', windowsHide: true, shell: true, timeout: CLAUDE_WAIT_MS }).status === 0
}

// The mod lives in a folder marketplace (`local-mods`), as ChoiBuddy's does.
function installMod(server: string): Step {
  if (sandbox) return 'skipped'

  if (!claude(['--version'])) return 'no claude command'

  const target = join(MODS, MOD)
  const manifestFile = join(MODS, '.claude-plugin', 'marketplace.json')
  const manifest = existsSync(manifestFile) ? parseJsonObject(readFileSync(manifestFile, 'utf8')) : null
  const plugins = (Array.isArray(manifest?.plugins) ? manifest.plugins : []).filter((plugin) => !isObject(plugin) || plugin.name !== MOD)

  rmSync(target, { recursive: true, force: true })
  cpSync(join(server, 'mod', MOD), target, { recursive: true })
  mkdirSync(dirname(manifestFile), { recursive: true })
  writeFileSync(
    manifestFile,
    `${JSON.stringify(
      {
        name: typeof manifest?.name === 'string' ? manifest.name : 'local-mods',
        owner: isObject(manifest?.owner) ? manifest.owner : { name: 'local' },
        plugins: [...plugins, { name: MOD, source: `./${MOD}`, description: 'ChoiTerm 상태 바로 사용량·컨텍스트·캐시·모델·effort 보고 (ChoiTerm 세션에서만)' }],
      },
      null,
      2,
    )}\n`,
  )

  if (!claude(['plugin', 'marketplace', 'update', 'local-mods'])) claude(['plugin', 'marketplace', 'add', `"${MODS}"`])

  if (!claude(['plugin', 'install', `${MOD}@local-mods`, '--scope', 'user'])) return 'install failed'

  claude(['plugin', 'update', `${MOD}@local-mods`])

  return 'ok'
}

// On its own, hidden, outliving this script and the program (CHOITERM_DETACHED tells main.ts not to
// follow its parent out). `conhost --headless`, as the scheduled task uses, needs a console here.
async function startServer(node: string, server: string): Promise<Step> {
  const env: Record<string, string> = {}

  // Started from inside a ChoiTerm session, these would point the server at that session's port.
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !['CHOITERM_PORT', 'CHOITERM_SESSION', 'CHOITERM_WEB'].includes(key.toUpperCase())) env[key] = value
  }

  env.CHOITERM_HOME = HOME
  env.CHOITERM_DETACHED = '1'

  // What the server prints before it can log (a crash at start) goes to a file for the report.
  const out = openSync(join(HOME, SERVER_OUT), 'a')
  const child = spawn(node, ['--no-warnings', join(server, 'main.ts')], {
    cwd: server,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env,
  })

  child.unref()
  closeSync(out)

  // Only the version just put in place counts: an old server still answering is not an update.
  const wanted = packageVersion(server)

  if (await until(async () => (await hello()) === wanted, START_WAIT_MS)) return 'ok'

  const answering = await hello()

  return answering === null ? 'did not answer' : `old server still answering (${answering})`
}

async function main(): Promise<void> {
  if (!sandbox && cloneRunsHere()) {
    result.skipped = 'this PC runs ChoiTerm from a clone'

    return
  }

  const bundled = packageVersion(SOURCE)
  const running = await hello()
  const installed = existsSync(join(HOME, 'config.json')) ? packageVersion(join(APP, 'server')) : null

  if (installed !== null && installed === bundled) {
    if (running === bundled) {
      result.server = 'running'

      return
    }

    result.stop = await stopServer()
    result.server = await startServer(join(APP, 'node', 'node.exe'), join(APP, 'server'))

    return
  }

  mkdirSync(HOME, { recursive: true })
  result.stop = await stopServer()

  const { node, server } = await copyApp()

  result.version = bundled ?? ''
  await writeConfig()
  result.serve = serveOnTailnet()
  result.hooks = addHooks(node, server)
  // The server first: the mod only adds the status bar, and its `claude` commands can be slow.
  result.server = await startServer(node, server)
  result.mod = installMod(server)
}

// The PC program names the main PC (CHOITERM_REPORT_TO); it gets how this run went and the end of
// this PC's server logs, so a server that will not stay up can be looked into from there.
function tail(name: string): string {
  try {
    return readFileSync(join(HOME, name), 'utf8').split(/\r?\n/).slice(-REPORT_LINES).join('\n')
  } catch {
    return ''
  }
}

async function sendReport(): Promise<void> {
  const target = process.env.CHOITERM_REPORT_TO

  if (target === undefined || result.skipped !== undefined) return

  const machine = hostname().toLowerCase().replace(/[^\w.-]/g, '-').slice(0, 64)
  const text = [JSON.stringify(result), '[choiterm.log]', tail('choiterm.log'), `[${SERVER_OUT}]`, tail(SERVER_OUT)].join('\n')

  try {
    await fetch(new URL('machine-report', target), { method: 'POST', body: JSON.stringify({ machine, text }), signal: AbortSignal.timeout(REPORT_WAIT_MS) })
  } catch {
    // Only a report.
  }
}

try {
  await main()
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
}

await sendReport()
console.log(JSON.stringify(result))
