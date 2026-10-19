// Which git project and branch a session's folder belongs to, for grouping the session list by
// project, and new git worktrees, so each task can get a folder and branch of its own.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
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

export function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => done(error === null ? stdout : null))
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

export function createRepoLookup(git: (args: string[], cwd: string) => Promise<string | null> = runGit, now: () => number = Date.now): (dir: string) => Promise<RepoInfo | null> {
  const cache = new Map<string, { at: number; info: Promise<RepoInfo | null> }>()

  return (dir) => {
    const key = dir.toLowerCase()
    const hit = cache.get(key)

    if (hit !== undefined && now() - hit.at < CACHE_MS) return hit.info

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

  const committed = await git(['commit', '--allow-empty', '-m', '시작'], folder)

  return committed === null ? null : folder
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
