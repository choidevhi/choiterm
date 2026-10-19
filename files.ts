// The file tree and file view: a folder's entries, a text file's contents, and any file as it is
// (images, PDFs) for the page to show. Read only. Only the owner reaches these, like the rest of
// ChoiTerm; a file is never served as a page of ChoiTerm's own origin (see rawHeaders).
import { open, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

export interface Entry {
  name: string
  path: string
  dir: boolean
  size: number
  modified: number
}

export type TextFile = { path: string; size: number; text: string; modified: number } | { path: string; size: number; binary: true } | { path: string; size: number; tooBig: true }

const MAX_ENTRIES = 3000
export const MAX_TEXT = 2 * 1024 * 1024
const SNIFF = 8000

// Folders, then files, each in name order the way Explorer sorts them (numbers by value).
export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }))
}

export async function listFolder(folder: string): Promise<Entry[] | null> {
  const dir = resolve(folder)
  let names

  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }

  const entries = await Promise.all(
    names.slice(0, MAX_ENTRIES).map(async (dirent): Promise<Entry> => {
      const path = join(dir, dirent.name)

      try {
        const info = await stat(path)

        return { name: dirent.name, path, dir: info.isDirectory(), size: info.size, modified: info.mtimeMs }
      } catch {
        // A broken link or a file in use: still listed, as what it says it is.
        return { name: dirent.name, path, dir: dirent.isDirectory(), size: 0, modified: 0 }
      }
    }),
  )

  return sortEntries(entries)
}

// A NUL byte in the first few kilobytes means it is not text.
export function looksBinary(head: Buffer): boolean {
  return head.subarray(0, SNIFF).includes(0)
}

export async function readText(file: string): Promise<TextFile | null> {
  const path = resolve(file)
  let info

  try {
    info = await stat(path)
  } catch {
    return null
  }

  if (!info.isFile()) return null

  if (info.size > MAX_TEXT) return { path, size: info.size, tooBig: true }

  const handle = await open(path, 'r')

  try {
    const body = await handle.readFile()

    if (looksBinary(body)) return { path, size: info.size, binary: true }

    // Text saved by Windows tools often starts with a BOM.
    return { path, size: info.size, text: body.toString('utf8').replace(/^\uFEFF/, ''), modified: info.mtimeMs }
  } finally {
    await handle.close()
  }
}

const RAW_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

// A file shown as itself. Anything that could run script in ChoiTerm's origin (HTML, SVG) is held
// in a sandbox, and types the browser does not know are plain bytes.
export function rawHeaders(path: string): Record<string, string> {
  const type = RAW_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' }

  // The browser's PDF viewer will not open inside a sandbox; a PDF cannot reach the page anyway.
  if (type !== 'application/pdf') headers['content-security-policy'] = 'sandbox'

  return headers
}

export type WriteResult = { path: string; modified: number } | { conflict: true; modified: number }

// Saves text to a file. `expected` is the modified time the editor loaded; when the file changed
// on disk since (an agent edited it), nothing is written and the caller is told.
export async function writeText(file: string, text: string, expected: number | null): Promise<WriteResult | null> {
  const path = resolve(file)

  try {
    const info = await stat(path)

    if (!info.isFile()) return null

    if (expected !== null && Math.abs(info.mtimeMs - expected) > 1) return { conflict: true, modified: info.mtimeMs }
  } catch {
    // A new file: its folder has to exist.
    try {
      if (!(await stat(join(path, '..'))).isDirectory()) return null
    } catch {
      return null
    }
  }

  const handle = await open(path, 'w')

  try {
    await handle.writeFile(text, 'utf8')
  } finally {
    await handle.close()
  }

  return { path, modified: (await stat(path)).mtimeMs }
}
