import type { HttpInit, On, SessionMeasureInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { cacheTtlMs, EMPTY, withCache, withUsage } from '../hooks/status.ts'

const NOW = Date.parse('2026-10-18T03:00:00Z')

const measure: SessionMeasureInput = {
  context: { window: 200_000, tokens: 28_000, percent: 14 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 3, resetsAt: '2026-10-18T07:00:00Z' },
    { kind: 'seven_day', percentUsed: 66, resetsAt: '2026-10-20T01:00:00Z' },
  ],
  changed: ['context', 'rateLimits'],
}

interface Post {
  url: string
  init: HttpInit | undefined
}

// Answers what the mod asks the engine, and keeps every request it sends.
function engineBeneath(on: On, posts: Post[], env: Record<string, string>): void {
  mock.env(on, env)
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: { effortLevel: 'medium' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('http.fetch', (_, e) => {
    posts.push({ url: e.url, init: e.init })

    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
}

test('in a ChoiTerm session the figures go to its status endpoint', async ($, on) => {
  const posts: Post[] = []

  mock.clock(on, { now: NOW })
  engineBeneath(on, posts, { CHOITERM_SESSION: 'term-1', CHOITERM_PORT: '47190' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure)

  const last = posts.at(-1)
  const body = JSON.parse(last?.init?.body ?? '{}')

  expect(last?.url).toBe('http://127.0.0.1:47190/status')
  expect(last?.init?.method).toBe('POST')
  expect(body.session).toBe('term-1')
  expect(body.status.model).toBe('claude-opus-5-5')
  expect(body.status.effort).toBe('medium')
  expect(body.status.contextPercent).toBe(14)
  expect(body.status.limits.map((limit: { kind: string }) => limit.kind)).toEqual(['five_hour', 'seven_day'])
})

test('outside ChoiTerm nothing is sent', async ($, on) => {
  const posts: Post[] = []

  mock.clock(on, { now: NOW })
  engineBeneath(on, posts, {})
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure)

  expect(posts.length).toBe(0)
})

test('the cache clock restarts only on a response that used the cache', async () => {
  const fresh = withUsage(EMPTY, measure.context, measure.rateLimits)
  const cached = withCache(fresh, NOW, 9_000, 0)

  expect(cached.cache?.at).toBe(NOW)
  expect(cached.cache?.ttlMs).toBe(60 * 60 * 1000)
  expect(withCache(cached, NOW + 1000, 0, 0).cache?.at).toBe(NOW)
  expect(cacheTtlMs([{ kind: 'five_hour', percent: 100, resetsAt: null }])).toBe(5 * 60 * 1000)
})
