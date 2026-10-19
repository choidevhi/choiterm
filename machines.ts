// The owner's PCs that run ChoiTerm, for switching between them: tailnet devices on the owner's own
// account (not tagged, not shared in, not a phone) that answer /hello on the ChoiTerm port. A PC seen
// once stays listed while it is off, greyed out, so it does not vanish from the list.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Every PC serves ChoiTerm on the same tailnet port (`tailscale serve --https=8449`).
export const TAILNET_PORT = 8449

export interface Peer {
  name: string
  dns: string
  online: boolean
}

export interface Tailnet {
  owner: string | null
  self: Peer | null
  peers: Peer[]
}

export interface Machine {
  name: string
  url: string
  online: boolean
  here: boolean
  // What it said about itself when asked; null when it did not answer (or is this PC).
  sessions: number | null
  busy: number | null
}

// A PC's answer to /hello: its sessions and how many are working (older servers say neither).
export interface MachineState {
  sessions: number | null
  busy: number | null
}

export interface Machines {
  list(): Promise<Machine[]>
}

const PHONES = new Set(['android', 'ios'])
const CACHE_MS = 20_000
const STATUS_TIMEOUT_MS = 4000
const MAX_KNOWN = 50

// The name the owner gave the device in Tailscale (the first part of its DNS name).
function peerOf(raw: { DNSName?: string; HostName?: string; Online?: boolean }, online: boolean): Peer | null {
  const dns = typeof raw.DNSName === 'string' ? raw.DNSName.replace(/\.$/, '') : ''

  if (dns === '') return null

  return { name: dns.split('.')[0] ?? dns, dns, online }
}

export function parseTailnet(text: string): Tailnet | null {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (raw === null || typeof raw !== 'object' || typeof raw.Self !== 'object' || raw.Self === null) return null

  const userId = raw.Self.UserID
  const user = raw.User?.[String(userId)]
  const peers: Peer[] = []

  for (const entry of Object.values(typeof raw.Peer === 'object' && raw.Peer !== null ? raw.Peer : {})) {
    // SAFETY: tailscale status --json gives each peer as an object; every field read is checked.
    const peer = entry as { DNSName?: string; HostName?: string; Online?: boolean; OS?: string; UserID?: number; Tags?: string[]; ShareeNode?: boolean }
    const mine = peer.UserID === userId && !Array.isArray(peer.Tags) && peer.ShareeNode !== true
    const parsed = peerOf(peer, peer.Online === true)

    if (mine && parsed !== null && !PHONES.has(String(peer.OS).toLowerCase())) peers.push(parsed)
  }

  return { owner: typeof user?.LoginName === 'string' ? user.LoginName : null, self: peerOf(raw.Self, true), peers }
}

export const machineUrl = (dns: string): string => `https://${dns}:${TAILNET_PORT}/`

// Tailscale installs its command line beside the app, which is not always on the PATH.
export function tailscaleCli(): string {
  const installed = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')

  return existsSync(installed) ? installed : 'tailscale'
}

export function readTailnet(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(tailscaleCli(), ['status', '--json'], { timeout: STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? stdout : null)
    })
  })
}

// Does ChoiTerm answer there? Through `tailscale serve` the request carries this PC's owner, the
// same account, so the other PC lets it in.
export async function probeMachine(url: string): Promise<MachineState | null> {
  try {
    const response = await fetch(`${url}hello`, { signal: AbortSignal.timeout(2500) })

    return parseHello(await response.text())
  } catch {
    return null
  }
}

// A ChoiTerm /hello reply, or null for anything else (a proxy's error page, another app).
export function parseHello(text: string): MachineState | null {
  try {
    const body = JSON.parse(text)

    if (body?.app !== 'choiterm') return null

    const count = (value: number | undefined): number | null => (Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null)

    return { sessions: count(body.sessions), busy: count(body.busy) }
  } catch {
    return null
  }
}

function loadKnown(file: string): Map<string, string> {
  const known = new Map<string, string>()

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))

    for (const entry of Array.isArray(raw?.machines) ? raw.machines : []) {
      if (typeof entry?.url === 'string' && typeof entry.name === 'string') known.set(entry.url, entry.name)
    }
  } catch {
    // No list yet.
  }

  return known
}

function saveKnown(file: string, known: Map<string, string>): void {
  const machines: { name: string; url: string }[] = []

  for (const [url, name] of known) machines.push({ name, url })

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify({ machines: machines.slice(-MAX_KNOWN) }, null, 2))
  renameSync(`${file}.tmp`, file)
}

export interface MachineSources {
  file: string
  read: () => Promise<string | null>
  probe: (url: string) => Promise<MachineState | null>
  now: () => number
}

export function createMachines(sources: MachineSources): Machines {
  const known = loadKnown(sources.file)
  let cached: { at: number; machines: Promise<Machine[]> } | null = null

  async function look(): Promise<Machine[]> {
    const tailnet = parseTailnet((await sources.read()) ?? '')
    const self = tailnet?.self ?? null
    const online = new Map<string, Peer>()

    for (const peer of tailnet?.peers ?? []) {
      if (peer.online) online.set(machineUrl(peer.dns), peer)
    }

    const answers = await Promise.all([...online.keys()].map(async (url) => [url, await sources.probe(url)] as const))
    const before = known.size
    const up = new Map<string, MachineState>()
    let renamed = false

    for (const [url, answered] of answers) {
      const name = online.get(url)?.name ?? url

      if (answered === null) continue

      up.set(url, answered)
      renamed ||= known.has(url) && known.get(url) !== name
      known.set(url, name)
    }

    if (known.size !== before || renamed) {
      try {
        saveKnown(sources.file, known)
      } catch {
        // The list still works for this run.
      }
    }

    const machines: Machine[] = []

    if (self !== null) machines.push({ name: self.name, url: machineUrl(self.dns), online: true, here: true, sessions: null, busy: null })

    for (const [url, name] of known) {
      const state = up.get(url)

      if (self === null || url !== machineUrl(self.dns)) machines.push({ name, url, online: state !== undefined, here: false, sessions: state?.sessions ?? null, busy: state?.busy ?? null })
    }

    return machines
  }

  return {
    list() {
      if (cached === null || sources.now() - cached.at > CACHE_MS) cached = { at: sources.now(), machines: look() }

      return cached.machines
    },
  }
}
