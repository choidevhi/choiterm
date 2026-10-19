// GitHub through the GitHub CLI (gh): whether it is installed and signed in, a sign-in by device code
// (the page shows the code, the owner types it at github.com/login/device), the repositories the
// account can reach, and cloning one into the home folder as a new project.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const GH_TIMEOUT_MS = 30_000
const CLONE_TIMEOUT_MS = 15 * 60_000
const SIGN_IN_TIMEOUT_MS = 15 * 60_000
// gh shows its code within a second or two; one that has not by then is stuck on something else.
const CODE_WAIT_MS = 20_000
const REPOS_FOR_MS = 60_000

export interface GithubRepo {
  name: string
  description: string
  private: boolean
  pushed: string
}

export interface SignIn {
  code: string
  url: string
}

export interface GithubState {
  installed: boolean
  login: string | null
  signIn: SignIn | null
}

export interface GhResult {
  ok: boolean
  out: string
  // gh itself is not there (not installed, or not on the PATH and not in its usual folder).
  missing: boolean
}

export type RunGh = (args: string[], timeoutMs?: number) => Promise<GhResult>

// A running `gh auth login`: its output as it comes, and how it ended.
export interface SignInProcess {
  onOutput(listener: (text: string) => void): void
  onExit(listener: (ok: boolean) => void): void
  write(text: string): void
  stop(): void
}

export type StartSignIn = () => SignInProcess | null

export type CloneResult = { ok: true; folder: string } | { ok: false; error: string }

// The installer puts gh in Program Files; a server started at logon may not have it on the PATH.
export function ghCli(): string {
  const installed = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')

  return existsSync(installed) ? installed : 'gh'
}

export function runGh(args: string[], timeoutMs = GH_TIMEOUT_MS): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(ghCli(), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      const missing = error?.code === 'ENOENT'

      resolve({ ok: error === null, out: stdout, missing })
    })
  })
}

export function startGhSignIn(): SignInProcess | null {
  try {
    const child = spawn(ghCli(), ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    child.on('error', () => {})
    child.stdin.on('error', () => {})
    setTimeout(() => child.kill(), SIGN_IN_TIMEOUT_MS).unref()

    return {
      onOutput(listener) {
        child.stdout.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')))
        child.stderr.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')))
      },
      onExit(listener) {
        child.on('exit', (code) => listener(code === 0))
        // Not started at all (gh missing): no exit follows.
        child.on('error', () => listener(false))
      },
      write(text) {
        child.stdin.write(text)
      },
      stop() {
        child.kill()
      },
    }
  } catch {
    return null
  }
}

// gh prints its code as "! First copy your one-time code: ABCD-1234" (older) or "! One-time code
// (ABCD-1234) copied to clipboard" (newer), then the page to type it into.
export function parseSignIn(output: string): SignIn | null {
  const code = output.match(/one-time code(?::\s*|\s*\()([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1]

  if (code === undefined) return null

  return { code, url: output.match(/https:\/\/github\.com\/login\/device\S*/)?.[0] ?? 'https://github.com/login/device' }
}

// One JSON object per line, as `--jq` writes them.
export function parseRepos(output: string): GithubRepo[] {
  const repos: GithubRepo[] = []

  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue

    try {
      const raw = JSON.parse(line)

      if (typeof raw?.n !== 'string') continue

      repos.push({ name: raw.n, description: typeof raw.d === 'string' ? raw.d : '', private: raw.p === true, pushed: typeof raw.t === 'string' ? raw.t : '' })
    } catch {
      // A line gh did not write as JSON.
    }
  }

  return repos
}

// owner/name, the way GitHub spells it: letters, digits, - _ and . only.
export function cleanRepoName(name: string): string | null {
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(name) && !name.endsWith('/.') && !name.endsWith('/..') ? name : null
}

export interface Github {
  state(): Promise<GithubState>
  signIn(): Promise<SignIn | null>
  repos(fresh: boolean): Promise<GithubRepo[] | null>
  clone(repo: string): Promise<CloneResult>
}

export function createGithub(home: string, run: RunGh = runGh, startSignIn: StartSignIn = startGhSignIn, now: () => number = Date.now): Github {
  let pending: SignIn | null = null
  let cached: { at: number; login: string; repos: GithubRepo[] } | null = null

  const login = async (): Promise<{ installed: boolean; login: string | null }> => {
    const user = await run(['api', 'user', '--jq', '.login'])

    if (user.missing) return { installed: false, login: null }

    return { installed: true, login: user.ok && user.out.trim() !== '' ? user.out.trim() : null }
  }

  return {
    async state() {
      const found = await login()

      if (found.login !== null) pending = null

      return { ...found, signIn: pending }
    },

    signIn() {
      if (pending !== null) return Promise.resolve(pending)

      const child = startSignIn()

      if (child === null) return Promise.resolve(null)

      return new Promise((resolve) => {
        let output = ''
        let answered = false

        const giveUp = setTimeout(() => {
          if (answered) return

          answered = true
          child.stop()
          resolve(null)
        }, CODE_WAIT_MS)

        child.onOutput((text) => {
          output += text

          const found = parseSignIn(output)

          if (found === null || answered) return

          answered = true
          clearTimeout(giveUp)
          pending = found
          // Older gh waits for Enter before it starts watching for the code.
          child.write('\n')
          resolve(found)
        })
        child.onExit((ok) => {
          pending = null
          cached = null

          // git itself then signs in through gh too, so the agents can push.
          if (ok) void run(['auth', 'setup-git'])

          clearTimeout(giveUp)

          if (!answered) resolve(null)
        })
      })
    },

    async repos(fresh) {
      const found = await login()

      if (found.login === null) return null

      if (!fresh && cached !== null && cached.login === found.login && now() - cached.at < REPOS_FOR_MS) return cached.repos

      const listed = await run(['api', '--paginate', 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', '--jq', '.[] | {n: .full_name, d: .description, p: .private, t: .pushed_at}'], 2 * GH_TIMEOUT_MS)

      if (!listed.ok) return null

      const repos = parseRepos(listed.out).sort((a, b) => b.pushed.localeCompare(a.pushed))

      cached = { at: now(), login: found.login, repos }

      return repos
    },

    async clone(repo) {
      const name = cleanRepoName(repo)

      if (name === null) return { ok: false, error: '저장소 이름이 이상해요' }

      const folder = join(home, name.split('/')[1])

      if (existsSync(folder)) return { ok: false, error: `${folder} 폴더가 이미 있어요` }

      // gh hands git its own sign-in for the clone, private repositories included.
      const cloned = await run(['repo', 'clone', name, folder], CLONE_TIMEOUT_MS)

      return cloned.ok ? { ok: true, folder } : { ok: false, error: cloned.missing ? 'GitHub CLI(gh)가 없어요' : '받지 못했어요' }
    },
  }
}
