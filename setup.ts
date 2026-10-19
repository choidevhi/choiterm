// The parts of setting ChoiTerm up on another PC (install.ts) that need no PC to try: the config
// from the tailnet, and ChoiTerm's entries in Claude Code's settings.hooks next to everyone else's.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TAILNET_PORT, type Tailnet } from './machines.ts'
import type { Settings } from './server.ts'

export type Json = null | boolean | number | string | Json[] | JsonObject
export type JsonObject = { [key: string]: Json }

export const SERVER_PORT = 47190

// The version in a folder's package.json; a file saved by Windows PowerShell starts with a BOM,
// which JSON.parse refuses.
export function packageVersion(folder: string): string | null {
  try {
    const version = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8').replace(/^﻿/, '')).version

    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

// The processes listening on 127.0.0.1:<port> in `netstat -ano -p TCP` output: how an update finds
// the installed server even when it left no id behind (or a stale one).
export function listenerPids(netstat: string, port: number): number[] {
  const pids = new Set<number>()

  for (const line of netstat.split(/\r?\n/)) {
    const [proto, local, , state, pid] = line.trim().split(/\s+/)

    if (proto === 'TCP' && local === `127.0.0.1:${port}` && state === 'LISTENING' && Number(pid) > 0) pids.add(Number(pid))
  }

  return [...pids]
}

// Only the owner's own Tailscale login gets in over the tailnet, at this PC's tailnet name.
export function configFor(tailnet: Tailnet | null, port: number): Settings {
  const dns = tailnet?.self?.dns

  return {
    owner: tailnet?.owner ?? '',
    hosts: dns === undefined ? [] : [`${dns}:${TAILNET_PORT}`],
    port,
  }
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJsonObject(text: string): JsonObject | null {
  try {
    const value: Json = JSON.parse(text)

    return isObject(value) ? value : null
  } catch {
    return null
  }
}

// hook.ts reports a session's conversation (SessionStart), finished turns (Stop), questions
// (AskUserQuestion) and waits for permission (Notification).
const HOOK_EVENTS: { event: string; matcher?: string }[] = [
  { event: 'SessionStart' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion' },
  { event: 'Notification' },
  { event: 'Stop' },
]
const HOOK_TIMEOUT_S = 5

const slashes = (path: string): string => path.replaceAll('\\', '/')

// Ours: a command running something in the installed app's folder.
function isOurs(hook: Json, app: string): boolean {
  return isObject(hook) && typeof hook.command === 'string' && slashes(hook.command).includes(`${slashes(app)}/`)
}

export function withoutOurHooks(hooks: JsonObject, app: string): JsonObject {
  const out: JsonObject = {}

  for (const [event, groups] of Object.entries(hooks)) {
    const kept: Json[] = []

    for (const group of Array.isArray(groups) ? groups : []) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group)
        continue
      }

      const inner = group.hooks.filter((hook) => !isOurs(hook, app))

      if (inner.length > 0) kept.push({ ...group, hooks: inner })
    }

    if (kept.length > 0) out[event] = kept
  }

  return out
}

// `node` is the installed server's own Node, named in full, so the hooks work without one on PATH;
// both it and `hook` sit in the `app` folder.
export function withOurHooks(hooks: JsonObject, app: string, node: string, hook: string): JsonObject {
  const out = withoutOurHooks(hooks, app)
  const command = `"${slashes(node)}" --no-warnings "${slashes(hook)}"`

  for (const { event, matcher } of HOOK_EVENTS) {
    const groups = out[event]
    const entry: JsonObject = { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }

    if (matcher !== undefined) entry.matcher = matcher

    out[event] = [...(Array.isArray(groups) ? groups : []), entry]
  }

  return out
}
