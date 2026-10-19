// Dev servers made viewable from anywhere the owner is: each previewed local port gets ChoiTerm's
// proxy in front (proxy.ts: hot reload passes, pages can be annotated) and one of a few tailnet
// ports (`tailscale serve --https=<port>`), tailnet only like ChoiTerm itself. A preview whose
// server has been gone a while is taken down again.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tailscaleCli } from './machines.ts'
import type { Proxy } from './proxy.ts'

export const PREVIEW_PORTS: number[] = Array.from({ length: 20 }, (_, index) => 8460 + index)

const GONE_FOR_MS = 120_000
const SERVE_TIMEOUT_MS = 15_000

interface Mapping {
  // The tailnet port, and the dev server's own address.
  serve: number
  target: string
  seen: number
}

export interface PreviewLinks {
  // This PC (through the proxy) and the tailnet (null without a tailnet name).
  local: string
  tailnet: string | null
}

export interface Previews {
  // Sets the preview of local `port` (answering at `target`) up on first use.
  open(port: number, target: string): Promise<PreviewLinks | null>
  url(port: number): string | null
  // The local ports still running; previews of the others go away after a while.
  sweep(running: Set<number>): Promise<void>
}

export interface PreviewSources {
  file: string
  // This PC's tailnet name, or '' when it has none.
  host: string
  proxy: (target: string) => Promise<Proxy>
  serve: (servePort: number, target: string) => Promise<boolean>
  unserve: (servePort: number) => Promise<void>
  now: () => number
}

export function tailscaleServe(servePort: number, target: string): Promise<boolean> {
  return new Promise((done) => {
    execFile(tailscaleCli(), ['serve', '--bg', `--https=${servePort}`, target], { timeout: SERVE_TIMEOUT_MS, windowsHide: true }, (error) => done(error === null))
  })
}

export function tailscaleUnserve(servePort: number): Promise<void> {
  return new Promise((done) => {
    execFile(tailscaleCli(), ['serve', `--https=${servePort}`, 'off'], { timeout: SERVE_TIMEOUT_MS, windowsHide: true }, () => done())
  })
}

function load(file: string): Map<number, Mapping> {
  const mappings = new Map<number, Mapping>()

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))

    for (const entry of Array.isArray(raw?.previews) ? raw.previews : []) {
      if (Number.isInteger(entry?.port) && (entry.serve === 0 || PREVIEW_PORTS.includes(entry.serve)) && typeof entry.target === 'string') {
        mappings.set(entry.port, { serve: entry.serve, target: entry.target, seen: Number(entry.seen) || 0 })
      }
    }
  } catch {
    // None yet.
  }

  return mappings
}

export function createPreviews(sources: PreviewSources): Previews {
  const mappings = load(sources.file)
  // Proxies live only as long as this server; after a restart the first open starts one again.
  const proxies = new Map<number, Proxy>()

  const store = (): void => {
    const previews: { port: number; serve: number; target: string; seen: number }[] = []

    for (const [port, mapping] of mappings) previews.push({ port, ...mapping })

    try {
      mkdirSync(dirname(sources.file), { recursive: true })
      writeFileSync(`${sources.file}.tmp`, JSON.stringify({ previews }, null, 2))
      renameSync(`${sources.file}.tmp`, sources.file)
    } catch {
      // The tailnet keeps serving; only the clean-up would forget it.
    }
  }

  // Serve port 0: shown on this PC only (no tailnet name, or every tailnet port taken).
  const tailnetUrl = (mapping: Mapping): string | null => (sources.host === '' || mapping.serve === 0 ? null : `https://${sources.host}:${mapping.serve}/`)

  return {
    url(port) {
      const mapping = mappings.get(port)

      return mapping === undefined || !proxies.has(port) ? null : tailnetUrl(mapping)
    },

    async open(port, target) {
      const known = mappings.get(port)
      let proxy = proxies.get(port)

      if (proxy !== undefined && known !== undefined && known.target === target) {
        known.seen = sources.now()

        return { local: `${proxy.url}/`, tailnet: tailnetUrl(known) }
      }

      proxy?.close()
      proxy = await sources.proxy(target)
      proxies.set(port, proxy)

      const taken = new Set<number>()

      for (const [other, mapping] of mappings) {
        if (other !== port) taken.add(mapping.serve)
      }

      const free = known?.serve || PREVIEW_PORTS.find((candidate) => !taken.has(candidate))
      const served = sources.host !== '' && free !== undefined && (await sources.serve(free, proxy.url))
      const mapping: Mapping = { serve: served ? free : 0, target, seen: sources.now() }

      mappings.set(port, mapping)
      store()

      return { local: `${proxy.url}/`, tailnet: tailnetUrl(mapping) }
    },

    async sweep(running) {
      let changed = false

      for (const [port, mapping] of [...mappings]) {
        if (running.has(port)) {
          mapping.seen = sources.now()
          continue
        }

        if (sources.now() - mapping.seen < GONE_FOR_MS) continue

        if (mapping.serve !== 0) await sources.unserve(mapping.serve)

        proxies.get(port)?.close()
        proxies.delete(port)
        mappings.delete(port)
        changed = true
      }

      if (changed) store()
    },
  }
}
