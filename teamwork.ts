// Worktrees working together: a worktree's changes are committed when its agent finishes a turn
// (never in the project's own checkout), the agent in the project's own checkout is told when a
// worktree is made and when one finishes a turn, and one worktree can take another's commits.
import { identity, runGit } from './repo.ts'

type Git = (args: string[], cwd: string) => Promise<string | null>

export interface Saved {
  files: number
}

function clock(now: number): string {
  const time = new Date(now)

  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
}

// Commits everything changed in `folder`; null when nothing had changed (or git refused).
export async function autoCommit(folder: string, now: number, git: Git = runGit): Promise<Saved | null> {
  const status = await git(['status', '--porcelain'], folder)

  if (status === null || status.trim() === '') return null

  const files = status.split(/\r?\n/).filter((line) => line.trim() !== '').length

  if ((await git(['add', '-A'], folder)) === null) return null

  if ((await git([...(await identity(folder, git)), 'commit', '-m', `자동 저장 ${clock(now)}`], folder)) === null) return null

  return { files }
}

// How many commits `branch` has that `base` does not.
export async function commitsAhead(folder: string, base: string, git: Git = runGit): Promise<number | null> {
  const count = await git(['rev-list', '--count', `${base}..HEAD`], folder)

  return count === null ? null : Number.parseInt(count.trim(), 10)
}

// Takes `branch`'s commits into the worktree at `folder`.
export async function mergeInto(folder: string, branch: string, git: Git = runGit): Promise<boolean> {
  return (await git(['merge', '--no-edit', branch], folder)) !== null
}

// `branch` into the project's checkout, as one merge commit or squashed into a single commit.
export async function mergeToProject(project: string, branch: string, squash: boolean, git: Git = runGit): Promise<boolean> {
  if (!squash) return (await git(['merge', '--no-ff', '--no-edit', branch], project)) !== null

  if ((await git(['merge', '--squash', branch], project)) === null) return false

  return (await git(['commit', '-m', `${branch} 병합`], project)) !== null
}

export interface CreatedNote {
  branch: string
  base: string | null
  agent: string
  folder: string
}

export function createdNote(info: CreatedNote): string {
  return [
    `[ChoiTerm] 새 워크트리 ${info.branch}를 만들었어요.`,
    `브랜치 ${info.branch} (${info.base ?? '지금 브랜치'}에서 시작) · 에이전트 ${info.agent}`,
    info.folder,
  ].join('\n')
}

export interface TurnNote {
  name: string
  branch: string
  agent: string
  folder: string
  saved: Saved | null
  ahead: number | null
  base: string
}

export function turnNote(info: TurnNote): string {
  const saved = info.saved === null ? '바뀐 파일 없음' : `자동 저장 커밋 (파일 ${info.saved.files}개)`
  const ahead = info.ahead === null ? '' : ` · ${info.base}보다 커밋 ${info.ahead}개 앞섬`

  return [`[ChoiTerm] 워크트리 ${info.name}에서 ${info.agent}가 턴을 끝냈어요.`, `${saved}${ahead} · 브랜치 ${info.branch}`, info.folder].join('\n')
}

// Notes for agents, held until the agent is idle so a turn in progress is never interrupted, then
// pasted into its input (the owner presses Enter). Several notes for one agent go in together.
export interface Relay {
  post(session: string, text: string): void
  // Delivers what can be delivered now; returns how many notes went out.
  tick(): number
  pending(session: string): number
}

export interface RelaySinks {
  busy(session: string): boolean
  alive(session: string): boolean
  deliver(session: string, text: string): void
}

export function createRelay(sinks: RelaySinks): Relay {
  const waiting = new Map<string, string[]>()

  return {
    post(session, text) {
      waiting.set(session, [...(waiting.get(session) ?? []), text])
    },

    tick() {
      let sent = 0

      for (const [session, notes] of waiting) {
        if (!sinks.alive(session)) {
          waiting.delete(session)
          continue
        }

        if (sinks.busy(session)) continue

        sinks.deliver(session, notes.join('\n\n'))
        sent += notes.length
        waiting.delete(session)
      }

      return sent
    },

    pending(session) {
      return waiting.get(session)?.length ?? 0
    },
  }
}
