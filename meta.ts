// What the page shows about each session beyond its name, gathered on the server and sent when it
// changes: the git project and branch of its folder, whether it is busy, the last line it printed,
// and the web servers it started, with their tailnet address once one was opened.
import type { RepoInfo } from './repo.ts'
import type { Previews } from './previews.ts'
import type { ProcessTable } from './ports.ts'
import { portsBySession } from './ports.ts'
import type { SessionMeta, Sessions } from './sessions.ts'

export interface MetaSources {
  sessions: Sessions
  repo: (dir: string) => Promise<RepoInfo | null>
  // Windows' listening ports and process tree (ports.ts); read less often, it takes a moment.
  table: () => Promise<ProcessTable | null>
  // The address a port answers HTTP on, or null when it is not a web server.
  http: (port: number) => Promise<string | null>
  previews: Previews | null
  // ChoiTerm's own ports, never offered as previews.
  skip: Set<number>
  now: () => number
}

export interface Meta {
  latest(): SessionMeta[]
  // Gathers once and tells the listener when anything changed.
  refresh(withPorts: boolean): Promise<void>
  subscribe(listener: (meta: SessionMeta[]) => void): void
  // The local address of a port some session runs, for opening its preview.
  target(port: number): string | null
}

export function createMeta(sources: MetaSources): Meta {
  let latest: SessionMeta[] = []
  let ports = new Map<string, number[]>()
  // Port → address answering HTTP there (null: checked, not a web server).
  const http = new Map<number, string | null>()
  const listeners = new Set<(meta: SessionMeta[]) => void>()
  let running = false

  async function readPorts(): Promise<void> {
    const table = await sources.table()

    if (table === null) return

    const found = portsBySession(table, sources.sessions.pids(), sources.skip)
    const all = new Set([...found.values()].flat())

    for (const port of all) {
      if (!http.has(port) || http.get(port) === null) http.set(port, await sources.http(port))
    }

    for (const port of [...http.keys()]) {
      if (!all.has(port)) http.delete(port)
    }

    ports = found
    await sources.previews?.sweep(all)
  }

  return {
    latest: () => latest,

    target: (port) => http.get(port) ?? null,

    subscribe(listener) {
      listeners.add(listener)
    },

    async refresh(withPorts) {
      // One gathering at a time; a slow one is not stacked on.
      if (running) return

      running = true

      try {
        if (withPorts) await readPorts()

        const infos = sources.sessions.list()
        const activity = new Map(sources.sessions.activity(sources.now()).map((each) => [each.id, each]))
        const next: SessionMeta[] = []

        for (const info of infos) {
          const repo = info.cwd === null ? null : await sources.repo(info.cwd)
          const web: SessionMeta['ports'] = []

          for (const port of ports.get(info.id) ?? []) {
            if (http.get(port)) web.push({ port, url: sources.previews?.url(port) ?? null })
          }

          next.push({ id: info.id, repo, busy: activity.get(info.id)?.busy ?? false, line: activity.get(info.id)?.line ?? '', ports: web })
        }

        if (JSON.stringify(next) === JSON.stringify(latest)) return

        latest = next

        for (const listener of listeners) listener(latest)
      } finally {
        running = false
      }
    },
  }
}
