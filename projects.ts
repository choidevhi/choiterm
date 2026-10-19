// The projects the side list shows: git repositories with every worktree they have,
// whether or not a session runs in it. A project is known once a session works in it or the owner
// adds its folder; added ones are kept in a file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { RepoInfo, Worktree } from './repo.ts'

export interface Project {
  path: string
  name: string
  worktrees: Worktree[]
}

export interface Projects {
  list(seen: string[]): Promise<Project[]>
  add(folder: string): Promise<string | null>
}

export interface ProjectSources {
  file: string
  repo: (dir: string) => Promise<RepoInfo | null>
  worktrees: (project: string) => Promise<Worktree[] | null>
}

function load(file: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))

    return Array.isArray(raw?.projects) ? raw.projects.filter((path: string) => typeof path === 'string') : []
  } catch {
    return []
  }
}

export function createProjects(sources: ProjectSources): Projects {
  const added = load(sources.file)

  return {
    // `seen`: the projects sessions work in right now (from their meta).
    async list(seen) {
      const keys = new Map<string, string>()

      // Windows paths differ only in case at times: the first spelling stays.
      for (const path of [...added, ...seen]) {
        if (!keys.has(path.toLowerCase())) keys.set(path.toLowerCase(), path)
      }

      const projects: Project[] = []

      for (const path of keys.values()) {
        const worktrees = await sources.worktrees(path)

        if (worktrees !== null) projects.push({ path, name: basename(path), worktrees })
      }

      return projects
    },

    // A folder inside a repository adds the repository; anything else is refused.
    async add(folder) {
      const repo = await sources.repo(folder)

      if (repo === null) return null

      if (!added.some((path) => path.toLowerCase() === repo.project.toLowerCase())) {
        added.push(repo.project)

        try {
          mkdirSync(dirname(sources.file), { recursive: true })
          writeFileSync(`${sources.file}.tmp`, JSON.stringify({ projects: added }, null, 2))
          renameSync(`${sources.file}.tmp`, sources.file)
        } catch {
          // Known until the next restart.
        }
      }

      return repo.project
    },
  }
}
