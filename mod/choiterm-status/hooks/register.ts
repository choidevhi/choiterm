// Inside a ChoiTerm session (CHOITERM_SESSION set), sends the usage figures to ChoiTerm on every
// change, for the status bar under its tabs. Anywhere else it does nothing. It never draws.
import type { EngineInterface, Register, Settings } from 'claude-code'
import { EMPTY, withCache, withUsage, type Effort, type Status } from './status.ts'

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function isRecord(value: Settings[string]): value is Readonly<Record<string, Settings[string]>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEffort(value: Settings[string]): value is Effort {
  return (typeof value === 'number' && Number.isFinite(value)) || EFFORT_LEVELS.some((name) => name === value)
}

// Before the first request says it, the effort comes from settings.json: the model's own entry
// first, then the global one.
function effortFromSettings(settings: Settings, model: string): Effort | null {
  const perModel = settings.modelSettings
  const entry = isRecord(perModel) ? perModel[model] : undefined
  const fromModel = isRecord(entry) ? entry.effortLevel : undefined

  if (isEffort(fromModel)) return fromModel

  const global = settings.effortLevel

  return isEffort(global) ? global : null
}

interface Target {
  session: string
  port: string
}

let target: Target | null = null
let status: Status = EMPTY

async function findTarget($: EngineInterface): Promise<Target | null> {
  const [session, port] = await Promise.all([$.env.get('CHOITERM_SESSION'), $.env.get('CHOITERM_PORT')])

  return session !== undefined && port !== undefined && /^\d+$/.test(port) ? { session, port } : null
}

async function send($: EngineInterface): Promise<void> {
  if (target === null) return

  await $.http
    .fetch(`http://127.0.0.1:${target.port}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: target.session, status }),
    })
    .catch(() => undefined)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    target = await findTarget($)

    if (target === null) return result

    const [usage, model, settings] = await Promise.all([$.session.usage(), $.session.model(), $.settings.read()])

    status = { ...withUsage(status, usage.context, usage.rateLimits), model, effort: status.effort ?? effortFromSettings(settings, model) }
    await send($)

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (target !== null) {
      status = withUsage(status, e.context, e.rateLimits)
      await send($)
    }

    return next(e)
  })

  // Each request of the main conversation names its model and effort (also after /model and
  // /effort); its answer says whether the prompt cache was used.
  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined

    if (target !== null && isMain) {
      status = { ...status, model: e.model, effort: e.effort ?? status.effort }
      await send($)
    }

    const result = yield* next(e)

    if (target !== null && isMain && result.usage !== null) {
      status = withCache(status, await $.clock.now(), result.usage.cache_read_input_tokens, result.usage.cache_creation_input_tokens)
      await send($)
    }

    return result
  })
}
