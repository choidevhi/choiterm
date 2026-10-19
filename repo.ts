// Which git project and branch a session's folder belongs to, for grouping the session list by
// project, and new git worktrees, so each task can get a folder and branch of its own.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export interface RepoInfo {
  // The main repository's folder and name: worktrees of one repository share these.
  project: string
  name: string
  // This checkout's folder (the main one or a worktree) and branch.
  root: string
  branch: string
  worktree: boolean
}

const GIT_TIMEOUT_MS = 3000
const CACHE_MS = 30_000
// Starting git in a folder of real work reads every file once.
const INIT_TIMEOUT_MS = 120_000
// More files than one project has: a whole drive or a home folder picked by mistake.
const MAX_INIT_FILES = 20_000

type Git = (args: string[], cwd: string) => Promise<string | null>

export function runGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => done(error === null ? stdout : null))
  })
}

// `git rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD` run in `dir`, three lines.
export function parseRevParse(dir: string, output: string): RepoInfo | null {
  const [top, common, branch] = output.trim().split(/\r?\n/)

  if (top === undefined || common === undefined || top === '') return null

  const root = resolve(top)
  const commonDir = isAbsolute(common) ? resolve(common) : resolve(dir, common)
  // The common folder is the main checkout's `.git`; a bare repository has no checkout above it.
  const project = basename(commonDir).toLowerCase() === '.git' ? dirname(commonDir) : root

  return { project, name: basename(project), root, branch: branch === 'HEAD' ? '' : (branch ?? ''), worktree: project.toLowerCase() !== root.toLowerCase() }
}

// `fresh` skips the cache (and refills it): a folder that just became a repository.
export function createRepoLookup(git: Git = runGit, now: () => number = Date.now): (dir: string, fresh?: boolean) => Promise<RepoInfo | null> {
  const cache = new Map<string, { at: number; info: Promise<RepoInfo | null> }>()

  return (dir, fresh = false) => {
    const key = dir.toLowerCase()
    const hit = cache.get(key)

    if (!fresh && hit !== undefined && now() - hit.at < CACHE_MS) return hit.info

    const info = existsSync(dir)
      ? git(['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'], dir).then((out) => (out === null ? null : parseRevParse(dir, out)))
      : Promise.resolve(null)

    cache.set(key, { at: now(), info })

    return info
  }
}

// A branch name git takes and a folder name Windows takes: letters, digits, `-`, `_`, `.`, `/`.
export function cleanBranch(name: string): string | null {
  const clean = name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._/-]/gu, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-./]+|[-./]+$/g, '')
    .slice(0, 80)

  return clean === '' || clean.includes('..') ? null : clean
}

// Worktrees go beside the project, in `<project>.worktrees/<branch>`.
export function worktreeFolder(project: string, branch: string): string {
  return join(`${project}.worktrees`, branch.replaceAll('/', '-'))
}

// A new branch from `base` (else the current one), checked out in its own folder. Returns that folder.
export async function addWorktree(project: string, branch: string, base: string | null = null, git: (args: string[], cwd: string) => Promise<string | null> = runGit): Promise<string | null> {
  const folder = worktreeFolder(project, branch)

  if (existsSync(folder)) return folder

  const created = await git(base === null ? ['worktree', 'add', '-b', branch, folder] : ['worktree', 'add', '-b', branch, folder, base], project)

  if (created !== null) return folder

  // The branch may exist already: check it out instead of making it.
  return (await git(['worktree', 'add', folder, branch], project)) === null ? null : folder
}

// `git for-each-ref --format=%(refname:short) refs/heads refs/remotes`: local branches first, then
// remote ones that have no local branch of the same name; origin/HEAD is left out.
export function parseBranches(output: string): string[] {
  const local: string[] = []
  const remote: string[] = []

  for (const line of output.split(/\r?\n/)) {
    const name = line.trim()

    if (name === '' || name.endsWith('/HEAD') || name === 'origin') continue

    if (name.startsWith('origin/')) remote.push(name)
    else local.push(name)
  }

  const shortNames = new Set(local)

  return [...local, ...remote.filter((name) => !shortNames.has(name.slice('origin/'.length)))]
}

// The project's branches and the one new work starts from by default (origin's HEAD, else the
// branch checked out in the project's own folder).
export async function listBranches(project: string, git: (args: string[], cwd: string) => Promise<string | null> = runGit): Promise<{ branches: string[]; base: string } | null> {
  const refs = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], project)

  if (refs === null) return null

  const head = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], project))?.trim().replace(/^origin\//, '')
  const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], project))?.trim()

  return { branches: parseBranches(refs), base: head || current || 'main' }
}

// A new project's folder name: letters, digits, spaces, `.`, `_`, `-`; nothing that climbs out.
export function cleanProjectName(name: string): string | null {
  const clean = name.trim().replace(/\s+/g, ' ')

  return /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(clean) && !clean.includes('..') ? clean : null
}

// A project in `parent`: the folder made if missing, and a git repository with a first (empty)
// commit, so worktrees can branch from it. An existing repository is just used.
export async function createProject(parent: string, name: string, git: (args: string[], cwd: string) => Promise<string | null> = runGit): Promise<string | null> {
  const clean = cleanProjectName(name)

  if (clean === null) return null

  const folder = join(parent, clean)

  mkdirSync(folder, { recursive: true })

  if (existsSync(join(folder, '.git'))) return folder

  if ((await git(['init', '-b', 'main'], folder)) === null) return null

  const committed = await git([...(await identity(folder, git)), 'commit', '--allow-empty', '-m', '시작'], folder)

  return committed === null ? null : folder
}

// A commit needs a name and an email; on a PC where git was never told them, this PC's user stands
// in, so the first commit works. Set ones are left alone.
export async function identity(folder: string, git: Git = runGit): Promise<string[]> {
  const email = await git(['config', 'user.email'], folder)

  if (email !== null && email.trim() !== '') return []

  const name = userInfo().username || 'choiterm'

  return ['-c', `user.name=${name}`, '-c', `user.email=${name}@${hostname().toLowerCase()}.local`]
}

// What a first commit leaves out: dependencies, build output, local secrets and system clutter.
export const STARTER_GITIGNORE = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '.gradle/',
  '*.log',
  '.env',
  '.env.*',
  '!.env.example',
  '*.key',
  '*.pem',
  '*.jks',
  '*.keystore',
  'Thumbs.db',
  'desktop.ini',
  '.DS_Store',
  '',
].join('\n')

// Folders too wide to be one project: a drive, the home folder and the usual folders in it, the
// folder of all users, and Windows' own.
export function tooWideForProject(folder: string, home: string): boolean {
  const path = resolve(folder).toLowerCase().replace(/[\\/]+$/, '')

  if (/^[a-z]:$/.test(path)) return true

  const wide = [home, dirname(home), ...['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive', 'AppData'].map((name) => join(home, name))]

  return wide.some((each) => resolve(each).toLowerCase() === path) || /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)(\\|$)/.test(path)
}

export type InitResult = { ok: true; folder: string } | { ok: false; error: string }

const slowGit: Git = (args, cwd) => runGit(args, cwd, INIT_TIMEOUT_MS)

// Turns a plain folder into a git project on this PC (nothing goes to GitHub): a starter
// .gitignore unless it has one, `git init`, then a first commit of what is there. Undone again when
// it cannot finish, or when the folder holds far more files than a project.
export async function initProject(folder: string, home: string, git: Git = slowGit): Promise<InitResult> {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return { ok: false, error: '폴더가 없어요' }

  if (tooWideForProject(folder, home)) return { ok: false, error: '너무 넓은 폴더라 git으로 만들지 않았어요' }

  // Already a repository, or inside one: adding it is enough.
  if ((await git(['rev-parse', '--show-toplevel'], folder)) !== null) return { ok: true, folder }

  const ignore = join(folder, '.gitignore')
  const wroteIgnore = !existsSync(ignore)

  const undo = (error: string): InitResult => {
    rmSync(join(folder, '.git'), { recursive: true, force: true })

    if (wroteIgnore) rmSync(ignore, { force: true })

    return { ok: false, error }
  }

  if (wroteIgnore) writeFileSync(ignore, STARTER_GITIGNORE)

  if ((await git(['init', '-b', 'main'], folder)) === null) return undo('git을 시작하지 못했어요')

  // Counted before anything is stored: a folder this big would fill .git for nothing.
  const files = await git(['ls-files', '--others', '--exclude-standard'], folder)

  if (files === null || files.split('\n').length > MAX_INIT_FILES) return undo('파일이 너무 많아서 git으로 만들지 않았어요')

  if ((await git(['add', '-A'], folder)) === null) return undo('파일을 담지 못했어요')

  if ((await git([...(await identity(folder, git)), 'commit', '--allow-empty', '-m', '시작'], folder)) === null) return undo('첫 커밋을 만들지 못했어요')

  return { ok: true, folder }
}

export interface Worktree {
  path: string
  branch: string
  // The repository's own checkout (git lists it first).
  primary: boolean
}

// `git worktree list --porcelain`: blocks of `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<b>`.
export function parseWorktrees(output: string): Worktree[] {
  const found: Worktree[] = []

  for (const block of output.split(/\r?\n\r?\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1]

    if (path === undefined || /^bare$/m.test(block)) continue

    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? ''

    found.push({ path: resolve(path), branch, primary: found.length === 0 })
  }

  return found
}

export async function listWorktrees(project: string, git: (args: string[], cwd: string) => Promise<string | null> = runGit): Promise<Worktree[] | null> {
  const out = await git(['worktree', 'list', '--porcelain'], project)

  return out === null ? null : parseWorktrees(out)
}

// Merges a finished worktree's branch into the branch the project's own checkout is on.
export async function mergeBranch(project: string, branch: string, git: (args: string[], cwd: string) => Promise<string | null> = runGit): Promise<boolean> {
  return (await git(['merge', '--no-ff', '--no-edit', branch], project)) !== null
}

// Takes a worktree away (its folder; the branch stays). git refuses while it has changes.
export async function removeWorktree(project: string, path: string, git: (args: string[], cwd: string) => Promise<string | null> = runGit): Promise<boolean> {
  return (await git(['worktree', 'remove', path], project)) !== null
}
