// Web servers a session started (`pnpm dev`, `npm start` …): ports listened on by the session's own
// processes, found from Windows' list of listening ports and its process tree. Each one gets a
// preview button, and opened from another device it is served on the tailnet (see previews.ts).
import { execFile } from 'node:child_process'

export interface Listener {
  port: number
  pid: number
}

export interface ProcessRow {
  pid: number
  ppid: number
  name: string
}

export interface ProcessTable {
  listen: Listener[]
  procs: ProcessRow[]
}

const READ_TIMEOUT_MS = 8000
// Agents themselves listen on ports (IDE bridges, auth callbacks); those are not previews.
const NOT_PREVIEWS = /^(claude|codex|cursor-agent|gemini|grok|opencode|copilot|qwen|choiterm|tailscaled?)(\.exe)?$/i
const MIN_PORT = 1024

const SCRIPT = [
  '$l = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { @{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })',
  '$p = @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name } })',
  '@{ listen = $l; procs = $p } | ConvertTo-Json -Compress -Depth 3',
].join('; ')

export function readProcessTable(): Promise<string | null> {
  return new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      done(error === null ? stdout : null),
    )
  })
}

const whole = (value: number): boolean => Number.isInteger(value) && value > 0

export function parseProcessTable(text: string): ProcessTable | null {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  const listen: Listener[] = []
  const procs: ProcessRow[] = []

  for (const entry of Array.isArray(raw?.listen) ? raw.listen : []) {
    if (whole(entry?.port) && whole(entry.pid)) listen.push({ port: entry.port, pid: entry.pid })
  }

  for (const entry of Array.isArray(raw?.procs) ? raw.procs : []) {
    if (whole(entry?.pid) && Number.isInteger(entry.ppid)) procs.push({ pid: entry.pid, ppid: entry.ppid, name: typeof entry.name === 'string' ? entry.name : '' })
  }

  return { listen, procs }
}

// The ports each session's processes listen on, lowest first. `roots` maps a session to the pid of
// its PowerShell; a process belongs to the session when that shell is among its ancestors.
export function portsBySession(table: ProcessTable, roots: Map<string, number>, skip: Set<number>): Map<string, number[]> {
  const children = new Map<number, number[]>()
  const names = new Map<number, string>()

  for (const row of table.procs) {
    names.set(row.pid, row.name)

    // Windows reuses ids, so a process "parented" by itself must not loop.
    if (row.ppid === row.pid) continue

    const list = children.get(row.ppid) ?? []

    list.push(row.pid)
    children.set(row.ppid, list)
  }

  const found = new Map<string, number[]>()

  for (const [id, root] of roots) {
    const family = new Set<number>([root])
    const queue = [root]

    for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
      for (const child of children.get(pid) ?? []) {
        if (!family.has(child)) {
          family.add(child)
          queue.push(child)
        }
      }
    }

    const ports = new Set<number>()

    for (const { port, pid } of table.listen) {
      if (family.has(pid) && port >= MIN_PORT && !skip.has(port) && !NOT_PREVIEWS.test(names.get(pid) ?? '')) ports.add(port)
    }

    if (ports.size > 0) found.set(id, [...ports].sort((a, b) => a - b))
  }

  return found
}

// Only ports that answer HTTP are worth a preview button (debuggers and databases listen too). Gives
// the address that answered: dev servers bound to `localhost` are often on IPv6 only.
export async function httpAddress(port: number): Promise<string | null> {
  for (const host of ['127.0.0.1', '[::1]']) {
    try {
      await fetch(`http://${host}:${port}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(1500) })

      return `http://${host}:${port}`
    } catch {
      // Not on this address.
    }
  }

  return null
}
