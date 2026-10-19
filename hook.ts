// Claude Code hook (SessionStart, Stop, Notification, PreToolUse on AskUserQuestion). Inside a
// ChoiTerm session it tells the server which conversation runs there (so a restart can resume it)
// and that Claude finished, asked something or needs a look, so the phone can show a notification,
// with buttons that answer a question or a permission request from there. Anywhere else it does
// nothing. It never prints and always exits 0, so it can never change what Claude does.

import { readFileSync } from 'node:fs'

type Kind = 'done' | 'question' | 'attention'

interface Answer {
  label: string
  keys: string
}

interface Report {
  kind: Kind
  text: string
  answers: Answer[]
}

interface Question {
  question?: string
  multiSelect?: boolean
  options?: { label?: string }[]
}

const TIMEOUT_MS = 2000
// Android shows three buttons at most.
const MAX_ANSWERS = 3
const ESC = '\u001b'

// A single one-choice question can be answered from the notification: each button presses the
// option's number. Several questions or a multi-select need the screen.
function questionReport(input: { questions?: Question[] } | undefined): Report {
  const questions = input?.questions ?? []
  const first = questions[0]
  const answers: Answer[] = []

  if (questions.length === 1 && first?.multiSelect !== true) {
    for (const [index, option] of (first?.options ?? []).slice(0, MAX_ANSWERS).entries()) {
      if (typeof option?.label === 'string') answers.push({ label: option.label, keys: String(index + 1) })
    }
  }

  return { kind: 'question', text: first?.question ?? '질문이 있어요', answers }
}

// Parses the hook's stdin into what is worth a notification, or null for nothing.
export function reportFor(stdin: string): Report | null {
  let event

  try {
    event = JSON.parse(stdin)
  } catch {
    return null
  }

  switch (event?.hook_event_name) {
    case 'Stop':
      return { kind: 'done', text: typeof event.last_assistant_message === 'string' ? event.last_assistant_message : '작업을 마쳤어요', answers: [] }
    case 'Notification': {
      // The idle reminder repeats the Stop notice a minute later.
      if (event.notification_type === 'idle_prompt' || typeof event.message !== 'string') return null

      // A permission prompt takes 1 for yes; Esc turns it down.
      const answers = event.notification_type === 'permission_prompt' ? [{ label: '허용', keys: '1' }, { label: '거절', keys: ESC }] : []

      return { kind: 'attention', text: event.message, answers }
    }
    case 'PreToolUse':
      return event.tool_name === 'AskUserQuestion' ? questionReport(event.tool_input) : null
    default:
      return null
  }
}

// Which conversation the event came from and its folder: a restart of ChoiTerm resumes it there.
export function conversationOf(stdin: string): { conversation: string; cwd: string | null } | null {
  let event

  try {
    event = JSON.parse(stdin)
  } catch {
    return null
  }

  if (typeof event?.session_id !== 'string') return null

  return { conversation: event.session_id, cwd: typeof event.cwd === 'string' ? event.cwd : null }
}

async function main(): Promise<void> {
  const session = process.env.CHOITERM_SESSION
  const port = process.env.CHOITERM_PORT

  if (session === undefined || port === undefined) return

  const stdin = readFileSync(0, 'utf8')
  const conversation = conversationOf(stdin)

  if (conversation !== null) {
    await fetch(`http://127.0.0.1:${port}/conversation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, ...conversation }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {})
  }

  const report = reportFor(stdin)

  if (report === null) return

  await fetch(`http://127.0.0.1:${port}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, kind: report.kind, text: report.text, answers: report.answers }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

if (process.argv[1]?.endsWith('hook.ts')) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0))
}
