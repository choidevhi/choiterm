// What Claude Code's hooks report from inside a ChoiTerm session: a finished turn, a question for
// the owner, or something that needs a look. Kept briefly so a phone that reconnects gets what it
// missed.

export type NoticeKind = 'done' | 'question' | 'attention'

// A button on the phone's notification: what it says and the key it sends to the session (a
// choice's number, or Esc to turn a permission request down).
export interface NoticeAnswer {
  label: string
  keys: string
}

export interface Notice {
  id: number
  session: string
  title: string
  kind: NoticeKind
  text: string
  answers: NoticeAnswer[]
  at: number
}

export interface NoticeInput {
  session: string
  kind: NoticeKind
  text: string
  answers?: NoticeAnswer[]
}

// Android shows at most three action buttons on a notification.
const MAX_ANSWERS = 3
const MAX_LABEL = 40
const ANSWER_KEYS = /^(?:[1-9]|\u001b)$/

export function parseAnswers(raw: NoticeAnswer[]): NoticeAnswer[] {
  const answers: NoticeAnswer[] = []

  for (const answer of Array.isArray(raw) ? raw.slice(0, MAX_ANSWERS) : []) {
    if (typeof answer?.label !== 'string' || typeof answer.keys !== 'string' || !ANSWER_KEYS.test(answer.keys)) return []

    answers.push({ label: answer.label.slice(0, MAX_LABEL), keys: answer.keys })
  }

  return answers
}

export interface Notices {
  add(input: NoticeInput, title: string): Notice
  since(id: number): Notice[]
  subscribe(listener: (notice: Notice) => void): () => void
}

const KEEP = 50
const MAX_TEXT = 400

// Hook text is the start of a markdown answer; a notification wants one plain, short line.
export function shorten(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return plain.length > MAX_TEXT ? `${plain.slice(0, MAX_TEXT - 1)}…` : plain
}

export function parseNoticeInput(text: string): NoticeInput | null {
  let raw

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (raw === null || typeof raw.session !== 'string' || typeof raw.text !== 'string') return null

  if (raw.kind !== 'done' && raw.kind !== 'question' && raw.kind !== 'attention') return null

  return { session: raw.session, kind: raw.kind, text: shorten(raw.text), answers: parseAnswers(raw.answers) }
}

export function createNotices(): Notices {
  const kept: Notice[] = []
  const listeners = new Set<(notice: Notice) => void>()
  let next = Date.now()

  return {
    add(input, title) {
      next += 1

      const notice: Notice = { id: next, session: input.session, title, kind: input.kind, text: input.text, answers: input.answers ?? [], at: Date.now() }

      kept.push(notice)

      if (kept.length > KEEP) kept.shift()

      for (const listener of listeners) listener(notice)

      return notice
    },

    since(id) {
      return kept.filter((notice) => notice.id > id)
    },

    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
  }
}
