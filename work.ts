// The right panel's other views: what changed in a checkout (git status and diffs), searching the
// project's files (ripgrep, else git grep), and the project's open pull requests and issues on
// GitHub (the gh command line, signed in once on this PC).
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

export interface Change {
  path: string
  // Two letters of `git status --porcelain`: staged, then in the working folder ('?' untracked).
  index: string
  work: string
}

export interface Hit {
  path: string
  line: number
  text: string
}

export interface Task {
  kind: 'pr' | 'issue'
  number: number
  title: string
  url: string
  branch: string | null
  author: string
  updatedAt: string
  draft: boolean
}

const TIMEOUT_MS = 15_000
const MAX_HITS = 400
const MAX_DIFF = 2 * 1024 * 1024

function run(command: string, args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    execFile(command, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      // grep and rg exit with 1 when nothing matched: that is an answer, not a failure.
      done({ ok: error === null || (typeof error.code === 'number' && error.code === 1), out: stdout })
    })
  })
}

// `git status --porcelain=v1 -z`: entries split by NUL, a rename followed by its old path.
export function parseStatus(output: string): Change[] {
  const parts = output.split('\0')
  const changes: Change[] = []

  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? ''

    if (entry.length < 4) continue

    const x = entry[0] ?? ' '
    const y = entry[1] ?? ' '

    changes.push({ path: entry.slice(3), index: x, work: y })

    if (x === 'R' || x === 'C') index += 1
  }

  return changes
}

export async function gitStatus(root: string): Promise<Change[] | null> {
  const result = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root)

  return result.ok ? parseStatus(result.out) : null
}

// The change of one file against the last commit; a new file shows whole, as added.
export async function gitDiff(root: string, path: string): Promise<string | null> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) return null

  const tracked = await run('git', ['diff', '--no-color', 'HEAD', '--', path], root)

  if (tracked.ok && tracked.out !== '') return tracked.out.slice(0, MAX_DIFF)

  const fresh = await run('git', ['diff', '--no-color', '--no-index', '--', 'NUL', path], root)

  return fresh.out === '' ? (tracked.ok ? '' : null) : fresh.out.slice(0, MAX_DIFF)
}

// `rg -n` / `git grep -n` lines: path:line:text (paths are relative, so the first colons split).
export function parseHits(output: string): Hit[] {
  const hits: Hit[] = []

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?):(\d+):(.*)$/)

    if (match === null) continue

    hits.push({ path: (match[1] ?? '').replace(/^\.[\\/]/, ''), line: Number(match[2]), text: (match[3] ?? '').slice(0, 300) })

    if (hits.length >= MAX_HITS) break
  }

  return hits
}

export async function searchFiles(root: string, query: string, rg = 'rg'): Promise<Hit[] | null> {
  if (query.trim() === '') return []

  // Smart case, fixed text (not a pattern), skipping what .gitignore skips.
  const found = await run(rg, ['-n', '--no-heading', '--color', 'never', '-S', '-F', '--max-count', '20', '--max-columns', '300', '-e', query, '.'], root)

  if (found.ok) return parseHits(found.out)

  const grep = await run('git', ['grep', '-n', '-I', '-i', '-F', '-e', query], root)

  return grep.ok ? parseHits(grep.out) : null
}

// What `gh pr list --json …` and `gh issue list --json …` give per item.
interface GhItem {
  number?: number
  title?: string
  url?: string
  headRefName?: string
  author?: { login?: string } | null
  updatedAt?: string
  isDraft?: boolean
}

function readItems(text: string): GhItem[] {
  try {
    const value = JSON.parse(text)

    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function parseTasks(prs: string, issues: string): Task[] {
  const tasks: Task[] = []

  for (const [kind, items] of [['pr', readItems(prs)], ['issue', readItems(issues)]] as const) {
    for (const item of items) {
      if (typeof item.number !== 'number' || typeof item.title !== 'string' || typeof item.url !== 'string') continue

      tasks.push({
        kind,
        number: item.number,
        title: item.title,
        url: item.url,
        branch: kind === 'pr' && typeof item.headRefName === 'string' ? item.headRefName : null,
        author: item.author?.login ?? '',
        updatedAt: item.updatedAt ?? '',
        draft: item.isDraft === true,
      })
    }
  }

  return tasks
}

export async function githubTasks(root: string): Promise<Task[] | null> {
  const [prs, issues] = await Promise.all([
    run('gh', ['pr', 'list', '--json', 'number,title,url,headRefName,author,updatedAt,isDraft', '-L', '30'], root, 20_000),
    run('gh', ['issue', 'list', '--json', 'number,title,url,author,updatedAt', '-L', '30'], root, 20_000),
  ])

  if (!prs.ok && !issues.ok) return null

  return parseTasks(prs.ok ? prs.out : '[]', issues.ok ? issues.out : '[]')
}

const MAX_NAMES = 50

// File paths (from `rg --files`) whose path contains the words, names that match first.
export function filterFileNames(output: string, query: string): string[] {
  const words = query.trim().toLowerCase()
  const byName: string[] = []
  const byPath: string[] = []

  if (words === '') return []

  for (const raw of output.split(/\r?\n/)) {
    const path = raw.replace(/^\.[\/]/, '')
    const lower = path.toLowerCase()

    if (path === '' || !lower.includes(words)) continue

    const name = lower.split(/[\/]/).at(-1) ?? lower

    if (name.includes(words)) byName.push(path)
    else byPath.push(path)
  }

  return [...byName, ...byPath].slice(0, MAX_NAMES)
}

export async function findFileNames(root: string, query: string, rg = 'rg'): Promise<string[] | null> {
  const listed = await run(rg, ['--files', '--color', 'never'], root)

  if (listed.ok) return filterFileNames(listed.out, query)

  const tracked = await run('git', ['ls-files'], root)

  return tracked.ok ? filterFileNames(tracked.out, query) : null
}
