// Every image that went through ChoiTerm: files the owner sent (uploads) and images a session showed
// by printing their path. Kept in a JSON file so the list, its tags and what was deleted survive
// restarts, and shared by every device.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'

export type GalleryFrom = 'me' | 'claude'

export interface GalleryItem {
  id: string
  path: string
  from: GalleryFrom
  // Every session the image was sent to or shown in.
  sessions: string[]
  // Sessions whose pinned thumbnails no longer show it (closed there, on any screen).
  unpinned: string[]
  at: number
  tags: string[]
}

export interface Gallery {
  list(): GalleryItem[]
  add(path: string, from: GalleryFrom, session: string | null): GalleryItem | null
  setTags(id: string, tags: string[]): GalleryItem | null
  remove(ids: string[]): string[]
  unpin(ids: string[], session: string): void
  subscribe(listener: (items: GalleryItem[]) => void): () => void
}

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const MAX_TAGS = 20
const MAX_TAG_LENGTH = 30
const MAX_ITEMS = 5000

export function isImagePath(path: string): boolean {
  return isAbsolute(path) && IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

// Trimmed, single-spaced, short and without repeats; empty ones dropped.
export function cleanTags(tags: string[]): string[] {
  const kept: string[] = []

  for (const tag of tags) {
    const clean = tag.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH)

    if (clean !== '' && !kept.includes(clean)) kept.push(clean)
  }

  return kept.slice(0, MAX_TAGS)
}

export function parseGalleryFile(text: string): GalleryItem[] {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }

  const items: GalleryItem[] = []

  for (const entry of Array.isArray(raw?.items) ? raw.items : []) {
    if (typeof entry?.id !== 'string' || typeof entry.path !== 'string' || !Number.isFinite(entry.at)) continue

    if (entry.from !== 'me' && entry.from !== 'claude') continue

    const tags: string[] = []
    const sessions: string[] = []
    const unpinned: string[] = []

    for (const tag of Array.isArray(entry.tags) ? entry.tags : []) {
      if (typeof tag === 'string') tags.push(tag)
    }

    for (const session of Array.isArray(entry.sessions) ? entry.sessions : []) {
      if (typeof session === 'string') sessions.push(session)
    }

    for (const session of Array.isArray(entry.unpinned) ? entry.unpinned : []) {
      if (typeof session === 'string') unpinned.push(session)
    }

    items.push({
      id: entry.id,
      path: entry.path,
      from: entry.from,
      sessions,
      unpinned,
      at: entry.at,
      tags: cleanTags(tags),
    })
  }

  return items
}

// Deleted images the list must not take back while the same file is still printed on a screen:
// path (lower case) to the file's size and time when it was deleted. A changed file comes back.
export function parseForgotten(text: string): Map<string, string> {
  const forgotten = new Map<string, string>()
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return forgotten
  }

  for (const entry of Array.isArray(raw?.forgotten) ? raw.forgotten : []) {
    if (typeof entry?.path === 'string' && typeof entry.stamp === 'string') forgotten.set(entry.path, entry.stamp)
  }

  return forgotten
}

function fileStamp(path: string): string | null {
  try {
    const info = statSync(path)

    return info.isFile() ? `${info.size}-${Math.trunc(info.mtimeMs)}` : null
  } catch {
    return null
  }
}

const MAX_FORGOTTEN = 5000

function inside(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path))

  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// `ownFolder` is where uploads land: deleting one of those removes the file as well. Images a
// session printed may be anyone's files (a project's screenshots), so deleting them only takes them
// off the list.
export function createGallery(file: string, ownFolder: string, log: (line: string) => void): Gallery {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const items = parseGalleryFile(text)
  const forgotten = parseForgotten(text)
  const listeners = new Set<(items: GalleryItem[]) => void>()
  let next = Date.now()

  const changed = (): void => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const kept = [...forgotten].slice(-MAX_FORGOTTEN).map(([path, stamp]) => ({ path, stamp }))

      writeFileSync(`${file}.tmp`, JSON.stringify({ items, forgotten: kept }))
      renameSync(`${file}.tmp`, file)
    } catch (error) {
      log(`gallery save failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    const copy = items.slice()

    for (const listener of listeners) listener(copy)
  }

  return {
    list() {
      return items.slice()
    },

    add(path, from, session) {
      if (!isImagePath(path)) return null

      const known = items.find((item) => item.path.toLowerCase() === path.toLowerCase())

      if (known !== undefined) {
        if (session !== null && !known.sessions.includes(session)) {
          known.sessions.push(session)
          changed()
        }

        return known
      }

      const stamp = fileStamp(path)

      if (stamp === null || forgotten.get(path.toLowerCase()) === stamp) return null

      forgotten.delete(path.toLowerCase())
      next += 1

      const item: GalleryItem = { id: next.toString(36), path, from, sessions: session === null ? [] : [session], unpinned: [], at: Date.now(), tags: [] }

      items.push(item)

      if (items.length > MAX_ITEMS) items.shift()

      changed()

      return item
    },

    setTags(id, tags) {
      const item = items.find((each) => each.id === id)

      if (item === undefined) return null

      item.tags = cleanTags(tags)
      changed()

      return item
    },

    remove(ids) {
      const removed: string[] = []

      for (const id of ids) {
        const index = items.findIndex((item) => item.id === id)

        if (index === -1) continue

        const [item] = items.splice(index, 1)

        removed.push(id)

        if (inside(ownFolder, item.path)) {
          rmSync(item.path, { force: true })
        } else {
          const stamp = fileStamp(item.path)

          if (stamp !== null) forgotten.set(item.path.toLowerCase(), stamp)
        }
      }

      if (removed.length > 0) {
        log(`gallery removed ${removed.length}`)
        changed()
      }

      return removed
    },

    unpin(ids, session) {
      let any = false

      for (const item of items) {
        if (!ids.includes(item.id) || item.unpinned.includes(session)) continue

        item.unpinned.push(session)
        any = true
      }

      if (any) changed()
    },

    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
  }
}
