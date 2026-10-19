// Notes: markdown files ChoiTerm keeps outside every repository. Loose notes sit in the notes
// folder; each project's in a folder of its own under projects/, named after the project and a
// short hash of its path, so two projects with one name stay apart.
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

export interface Note {
  name: string
  path: string
  title: string
  modified: number
}

// Enough of a note to find its first line.
const TITLE_BYTES = 400

export function projectNotesFolder(root: string, project: string): string {
  const name = basename(project).replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'project'
  const hash = createHash('sha1').update(resolve(project).toLowerCase()).digest('hex').slice(0, 6)

  return join(root, 'projects', `${name}-${hash}`)
}

// The first line with words in it, without its heading marks; else the file's name.
export function noteTitle(text: string, name: string): string {
  for (const line of text.split(/\r?\n/)) {
    const words = line.replace(/^\s*#+\s*/, '').trim()

    if (words !== '') return words.slice(0, 80)
  }

  return name.replace(/\.md$/i, '')
}

export function listNotes(folder: string): Note[] {
  mkdirSync(folder, { recursive: true })

  const notes: Note[] = []

  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue

    const path = join(folder, entry.name)

    try {
      const head = readFileSync(path).subarray(0, TITLE_BYTES).toString('utf8')

      notes.push({ name: entry.name, path, title: noteTitle(head, entry.name), modified: statSync(path).mtimeMs })
    } catch {
      // Gone or locked since the listing.
    }
  }

  return notes.sort((a, b) => b.modified - a.modified)
}

// Only a markdown file inside the notes folder (a project's included) is ever removed.
export function deleteNote(root: string, path: string): boolean {
  const target = resolve(path)
  const inside = target.toLowerCase().startsWith(`${resolve(root).toLowerCase()}${sep}`)

  if (!inside || !/\.md$/i.test(target)) return false

  try {
    if (!statSync(target).isFile()) return false

    rmSync(target)

    return true
  } catch {
    return false
  }
}
