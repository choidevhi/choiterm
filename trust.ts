// Marks folders as trusted Claude Code workspaces in ~/.claude.json, so the "do you trust this
// folder?" question never stops a session (the owner asked for every folder to be trusted). Claude
// walks up to the first trusted folder, except inside a git repository, where only the repository
// root counts: so each folder is trusted at its repository root when it has one.
//
//   node trust.ts <folder>…            trust these folders (their repository roots)
//   node trust.ts --scan <dir>… [--depth N]   trust every repository found below these

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SKIP = new Set(['node_modules', 'AppData', '$Recycle.Bin', 'System Volume Information', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'])

// The key Claude keeps a folder under: an absolute path with forward slashes.
export function projectKey(folder: string): string {
  return resolve(folder).replaceAll('\\', '/')
}

// The repository a folder belongs to, or the folder itself outside any repository.
export function trustRoot(folder: string): string {
  let at = resolve(folder)

  while (true) {
    if (existsSync(join(at, '.git'))) return at

    const up = dirname(at)

    if (up === at) return resolve(folder)

    at = up
  }
}

// Every repository below `dir`, down to `depth` levels, skipping system and dependency folders.
export function findRepositories(dir: string, depth: number): string[] {
  const found: string[] = []
  let entries

  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }

  if (entries.some((entry) => entry.name === '.git')) found.push(resolve(dir))

  if (depth === 0) return found

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue

    found.push(...findRepositories(join(dir, entry.name), depth - 1))
  }

  return found
}

// Adds the folders to the trusted list; returns how many were new. Written whole and renamed in,
// since running Claude Code sessions read the same file.
export function trustFolders(config: string, folders: string[]): number {
  if (!existsSync(config)) return 0

  const data = JSON.parse(readFileSync(config, 'utf8'))
  let added = 0

  data.projects ??= {}

  for (const folder of folders) {
    const key = projectKey(folder)

    if (data.projects[key]?.hasTrustDialogAccepted === true) continue

    data.projects[key] = {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      ...data.projects[key],
      hasTrustDialogAccepted: true,
    }
    added += 1
  }

  if (added > 0) {
    writeFileSync(`${config}.choiterm.tmp`, JSON.stringify(data, null, 2))
    renameSync(`${config}.choiterm.tmp`, config)
  }

  return added
}

export const CLAUDE_CONFIG = join(homedir(), '.claude.json')

if (process.argv[1]?.endsWith('trust.ts')) {
  const args = process.argv.slice(2)
  const depthAt = args.indexOf('--depth')
  const depth = depthAt === -1 ? 4 : Number(args[depthAt + 1])
  const named = args.filter((arg, index) => !arg.startsWith('--') && (depthAt === -1 || index !== depthAt + 1))
  const folders = args.includes('--scan') ? named.flatMap((dir) => findRepositories(dir, depth)) : named.map(trustRoot)

  try {
    const added = trustFolders(CLAUDE_CONFIG, folders)

    if (args.includes('--scan')) console.log(`trusted ${added} new of ${folders.length} repositories`)
  } catch {
    // Never stand between the owner and starting Claude.
  }
}
