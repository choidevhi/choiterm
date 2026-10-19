// The command-line agents a new tab can run, and which of them this PC has. Each starts in its own
// PowerShell, so when the agent exits the tab stays open as a shell in the same folder. The owner
// signs in to each one inside it the first time, as on any terminal.
import { execFile } from 'node:child_process'

export interface Agent {
  id: string
  label: string
  // What PowerShell runs; null for a plain shell.
  command: string | null
  // How to get it, shown while it is missing.
  install: string
}

export interface AgentState {
  id: string
  label: string
  installed: boolean
  install: string
}

export const AGENTS: Agent[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', install: 'irm https://claude.ai/install.ps1 | iex' },
  { id: 'codex', label: 'Codex', command: 'codex', install: 'npm i -g @openai/codex' },
  { id: 'grok', label: 'Grok', command: 'grok', install: '' },
  { id: 'gemini', label: 'Gemini', command: 'gemini', install: 'npm i -g @google/gemini-cli' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', install: 'npm i -g opencode-ai' },
  { id: 'cursor', label: 'Cursor', command: 'cursor-agent', install: 'https://cursor.com/cli' },
  { id: 'copilot', label: 'GitHub Copilot', command: 'copilot', install: 'npm i -g @github/copilot' },
  { id: 'qwen', label: 'Qwen Code', command: 'qwen', install: 'npm i -g @qwen-code/qwen-code' },
  { id: 'shell', label: 'PowerShell', command: null, install: '' },
]

const BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]))
const CHECK_TIMEOUT_MS = 4000
const CACHE_MS = 60_000

export function agentOf(id: string): Agent | undefined {
  return BY_ID.get(id)
}

export function isAgentId(id: string): boolean {
  return BY_ID.has(id)
}

export function agentLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id
}

// `where.exe` finds a command the way PowerShell would (PATH and PATHEXT).
function onPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('where.exe', [command], { timeout: CHECK_TIMEOUT_MS, windowsHide: true }, (error) => resolve(error === null))
  })
}

export function createAgentCheck(find: (command: string) => Promise<boolean> = onPath, now: () => number = Date.now): () => Promise<AgentState[]> {
  let cached: { at: number; states: Promise<AgentState[]> } | null = null

  const look = async (): Promise<AgentState[]> =>
    Promise.all(
      AGENTS.map(async (agent) => ({
        id: agent.id,
        label: agent.label,
        installed: agent.command === null || (await find(agent.command)),
        install: agent.install,
      })),
    )

  return () => {
    if (cached === null || now() - cached.at > CACHE_MS) cached = { at: now(), states: look() }

    return cached.states
  }
}
