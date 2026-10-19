import { Terminal } from '/vendor/xterm.mjs'
import { FitAddon } from '/vendor/addon-fit.mjs'
import { Unicode11Addon } from '/vendor/addon-unicode11.mjs'
import { BRANCH_ICON, CHEVRON_ICON, CLOSE_ICON, FILE_ICON, FOLDER_ICON, GLOBE_ICON, PLUS_ICON, UI, agentIcon, agentMark, icon } from '/icons.js'
import { fileName as docName, showDiff, showFile, showWeb } from '/docs.js'
import { createMiniTerm } from '/mini-term.js'

// Rows Claude Code padded to the edge (diff lines, boxes) make the terminal think the next row
// continues them, and a wider terminal then glues two or three narrow lines into one: after a phone
// used the session, the PC saw them side by side. A row after one ending in padding (two or more
// spaces) starts its own line again; a real long line, cut mid-word, still joins up. Call it just
// before resizing. (The server does the same to its copy; see sessions.ts.)
function unwrapPadded(term) {
  const lines = term._core?.buffer?.lines
  const view = term.buffer.active

  if (lines === undefined || typeof lines.get !== 'function') return

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines.get(index)

    if (line?.isWrapped && /\s{2,}$/.test(view.getLine(index - 1)?.translateToString(false) ?? '')) line.isWrapped = false
  }
}

// Terminal colours: Ghostty's default dark and the Tango light. style.css --term matches their
// backgrounds.
const PALETTES = {
  dark: {
    background: '#282c34', foreground: '#ffffff', cursor: '#ffffff', cursorAccent: '#282c34',
    selectionBackground: '#5a7898', selectionForeground: '#ffffff',
    black: '#1d1f21', red: '#cc6666', green: '#b5bd68', yellow: '#f0c674',
    blue: '#81a2be', magenta: '#b294bb', cyan: '#8abeb7', white: '#c5c8c6',
    brightBlack: '#666666', brightRed: '#d54e53', brightGreen: '#b9ca4a', brightYellow: '#e7c547',
    brightBlue: '#7aa6da', brightMagenta: '#c397d8', brightCyan: '#70c0b1', brightWhite: '#eaeaea',
  },
  light: {
    background: '#ffffff', foreground: '#2e3434', cursor: '#2e3434', cursorAccent: '#ffffff',
    selectionBackground: '#accef7', selectionForeground: '#2e3434',
    black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#8e7700',
    blue: '#3465a4', magenta: '#75507b', cyan: '#05727e', white: '#6a6a6a',
    brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#1b7a1b', brightYellow: '#6d5a00',
    brightBlue: '#204a87', brightMagenta: '#ad7fa8', brightCyan: '#034b50', brightWhite: '#3d3d3d',
  },
}

// Named keys a combination can be built on, and how a terminal spells each one.
const SPECIAL = {
  esc: { label: 'Esc' },
  tab: { label: 'Tab' },
  enter: { label: 'Enter' },
  backspace: { label: 'Backspace' },
  delete: { label: 'Del' },
  up: { label: 'Up', final: 'A' },
  down: { label: 'Down', final: 'B' },
  right: { label: 'Right', final: 'C' },
  left: { label: 'Left', final: 'D' },
  home: { label: 'Home', final: 'H' },
  end: { label: 'End', final: 'F' },
  pgup: { label: 'PgUp', tilde: 5 },
  pgdn: { label: 'PgDn', tilde: 6 },
}

const MODIFIERS = ['ctrl', 'alt', 'shift']
const MOD_LABEL = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }

// The xterm modifier number: 1 plus Shift 1, Alt 2, Ctrl 4.
function modifierCode(mods) {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

function anyModifier(mods) {
  return mods.ctrl || mods.alt || mods.shift
}

// Turns a key (one character or a SPECIAL name) plus held modifiers into the bytes a terminal
// sends for it.
function encodeKey(key, mods, appCursor) {
  const special = SPECIAL[key]

  if (special === undefined) {
    let char = mods.shift ? key.toUpperCase() : key

    if (mods.ctrl) {
      const upper = char.toUpperCase()
      const code = upper.charCodeAt(0)

      if (char === ' ') char = '\x00'
      else if (char === '?') char = '\x7f'
      else if (code >= 64 && code <= 95) char = String.fromCharCode(code & 0x1f)
    }

    return mods.alt ? `\x1b${char}` : char
  }

  const code = modifierCode(mods)

  if (special.final !== undefined) {
    if (code > 1) return `\x1b[1;${code}${special.final}`

    return appCursor && 'ABCD'.includes(special.final) ? `\x1bO${special.final}` : `\x1b[${special.final}`
  }

  if (special.tilde !== undefined) return code > 1 ? `\x1b[${special.tilde};${code}~` : `\x1b[${special.tilde}~`

  const alt = mods.alt ? '\x1b' : ''

  switch (key) {
    case 'esc':
      return `${alt}\x1b`
    case 'tab':
      return mods.shift ? '\x1b[Z' : `${alt}\t`
    case 'enter':
      // Shift or Ctrl with Enter means "new line, don't send" in Claude Code; LF does that.
      return mods.shift || mods.ctrl ? '\n' : `${alt}\r`
    case 'backspace':
      return mods.ctrl ? '\x08' : `${alt}\x7f`
    case 'delete':
      return code > 1 ? `\x1b[3;${code}~` : '\x1b[3~'
    default:
      return ''
  }
}

function comboLabel(key, mods) {
  const parts = []

  for (const mod of MODIFIERS) {
    if (mods[mod]) parts.push(MOD_LABEL[mod])
  }

  parts.push(SPECIAL[key]?.label ?? key.toUpperCase())

  return parts.join('+')
}

// Every key the bar can show. `mod` keys are sticky: they apply to the next key or typed letter.
const CATALOG = {
  esc: { label: 'Esc', key: 'esc' },
  'esc-esc': { label: 'Esc Esc', text: '\x1b\x1b', hint: 'Claude 되돌리기' },
  tab: { label: 'Tab', key: 'tab' },
  'shift-tab': { label: 'Shift+Tab', key: 'tab', mods: { shift: true }, hint: '모드 전환', icon: 'shift', iconLabel: 'Tab' },
  up: { label: '위', key: 'up', icon: 'up' },
  down: { label: '아래', key: 'down', icon: 'down' },
  left: { label: '왼쪽', key: 'left', icon: 'left' },
  right: { label: '오른쪽', key: 'right', icon: 'right' },
  home: { label: 'Home', key: 'home' },
  end: { label: 'End', key: 'end' },
  pgup: { label: 'PgUp', key: 'pgup' },
  pgdn: { label: 'PgDn', key: 'pgdn' },
  backspace: { label: '지우기', key: 'backspace', icon: 'backspace' },
  delete: { label: 'Del', key: 'delete' },
  enter: { label: 'Enter', key: 'enter', icon: 'enter' },
  paste: { label: '붙여넣기', action: 'paste', icon: 'paste', hint: '클립보드 붙여넣기' },
  newline: { label: '줄바꿈', key: 'enter', mods: { shift: true }, hint: '보내지 않고 줄바꿈', icon: 'enter', iconLabel: '줄' },
  'mod-ctrl': { label: 'Ctrl', mod: 'ctrl' },
  'mod-alt': { label: 'Alt', mod: 'alt' },
  'mod-shift': { label: 'Shift', mod: 'shift' },
  'ctrl-c': { label: '^C', key: 'c', mods: { ctrl: true }, hint: '중단' },
  'ctrl-d': { label: '^D', key: 'd', mods: { ctrl: true } },
  'ctrl-l': { label: '^L', key: 'l', mods: { ctrl: true }, hint: '화면 정리' },
  'ctrl-o': { label: '^O', key: 'o', mods: { ctrl: true }, hint: 'Claude 기록 보기' },
  'ctrl-r': { label: '^R', key: 'r', mods: { ctrl: true }, hint: '이전 입력 검색' },
  'ctrl-z': { label: '^Z', key: 'z', mods: { ctrl: true } },
  'ctrl-g': { label: '^G', key: 'g', mods: { ctrl: true }, hint: '편집기로 열기' },
  slash: { label: '/', text: '/' },
  bang: { label: '!', text: '!', hint: 'Claude 셸 모드' },
  at: { label: '@', text: '@', hint: '파일 언급' },
}

const DEFAULT_LAYOUT = ['paste', 'esc', 'tab', 'shift-tab', 'mod-ctrl', 'up', 'down', 'left', 'right', 'backspace', 'ctrl-c', 'enter']
const KEYS_STORE = 'choiterm.keys'
const SCROLL_STORE = 'choiterm.scroll'
// Rows of finger travel per row scrolled: at normal the text stays under the finger.
const SCROLL_SPEEDS = { slow: 1.5, normal: 1, fast: 0.6 }
// A full-screen app that takes the mouse scrolls 3 rows per wheel notch.
const ROWS_PER_NOTCH = 3
const LAST_KEY = 'choiterm.last'
const FONT = "'Monoplex KR', D2Coding, 'Malgun Gothic', 'ChoiTerm Symbols', monospace"

const dark = matchMedia('(prefers-color-scheme: dark)')
const touch = matchMedia('(pointer: coarse)').matches

const $ = (id) => document.getElementById(id)

// The page's own buttons name their lucide icon (data-icon); drawn once here.
for (const element of document.querySelectorAll('[data-icon]')) {
  element.insertAdjacentHTML('afterbegin', icon(element.dataset.icon, Number(element.dataset.size ?? 16), Number(element.dataset.stroke ?? 2)))
}
const stage = $('stage')
const screen = $('screen')
const tabs = $('tabs')
const empty = $('empty')
const emptyText = $('emptyText')
const showList = $('showList')
const appEl = $('app')
const backHome = $('backHome')
const headTitle = $('headTitle')
const headSub = $('headSub')
const scrim = $('scrim')
const list = $('list')
const pickButton = $('pick')
const foot = $('foot')
const killButton = $('kill')
const archiveButton = $('archivePicked')
const menu = $('menu')
const addButton = $('add')
const dot = $('dot')
const text = $('text')

let socket = null
let retry = 0
let sessions = []
let current = null
// The owner's PCs running ChoiTerm (see refreshMachines); the key bar shows them on a phone.
let machines = []
let serverSize = { cols: 0, rows: 0 }

// Sessions with something new (a finished turn, a question) that this screen has not looked at.
const unread = new Set()
// Per session: git project and branch, busy, last line, web servers (the server's `meta`).
const metaById = new Map()
// Files and web pages open as tabs on this device ({ id, type: 'file' | 'web', title, path | url,
// pane: 'main' | 'second' }), and the one on screen instead of the terminal (null: the terminal).
const DOCS_KEY = 'choiterm.docs'
let docs = []
let view = null
// The PC's home page is on screen instead of a tab (showHome).
let homeOpen = false

try {
  const kept = JSON.parse(load(DOCS_KEY) ?? '[]')

  if (Array.isArray(kept)) docs = kept.filter((doc) => typeof doc?.id === 'string' && ['file', 'web', 'diff'].includes(doc.type))
} catch {
  // Start without.
}

// Codex's limits and the PC's memory for the PC's bottom line (refreshUsage).
let codexLimits = null
let system = null

// The agents this PC can run (`/agents`), for the + menu.
let agents = [{ id: 'claude', label: 'Claude Code', installed: true }, { id: 'codex', label: 'Codex', installed: true }, { id: 'shell', label: 'PowerShell', installed: true }]

function load(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function save(key, value) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Private windows may refuse storage; tabs then last only until the page reloads.
  }
}

// The tabs are the sessions of the open session's checkout (its git worktree, else its folder),
// oldest first; the side list holds every project. Closing a tab puts the session in
// the archive (it keeps running, and comes back from the list); which tab a screen looks at is its
// own. `allTabs` is every running session outside the archive.
let openTabs = []
let allTabs = []

// Where a session works: its git checkout, else its folder ('' when unknown).
function scopeOf(id) {
  const meta = metaById.get(id)
  const session = sessions.find((each) => each.id === id)

  return (meta?.repo?.root ?? session?.cwd ?? '').toLowerCase()
}

function refreshTabs() {
  allTabs = []

  for (const session of [...sessions].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!session.archived) allTabs.push(session.id)
  }

  const scope = current === null ? null : scopeOf(current)

  openTabs = scope === null ? [...allTabs] : allTabs.filter((id) => scopeOf(id) === scope)

  // A session just opened from the archive (or not yet in the list) still gets its tab.
  if (current !== null && !openTabs.includes(current) && sessions.some((each) => each.id === current)) openTabs.push(current)
}

// A notification tap on the phone opens its session: `#open=<id>` on load, choiterm.open later.
let pendingOpen = new URLSearchParams(location.hash.slice(1)).get('open')

await Promise.all([
  document.fonts.load(`500 14px ${FONT}`),
  document.fonts.load(`400 14px 'ChoiTerm Symbols'`, '⏵'),
]).catch(() => [])

const term = new Terminal({
  fontFamily: FONT,
  fontSize: touch ? 12 : 15,
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 5000,
  allowProposedApi: true,
  theme: dark.matches ? PALETTES.dark : PALETTES.light,
})

const fit = new FitAddon()

term.loadAddon(fit)
term.loadAddon(new Unicode11Addon())
term.unicode.activeVersion = '11'
term.open(screen)

// On a phone the input bar does the typing: tapping the terminal must never pop the keyboard.
// inputmode=none alone does not stop Android keyboards, so xterm's hidden box is read-only there
// and lets go of focus right away (key bar keys and the input bar send input without it).
if (touch && term.textarea !== undefined) {
  const helper = term.textarea

  helper.setAttribute('inputmode', 'none')
  helper.readOnly = true
  helper.addEventListener('focus', () => helper.blur())
}

dark.addEventListener('change', () => {
  term.options.theme = dark.matches ? PALETTES.dark : PALETTES.light
})

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function sendInput(data) {
  if (current === null) return

  claim()
  send({ t: 'in', id: current, d: data })
}

// Wheel notches this screen has sent up into a full-screen app (Claude Code) and not back down.
// The app scrolls itself, so this count is the only way to know a "back to the bottom" is useful.
let wheeledUp = 0

// Typing, a key or a send goes back to the newest output first: Claude keeps its scroll position
// while you type, so the reply would otherwise arrive out of sight.
function input(data) {
  // An empty paste (nothing but an image on the clipboard) has nothing to type.
  if (current === null || data === '') return

  toNewest()
  sendInput(data)
}

// One terminal has one size. Whoever is using it (typing, focused, just opened it) sets it; the
// other screens show the same grid, shrunk to fit when it is bigger than they are.
function claim() {
  const wanted = fit.proposeDimensions()

  if (current === null || wanted === undefined) return

  if (wanted.cols !== serverSize.cols || wanted.rows !== serverSize.rows) {
    send({ t: 'resize', id: current, cols: wanted.cols, rows: wanted.rows })
  }
}

function applySize(cols, rows) {
  serverSize = { cols, rows }

  if (term.cols !== cols || term.rows !== rows) {
    unwrapPadded(term)
    term.resize(cols, rows)
  }

  const room = fit.proposeDimensions()

  if (room === undefined) return

  const scale = Math.min(1, room.cols / cols, room.rows / rows)

  screen.style.transform = scale < 1 ? `scale(${scale})` : ''
  scheduleLinks()
}

function select(id, show = true) {
  // What the input bar typed, and how far it scrolled, belong to the session they were done in: the
  // draft is put away with it and comes back with it.
  if (id !== current) {
    keepDraft()
    wheeledUp = 0
  }

  const switched = id !== current

  current = id

  if (switched) restoreDraft(id)

  save(LAST_KEY, id)

  if (id !== null) unread.delete(id)

  view = null
  panelOverride = null
  refreshTabs()
  term.reset()
  screen.style.transform = ''
  render()

  if (id !== null && touch && show) setView('session')

  // No session to show on the PC: its home instead.
  showHome(id === null)

  followFiles()

  if (panel === 'images') refreshPanel()

  if (id !== null) send({ t: 'attach', id })
}

function pickAfterListChange() {
  const running = new Set(sessions.map((session) => session.id))

  refreshTabs()

  const alive = new Set(allTabs)

  for (const id of unread) {
    if (!running.has(id)) unread.delete(id)
  }

  if (pendingOpen !== null && alive.has(pendingOpen)) {
    const id = pendingOpen

    pendingOpen = null
    select(id)

    return
  }

  if (current !== null && allTabs.includes(current)) {
    render()

    return
  }

  const last = load(LAST_KEY)
  // The next tab of the same checkout, else any running session.
  const near = openTabs.find((id) => id !== current && allTabs.includes(id))

  select(last !== null && allTabs.includes(last) ? last : near ?? allTabs[0] ?? null, false)
}

// Shown at once here; the server's list then brings every other screen along.
function hideTab(id) {
  const session = sessions.find((each) => each.id === id)

  if (session === undefined) return

  session.archived = true
  send({ t: 'archive', id, archived: true })
  notice('보관함으로 옮겼어요. 목록에서 다시 열 수 있어요')
  pickAfterListChange()
}

// The owner's name for a session when it has one, still led by Claude Code's status mark (✳ and a
// spinner) so a renamed session shows whether it is working.
function displayName(session) {
  if (session.name === null || session.name === undefined) return session.title

  const mark = session.title.match(/^[^\p{L}\p{N}]+/u)?.[0] ?? ''

  return `${mark}${session.name}`
}

// Claude Code puts its own status mark in front of the title; a fresh one has none yet.
function needsStar(session) {
  return session.kind === 'claude' && !/^[^\p{L}\p{N}]/u.test(displayName(session))
}

function star() {
  const mark = document.createElement('span')

  mark.className = 'star'
  mark.textContent = '✻'

  return mark
}

function agentName(kind) {
  return agents.find((agent) => agent.id === kind)?.label ?? kind
}

function tabCloser(label, onClose) {
  const hide = document.createElement('span')

  hide.className = 'x'
  hide.innerHTML = icon('x', 12)
  hide.setAttribute('role', 'button')
  hide.setAttribute('aria-label', label)
  hide.addEventListener('click', (event) => {
    event.stopPropagation()
    onClose()
  })

  return hide
}

// A tab: the agent's state and mark, the name, and × (shown on the open tab and on hover).
function sessionTab(session) {
  const id = session.id
  const tab = document.createElement('button')
  const name = document.createElement('span')
  const lead = document.createElement('span')
  const busy = metaById.get(id)?.busy === true
  const fresh = unread.has(id)

  tab.className = 'tab'
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', String(id === current && view === null && !homeOpen))
  tab.toggleAttribute('data-unread', fresh)
  tab.title = displayName(session)
  lead.className = 'tab-lead'

  if (fresh) lead.innerHTML = '<svg class="bell" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M10.268 21a2 2 0 0 0 3.464 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" fill="currentColor"/></svg>'
  else if (busy) lead.append(agentDot(true, false))

  lead.append(agentIcon(session.kind, 12))
  name.className = 'name'
  name.textContent = touch && session.kind !== 'shell' ? agentName(session.kind) : plainName(session)
  tab.append(lead, name, tabCloser('보관함으로 (세션은 계속 실행)', () => hideTab(id)))
  tab.addEventListener('click', () => {
    if (id !== current || view !== null || homeOpen) select(id)
  })

  return tab
}

function docTab(doc, onOpen = () => showDoc(doc.id), selected = view === doc.id) {
  const tab = document.createElement('button')
  const name = document.createElement('span')
  const lead = document.createElement('span')

  tab.className = 'tab'
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', String(selected))
  tab.title = doc.type === 'file' ? doc.path : doc.url
  lead.className = 'tab-lead'
  lead.innerHTML = doc.type === 'web' ? `<span class="web-mark">${icon('globe', 12)}</span>` : doc.type === 'diff' ? icon('git-compare-arrows', 12) : icon('file-text', 12)
  name.className = 'name'
  name.textContent = doc.title
  tab.append(lead, name, tabCloser('닫기', () => closeDoc(doc.id)))
  tab.addEventListener('click', onOpen)

  return tab
}

// The session's name without Claude Code's leading status mark (the tab shows its own).
function plainName(session) {
  return displayName(session).replace(/^[^\p{L}\p{N}]+/u, '') || displayName(session)
}

function render() {
  tabs.replaceChildren()

  for (const id of openTabs) {
    const session = sessions.find((info) => info.id === id)

    if (session !== undefined) tabs.append(sessionTab(session))
  }

  for (const doc of docs) {
    if (doc.pane !== 'second') tabs.append(docTab(doc))
  }

  const active = sessions.find((session) => session.id === current)
  const viewing = docs.find((doc) => doc.id === view)

  empty.hidden = active !== undefined || viewing !== undefined
  stage.hidden = viewing !== undefined
  docBox.hidden = viewing === undefined
  renderStatus()
  renderFooter()
  renderEmpty()
  emptyText.textContent = sessions.length === 0 ? '무엇을 열까요?' : `탭이 비어 있어요. 실행 중인 세션 ${sessions.length}개는 목록에 있어요`
  showList.hidden = sessions.length === 0 || !touch
  document.title = viewing !== undefined ? `${viewing.title} · ChoiTerm` : active === undefined ? 'ChoiTerm' : `${plainName(active)} · ChoiTerm`
  const activeRepo = active === undefined ? null : metaById.get(active.id)?.repo
  const worktreeName = activeRepo ? (activeRepo.worktree ? baseName(activeRepo.root) : activeRepo.name) : null

  headTitle.textContent = viewing?.title ?? worktreeName ?? (active === undefined ? 'ChoiTerm' : plainName(active))

  const busy = openTabs.filter((id) => metaById.get(id)?.busy).length

  headSub.textContent = active === undefined ? '' : `탭 ${openTabs.length}개${busy > 0 ? ` · ${busy}개 작업 중` : ''}`
  $('headDot').dataset.state = dot.dataset.state ?? ''
  renderDrawer()
}

const NOTICE_LABEL = { done: '끝났어요', question: '질문이 있어요', attention: '확인이 필요해요' }

function handle(message) {
  switch (message.t) {
    case 'list':
      sessions = message.sessions
      render()
      pickAfterListChange()
      break
    case 'notice': {
      const { session, kind, title } = message.notice
      const looking = session === current && document.visibilityState === 'visible'

      if (!looking) unread.add(session)

      if (document.visibilityState === 'visible' && session !== current) notice(`${title} · ${NOTICE_LABEL[kind]}`)

      render()
      break
    }
    case 'snapshot':
      if (message.id !== current) {
        current = message.id
        save(LAST_KEY, current)
        render()
      }

      term.reset()
      applySize(message.cols, message.rows)
      term.write(message.d)
      claim()
      renderShots()
      break
    case 'out':
      if (message.id === current) term.write(message.d)

      break
    case 'size':
      if (message.id === current) applySize(message.cols, message.rows)

      break
    case 'exit':
      if (message.id === current) {
        current = null
        term.reset()
        renderShots()
      }

      break
    case 'gallery':
      galleryChanged(message.items)
      break
    case 'status':
      statuses.set(message.id, message.status)

      if (message.id === current) renderStatus()

      renderFooter()
      break
    case 'meta': {
      const scopeBefore = current === null ? null : scopeOf(current)

      const knownRoots = new Set([...metaById.values()].map((item) => item.repo?.root))

      metaById.clear()

      for (const item of message.meta) {
        metaById.set(item.id, item)

        if (item.busy) lastActive.set(item.id, Date.now())
      }

      // A session in a worktree the list has not seen (a new task): ask for the projects again.
      if (message.meta.some((item) => item.repo && !knownRoots.has(item.repo.root))) void refreshProjects()

      refreshTabs()
      render()

      // The open session's project became known: the file panel follows it.
      if (current !== null && scopeOf(current) !== scopeBefore) followFiles()

      break
    }
    case 'error':
      notice(message.text)
      break
  }
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'

  socket = new WebSocket(`${scheme}://${location.host}/ws`)
  dot.dataset.state = 'connecting'

  socket.addEventListener('open', () => {
    const reconnected = retry > 0

    retry = 0
    dot.dataset.state = 'open'

    if (current !== null) send({ t: 'attach', id: current })

    // Back after the server restarted: an update brings a new page, which a window that is never
    // hidden (the PC program) would otherwise not load.
    if (reconnected) void checkForUpdate()
  })

  socket.addEventListener('message', (event) => handle(JSON.parse(event.data)))

  socket.addEventListener('close', () => {
    dot.dataset.state = 'closed'
    retry = Math.min(retry + 1, 5)
    setTimeout(connect, retry * 1000)
  })
}

// The folder a new tab opens in: the open session's checkout or folder, else the home folder.
function currentFolder() {
  if (current === null) return null

  return metaById.get(current)?.repo?.root ?? sessions.find((each) => each.id === current)?.cwd ?? null
}

function openSession(kind, cwd = currentFolder()) {
  const size = fit.proposeDimensions() ?? { cols: 100, rows: 30 }

  closeAddMenu()
  closeDrawer()
  send({ t: 'new', kind, cols: size.cols, rows: size.rows, cwd })
}

async function refreshAgents() {
  try {
    const body = await (await fetch('/agents', { cache: 'no-store' })).json()

    if (Array.isArray(body?.agents) && body.agents.length > 0) agents = body.agents
  } catch {
    // The defaults stay.
  }
}

function closeAddMenu() {
  menu.hidden = true
  addButton.setAttribute('aria-expanded', 'false')
}

function shortFolder(path) {
  if (path === null) return '홈 폴더'

  const parts = path.split(/[\\/]/).filter(Boolean)

  return parts.length <= 2 ? path : `…\\${parts.slice(-2).join('\\')}`
}

// The + menu: an agent for a new tab in this checkout, another folder, or a new worktree.
// The + menu: an agent for a new tab in this checkout.
function agentButton(agent, onPick) {
  const button = document.createElement('button')
  const label = document.createElement('span')

  button.type = 'button'
  button.disabled = !agent.installed
  label.textContent = agent.label
  button.append(agentIcon(agent.id, 14), label)

  if (!agent.installed) {
    const hint = document.createElement('span')

    hint.className = 'hint'
    hint.textContent = '설치 안 됨'
    button.append(hint)
    button.title = agent.install ? `설치: ${agent.install}` : '이 PC에 없어요'
  }

  button.addEventListener('click', () => onPick(agent.id))

  return button
}

let showMissing = false

// The + menu: a search over what can open, a terminal, the agents this PC
// has, then another folder and a new workspace.
function renderAddMenu(cwd = currentFolder()) {
  const field = document.createElement('input')
  const where = document.createElement('div')
  const rows = document.createElement('div')
  const draw = () => {
    const words = field.value.trim().toLowerCase()
    const entries = []
    const shell = agents.find((agent) => agent.id === 'shell')

    if (shell !== undefined) entries.push(agentButton({ ...shell, label: '새 터미널' }, (kind) => openSession(kind, cwd)))

    for (const agent of agents) {
      if (agent.id !== 'shell' && agent.installed && agent.label.toLowerCase().includes(words)) entries.push(agentButton(agent, (kind) => openSession(kind, cwd)))
    }

    if (showMissing) {
      for (const agent of agents) {
        if (!agent.installed && agent.label.toLowerCase().includes(words)) entries.push(agentButton(agent, () => {}))
      }
    }

    const missing = agents.filter((agent) => !agent.installed).length

    if (missing > 0 && words === '') {
      const more = document.createElement('button')

      more.type = 'button'
      more.className = 'menu-more'
      more.innerHTML = `<span>설치 안 된 에이전트 ${missing}개</span>${icon(showMissing ? 'chevron-up' : 'chevron-down', 13)}`
      more.addEventListener('click', () => {
        showMissing = !showMissing
        draw()
      })
      entries.push(more)
    }

    const sep = document.createElement('div')
    const elsewhere = document.createElement('button')
    const worktree = document.createElement('button')

    sep.className = 'menu-sep'
    elsewhere.type = 'button'
    elsewhere.innerHTML = `${icon('folder-open', 14)}<span>다른 폴더에서…</span>`
    elsewhere.addEventListener('click', () => {
      closeAddMenu()
      openFolderSheet(cwd)
    })
    worktree.type = 'button'
    worktree.innerHTML = `${icon('git-branch', 14)}<span>새 작업 공간…</span><span class="hint">Ctrl N</span>`
    worktree.addEventListener('click', () => {
      closeAddMenu()
      openCreate()
    })
    entries.push(sep, elsewhere, worktree)
    rows.replaceChildren(...entries)
  }

  field.className = 'menu-search'
  field.type = 'search'
  field.placeholder = '열 것 찾기…'
  field.addEventListener('input', draw)
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') rows.querySelector('button:not(:disabled):not(.menu-more)')?.click()
  })
  where.className = 'menu-folder'
  where.innerHTML = icon('folder', 12)
  where.append(shortFolder(cwd))
  where.title = cwd ?? ''
  rows.className = 'menu-rows'
  menu.replaceChildren(field, where, rows)
  draw()

  if (!touch) requestAnimationFrame(() => field.focus())
}

function openAddMenu(cwd = currentFolder()) {
  openAddMenuAt(addButton, cwd)
  addButton.setAttribute('aria-expanded', 'true')
}

// With nothing open, the agents are the first thing on screen.
function renderEmpty() {
  const grid = $('emptyAgents')

  grid.replaceChildren()

  for (const agent of agents) {
    const card = document.createElement('button')
    const words = document.createElement('span')
    const note = document.createElement('small')

    card.type = 'button'
    card.className = 'agent-card'
    card.disabled = !agent.installed
    words.textContent = agent.label
    note.textContent = agent.installed ? shortFolder(currentFolder()) : '설치 안 됨'
    words.append(note)
    card.append(agentIcon(agent.id, 18), words)
    card.addEventListener('click', () => openSession(agent.id))
    grid.append(card)
  }
}

// Windows' Korean IME in the PC program at times commits a finished syllable twice in a row
// ("폰폰에에서"); nobody types the same Korean text twice within a few milliseconds, so a repeat
// that fast is dropped.
const IME_REPEAT_MS = 40
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/

function imeGuard(send) {
  let last = ''
  let at = 0

  return (data) => {
    const now = performance.now()

    if (data === last && now - at < IME_REPEAT_MS && HANGUL.test(data)) return

    last = data
    at = now
    send(data)
  }
}

term.onData(imeGuard(input))

addButton.addEventListener('click', (event) => {
  event.stopPropagation()

  if (menu.hidden) openAddMenu()
  else closeAddMenu()
})

menu.addEventListener('click', (event) => event.stopPropagation())
document.addEventListener('click', closeAddMenu)
void refreshAgents().then(render)

for (const button of document.querySelectorAll('[data-kind]')) {
  button.addEventListener('click', () => openSession(button.dataset.kind))
}

// The key bar above the input: which keys, in what order, plus keys the owner made. Kept per
// device, since a phone and the PC window want different keys.
function parseStep(step) {
  return { key: step.key, mods: { ctrl: !!step.mods?.ctrl, alt: !!step.mods?.alt, shift: !!step.mods?.shift } }
}

function stepsLabel(steps) {
  return steps.map((step) => comboLabel(step.key, step.mods)).join(', ')
}

function parseKeySetup(raw) {
  const fallback = { layout: [...DEFAULT_LAYOUT], custom: {} }

  if (raw === null) return fallback

  try {
    const stored = JSON.parse(raw)
    const custom = {}

    for (const [id, entry] of Object.entries(stored?.custom ?? {})) {
      if (typeof entry?.label !== 'string') continue

      if (typeof entry.text === 'string') custom[id] = { label: entry.label, text: entry.text }
      else if (typeof entry.key === 'string') custom[id] = { label: entry.label, steps: [parseStep(entry)] }
      else if (Array.isArray(entry.steps)) {
        const steps = []

        for (const step of entry.steps) {
          if (typeof step?.key === 'string') steps.push(parseStep(step))
        }

        custom[id] = { label: entry.label, steps }
      }
    }

    const layout = Array.isArray(stored?.layout) ? stored.layout.filter((id) => typeof id === 'string' && (id in CATALOG || id in custom)) : fallback.layout

    return { layout, custom }
  } catch {
    return fallback
  }
}

let keySetup = parseKeySetup(load(KEYS_STORE))

// The paste key came later: a key bar set up before it gets it once, at the front.
if (load('choiterm.keys.paste') === null) {
  if (!keySetup.layout.includes('paste')) keySetup.layout.unshift('paste')

  save('choiterm.keys.paste', '1')
}
let scrollSpeed = load(SCROLL_STORE) in SCROLL_SPEEDS ? load(SCROLL_STORE) : 'normal'

function saveKeys() {
  save(KEYS_STORE, JSON.stringify(keySetup))
  renderKeys()
}

function keyEntry(id) {
  return CATALOG[id] ?? keySetup.custom[id]
}

// Sticky modifiers. One tap holds for the next key or typed letter ('once'); a quick second tap
// locks it until tapped again ('lock'), so Ctrl+S then Ctrl+X is just s, x.
const held = { ctrl: false, alt: false, shift: false }
const lastModTap = { ctrl: 0, alt: 0, shift: 0 }
const LOCK_TAP_MS = 400

function releaseModifiers() {
  for (const mod of MODIFIERS) {
    if (held[mod] === 'once') held[mod] = false
  }

  renderKeys()
}

function tapModifier(mod) {
  const now = Date.now()

  if (held[mod] === 'once' && now - lastModTap[mod] < LOCK_TAP_MS) held[mod] = 'lock'
  else held[mod] = held[mod] ? false : 'once'

  lastModTap[mod] = now
  renderKeys()
}

function stepBytes(step) {
  const mods = { ctrl: held.ctrl || step.mods.ctrl, alt: held.alt || step.mods.alt, shift: held.shift || step.mods.shift }

  return encodeKey(step.key, mods, term.modes.applicationCursorKeysMode)
}

function press(entry) {
  if (entry.mod !== undefined) {
    tapModifier(entry.mod)

    return
  }

  if (entry.action === 'paste') {
    void pasteClipboard()

    return
  }

  // A key can change the terminal's line in ways the input bar cannot follow (Tab completes,
  // arrows move the cursor), so the bar lets go of what it typed and starts fresh.
  forget()

  if (entry.text !== undefined) {
    input(anyModifier(held) && [...entry.text].length === 1 ? encodeKey(entry.text, held, false) : entry.text)
  } else if (entry.steps !== undefined) {
    input(entry.steps.map(stepBytes).join(''))
  } else {
    input(stepBytes(parseStep(entry)))
  }

  if (anyModifier(held)) releaseModifiers()
}

// The paste key: text goes in as a paste, an image is uploaded and its path typed in. Phones ask
// once for permission to read the clipboard.
async function pasteClipboard() {
  try {
    const items = await navigator.clipboard.read()

    for (const item of items) {
      const type = item.types.find((each) => each.startsWith('image/'))

      if (type !== undefined) {
        const blob = await item.getType(type)

        void sendFiles([new File([blob], `clipboard.${type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`, { type })], touch)

        return
      }
    }
  } catch {
    // No image access here: text below.
  }

  try {
    const text = await navigator.clipboard.readText()

    if (text === '') {
      notice('클립보드가 비어 있어요')

      return
    }

    if (touch) {
      insertText(text)
    } else {
      input(`\x1b[200~${text}\x1b[201~`)
    }
  } catch {
    notice('클립보드를 읽을 수 없어요. 입력창을 길게 눌러 붙여넣어 주세요')
  }
}

// Into the phone's input bar at the cursor, as if typed.
function insertText(value) {
  const at = text.selectionStart ?? text.value.length

  text.value = text.value.slice(0, at) + value + text.value.slice(text.selectionEnd ?? at)
  sync()
  grow()
}

const keysBar = $('keys')

function renderKeys() {
  keysBar.replaceChildren()

  for (const id of keySetup.layout) {
    const entry = keyEntry(id)

    if (entry === undefined) continue

    const button = document.createElement('button')

    button.type = 'button'

    if (entry.icon !== undefined && UI[entry.icon] !== undefined) {
      button.innerHTML = UI[entry.icon]
      button.setAttribute('aria-label', entry.hint ?? entry.label)

      // An icon with a word beside it (Shift+Tab, a newline).
      if (entry.iconLabel !== undefined) {
        button.classList.add('key-with-icon')
        button.append(entry.iconLabel)
      }
    } else {
      button.textContent = entry.label
    }

    button.toggleAttribute('data-held', entry.mod !== undefined && !!held[entry.mod])
    button.toggleAttribute('data-locked', entry.mod !== undefined && held[entry.mod] === 'lock')

    if (entry.hint !== undefined) button.title = entry.hint

    // Keep the phone keyboard where it is while tapping keys.
    button.addEventListener('pointerdown', (event) => event.preventDefault())
    button.addEventListener('click', () => press(entry))
    keysBar.append(button)
  }

  const edit = document.createElement('button')

  edit.type = 'button'
  edit.className = 'edit-keys'
  edit.textContent = '편집'
  edit.addEventListener('pointerdown', (event) => event.preventDefault())
  edit.addEventListener('click', openKeyEditor)
  keysBar.append(edit)
}

// The key editor sheet: reorder or remove the bar's keys, add from the list, build a combination
// or a text key, and pick the scroll speed.
const sheet = $('sheet')
const sheetBody = $('sheetBody')
const draft = { steps: [], key: '', mods: { ctrl: false, alt: false, shift: false } }

function chip(label, onClick, attrs = {}) {
  const button = document.createElement('button')

  button.type = 'button'
  button.className = 'chip'
  button.textContent = label

  for (const [name, on] of Object.entries(attrs)) button.toggleAttribute(name, on)

  button.addEventListener('click', onClick)

  return button
}

// A chip showing an icon instead of words; `label` is what it says to screen readers.
function iconChip(icon, label, onClick) {
  const button = chip('', onClick)

  button.innerHTML = icon
  button.setAttribute('aria-label', label)
  button.title = label

  return button
}

function section(title) {
  const box = document.createElement('section')
  const heading = document.createElement('h3')

  heading.textContent = title
  box.append(heading)
  sheetBody.append(box)

  return box
}

function moveKey(index, by) {
  const layout = [...keySetup.layout]
  const target = index + by

  if (target < 0 || target >= layout.length) return

  const moving = layout[index]

  layout[index] = layout[target]
  layout[target] = moving
  keySetup = { ...keySetup, layout }
  saveKeys()
  renderEditor()
}

function removeKey(index) {
  const id = keySetup.layout[index]
  const layout = keySetup.layout.filter((_, at) => at !== index)
  const custom = { ...keySetup.custom }

  // A key the owner made disappears with its last button.
  if (id in custom) delete custom[id]

  keySetup = { layout, custom }
  saveKeys()
  renderEditor()
}

function addKey(id, entry) {
  const custom = entry === undefined ? keySetup.custom : { ...keySetup.custom, [id]: entry }

  keySetup = { layout: [...keySetup.layout, id], custom }
  saveKeys()
  renderEditor()
}

function newId() {
  return `custom-${Date.now().toString(36)}`
}

function renderEditor() {
  sheetBody.replaceChildren()

  const shown = section('키 줄 (순서대로)')
  const rows = document.createElement('div')

  rows.className = 'key-rows'
  keySetup.layout.forEach((id, index) => {
    const entry = keyEntry(id)

    if (entry === undefined) return

    const row = document.createElement('div')
    const name = document.createElement('span')

    row.className = 'key-row'
    name.className = 'key-name'
    name.textContent = entry.hint === undefined ? entry.label : `${entry.label}  ·  ${entry.hint}`
    row.append(
      name,
      iconChip(UI.up, '앞으로', () => moveKey(index, -1)),
      iconChip(UI.down, '뒤로', () => moveKey(index, 1)),
      chip('빼기', () => removeKey(index), { 'data-danger': true }),
    )
    rows.append(row)
  })
  shown.append(rows)

  const more = section('추가할 수 있는 키')
  const pool = document.createElement('div')

  pool.className = 'chips'

  for (const [id, entry] of Object.entries(CATALOG)) {
    if (keySetup.layout.includes(id)) continue

    pool.append(chip(entry.hint === undefined ? entry.label : `${entry.label} ${entry.hint}`, () => addKey(id)))
  }

  if (pool.childElementCount === 0) pool.textContent = '모두 키 줄에 있어요'

  more.append(pool)

  const combo = section('조합키 만들기')
  const modRow = document.createElement('div')
  const keyRow = document.createElement('div')
  const letter = document.createElement('input')
  const preview = document.createElement('p')

  modRow.className = 'chips'
  keyRow.className = 'chips'

  for (const mod of MODIFIERS) {
    modRow.append(chip(MOD_LABEL[mod], () => {
      draft.mods[mod] = !draft.mods[mod]
      renderEditor()
    }, { 'data-on': draft.mods[mod] }))
  }

  for (const [name, special] of Object.entries(SPECIAL)) {
    keyRow.append(chip(special.label, () => {
      draft.key = name
      renderEditor()
    }, { 'data-on': draft.key === name }))
  }

  letter.className = 'field'
  letter.maxLength = 1
  letter.placeholder = '또는 글자 하나 (예: a)'
  letter.value = draft.key.length === 1 ? draft.key : ''
  // The steps so far plus the one being picked, e.g. "Ctrl+S, X".
  const describe = () => {
    const steps = draft.key === '' ? draft.steps : [...draft.steps, { key: draft.key, mods: draft.mods }]

    return steps.length === 0 ? '키를 고르세요' : stepsLabel(steps)
  }

  letter.addEventListener('input', () => {
    draft.key = letter.value.slice(0, 1)
    preview.textContent = describe()
  })

  const clearStep = () => {
    draft.key = ''
    draft.mods = { ctrl: false, alt: false, shift: false }
  }

  preview.className = 'preview'
  preview.textContent = describe()
  combo.append(
    modRow,
    keyRow,
    letter,
    preview,
    chip('다음 단계 이어서', () => {
      if (draft.key === '') return

      draft.steps.push({ key: draft.key, mods: { ...draft.mods } })
      clearStep()
      renderEditor()
    }),
    chip('처음부터', () => {
      draft.steps = []
      clearStep()
      renderEditor()
    }),
    chip('키 줄에 추가', () => {
      const steps = draft.key === '' ? draft.steps : [...draft.steps, { key: draft.key, mods: { ...draft.mods } }]

      if (steps.length === 0) return

      addKey(newId(), { label: stepsLabel(steps), steps })
      draft.steps = []
      clearStep()
      renderEditor()
    }, { 'data-primary': true }),
  )

  const macro = section('글자 키 만들기')
  const label = document.createElement('input')
  const body = document.createElement('input')
  const enter = chip('보낸 뒤 Enter', () => enter.toggleAttribute('data-on'))

  label.className = 'field'
  label.placeholder = '버튼 이름 (예: 압축)'
  body.className = 'field'
  body.placeholder = '보낼 글자 (예: /compact)'
  macro.append(label, body, enter, chip('키 줄에 추가', () => {
    if (body.value === '') return

    const text = enter.hasAttribute('data-on') ? `${body.value}\r` : body.value

    addKey(newId(), { label: label.value === '' ? body.value : label.value, text })
  }, { 'data-primary': true }))

  const speed = section('스크롤 속도')
  const speeds = document.createElement('div')

  speeds.className = 'chips'

  for (const [name, title] of [['slow', '느리게'], ['normal', '보통'], ['fast', '빠르게']]) {
    speeds.append(chip(title, () => {
      scrollSpeed = name
      save(SCROLL_STORE, name)
      renderEditor()
    }, { 'data-on': scrollSpeed === name }))
  }

  speed.append(speeds)

  const reset = section('되돌리기')

  reset.append(chip('키 줄 기본값으로', () => {
    keySetup = { layout: [...DEFAULT_LAYOUT], custom: {} }
    saveKeys()
    renderEditor()
  }, { 'data-danger': true }))
}

const sheetTitle = $('sheetTitle')

function openKeyEditor() {
  sheetTitle.textContent = '키 줄 편집'
  renderEditor()
  sheet.hidden = false
}

// Model and effort for the open Claude Code session, picked from buttons. Each pick clears the
// prompt line (Ctrl+U), then types the slash command and Enter, exactly as if typed by hand.
const MODELS = [
  ['fable', 'Fable 5.1'],
  ['opus', 'Opus 5.5'],
  ['opus[1m]', 'Opus 5.5 · 1M'],
  ['sonnet', 'Sonnet 5.5'],
  ['haiku', 'Haiku 5.5'],
  ['default', '기본값'],
]

const EFFORTS = [
  ['low', '낮음'],
  ['medium', '보통'],
  ['high', '높음'],
  ['xhigh', '매우 높음'],
  ['max', '최대'],
  ['auto', '자동'],
]

// What this screen last picked per session, only to mark the chip; Claude's own line is the truth.
const picks = new Map()

function runCommand(command) {
  forget()
  input('\x15')
  setTimeout(() => sendInput(command), 40)
  setTimeout(() => sendInput('\r'), 140)
}

function renderModelSheet() {
  sheetBody.replaceChildren()

  const mine = picks.get(current) ?? {}

  for (const [title, options, field, command] of [
    ['모델', MODELS, 'model', '/model'],
    ['추론 강도', EFFORTS, 'effort', '/effort'],
  ]) {
    const box = section(title)
    const row = document.createElement('div')

    row.className = 'chips'

    for (const [value, label] of options) {
      row.append(chip(label, () => {
        picks.set(current, { ...mine, [field]: value })
        runCommand(`${command} ${value}`)
        sheet.hidden = true
        notice(`${title}: ${label}`)
      }, { 'data-on': mine[field] === value }))
    }

    box.append(row)
  }
}

// ---- Status bar under the tabs: usage windows, context, prompt cache, model and effort of the
// Claude session on screen, as the choiterm-status mod reports them. A tap opens the details with
// the model and effort pickers.

const statusBar = $('statusbar')
const statuses = new Map()
const STATUS_TICK_MS = 30_000
const LIMIT_NAMES = { five_hour: '5H', seven_day: '7D' }
const LIMIT_TITLES = { five_hour: '5시간', seven_day: '주간' }

function limitName(kind) {
  return LIMIT_NAMES[kind] ?? kind.replace(/^seven_day_/, '7D ').toUpperCase()
}

function limitTitle(kind) {
  return LIMIT_TITLES[kind] ?? `주간 ${kind.replace(/^seven_day_/, '')}`
}

// claude-opus-5-5[1m] reads Opus 5.5 1M.
function modelLabel(model) {
  const match = model?.match(/^claude-([a-z]+)-(\d+)-(\d+)/)

  if (!match) return model ?? '모델'

  const wide = /\[1m\]/i.test(model) ? ' 1M' : ''

  return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}${wide}`
}

// The largest unit or two: 52m, 3h12m, 1d4h.
function shortSpan(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000))

  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)

  if (hours < 24) return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`

  return `${Math.floor(hours / 24)}d${hours % 24 > 0 ? `${hours % 24}h` : ''}`
}

function tone(percent) {
  if (percent >= 90) return 'bad'

  if (percent >= 70) return 'warn'

  return ''
}

function cacheLeft(cache) {
  return cache === null ? null : cache.at + cache.ttlMs - Date.now()
}

function statusChip(text, mood = '') {
  const piece = document.createElement('span')

  piece.className = 'stat'
  piece.textContent = text

  if (mood !== '') piece.dataset.tone = mood

  return piece
}

function renderStatus() {
  const active = sessions.find((session) => session.id === current)

  statusBar.hidden = active?.kind !== 'claude'

  if (statusBar.hidden) return

  const status = statuses.get(current)
  const pieces = []

  if (status === undefined) {
    pieces.push(statusChip('상태 기다리는 중'), statusChip('모델·추론 ›'))
    statusBar.replaceChildren(...pieces)

    return
  }

  for (const limit of status.limits) {
    const left = limit.resetsAt === null ? '' : ` ${shortSpan(Date.parse(limit.resetsAt) - Date.now())}`

    pieces.push(statusChip(`${limitName(limit.kind)} ${Math.round(limit.percent)}%${left}`, tone(limit.percent)))
  }

  if (status.contextPercent !== null) pieces.push(statusChip(`CTX ${status.contextPercent}%`, tone(status.contextPercent)))

  const left = cacheLeft(status.cache)

  if (left !== null) pieces.push(statusChip(left > 0 ? `캐시 ${shortSpan(left)}` : '캐시 식음', left > 0 && left < 5 * 60_000 ? 'warn' : ''))

  pieces.push(statusChip(modelLabel(status.model), 'model'))

  if (status.effort !== null) pieces.push(statusChip(status.effort))

  statusBar.replaceChildren(...pieces)
}

function tokens(count) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k` : String(count)
}

function openStatusSheet() {
  const status = statuses.get(current)

  sheetTitle.textContent = '상태와 모델'
  renderModelSheet()

  const box = section('지금 상태')
  const rows = document.createElement('div')
  const line = (label, value) => {
    const row = document.createElement('div')
    const name = document.createElement('span')
    const text = document.createElement('span')

    row.className = 'stat-row'
    name.textContent = label
    text.textContent = value
    row.append(name, text)
    rows.append(row)
  }

  rows.className = 'stat-rows'

  if (status === undefined) {
    line('상태', '아직 보고가 없어요. 다음 응답부터 보여요')
  } else {
    for (const limit of status.limits) {
      const reset = limit.resetsAt === null ? '' : ` · ${shortSpan(Date.parse(limit.resetsAt) - Date.now())} 뒤 초기화`

      line(limitTitle(limit.kind), `${limit.percent}% 사용${reset}`)
    }

    if (status.contextPercent !== null) {
      const amount = status.contextTokens === null || status.contextWindow === null ? '' : ` (${tokens(status.contextTokens)} / ${tokens(status.contextWindow)})`

      line('컨텍스트', `${status.contextPercent}%${amount}`)
    }

    const left = cacheLeft(status.cache)

    if (status.cache !== null && left !== null) {
      line('캐시', `${left > 0 ? `${shortSpan(left)} 남음` : '식음'} · 읽음 ${tokens(status.cache.read)}, 새로 씀 ${tokens(status.cache.written)}`)
    }

    line('모델', status.model === null ? '모름' : modelLabel(status.model))
    line('추론 강도', status.effort ?? '기본')
  }

  box.append(rows)
  sheetBody.prepend(box)
  sheet.hidden = false
}

statusBar.addEventListener('click', openStatusSheet)
setInterval(renderStatus, STATUS_TICK_MS)

$('sheetClose').addEventListener('click', () => {
  sheet.hidden = true
})

renderKeys()

// The input bar types into the terminal as you write, so Claude's own completions and the command
// you are building show up live. `mirrored` is what it has typed so far; each edit sends only the
// difference: backspaces for what changed at the end, then the new text. A line break is LF, which
// both Claude Code and PowerShell take as a new line rather than as sending.
let mirrored = []
let lastSync = 0

function sync() {
  const now = [...text.value]
  let same = 0

  while (same < now.length && same < mirrored.length && now[same] === mirrored[same]) same += 1

  const removed = mirrored.length - same
  const added = now.slice(same).join('')

  if (removed === 0 && added === '') return

  mirrored = now
  lastSync = Date.now()
  input(`${'\x7f'.repeat(removed)}${added}`)
}

function forget() {
  text.value = ''
  mirrored = []
  grow()
  keepDraft()
}

// What the input bar holds, per session: going to another tab and back (or the page reloading)
// brings it back, still matched to what was typed into the terminal, so it can be edited further.
const DRAFTS_KEY = 'choiterm.drafts'
const drafts = new Map()

try {
  for (const [id, value] of Object.entries(JSON.parse(load(DRAFTS_KEY) ?? '{}'))) {
    if (typeof value === 'string') drafts.set(id, value)
  }
} catch {
  // Start without.
}

function keepDraft() {
  if (current === null) return

  if (text.value === '') drafts.delete(current)
  else drafts.set(current, text.value)

  save(DRAFTS_KEY, drafts.size === 0 ? null : JSON.stringify(Object.fromEntries(drafts)))
}

function restoreDraft(id) {
  const draft = drafts.get(id) ?? ''

  text.value = draft
  mirrored = [...draft]
  grow()
}

function submit() {
  sync()
  forget()

  // Text that arrived a moment ago could be read together with Enter as one paste, which would add
  // a line instead of sending; a short pause keeps Enter on its own.
  const wait = Math.max(0, 60 - (Date.now() - lastSync))

  setTimeout(() => input('\r'), wait)
}

function grow() {
  text.style.height = 'auto'
  text.style.height = `${text.scrollHeight}px`
}

$('compose').addEventListener('submit', (event) => {
  event.preventDefault()
  submit()
})

text.addEventListener('input', () => {
  // With Ctrl, Alt or Shift held from the key bar, the letter just typed is a combination, not text.
  if (anyModifier(held)) {
    const now = [...text.value]
    const typed = now.length === mirrored.length + 1 ? now.find((char, at) => char !== mirrored[at]) : undefined

    text.value = mirrored.join('')

    if (typed !== undefined) {
      forget()
      input(encodeKey(typed, held, false))
    }

    releaseModifiers()

    return
  }

  sync()
  grow()
  keepDraft()
})

// Where on the grid a point falls; the box already includes the shrink-to-fit scale.
function cellAt(clientX, clientY) {
  const box = term.element.querySelector('.xterm-screen').getBoundingClientRect()
  const col = Math.floor(((clientX - box.left) / box.width) * term.cols)
  const row = Math.floor(((clientY - box.top) / box.height) * term.rows)

  return { col: Math.min(Math.max(col, 0), term.cols - 1), row: Math.min(Math.max(row, 0), term.rows - 1) }
}

// Claude Code runs full screen with mouse reporting and scrolls itself, so a drag turns into wheel
// events for it. A plain shell keeps xterm's own scrollback.
function wheel(up, cell) {
  const buffer = term.buffer.active

  if (term.modes.mouseTrackingMode !== 'none') {
    sendInput(`\x1b[<${up ? 64 : 65};${cell.col + 1};${cell.row + 1}M`)
    wheeledUp = Math.max(0, wheeledUp + (up ? 1 : -1))
    updateBottomButton()
  } else if (buffer.type === 'alternate') {
    input(up ? '\x1b[A' : '\x1b[B')
  } else {
    term.scrollLines(up ? -1 : 1)
  }
}

const toBottom = $('toBottom')

function updateBottomButton() {
  const buffer = term.buffer.active

  toBottom.hidden = !(wheeledUp > 0 || (buffer.type === 'normal' && buffer.viewportY < buffer.baseY))
}

// Back to the newest output: wheel down as far as this screen went up (plus a little, in case the
// app moved on its own), or xterm's own scrollback to its end.
function toNewest() {
  if (wheeledUp > 0) {
    const cell = { col: Math.floor(term.cols / 2), row: Math.floor(term.rows / 2) }
    const notches = wheeledUp + 3

    for (let step = 0; step < notches; step += 1) sendInput(`\x1b[<65;${cell.col + 1};${cell.row + 1}M`)

    wheeledUp = 0
  } else {
    term.scrollToBottom()
  }

  updateBottomButton()
}

toBottom.addEventListener('click', toNewest)

term.onScroll(updateBottomButton)

// One visible row as text, with the string index for every column (wide Korean letters take two
// columns but one character), whether the terminal wrapped it from the row above, and its last
// non-blank column.
function rowText(row) {
  return bufferRow(term.buffer.active.viewportY + row)
}

function bufferRow(y) {
  const line = term.buffer.active.getLine(y)
  const columns = []
  let text = ''
  let lastCol = -1

  if (line === undefined) return { text, columns, wrapped: false, lastCol }

  for (let col = 0; col < term.cols; col += 1) {
    const cell = line.getCell(col)

    columns.push(text.length)

    if (cell === undefined || cell.getWidth() === 0) continue

    const chars = cell.getChars() || ' '

    if (chars.trim() !== '') lastCol = col

    text += chars
  }

  return { text, columns, wrapped: line.isWrapped, lastCol }
}

const IMAGE_PATTERN = /[A-Za-z]:[\\/][^\s"'<>|*?]+?\.(?:png|jpe?g|gif|webp|bmp)(?![\w.])/gi
const LINK_PATTERNS = [
  { kind: 'url', pattern: /https?:\/\/[^\s"'<>`]+/g },
  { kind: 'image', pattern: IMAGE_PATTERN },
]

const LINK_CHAR = /[^\s"'<>`|*?]/
// Claude cuts a long path or URL at its own margin, which sits this close to the right edge.
const BREAK_MARGIN = 6

function cleanLink(text) {
  return text.replace(/[).,;:'"\]]+$/, '')
}

// Claude breaks a long unbroken word onto the next row itself (not a terminal wrap) and indents
// the rest, so a row that runs to the margin and a next row that picks up mid-word belong together.
function brokenAt(upper, lower) {
  const end = upper.text.trimEnd()
  const start = lower.text.trimStart()

  return end !== '' && start !== '' && LINK_CHAR.test(end.at(-1)) && LINK_CHAR.test(start[0]) && upper.lastCol >= term.cols - 1 - BREAK_MARGIN
}

// The screen as lines of text. Rows the terminal wrapped are always one line; with `breaks`, rows
// Claude broke itself are joined too, without the indent. Each line keeps, per row, where that
// row's columns land in the line's text.
function screenLines(breaks) {
  const lines = []
  let line = null

  for (let row = 0; row < term.rows; row += 1) {
    const part = rowText(row)
    const joined = line !== null && (part.wrapped || (breaks && brokenAt(line.last, part)))

    if (!joined) {
      line = { text: '', rows: new Map(), last: part, lastRow: null }
      lines.push(line)
    }

    // Claude also fills a row to the very edge and indents the next one: the terminal calls that a
    // wrap, but the indent is Claude's and must go, or a space lands in the middle of the link.
    const broken = joined && (!part.wrapped || (breaks && /^\s/.test(part.text) && brokenAt(line.last, part)))
    const lead = broken ? part.text.length - part.text.trimStart().length : 0

    // The upper row's trailing blanks and this row's indent are not part of the line; `from`/`to`
    // mark which of a row's characters are.
    if (broken) {
      line.text = line.text.trimEnd()
      line.lastRow.to = line.last.text.trimEnd().length
    }

    line.lastRow = { offset: line.text.length - lead, columns: part.columns, from: lead, to: part.text.length }
    line.rows.set(row, line.lastRow)
    line.text += part.text.slice(lead)
    line.last = part
  }

  return lines
}

// A URL or image path under a tap. The joined reading goes first: a URL cut at Claude's margin
// also matches on its first row alone and would open cut short. Rows are joined only when the upper
// one runs to the margin, so a link that merely ends a row stays as it is.
function linkAt(cell) {
  for (const breaks of [true, false]) {
    const line = screenLines(breaks).find((each) => each.rows.has(cell.row))
    const at = line.rows.get(cell.row)
    const index = at.offset + at.columns[cell.col]

    for (const { kind, pattern } of LINK_PATTERNS) {
      for (const match of line.text.trimEnd().matchAll(pattern)) {
        if (index < match.index || index >= match.index + match[0].length) continue

        return { kind, target: cleanLink(match[0]) }
      }
    }
  }

  return null
}

// Every image path on screen, top to bottom.
function screenImages() {
  const found = []

  for (const line of screenLines(true)) {
    for (const match of line.text.matchAll(IMAGE_PATTERN)) {
      const path = cleanLink(match[0])

      if (!found.includes(path)) found.push(path)
    }
  }

  return found
}

function openUrl(url) {
  if (window.ChoiTermApp?.openUrl) window.ChoiTermApp.openUrl(url)
  else window.open(url, '_blank', 'noopener')
}

const previewUrl = (path) => `/preview?path=${encodeURIComponent(path)}`

// Every image that went through ChoiTerm, kept by the server (oldest first) and pushed to every
// screen when it changes.
let gallery = []
const reported = new Set()

function galleryItem(path) {
  const key = path.toLowerCase()

  return gallery.find((item) => item.path.toLowerCase() === key)
}

function fileName(path) {
  return path.split(/[\\/]/).at(-1) ?? path
}

function postJson(path, body) {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

// Tells the server about an image a session printed; it checks the file exists and adds it, or
// files a known one under this session too.
function report(path) {
  const key = `${current}|${path.toLowerCase()}`
  const known = galleryItem(path)

  if (current === null || reported.has(key) || known?.sessions.includes(current)) return

  reported.add(key)
  postJson('/gallery/add', { path, session: current }).catch(() => reported.delete(key))
}

function saveTags(item, tags) {
  item.tags = tags
  renderViewerInfo()
  postJson('/gallery/tags', { id: item.id, tags }).catch(() => notice('태그를 저장하지 못했어요'))
}

// ---- Viewer: swipe between images, pinch/drag/double tap to zoom, tags under the picture.

const viewer = $('viewer')
const viewerTrack = $('viewerTrack')
const viewerCount = $('viewerCount')
const viewerPath = $('viewerPath')
const viewerTags = $('viewerTags')
const slides = [...viewerTrack.querySelectorAll('.slide')]

const ZOOM_MAX = 8
const DOUBLE_TAP_ZOOM = 2.5
const DOUBLE_TAP_MS = 300
const TAP_SLOP_PX = 10
const SWIPE_SHARE = 0.18
const SWIPE_FLICK_PX = 30
const SWIPE_FLICK_MS = 250
const SLIDE_MS = 220
const EDGE_RESISTANCE = 0.35
const zoom = { scale: 1, x: 0, y: 0 }
const pointers = new Map()
const shown = { items: [], index: 0 }
let pinch = null
let drag = null
let lastTap = 0
let sliding = false
let tagDraft = null

for (const slide of slides) {
  const image = slide.querySelector('img')

  image.addEventListener('load', () => slide.removeAttribute('data-missing'))
  image.addEventListener('error', () => {
    if (image.hasAttribute('src')) slide.setAttribute('data-missing', '')
  })
}

const currentImage = () => slides[1].querySelector('img')

function applyZoom() {
  currentImage().style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`
}

function resetZoom() {
  zoom.scale = 1
  zoom.x = 0
  zoom.y = 0

  for (const slide of slides) slide.querySelector('img').style.transform = ''
}

// Where the current image's top-left corner sits on screen when not zoomed.
function imageOrigin() {
  const box = slides[1].getBoundingClientRect()
  const image = currentImage()

  return { x: box.left + image.offsetLeft, y: box.top + image.offsetTop }
}

// Scale to `scale` while the image point under (clientX, clientY) stays put.
function zoomAt(scale, clientX, clientY) {
  const next = Math.min(Math.max(scale, 1), ZOOM_MAX)
  const origin = imageOrigin()
  const localX = clientX - origin.x
  const localY = clientY - origin.y

  zoom.x = localX - (localX - zoom.x) * (next / zoom.scale)
  zoom.y = localY - (localY - zoom.y) * (next / zoom.scale)
  zoom.scale = next

  if (next === 1) resetZoom()
  else applyZoom()
}

function setSlide(slide, item) {
  const image = slide.querySelector('img')

  if (item === undefined) {
    slide.hidden = true
    slide.dataset.path = ''
    image.removeAttribute('src')

    return
  }

  slide.hidden = false

  if (slide.dataset.path === item.path) return

  slide.dataset.path = item.path
  slide.removeAttribute('data-missing')
  image.src = previewUrl(item.path)
}

// Three slides: the one before, the current one and the one after, so a swipe shows its neighbour.
function layoutSlides() {
  slides.forEach((slide, place) => {
    slide.style.transform = `translateX(${(place - 1) * 100}%)`
    setSlide(slide, shown.items[shown.index + place - 1])
  })
  renderViewerInfo()
}

function moveTrack(pixels, animate) {
  viewerTrack.style.transition = animate ? `transform ${SLIDE_MS}ms ease-out` : 'none'
  viewerTrack.style.transform = `translateX(${pixels}px)`
}

function go(step) {
  const target = shown.index + step

  if (sliding || target < 0 || target >= shown.items.length) {
    moveTrack(0, true)

    return
  }

  sliding = true
  tagDraft = null
  moveTrack(-step * viewerTrack.clientWidth, true)
  setTimeout(() => {
    shown.index = target

    if (step > 0) slides.push(slides.shift())
    else slides.unshift(slides.pop())

    resetZoom()
    moveTrack(0, false)
    layoutSlides()
    sliding = false
  }, SLIDE_MS)
}

function openViewer(items, index) {
  if (items.length === 0) return

  shown.items = items
  shown.index = Math.min(Math.max(index, 0), items.length - 1)
  tagDraft = null
  resetZoom()
  moveTrack(0, false)
  viewer.hidden = false
  layoutSlides()
}

function closeViewer() {
  viewer.hidden = true
  pointers.clear()
  pinch = null
  drag = null
  tagDraft = null

  for (const slide of slides) setSlide(slide, undefined)
}

// The images of the session on screen, so a swipe walks through this conversation's pictures.
function sessionImages() {
  return gallery.filter((item) => item.sessions.includes(current))
}

// A tapped path: inside this session's images when the gallery has it, alone otherwise (and
// reported, so it is there next time).
function openImagePath(path) {
  const known = galleryItem(path)

  if (known === undefined) {
    report(path)
    openViewer([{ id: null, path, from: 'claude', sessions: [], at: Date.now(), tags: [] }], 0)

    return
  }

  const items = known.sessions.includes(current) ? sessionImages() : [known]

  openViewer(items, items.indexOf(known))
}

const FROM_LABEL = { me: '내가 보낸 이미지', claude: '받은 이미지' }

function timeLabel(at) {
  return new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function renderViewerInfo() {
  const item = shown.items[shown.index]

  viewerCount.textContent = shown.items.length > 1 ? `${shown.index + 1} / ${shown.items.length}` : ''
  $('viewerPrev').hidden = shown.index === 0
  $('viewerNext').hidden = shown.index >= shown.items.length - 1
  viewerTags.replaceChildren()

  if (item === undefined) return

  viewerPath.textContent = item.id === null ? fileName(item.path) : `${fileName(item.path)} · ${FROM_LABEL[item.from]} · ${timeLabel(item.at)}`
  viewerPath.title = item.path

  // A path not in the gallery yet has nothing to hang tags on.
  if (item.id === null) return

  for (const tag of item.tags) {
    viewerTags.append(chip(`#${tag} ×`, () => saveTags(item, item.tags.filter((each) => each !== tag)), { 'data-tag': true }))
  }

  if (tagDraft === null) {
    viewerTags.append(chip('+ 태그', () => {
      tagDraft = ''
      renderViewerInfo()
    }, { 'data-add': true }))

    return
  }

  const field = document.createElement('input')
  const commit = () => {
    const tag = field.value.replace(/^#/, '').trim()

    tagDraft = null

    if (tag !== '' && !item.tags.includes(tag)) saveTags(item, [...item.tags, tag])
    else renderViewerInfo()
  }

  field.className = 'tag-field'
  field.placeholder = '태그 이름'
  field.enterKeyHint = 'done'
  field.maxLength = 30
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      tagDraft = null
      renderViewerInfo()
    }
  })
  field.addEventListener('blur', commit)
  viewerTags.append(field)
  field.focus()
}

$('viewerClose').addEventListener('click', closeViewer)
$('viewerPrev').addEventListener('click', () => go(-1))
$('viewerNext').addEventListener('click', () => go(1))

addEventListener('keydown', (event) => {
  if (viewer.hidden || event.target.closest?.('input')) return

  if (event.key === 'ArrowLeft') go(-1)
  else if (event.key === 'ArrowRight') go(1)
})

function startPinch() {
  const [a, b] = [...pointers.values()]

  pinch = {
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    scale: zoom.scale,
    x: zoom.x,
    y: zoom.y,
  }
}

viewerTrack.addEventListener('pointerdown', (event) => {
  if (sliding) return

  viewerTrack.setPointerCapture(event.pointerId)
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

  if (pointers.size === 1) {
    drag = { x: event.clientX, y: event.clientY, at: performance.now(), mode: 'tap', onImage: event.target.tagName === 'IMG' }
  } else if (pointers.size === 2) {
    if (drag?.mode === 'swipe') moveTrack(0, true)

    drag = { mode: 'pinch' }
    startPinch()
  }
})

viewerTrack.addEventListener('pointermove', (event) => {
  const last = pointers.get(event.pointerId)

  if (last === undefined || drag === null) return

  const point = { x: event.clientX, y: event.clientY }

  pointers.set(event.pointerId, point)

  if (drag.mode === 'pinch') {
    if (pinch === null || pointers.size !== 2) return

    const [a, b] = [...pointers.values()]
    const scale = Math.min(Math.max(pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance), 1), ZOOM_MAX)
    const origin = imageOrigin()
    const midX = (a.x + b.x) / 2 - origin.x
    const midY = (a.y + b.y) / 2 - origin.y

    // The image point that sat under the fingers' first midpoint follows the midpoint now.
    zoom.x = midX - (pinch.midX - origin.x - pinch.x) * (scale / pinch.scale)
    zoom.y = midY - (pinch.midY - origin.y - pinch.y) * (scale / pinch.scale)
    zoom.scale = scale
    applyZoom()

    return
  }

  const dx = point.x - drag.x
  const dy = point.y - drag.y

  if (drag.mode === 'tap' && Math.hypot(dx, dy) > TAP_SLOP_PX) {
    if (zoom.scale > 1) drag.mode = 'pan'
    else drag.mode = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'none'
  }

  if (drag.mode === 'pan') {
    zoom.x += point.x - last.x
    zoom.y += point.y - last.y
    applyZoom()
  } else if (drag.mode === 'swipe') {
    const blocked = (dx > 0 && shown.index === 0) || (dx < 0 && shown.index >= shown.items.length - 1)

    moveTrack(blocked ? dx * EDGE_RESISTANCE : dx, false)
  }
})

function endPointer(event) {
  if (!pointers.delete(event.pointerId) || drag === null) return

  if (drag.mode === 'pinch') {
    if (pointers.size > 0) return

    pinch = null
    drag = null

    if (zoom.scale <= 1.01) resetZoom()

    return
  }

  const done = drag
  const dx = event.clientX - done.x

  drag = null

  if (event.type === 'pointercancel') {
    if (done.mode === 'swipe') moveTrack(0, true)

    return
  }

  if (done.mode === 'swipe') {
    const quick = performance.now() - done.at < SWIPE_FLICK_MS && Math.abs(dx) > SWIPE_FLICK_PX

    if (quick || Math.abs(dx) > viewerTrack.clientWidth * SWIPE_SHARE) go(dx < 0 ? 1 : -1)
    else moveTrack(0, true)

    return
  }

  if (done.mode !== 'tap') return

  // Double tap on the image zooms in there or back out; a tap beside it closes the viewer.
  if (done.onImage) {
    const now = performance.now()

    if (now - lastTap < DOUBLE_TAP_MS) {
      lastTap = 0
      zoomAt(zoom.scale > 1 ? 1 : DOUBLE_TAP_ZOOM, done.x, done.y)
    } else {
      lastTap = now
    }
  } else if (zoom.scale === 1) {
    closeViewer()
  }
}

viewerTrack.addEventListener('pointerup', endPointer)
viewerTrack.addEventListener('pointercancel', endPointer)

viewerTrack.addEventListener('wheel', (event) => {
  event.preventDefault()
  zoomAt(zoom.scale * 1.0015 ** -event.deltaY, event.clientX, event.clientY)
}, { passive: false })

// ---- Pinned thumbnails: this session's images pile up in the top-right corner and stay until
// closed one by one (or all at once). The server keeps what was closed in which session, so every
// screen shows the same pile; `dismissed` only hides them here until its answer arrives.

const shots = $('shots')
const SCAN_DELAY_MS = 250
const dismissed = new Set()
let shotsKey = ''
let scanTimer = 0

function dismiss(ids) {
  for (const id of ids) dismissed.add(id)

  postJson('/gallery/unpin', { ids, session: current }).catch(() => notice('닫은 미리보기를 저장하지 못했어요'))
  renderShots()
}

function pinnedImages() {
  return sessionImages().filter((item) => !dismissed.has(item.id) && !item.unpinned?.includes(current))
}

// Rebuilt only when the set changes: Claude redraws its screen all the time, and a thumbnail taken
// out and put back between finger down and up would swallow the tap.
// The corner card of this session's images starts folded to one line.
const SHOTS_OPEN_KEY = 'choiterm.shots-open'
let shotsOpen = load(SHOTS_OPEN_KEY) === '1'

function renderShots() {
  const items = current === null ? [] : pinnedImages()
  const key = items.map((item) => item.id).join(',')

  if (key === shotsKey) return

  const grew = items.length > shotsKey.split(',').filter(Boolean).length

  shotsKey = key
  shots.replaceChildren()
  shots.hidden = items.length === 0

  if (items.length === 0) return

  const row = document.createElement('div')

  row.className = 'shots-row'

  items.forEach((item, index) => {
    const cell = document.createElement('div')
    const open = document.createElement('button')
    const image = document.createElement('img')
    const close = document.createElement('button')

    cell.className = 'shot'
    open.type = 'button'
    open.className = 'shot-open'
    open.title = item.path
    image.alt = ''
    image.draggable = false
    image.loading = 'lazy'
    image.src = previewUrl(item.path)
    open.append(image)
    open.addEventListener('click', () => openViewer(items, index))
    close.type = 'button'
    close.className = 'shot-x'
    close.setAttribute('aria-label', '이 미리보기 닫기')
    close.innerHTML = icon('x', 11, 2.5)
    close.addEventListener('click', () => dismiss([item.id]))
    cell.append(open, close)
    row.append(cell)
  })

  const head = document.createElement('div')
  const all = document.createElement('button')
  const toggle = document.createElement('button')

  head.className = 'shots-head'
  toggle.type = 'button'
  toggle.className = 'shots-toggle'
  toggle.innerHTML = icon('image', 12)
  toggle.append(`이미지 ${items.length}`)
  toggle.insertAdjacentHTML('beforeend', icon(shotsOpen ? 'chevron-up' : 'chevron-down', 12))
  toggle.title = shotsOpen ? '접기' : '펼치기'
  toggle.addEventListener('click', () => {
    shotsOpen = !shotsOpen
    save(SHOTS_OPEN_KEY, shotsOpen ? '1' : null)
    shotsKey = ''
    renderShots()
  })
  head.append(toggle)
  shots.toggleAttribute('data-folded', !shotsOpen)
  row.hidden = !shotsOpen
  all.type = 'button'
  all.className = 'icon-5'
  all.innerHTML = icon('x', 12)
  all.title = items.length > 1 ? '모두 닫기' : '닫기'
  all.setAttribute('aria-label', all.title)
  all.addEventListener('click', () => dismiss(items.map((item) => item.id)))
  head.append(all)
  shots.append(head, row)

  // The newest sits at the right end; keep it in view when one arrives.
  if (grew) row.scrollLeft = row.scrollWidth
}

// Links and image paths on screen get a coloured underline drawn over the terminal, so it is clear
// what a tap opens (xterm only underlines a link while the mouse is on it).
const linksLayer = $('links')

function drawLinks() {
  linksLayer.replaceChildren()

  if (current === null) return

  const box = term.element.querySelector('.xterm-screen').getBoundingClientRect()
  const origin = stage.getBoundingClientRect()
  const cellWidth = box.width / term.cols
  const cellHeight = box.height / term.rows

  for (const line of screenLines(true)) {
    for (const { pattern } of LINK_PATTERNS) {
      for (const match of line.text.matchAll(pattern)) {
        const start = match.index
        const end = start + cleanLink(match[0]).length

        for (const [row, at] of line.rows) {
          let first = -1
          let last = -1

          at.columns.forEach((index, col) => {
            const spot = at.offset + index

            if (index < at.from || index >= at.to || spot < start || spot >= end) return

            if (first === -1) first = col

            last = col
          })

          if (first === -1) continue

          const mark = document.createElement('div')

          mark.className = 'link-mark'
          mark.style.left = `${box.left - origin.left + first * cellWidth}px`
          mark.style.top = `${box.top - origin.top + row * cellHeight}px`
          mark.style.width = `${(last - first + 1) * cellWidth}px`
          mark.style.height = `${cellHeight}px`
          linksLayer.append(mark)
        }
      }
    }
  }
}

// Redrawn with the terminal's own frames (at most once per frame), so the underlines move with
// the text while it scrolls instead of catching up afterwards.
let linksFrame = 0

function scheduleLinks() {
  if (linksFrame !== 0) return

  linksFrame = requestAnimationFrame(() => {
    linksFrame = 0
    drawLinks()
  })
}

term.onRender(scheduleLinks)

function scanScreen() {
  if (current === null) return

  for (const path of screenImages()) report(path)
}

// At most one scan per delay: Claude's screen never stops changing (spinner, clock), so a timer
// that restarted on each write would never fire.
function scheduleScan() {
  if (scanTimer !== 0) return

  scanTimer = setTimeout(() => {
    scanTimer = 0
    scanScreen()
  }, SCAN_DELAY_MS)
}

term.onWriteParsed(scheduleScan)
term.onScroll(scheduleScan)

// ---- Gallery: everything sent and received, filtered by who sent it or a tag; long press or
// "선택" picks several to delete.

const galleryPanel = $('galleryPanel')
const galleryGrid = $('galleryGrid')
const galleryFilters = $('galleryFilters')
const galleryFoot = $('galleryFoot')
const galleryDelete = $('galleryDelete')
const galleryPick = $('galleryPick')
const LONG_PRESS_MS = 500
const galleryPicked = new Set()
let galleryFilter = 'all'
let galleryPicking = false
let galleryArmed = 0

function galleryMatches(item) {
  if (galleryFilter === 'all') return true

  if (galleryFilter === 'me' || galleryFilter === 'claude') return item.from === galleryFilter

  if (galleryFilter === 'session') return item.sessions.includes(current)

  return item.tags.includes(galleryFilter.slice(1))
}

function filteredGallery() {
  return gallery.filter(galleryMatches).reverse()
}

function setGalleryPicking(on) {
  galleryPicking = on
  galleryPicked.clear()
  galleryArmed = 0
  renderGallery()
}

// A press held still for a moment, for touch and mouse alike. The click that follows is eaten at
// the document, since the action usually redraws the list and the click lands on a new element.
const CLICK_SWALLOW_MS = 600
let swallowClicksUntil = 0

document.addEventListener('click', (event) => {
  if (performance.now() > swallowClicksUntil) return

  swallowClicksUntil = 0
  event.stopImmediatePropagation()
  event.preventDefault()
}, { capture: true })

function onLongPress(element, action) {
  let timer = 0
  let start = null

  element.addEventListener('pointerdown', (event) => {
    start = { x: event.clientX, y: event.clientY }
    clearTimeout(timer)
    const mouse = event.pointerType === 'mouse'

    timer = setTimeout(() => {
      swallowClicksUntil = performance.now() + CLICK_SWALLOW_MS
      navigator.vibrate?.(15)
      action({ x: start.x, y: start.y, mouse })
    }, LONG_PRESS_MS)
  })
  element.addEventListener('pointermove', (event) => {
    if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) clearTimeout(timer)
  })

  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) element.addEventListener(type, () => clearTimeout(timer))

  // A right click on the PC does the same; a phone may send this too on a long press, before or
  // after the timer, and either way the action runs once.
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    clearTimeout(timer)

    if (performance.now() <= swallowClicksUntil) return

    // A mouse's right click is not followed by a click, so the menu it opens takes one at once.
    if (touch) swallowClicksUntil = performance.now() + CLICK_SWALLOW_MS

    action({ x: event.clientX, y: event.clientY, mouse: !touch })
  })
}

function renderGallery() {
  if (galleryPanel.hidden) return

  const items = filteredGallery()
  const tags = [...new Set(gallery.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b, 'ko'))
  const filters = [['all', '전체'], ['session', '이 세션'], ['me', '내가 보낸 것'], ['claude', '받은 것'], ...tags.map((tag) => [`#${tag}`, `#${tag}`])]

  if (!filters.some(([key]) => key === galleryFilter)) galleryFilter = 'all'

  galleryFilters.replaceChildren(...filters.map(([key, label]) => chip(label, () => {
    galleryFilter = key
    renderGallery()
  }, { 'data-on': galleryFilter === key })))
  $('galleryCount').textContent = `${items.length}개`
  galleryPick.textContent = galleryPicking ? '취소' : '선택'
  galleryGrid.replaceChildren()

  if (items.length === 0) {
    const none = document.createElement('p')

    none.className = 'gallery-empty'
    none.textContent = gallery.length === 0 ? '아직 주고받은 이미지가 없어요' : '이 조건에 맞는 이미지가 없어요'
    galleryGrid.append(none)
  }

  items.forEach((item, index) => {
    const cell = document.createElement('button')
    const image = document.createElement('img')

    cell.type = 'button'
    cell.className = 'cell'
    cell.title = item.path
    cell.dataset.from = item.from
    cell.toggleAttribute('data-picked', galleryPicked.has(item.id))
    image.alt = ''
    image.draggable = false
    image.loading = 'lazy'
    image.src = previewUrl(item.path)
    image.addEventListener('error', () => cell.setAttribute('data-missing', ''))
    cell.append(image)

    if (galleryPicking) {
      const box = document.createElement('span')

      box.className = 'check'
      cell.append(box)
    }

    if (item.tags.length > 0) {
      const badge = document.createElement('span')

      badge.className = 'cell-tags'
      badge.textContent = item.tags.map((tag) => `#${tag}`).join(' ')
      cell.append(badge)
    }

    cell.addEventListener('click', () => {
      if (!galleryPicking) {
        openViewer(items, index)

        return
      }

      if (galleryPicked.has(item.id)) galleryPicked.delete(item.id)
      else galleryPicked.add(item.id)

      galleryArmed = 0
      renderGallery()
    })
    onLongPress(cell, () => {
      if (!galleryPicking) {
        galleryPicking = true
        galleryPicked.clear()
      }

      galleryPicked.add(item.id)
      renderGallery()
    })
    galleryGrid.append(cell)
  })

  galleryFoot.hidden = !galleryPicking
  galleryDelete.disabled = galleryPicked.size === 0
  galleryDelete.textContent = galleryArmed > Date.now() ? `정말 ${galleryPicked.size}개를 지울까요?` : `${galleryPicked.size}개 삭제`
}

function openGallery() {
  closeDrawer()
  galleryPanel.hidden = false
  setGalleryPicking(false)
}

$('openGallery').addEventListener('click', openGallery)
$('galleryBack').addEventListener('click', () => {
  galleryPanel.hidden = true
})
galleryPick.addEventListener('click', () => setGalleryPicking(!galleryPicking))
$('galleryAll').addEventListener('click', () => {
  if (!galleryPicking) galleryPicking = true

  const items = filteredGallery()
  const everything = items.every((item) => galleryPicked.has(item.id))

  for (const item of items) {
    if (everything) galleryPicked.delete(item.id)
    else galleryPicked.add(item.id)
  }

  renderGallery()
})

// Deleting removes files the owner sent from the PC too, so the button asks once more.
galleryDelete.addEventListener('click', () => {
  if (galleryArmed <= Date.now()) {
    galleryArmed = Date.now() + 3000
    renderGallery()
    setTimeout(renderGallery, 3100)

    return
  }

  const ids = [...galleryPicked]

  galleryArmed = 0
  postJson('/gallery/delete', { ids })
    .then(() => notice(`${ids.length}개 지웠어요`))
    .catch(() => notice('지우지 못했어요'))
  setGalleryPicking(false)
})

// A new list from the server: thumbnails, the gallery and an open viewer follow it.
function galleryChanged(items) {
  gallery = items
  renderShots()
  renderGallery()

  if (!filesPanel.hidden && panel === 'images') renderSessionImages()

  if (viewer.hidden) return

  const fresh = new Map(items.map((item) => [item.id, item]))
  const kept = []
  let index = 0

  shown.items.forEach((item, at) => {
    const next = item.id === null ? galleryItem(item.path) ?? item : fresh.get(item.id)

    if (next === undefined) return

    if (at <= shown.index) index = kept.length

    kept.push(next)
  })

  if (kept.length === 0) {
    closeViewer()

    return
  }

  shown.items = kept
  shown.index = Math.min(index, kept.length - 1)
  layoutSlides()
}

function openLink(link) {
  if (link.kind === 'image') openImagePath(link.target)
  else openUrl(link.target)
}

const DRAG_START_PX = 8
// Fling: the speed at release decays by this factor every 100 ms, and stops below the floor.
const FLING_DECAY_PER_100MS = 0.35
const FLING_MIN_PX_PER_MS = 0.05
let gesture = null
let fling = 0

// Pixels of finger travel turn into wheel notches; the remainder carries over so slow drags still
// scroll and nothing is lost between moves.
function scrollBy(state, pixels, x, y) {
  const box = term.element.querySelector('.xterm-screen').getBoundingClientRect()
  const rows = term.modes.mouseTrackingMode !== 'none' ? ROWS_PER_NOTCH : 1
  const notch = (box.height / term.rows) * SCROLL_SPEEDS[scrollSpeed] * rows

  state.carry += pixels

  const notches = Math.trunc(state.carry / notch)

  if (notches === 0) return

  state.carry -= notches * notch

  const cell = cellAt(x, y)

  for (let step = 0; step < Math.abs(notches); step += 1) wheel(notches < 0, cell)
}

function startFling(state, velocity) {
  let speed = velocity
  let last = performance.now()
  const id = (fling += 1)

  const frame = (now) => {
    if (id !== fling || Math.abs(speed) < FLING_MIN_PX_PER_MS) return

    const elapsed = now - last

    last = now
    scrollBy(state, speed * elapsed, state.x, state.lastY)
    speed *= FLING_DECAY_PER_100MS ** (elapsed / 100)
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}

// Captured before xterm sees them: drags scroll (and keep going for a moment after a flick), taps
// on a link open it, other taps go on to the app as clicks.
stage.addEventListener('touchstart', (event) => {
  const point = event.touches[0]

  fling += 1

  // Thumbnails and the selection handles take their own touches.
  if (event.target.closest('.shots, .sel-handle')) {
    gesture = null

    return
  }

  const started = { startY: point.clientY, lastY: point.clientY, x: point.clientX, dragging: false, carry: 0, velocity: 0, at: performance.now(), held: false }

  gesture = started
  clearTimeout(holdTimer)
  holdTimer = setTimeout(() => {
    if (gesture !== started || started.dragging || current === null) return

    started.held = true
    navigator.vibrate?.(15)
    startCopy(cellAt(started.x, started.startY))
  }, LONG_PRESS_MS)
}, { capture: true, passive: true })

stage.addEventListener('touchmove', (event) => {
  if (gesture === null || current === null) return

  const point = event.touches[0]

  if (!gesture.dragging && Math.abs(point.clientY - gesture.startY) < DRAG_START_PX) return

  clearTimeout(holdTimer)

  // Scrolling means reading: the input bar lets go, or the keyboard keeps coming back while the
  // page moves under it. What was typed stays in the bar.
  if (!gesture.dragging && document.activeElement === text) text.blur()

  gesture.dragging = true
  event.preventDefault()
  event.stopPropagation()

  const now = performance.now()
  const moved = gesture.lastY - point.clientY
  const elapsed = Math.max(now - gesture.at, 1)

  // Smoothed, so one jittery move does not decide the fling.
  gesture.velocity = gesture.velocity * 0.6 + (moved / elapsed) * 0.4
  gesture.at = now
  gesture.lastY = point.clientY
  scrollBy(gesture, moved, gesture.x, point.clientY)
}, { capture: true, passive: false })

stage.addEventListener('touchend', (event) => {
  const done = gesture

  gesture = null
  clearTimeout(holdTimer)

  if (done === null) return

  // The press already chose text to copy; the lift must not also click into Claude.
  if (done.held) {
    event.preventDefault()
    event.stopPropagation()

    return
  }

  // A tap beside a selection puts it away (and is not a click into the terminal).
  if (!done.dragging && selecting()) {
    event.preventDefault()
    event.stopPropagation()
    endCopy()

    return
  }

  if (done.dragging) {
    event.preventDefault()
    event.stopPropagation()

    // A finger that stopped before lifting means no fling.
    if (performance.now() - done.at < 80) startFling(done, done.velocity)

    return
  }

  const link = linkAt(cellAt(done.x, done.startY))

  if (link === null) return

  // Stops the browser's follow-up mouse click, so Claude does not also open it on the PC.
  event.preventDefault()
  event.stopPropagation()
  openLink(link)
}, { capture: true, passive: false })

// ---- Search: what the terminal still holds (a shell's scrollback; for Claude's full screen only
// what is on it). The addon loads on first use, so the page works on a server without it.

const searchForm = $('search')
const searchText = $('searchText')
const searchCount = $('searchCount')
const SEARCH_OPTIONS = {
  caseSensitive: false,
  decorations: {
    matchBackground: '#E8B39A',
    matchOverviewRuler: '#C96442',
    activeMatchBackground: '#C96442',
    activeMatchColorOverviewRuler: '#C96442',
  },
}
let searcher = null

async function openSearch() {
  if (searcher === null) {
    try {
      const { SearchAddon } = await import('/vendor/addon-search.mjs')

      searcher = new SearchAddon()
      term.loadAddon(searcher)
      searcher.onDidChangeResults(({ resultIndex, resultCount }) => {
        searchCount.textContent = resultCount === 0 ? '없음' : `${resultIndex + 1} / ${resultCount}`
      })
    } catch {
      notice('찾기를 불러오지 못했어요')

      return
    }
  }

  searchForm.hidden = false
  searchText.focus()
  searchText.select()
}

function closeSearch() {
  searchForm.hidden = true
  searchCount.textContent = ''
  searcher?.clearDecorations()
}

function find(forward) {
  const query = searchText.value

  if (searcher === null || query === '') {
    searchCount.textContent = ''
    searcher?.clearDecorations()

    return
  }

  if (forward) searcher.findNext(query, SEARCH_OPTIONS)
  else searcher.findPrevious(query, SEARCH_OPTIONS)
}

$('searchButton').addEventListener('click', () => {
  if (searchForm.hidden) void openSearch()
  else closeSearch()
})
searchText.addEventListener('input', () => find(true))
searchForm.addEventListener('submit', (event) => {
  event.preventDefault()
  find(true)
})
$('searchPrev').addEventListener('click', () => find(false))
$('searchClose').addEventListener('click', closeSearch)
searchText.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return

  event.preventDefault()
  closeSearch()
})

// Ctrl+F on the PC opens it (the browser's own find cannot see the terminal's scrollback).
addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return

  event.preventDefault()
  void openSearch()
}, { capture: true })

// Ctrl+Tab and Ctrl+Shift+Tab walk the tabs, wrapping around (the PC program hands these keys to
// the page; a browser keeps them for its own tabs).
addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.key !== 'Tab' || openTabs.length < 2) return

  event.preventDefault()
  event.stopPropagation()

  const at = openTabs.indexOf(current)
  const step = event.shiftKey ? -1 : 1

  select(openTabs[(at + step + openTabs.length) % openTabs.length] ?? openTabs[0])
}, { capture: true })

// Ctrl+T opens a new Claude Code tab, Ctrl+Shift+T a PowerShell one (the PC program hands these
// keys to the page; in a browser they stay the browser's).
addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 't') return

  event.preventDefault()
  event.stopPropagation()

  if (!event.repeat) openSession(event.shiftKey ? 'shell' : 'claude')
}, { capture: true })

// ---- Copying. The selection is xterm's own (it draws it and keeps it while scrolling). On the
// phone a long press selects the word under the finger, two handles stretch it, and a bar copies it
// or widens it to the paragraph or the screen. On the PC a mouse drag selects and Ctrl+C copies.

const copyBar = $('copybar')
const handles = { start: $('selStart'), end: $('selEnd') }
let holdTimer = 0
// Where a handle drag holds the other end of the selection.
let anchor = null

const order = (pos) => pos.y * term.cols + pos.x

// Selects from one cell to another, either way round, both ends included.
function selectBetween(a, b) {
  const [from, to] = order(a) <= order(b) ? [a, b] : [b, a]

  term.select(from.x, from.y, order(to) - order(from) + 1)
  // xterm does not always announce a selection made again on the same cells.
  placeHandles()
}

function selecting() {
  return term.hasSelection()
}

// The word under a cell (a run of non-blank characters); a blank spot takes the row's text.
function wordAt(cell) {
  const y = term.buffer.active.viewportY + cell.row
  const row = bufferRow(y)
  const blank = (col) => {
    const at = row.columns[col]

    return at === undefined || (row.text[at] ?? ' ').trim() === ''
  }

  if (blank(cell.col)) {
    const first = row.columns.findIndex((_, col) => !blank(col))

    return first === -1 ? null : { from: { x: first, y }, to: { x: row.lastCol, y } }
  }

  let from = cell.col
  let to = cell.col

  while (from > 0 && !blank(from - 1)) from -= 1

  while (to < term.cols - 1 && !blank(to + 1)) to += 1

  // A word (a link, most often) cut at the last column goes on at the start of the next row.
  const start = { x: from, y }
  const end = { x: to, y }

  while (end.x === term.cols - 1 && continuesBelow(end.y)) {
    const next = bufferRow(end.y + 1)
    const lead = next.columns.findIndex((at) => (next.text[at] ?? ' ').trim() !== '')
    let last = lead

    while (last < term.cols - 1 && (next.text[next.columns[last + 1]] ?? ' ').trim() !== '') last += 1

    end.y += 1
    end.x = last
  }

  while (start.x <= firstColumn(start.y) && continuesBelow(start.y - 1)) {
    const above = bufferRow(start.y - 1)
    let first = term.cols - 1

    while (first > 0 && (above.text[above.columns[first - 1]] ?? ' ').trim() !== '') first -= 1

    start.y -= 1
    start.x = first
  }

  return { from: start, to: end }
}

// Whether row y runs on into row y + 1: a wrap, or Claude's own cut at the last column with the
// rest indented on the next row.
function continuesBelow(y) {
  if (y < 0 || y + 1 >= term.buffer.active.length) return false

  const row = bufferRow(y)
  const next = bufferRow(y + 1)

  return next.wrapped || (row.lastCol === term.cols - 1 && /^\s*\S/.test(next.text) && LINK_CHAR.test(row.text.trimEnd().at(-1) ?? ' '))
}

function firstColumn(y) {
  const row = bufferRow(y)
  const found = row.columns.findIndex((at) => (row.text[at] ?? ' ').trim() !== '')

  return found === -1 ? 0 : found
}

// The selected text, rebuilt row by row: a row Claude broke at the very last column (a long word
// or link) joins the next without its indent, other rows end in a line break, and the indent the
// rows share is dropped.
function selectionText() {
  const range = term.getSelectionPosition()

  if (range === undefined) return ''

  const pieces = []

  for (let y = range.start.y; y <= range.end.y; y += 1) {
    const row = bufferRow(y)
    const from = y === range.start.y ? range.start.x : 0
    const to = y === range.end.y ? range.end.x : term.cols
    const text = row.text.slice(row.columns[from] ?? row.text.length, row.columns[to] ?? row.text.length)
    const next = y < range.end.y ? bufferRow(y + 1) : null
    const joins = next !== null && (next.wrapped || (row.lastCol === term.cols - 1 && /^\s/.test(next.text) && LINK_CHAR.test(row.text.trimEnd().at(-1) ?? ' ')))

    pieces.push({ text, joins, lead: pieces.at(-1)?.joins === true })
  }

  const lines = []
  let line = ''

  for (const piece of pieces) {
    line += piece.lead ? piece.text.trimStart() : piece.text

    if (!piece.joins) {
      lines.push(line.replace(/\s+$/, ''))
      line = ''
    }
  }

  // A selection that starts mid-row has no indent on its first line; the others set it.
  const startsMidRow = range.start.x > firstColumn(range.start.y)
  let common = Infinity

  lines.forEach((each, index) => {
    if (each.trim() !== '' && !(index === 0 && startsMidRow)) common = Math.min(common, each.length - each.trimStart().length)
  })

  const cut = Number.isFinite(common) ? common : 0

  return lines.map((each, index) => (index === 0 && startsMidRow ? each : each.slice(cut))).join('\n').replace(/\n+$/, '')
}

function placeHandles() {
  const range = touch ? term.getSelectionPosition() : undefined

  copyBar.hidden = !touch || range === undefined

  const box = term.element.querySelector('.xterm-screen').getBoundingClientRect()
  const origin = stage.getBoundingClientRect()
  const cellWidth = box.width / term.cols
  const cellHeight = box.height / term.rows
  const top = term.buffer.active.viewportY

  // Only moved, never hidden and shown again: hiding a handle under a finger ends its drag.
  for (const [name, pos] of [['start', range?.start], ['end', range?.end]]) {
    const handle = handles[name]
    const row = pos === undefined ? -1 : pos.y - top
    const shown = pos !== undefined && row >= 0 && row < term.rows

    if (handle.hidden === shown) handle.hidden = !shown

    if (!shown) continue

    handle.style.left = `${box.left - origin.left + pos.x * cellWidth}px`
    handle.style.top = `${box.top - origin.top + (row + 1) * cellHeight}px`
  }
}

function startCopy(cell) {
  const word = wordAt(cell)

  if (word === null) {
    notice('복사할 글자가 없는 곳이에요')

    return
  }

  selectBetween(word.from, word.to)
}

function endCopy() {
  anchor = null
  term.clearSelection()
  placeHandles()
}

async function copyText(value) {
  if (value === '') return

  try {
    await navigator.clipboard.writeText(value)
  } catch {
    // Older WebViews refuse the clipboard API outside a secure page; a selected box still copies.
    const box = document.createElement('textarea')

    box.value = value
    box.setAttribute('readonly', '')
    box.style.position = 'fixed'
    box.style.opacity = '0'
    document.body.append(box)
    box.select()
    document.execCommand('copy')
    box.remove()
  }

  const lines = value.split('\n').length

  notice(lines > 1 ? `${lines}줄 복사했어요` : '복사했어요')
}

// The paragraph around the selection's start: the run of non-blank rows on screen.
function selectParagraph() {
  const range = term.getSelectionPosition()

  if (range === undefined) return

  const blank = (y) => bufferRow(y).text.trim() === ''
  let first = range.start.y
  let last = range.start.y

  while (first > 0 && !blank(first - 1)) first -= 1

  while (last < term.buffer.active.length - 1 && !blank(last + 1)) last += 1

  selectBetween({ x: 0, y: first }, { x: term.cols - 1, y: last })
}

$('copyNow').addEventListener('click', () => {
  void copyText(selectionText()).then(endCopy)
})
$('copyParagraph').addEventListener('click', selectParagraph)
$('copyScreen').addEventListener('click', () => {
  const top = term.buffer.active.viewportY

  selectBetween({ x: 0, y: top }, { x: term.cols - 1, y: top + term.rows - 1 })
})
$('copyCancel').addEventListener('click', endCopy)
term.onSelectionChange(placeHandles)
term.onScroll(placeHandles)

// Dragging a handle moves that end of the selection; near the top or bottom edge the terminal
// scrolls so the selection can grow past the screen.
const EDGE_PX = 28

for (const [name, handle] of Object.entries(handles)) {
  handle.addEventListener('pointerdown', (event) => {
    const range = term.getSelectionPosition()

    if (range === undefined) return

    event.preventDefault()
    event.stopPropagation()
    handle.setPointerCapture(event.pointerId)
    // The end the finger does not hold stays where it is (the end position is one past the last cell).
    anchor = name === 'start' ? { x: Math.max(0, range.end.x - 1), y: range.end.y } : range.start
  })
  handle.addEventListener('pointermove', (event) => {
    if (anchor === null || !handle.hasPointerCapture(event.pointerId)) return

    const box = stage.getBoundingClientRect()
    const cellHeight = term.element.querySelector('.xterm-screen').getBoundingClientRect().height / term.rows

    if (event.clientY < box.top + EDGE_PX) term.scrollLines(-1)
    else if (event.clientY > box.bottom - EDGE_PX) term.scrollLines(1)

    // The handle hangs under the text, so the cell is the one just above the finger.
    const cell = cellAt(event.clientX, event.clientY - cellHeight * 0.8)

    selectBetween(anchor, { x: cell.col, y: term.buffer.active.viewportY + cell.row })
  })

  for (const type of ['pointerup', 'pointercancel']) {
    handle.addEventListener(type, () => {
      anchor = null
    })
  }
}

// PC: Ctrl+C copies when something is selected and is the terminal's interrupt otherwise, like
// Windows Terminal; Ctrl+Shift+C always copies.
term.attachCustomKeyEventHandler((event) => {
  // Ctrl+V is the browser's paste, not ^V to the shell: text goes in as a paste and an image is
  // uploaded (see the paste listener). Without this xterm sends ^V and cancels the paste.
  const pasteKey = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v'

  if (pasteKey) return false

  const copyKey = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c'

  if (!copyKey || (!event.shiftKey && !selecting())) return true

  if (event.type === 'keydown') {
    void copyText(selectionText())
    term.clearSelection()
  }

  event.preventDefault()

  return false
})

// On the PC a click opens links and images (the pointer shows a hand over them); a drag still
// selects text. A program that takes the mouse itself (mouse reporting on) keeps plain clicks, so
// there Ctrl+click opens them. Phones have their own tap handling.
const CLICK_SLOP_PX = 4
let pressedLink = null

screen.addEventListener('mousedown', (event) => {
  pressedLink = null

  if (touch || event.button !== 0) return

  const link = linkAt(cellAt(event.clientX, event.clientY))

  if (link === null) return

  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    event.stopPropagation()
    openLink(link)

    return
  }

  if (term.modes.mouseTrackingMode === 'none') pressedLink = { x: event.clientX, y: event.clientY, link }
}, { capture: true })

addEventListener('mouseup', (event) => {
  const press = pressedLink

  pressedLink = null

  if (press === null || Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX || term.hasSelection()) return

  openLink(press.link)
})

let hoverFrame = 0

// An image path under the mouse shows the picture beside the pointer, without leaving the terminal;
// a click still opens it large.
const hoverPreview = document.createElement('div')
const hoverImage = document.createElement('img')
const hoverName = document.createElement('div')
const HOVER_GAP_PX = 14
let hoverPath = null

hoverPreview.className = 'hover-preview'
hoverPreview.hidden = true
hoverImage.alt = ''
hoverImage.draggable = false
hoverName.className = 'hover-name'
hoverPreview.append(hoverImage, hoverName)
document.body.append(hoverPreview)

function placeHoverPreview(x, y) {
  const box = hoverPreview.getBoundingClientRect()
  const left = x + HOVER_GAP_PX + box.width > innerWidth - 8 ? x - HOVER_GAP_PX - box.width : x + HOVER_GAP_PX
  const top = y + HOVER_GAP_PX + box.height > innerHeight - 8 ? y - HOVER_GAP_PX - box.height : y + HOVER_GAP_PX

  hoverPreview.style.left = `${Math.max(8, left)}px`
  hoverPreview.style.top = `${Math.max(8, top)}px`
}

function showHoverPreview(path, x, y) {
  if (path !== hoverPath) {
    hoverPath = path
    hoverImage.onload = () => placeHoverPreview(x, y)
    hoverImage.src = previewUrl(path)
    hoverName.textContent = fileName(path)
  }

  hoverPreview.hidden = false
  placeHoverPreview(x, y)
}

function hideHoverPreview() {
  hoverPreview.hidden = true
}

screen.addEventListener('mousemove', (event) => {
  if (touch || hoverFrame !== 0) return

  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0

    const link = linkAt(cellAt(event.clientX, event.clientY))

    screen.classList.toggle('over-link', link !== null)

    if (link?.kind === 'image') showHoverPreview(link.target, event.clientX, event.clientY)
    else hideHoverPreview()
  })
})

screen.addEventListener('mouseleave', () => {
  screen.classList.remove('over-link')
  hideHoverPreview()
})
screen.addEventListener('wheel', hideHoverPreview, { passive: true })
screen.addEventListener('mousedown', hideHoverPreview)

// The side list: every running session, opened into a tab with a tap, and the only place that
// ends them (several at once in pick mode).
let picking = false
const picked = new Set()
let killArmed = 0

// On a phone: the desktops first, then one desktop's workspaces, then a session
// filling the screen. On the PC the list is a sidebar that can be folded away.
// How long the phone app takes to put its insets back after the keyboard or the home screen.
const SETTLE_MS = 400
const hostsEl = $('hosts')
const hostsBody = $('hostsBody')

function setView(name) {
  appEl.dataset.view = name
  hostsEl.hidden = !(touch && name === 'hosts')

  if (name === 'hosts') {
    renderHosts()
    void refreshMachines()
  }

  if (name === 'session') {
    requestAnimationFrame(claim)
    setTimeout(claim, SETTLE_MS)
  }
}

function openDrawer() {
  if (touch) setView('home')
  else setSideOpen(true)
}

const SIDE_KEY = 'choiterm.side'

function setSideOpen(open) {
  $('side').hidden = !open
  $('sideOpen').hidden = open
  save(SIDE_KEY, open ? null : 'closed')
  requestAnimationFrame(() => claim())
}

$('sideClose').addEventListener('click', () => setSideOpen(false))
$('sideOpen').addEventListener('click', () => setSideOpen(true))
backHome.addEventListener('click', () => setView('home'))
$('toHosts').addEventListener('click', () => setView('hosts'))
$('hostsRefresh').addEventListener('click', () => {
  void refreshMachines()
  void refreshUsage()
})

if (!touch && load(SIDE_KEY) === 'closed') setSideOpen(false)

// A notification opens its session; another PC's card opens that PC's list (#host); otherwise the
// phone starts on its desktops.
const startHash = new URLSearchParams(location.hash.slice(1))

if (location.hash !== '') history.replaceState(null, '', location.pathname)


// ---- The desktops (the phone's home): a card per PC with its state and sessions, what to pick up
// again, quick actions and the accounts' usage.
const OS_LABEL = 'Windows'
// This PC's tailnet address (its /hello), for the phone app's first start.
let ownAddress = ''

void getJson('/hello').then((hello) => {
  ownAddress = typeof hello?.url === 'string' ? hello.url : ''
  renderHosts()
})

function hereCounts() {
  const running = sessions.filter((session) => !session.archived)

  return { sessions: running.length, busy: running.filter((session) => metaById.get(session.id)?.busy).length }
}

function countLine(counts) {
  if (counts.sessions === null) return ''

  return counts.busy > 0 ? `세션 ${counts.sessions}개 · ${counts.busy}개 작업 중` : `세션 ${counts.sessions}개`
}

function hostCard(machine) {
  const card = document.createElement('button')
  const tile = document.createElement('span')
  const main = document.createElement('span')
  const name = document.createElement('span')
  const os = document.createElement('span')
  const state = document.createElement('span')
  const counts = machine.here ? hereCounts() : { sessions: machine.sessions, busy: machine.busy }
  const live = machine.here || machine.online

  card.type = 'button'
  card.className = 'host-card'
  card.toggleAttribute('data-off', !live)
  tile.className = 'host-tile'
  tile.innerHTML = icon('monitor', 20)
  main.className = 'host-main'
  name.className = 'host-name'
  name.textContent = machine.name
  os.className = 'host-os'
  os.textContent = machine.here ? `${OS_LABEL} · 지금 보는 PC` : OS_LABEL
  state.className = 'host-state'
  state.innerHTML = `<i class="dot" data-state="${live ? 'open' : 'off'}"></i>`
  state.append(live ? '연결됨 · Tailscale' : '꺼져 있음')
  main.append(name, os, state)

  if (live && countLine(counts) !== '') main.append(Object.assign(document.createElement('span'), { className: 'host-count', textContent: countLine(counts) }))

  if (!live) main.append(Object.assign(document.createElement('span'), { className: 'host-hint', textContent: 'PC가 켜져 있고 ChoiTerm이 실행 중인지 확인해 주세요' }))

  card.append(tile, main)
  card.insertAdjacentHTML('beforeend', `<span class="host-go">${icon('chevron-right', 18)}</span>`)
  card.disabled = !live
  card.addEventListener('click', () => {
    if (machine.here) {
      if (touch) setView('home')
      else showHome(false)

      return
    }

    // An older phone app opens other PCs in the browser: ask for the new one instead.
    if (oldApp()) {
      showAppUpdate('다른 PC를 앱 안에서 열려면 앱을 새 버전으로 바꿔 주세요')

      return
    }

    location.href = `${machine.url}#host`
  })

  return card
}

function heading(text) {
  return Object.assign(document.createElement('h2'), { className: 'home-heading', textContent: text })
}

// A usage bar: green under 60%, amber under 80%, red from there.
function usageBar(label, percent) {
  const row = document.createElement('span')
  const track = document.createElement('span')
  const fill = document.createElement('i')

  row.className = 'usage-row'
  track.className = 'usage-track'
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`
  fill.dataset.level = percent >= 80 ? 'high' : percent >= 60 ? 'mid' : 'low'
  track.append(fill)
  row.append(Object.assign(document.createElement('span'), { className: 'usage-label', textContent: label }), track, Object.assign(document.createElement('span'), { className: 'usage-value', textContent: `${Math.round(percent)}%` }))

  return row
}

function usageCards() {
  const cards = []
  const latest = [...statuses.values()].at(-1)
  const sources = []

  if (latest !== undefined) sources.push(['claude', 'Claude', latest.limits])
  if (codexLimits !== null) sources.push(['codex', 'Codex', codexLimits])

  for (const [kind, label, limits] of sources) {
    const card = document.createElement('div')
    const head = document.createElement('div')
    const tile = document.createElement('span')

    card.className = 'usage-card'
    head.className = 'usage-head'
    tile.className = 'usage-tile'
    tile.innerHTML = agentMark(kind, 18)
    head.append(tile, Object.assign(document.createElement('strong'), { textContent: label }))
    card.append(head)

    for (const limit of limits) card.append(usageBar(limitName(limit.kind).toLowerCase(), limit.percent))

    cards.push(card)
  }

  return cards
}

const homePane = $('homePane')

// The PC's home: shown from the sidebar's 홈 and whenever no session is open.
function showHome(open) {
  if (touch) return

  if (homeOpen !== open) {
    homeOpen = open
    render()
  }

  homePane.hidden = !open
  $('panes').hidden = open
  $('navHome').toggleAttribute('aria-current', open)

  if (open) {
    $('navHome').setAttribute('aria-current', 'page')
    renderHosts()
  } else {
    requestAnimationFrame(claim)
  }
}

$('navHome').addEventListener('click', () => showHome(true))

function renderHosts() {
  const target = touch ? (hostsEl.hidden ? null : hostsBody) : homePane.hidden ? null : $('homeBody')

  if (target === null) return

  const here = machines.find((machine) => machine.here)
  const known = machines.length > 0 ? [...machines].sort(machineOrder) : [{ name: location.hostname.split('.')[0] || 'ChoiTerm', url: location.origin, online: true, here: true, sessions: null, busy: null }]
  const counts = hereCounts()
  const parts = []
  const hero = document.createElement('div')
  const stats = document.createElement('div')

  hero.className = 'home-hero'
  hero.append(Object.assign(document.createElement('h1'), { textContent: '어서 오세요' }))
  stats.className = 'home-stats'

  for (const [value, label] of [[counts.sessions, '세션'], [counts.busy, '작업 중'], [known.filter((machine) => machine.here || machine.online).length, '켜진 PC']]) {
    const stat = document.createElement('div')

    stat.className = 'home-stat'
    stat.append(Object.assign(document.createElement('strong'), { textContent: String(value) }), Object.assign(document.createElement('span'), { textContent: label }))
    stats.append(stat)
  }

  hero.append(stats)
  parts.push(hero, heading('데스크톱'))

  const cards = document.createElement('div')

  cards.className = 'host-cards'
  cards.append(...known.map(hostCard))
  parts.push(cards)

  // "Resume": the session used last on this PC.
  const resume = sessions.filter((session) => !session.archived).sort((a, b) => (lastActive.get(b.id) ?? b.createdAt) - (lastActive.get(a.id) ?? a.createdAt))[0]

  if (resume !== undefined) {
    const card = document.createElement('button')
    const tile = document.createElement('span')
    const main = document.createElement('span')
    const repo = metaById.get(resume.id)?.repo
    const where = document.createElement('span')

    card.type = 'button'
    card.className = 'resume-card'
    tile.className = 'host-tile'
    tile.innerHTML = agentMark(resume.kind, 18)
    main.className = 'host-main'
    main.append(Object.assign(document.createElement('span'), { className: 'resume-title', textContent: plainName(resume) }))
    where.className = 'resume-sub'
    where.innerHTML = `<i style="background:${repoColour(repo?.name ?? here?.name ?? 'ChoiTerm')}"></i>`
    where.append(repo ? `${repo.name}  ·  ${repo.branch}` : resume.cwd ?? '')
    main.append(where)
    card.append(tile, main)
    card.insertAdjacentHTML('beforeend', `<span class="host-go">${icon('chevron-right', 16)}</span>`)
    card.addEventListener('click', () => select(resume.id))
    parts.push(heading('이어서 하기'), card)
  }

  const quick = document.createElement('div')
  const create = document.createElement('button')
  const folder = document.createElement('button')

  quick.className = 'quick-actions'
  create.type = 'button'
  create.className = 'quick-action'
  create.innerHTML = `<span class="quick-tile">${icon('plus', 16)}</span>새 작업 공간`
  create.addEventListener('click', () => openCreate())
  folder.type = 'button'
  folder.className = 'quick-action'
  folder.innerHTML = `<span class="quick-tile">${icon('folder-open', 16)}</span>폴더에서 열기`
  folder.addEventListener('click', () => void openFolderAnywhere())
  quick.append(create, folder)
  parts.push(heading('빠른 작업'), quick)

  // On the PC: what the phone app needs, this PC's tailnet address and the app itself.
  if (!touch && ownAddress !== '') {
    const card = document.createElement('div')
    const address = document.createElement('code')
    const copy = document.createElement('button')
    const apk = document.createElement('a')

    card.className = 'phone-card'
    card.append(Object.assign(document.createElement('span'), { className: 'phone-card-text', textContent: '폰 앱 첫 화면에 이 주소를 넣으세요' }))
    address.textContent = ownAddress
    copy.type = 'button'
    copy.className = 'icon-6'
    copy.innerHTML = icon('copy', 14)
    copy.title = '주소 복사'
    copy.addEventListener('click', () => void copyText(ownAddress))
    apk.href = '/ChoiTerm.apk'
    apk.className = 'phone-card-link'
    apk.innerHTML = icon('smartphone', 14)
    apk.append('APK 받기')
    card.append(Object.assign(document.createElement('span'), { className: 'phone-card-row' }))
    card.lastChild.append(address, copy, apk)
    parts.push(heading('폰 연결'), card)
  }

  const usage = usageCards()

  if (usage.length > 0) parts.push(heading('계정 사용량'), ...usage)

  target.replaceChildren(...parts)
}

// The phone's list header: this desktop, its state, its sessions.
function renderHostChrome() {
  if (!touch) return

  const here = machines.find((machine) => machine.here)

  $('hostName').textContent = here?.name ?? (location.hostname.split('.')[0] || 'ChoiTerm')
  $('hostSub').textContent = [OS_LABEL, countLine(hereCounts())].filter(Boolean).join(' · ')
  $('hostDot').dataset.state = dot.dataset.state ?? ''
}

$('phoneOptions').addEventListener('click', (event) => openListOptions(event.currentTarget))
$('phoneSearch').addEventListener('click', () => {
  const row = $('sideFilterRow')

  row.hidden = !row.hidden
  $('phoneSearch').innerHTML = icon(row.hidden ? 'search' : 'x', 16)

  if (row.hidden) {
    sideFilter.value = ''
    renderDrawer()
  } else {
    sideFilter.focus()
  }
})
$('phoneTasks').addEventListener('click', () => {
  setFilesOpen(true)
  setPanel('tasks')
})
$('phoneGallery').addEventListener('click', () => $('openGallery').click())
$('fab').addEventListener('click', () => openCreate())

// The owner's PCs that run ChoiTerm (this PC's server asks the tailnet), picked from the button in
// the top bar. Each PC serves its own page with its own sessions, so picking one opens that page.
// The list scrolls however many PCs there are, and past a handful it can be searched.
const pcButton = $('pcButton')
const pcName = $('pcName')
const pcMenu = $('pcMenu')
const pcFilter = $('pcFilter')
const pcList = $('pcList')
const PC_SEARCH_FROM = 8

async function refreshMachines() {
  try {
    const body = await (await fetch('/machines', { cache: 'no-store' })).json()

    machines = Array.isArray(body?.machines) ? body.machines : []
  } catch {
    return
  }

  renderMachines()
}

// This PC first, then the ones that answer, then the ones that are off, each by name.
function machineOrder(a, b) {
  const rank = (machine) => (machine.here ? 0 : machine.online ? 1 : 2)

  return rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko', { numeric: true })
}

// The PC list: a monitor for this PC, a server for the others, and on the
// right whether it is on and how many sessions it runs.
function renderMachines() {
  const here = machines.find((machine) => machine.here)
  const words = pcFilter.value.trim().toLowerCase()

  pcButton.querySelector('.chev').style.visibility = machines.length < 2 ? 'hidden' : ''
  pcName.textContent = here?.name ?? 'ChoiTerm'
  pcButton.title = here === undefined ? '' : `${here.name}의 세션 · 다른 PC 고르기`
  pcFilter.hidden = machines.length < PC_SEARCH_FROM
  pcList.replaceChildren()

  for (const machine of [...machines].sort(machineOrder)) {
    if (words !== '' && !machine.name.toLowerCase().includes(words)) continue

    const row = document.createElement('button')
    const name = document.createElement('span')
    const state = document.createElement('span')
    const counts = machine.here ? hereCounts() : { sessions: machine.sessions, busy: machine.busy }

    name.className = 'pc-row-name'
    name.textContent = machine.name
    state.className = 'pc-row-state'
    state.textContent = machine.here ? '지금 PC' : machine.online ? countLine(counts) || '켜짐' : '꺼짐'
    row.type = 'button'
    row.className = 'pc-row'
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(machine.here))
    row.disabled = !machine.here && !machine.online
    row.innerHTML = icon(machine.here ? 'monitor' : machine.online ? 'server' : 'server-off', 14)
    row.append(name, state)

    if (machine.here) row.dataset.here = ''

    row.addEventListener('click', () => {
      closePcMenu()

      if (machine.here) return

      if (oldApp()) {
        showAppUpdate('다른 PC를 앱 안에서 열려면 앱을 새 버전으로 바꿔 주세요')

        return
      }

      location.href = machine.url
    })
    pcList.append(row)
  }

  if (pcList.childElementCount === 0) {
    const none = document.createElement('p')

    none.className = 'pc-empty'
    none.textContent = '맞는 PC가 없어요'
    pcList.append(none)
  }

  renderHosts()
  renderHostChrome()
}

function openPcMenu() {
  // On the PC the list hangs under the top-bar button; on a phone CSS makes it a bottom sheet.
  if (!touch) {
    const box = pcButton.getBoundingClientRect()

    pcMenu.style.left = `${Math.max(8, box.left)}px`
    pcMenu.style.top = `${box.bottom + 6}px`
  }

  pcMenu.hidden = false
  pcButton.setAttribute('aria-expanded', 'true')
  pcFilter.value = ''
  renderMachines()

  if (!pcFilter.hidden && !touch) pcFilter.focus()

  // Asked again on every open, so a PC switched on since shows up.
  void refreshMachines()
}

// The phone app tells its version from 0.8.0 on; one that cannot is older.
function oldApp() {
  return window.ChoiTermApp !== undefined && typeof window.ChoiTermApp.version !== 'function'
}

function showAppUpdate(reason) {
  if (document.getElementById('appUpdate') !== null) return

  const bar = document.createElement('div')
  const words = document.createElement('span')
  const get = document.createElement('button')
  const close = document.createElement('button')

  bar.id = 'appUpdate'
  bar.className = 'app-update'
  words.textContent = reason
  get.type = 'button'
  get.textContent = '새 앱 받기'
  get.addEventListener('click', () => window.ChoiTermApp.openUrl(new URL('/ChoiTerm.apk', location.href).href))
  close.type = 'button'
  close.className = 'icon'
  close.innerHTML = UI.close
  close.setAttribute('aria-label', '닫기')
  close.addEventListener('click', () => bar.remove())
  bar.append(words, get, close)
  document.body.append(bar)
}

if (oldApp()) showAppUpdate('새 앱이 있어요 (0.8.0) · 다른 PC 오가기와 새 화면이 앱 안에서 돼요')

function closePcMenu() {
  pcMenu.hidden = true
  pcButton.setAttribute('aria-expanded', 'false')
}

pcButton.addEventListener('click', (event) => {
  event.stopPropagation()

  if (machines.length < 2) return

  if (pcMenu.hidden) openPcMenu()
  else closePcMenu()
})

pcMenu.addEventListener('click', (event) => event.stopPropagation())
pcFilter.addEventListener('input', renderMachines)
pcFilter.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePcMenu()

  if (event.key === 'Enter') pcList.querySelector('.pc-row:not(:disabled):not([data-here])')?.click()
})
document.addEventListener('click', closePcMenu)

void refreshMachines()

function closeDrawer() {
  if (picking) setPicking(false)
}

function setPicking(on) {
  picking = on
  picked.clear()
  pickButton.setAttribute('aria-pressed', String(on))
  pickButton.title = on ? '선택 그만두기' : '여러 개 선택'
  renderDrawer()
}

// 49m, 3h, 2d: how long ago a session opened.
function since(time) {
  return shortSpan(Date.now() - time)
}

let archiveOpen = false

// An agent's state: a turning ring while it works, a check when it finished
// something this screen has not seen, a grey dot otherwise.
function agentDot(working, done) {
  const box = document.createElement('span')

  box.className = 'agent-dot'

  if (working) box.innerHTML = '<i class="ring"></i>'
  else if (done) box.innerHTML = icon('circle-check', 10, 2.4)
  else box.innerHTML = '<i class="idle"></i>'

  box.dataset.state = working ? 'working' : done ? 'done' : 'idle'

  return box
}

// One agent (session) row under its workspace: state, agent, name - last line, ports, time. On its own
// (the archive, picking) it also says which agent and branch.
function sessionItem(session, nested = false) {
  const meta = metaById.get(session.id)
  const item = document.createElement('button')
  const words = document.createElement('span')
  const lead = document.createElement('span')
  const when = document.createElement('span')
  const fresh = unread.has(session.id)

  item.type = 'button'
  item.className = nested ? 'item agent-row' : 'item agent-row loose'
  item.toggleAttribute('data-current', session.id === current)
  item.toggleAttribute('data-picked', picked.has(session.id))
  item.toggleAttribute('data-archived', session.archived)
  item.toggleAttribute('data-fresh', fresh)
  words.className = 'agent-text'
  lead.className = 'lead'
  lead.textContent = plainName(session)
  words.append(lead)

  const line = meta?.line?.trim()

  if (line && line !== lead.textContent) {
    const trail = document.createElement('span')

    trail.className = 'trail'
    trail.textContent = ` - ${line}`
    words.append(trail)
  }

  if (!nested) {
    const sub = document.createElement('span')

    sub.className = 'sub'
    sub.textContent = [agentName(session.kind), meta?.repo?.branch ?? '', session.muted ? '알림 꺼짐' : ''].filter(Boolean).join(' · ')
    words.append(sub)
  }

  when.className = 'when'
  when.textContent = since(lastActive.get(session.id) ?? session.createdAt)

  if (picking) {
    const box = document.createElement('span')

    box.className = 'check'
    item.append(box)
  } else {
    item.append(agentDot(meta?.busy === true, fresh))
  }

  item.append(agentIcon(session.kind, 13), words)

  for (const web of meta?.ports ?? []) {
    const chip = document.createElement('span')

    chip.className = 'port-chip'
    chip.innerHTML = `${icon('globe', 11)}${web.port}`
    chip.title = `localhost:${web.port} 미리보기`
    chip.addEventListener('click', (event) => {
      event.stopPropagation()
      void openWeb(web.port, session.id)
    })
    item.append(chip)
  }

  item.append(when)

  // A row sits inside its workspace's card, which opens on a click of its own.
  item.addEventListener('click', (event) => {
    event.stopPropagation()

    if (!picking) {
      // Opening an archived session takes it back out of the archive.
      if (session.archived) send({ t: 'archive', id: session.id, archived: false })

      closeDrawer()
      select(session.id)

      return
    }

    if (picked.has(session.id)) picked.delete(session.id)
    else picked.add(session.id)

    killArmed = 0
    renderDrawer()
  })
  onLongPress(item, (at) => {
    if (picking) {
      picked.add(session.id)
      renderDrawer()
    } else if (at.mouse) {
      openSessionMenu(session.id, at.x, at.y)
    } else {
      openSessionSheet(session.id)
    }
  })

  return item
}

// ---- The list: projects, each with its workspaces (a git worktree, or a folder), each
// with the agents working in it. The options ("Workspace options") sort, group and filter it.
const PINS_KEY = 'choiterm.pins'
const OPEN_TREES_KEY = 'choiterm.open-worktrees'
const FILTER_KEY = 'choiterm.filter'
const SORT_KEY = 'choiterm.sort'
const GROUP_KEY = 'choiterm.group'
const AGENTS_VIEW_KEY = 'choiterm.agents-view'
const GROUPS_KEY = 'choiterm.folded'
const PR_EVERY_MS = 300_000
const pins = new Set((load(PINS_KEY) ?? '').split('\n').filter(Boolean))
// In the summary view, workspaces whose agents were opened up anyway.
const openTrees = new Set((load(OPEN_TREES_KEY) ?? '').split('\n').filter(Boolean))
const folded = new Set((load(GROUPS_KEY) ?? '').split('\n').filter(Boolean))
const lastActive = new Map()
const prs = new Map()
const sideFilter = $('sideFilter')
let projectList = []
let listFilter = ['all', 'busy', 'new'].includes(load(FILTER_KEY)) ? load(FILTER_KEY) : 'all'
let listSort = load(SORT_KEY) === 'name' ? 'name' : 'recent'
let listGroup = load(GROUP_KEY) === 'none' ? 'none' : 'project'
// Every agent listed (the owner's choice), or a one-line summary when a workspace has several.
let agentsView = load(AGENTS_VIEW_KEY) === 'compact' ? 'compact' : 'full'
let prsAt = 0

const keyOf = (path) => (path ?? '').toLowerCase().replace(/[\\/]+$/, '')
const baseName = (path) => (path ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? ''
const saveSet = (key, set) => save(key, set.size === 0 ? null : [...set].join('\n'))

async function refreshProjects() {
  const reply = await getJson('/projects')

  if (!Array.isArray(reply?.projects)) return

  projectList = reply.projects
  renderDrawer()

  if (Date.now() - prsAt > PR_EVERY_MS) void refreshPrs()
}

// Pull requests by branch, for the PR mark on a workspace.
async function refreshPrs() {
  prsAt = Date.now()

  for (const project of projectList) {
    const reply = await getJson(`/tasks?root=${encodeURIComponent(project.path)}`)

    for (const task of reply?.tasks ?? []) {
      if (task.kind === 'pr' && task.branch) prs.set(`${keyOf(project.path)}|${task.branch}`, task)
    }
  }

  renderDrawer()
}

// Every worktree of every known project, and the sessions working in each; sessions outside any
// known checkout make a folder project of their own.
function buildTree() {
  const trees = new Map()
  const projects = []
  const archived = []

  for (const project of projectList) {
    const entry = { name: project.name, path: project.path, git: true, worktrees: [] }

    for (const worktree of project.worktrees) {
      const tree = { ...worktree, project: entry, sessions: [] }

      trees.set(keyOf(worktree.path), tree)
      entry.worktrees.push(tree)
    }

    projects.push(entry)
  }

  for (const session of [...sessions].sort((a, b) => b.createdAt - a.createdAt)) {
    if (session.archived) {
      archived.push(session)
      continue
    }

    const repo = metaById.get(session.id)?.repo
    const root = repo?.root ?? session.cwd ?? ''
    let tree = trees.get(keyOf(root))

    if (tree === undefined) {
      const entry = { name: repo?.name ?? (baseName(root) || '폴더'), path: repo?.project ?? (root || null), git: Boolean(repo), worktrees: [] }

      tree = { path: root, branch: repo?.branch ?? '', primary: !repo?.worktree, project: entry, sessions: [] }
      entry.worktrees.push(tree)
      trees.set(keyOf(root), tree)
      projects.push(entry)
    }

    tree.sessions.push(session)
  }

  return { projects, archived }
}

function treeBusy(tree) {
  return tree.sessions.some((session) => metaById.get(session.id)?.busy)
}

function treeFresh(tree) {
  return tree.sessions.some((session) => unread.has(session.id))
}

function treeActive(tree) {
  let latest = 0

  for (const session of tree.sessions) latest = Math.max(latest, lastActive.get(session.id) ?? session.createdAt)

  return latest
}

// A workspace's name: a worktree's folder (its project's name for the main checkout), or the folder.
function treeTitle(tree) {
  if (!tree.project.git) return baseName(tree.path) || '폴더'

  return tree.primary ? tree.project.name : baseName(tree.path) || tree.branch
}

function treeMatches(tree) {
  if (listFilter === 'busy' && !treeBusy(tree)) return false
  if (listFilter === 'new' && !treeFresh(tree)) return false

  const words = sideFilter.value.trim().toLowerCase()

  if (words === '') return true

  return [treeTitle(tree), tree.branch, tree.project.name, tree.path, ...tree.sessions.map((session) => displayName(session))].some((text) => (text ?? '').toLowerCase().includes(words))
}

// The session to open for a workspace: the one last used there.
function latestSession(tree) {
  return [...tree.sessions].sort((a, b) => (lastActive.get(b.id) ?? b.createdAt) - (lastActive.get(a.id) ?? a.createdAt))[0]
}

// A repository's colour: the same hue for the same name.
const REPO_COLOURS = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1']

function repoColour(name) {
  let hash = 0

  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0

  return REPO_COLOURS[Math.abs(hash) % REPO_COLOURS.length]
}

function openTree(tree, anchor) {
  const session = latestSession(tree)

  if (session !== undefined) {
    closeDrawer()
    select(session.id)

    return
  }

  // An empty workspace: start an agent in it.
  openAddMenuAt(anchor, tree.path)
}

// A workspace's state: an amber bell for something new, a turning ring while
// an agent works, green while agents run, grey when none does.
function treeStatus(tree) {
  const slot = document.createElement('span')

  slot.className = 'card-status'

  if (treeFresh(tree)) {
    slot.innerHTML = '<svg class="bell" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M10.268 21a2 2 0 0 0 3.464 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" fill="currentColor"/></svg>'
    slot.title = '새 소식'
  } else if (treeBusy(tree)) {
    slot.innerHTML = '<i class="ring"></i>'
    slot.title = '작업 중'
  } else {
    slot.innerHTML = `<i class="${tree.sessions.length > 0 ? 'live' : 'idle'}"></i>`
  }

  return slot
}

// A summary of several agents on one line: their marks by state, then how many more.
function agentSummary(tree, key) {
  const pill = document.createElement('button')
  const marks = document.createElement('span')

  pill.type = 'button'
  pill.className = 'agent-pill'
  marks.className = 'pill-marks'

  for (const session of tree.sessions.slice(0, 3)) {
    const meta = metaById.get(session.id)
    const one = document.createElement('span')

    one.className = 'pill-one'
    one.append(agentDot(meta?.busy === true, unread.has(session.id)), agentIcon(session.kind, 13))
    marks.append(one)
  }

  pill.append(marks)

  if (tree.sessions.length > 3) pill.append(Object.assign(document.createElement('span'), { className: 'pill-more', textContent: `+${tree.sessions.length - 3}` }))

  pill.insertAdjacentHTML('beforeend', `<span class="pill-chev">${icon('chevron-right', 12)}</span>`)
  pill.addEventListener('click', (event) => {
    event.stopPropagation()
    openTrees.add(key)
    saveSet(OPEN_TREES_KEY, openTrees)
    renderDrawer()
  })

  return pill
}

function worktreeRow(tree) {
  const card = document.createElement('div')
  const row = document.createElement('div')
  const body = document.createElement('div')
  const title = document.createElement('div')
  const name = document.createElement('span')
  const meta = document.createElement('div')
  const branch = document.createElement('span')
  const marks = document.createElement('span')
  const pr = prs.get(`${keyOf(tree.project.path)}|${tree.branch}`)
  const key = keyOf(tree.path)
  const fresh = treeFresh(tree)

  card.className = 'card'
  card.setAttribute('role', 'button')
  card.tabIndex = 0
  card.toggleAttribute('data-current', tree.sessions.some((session) => session.id === current))
  card.toggleAttribute('data-empty', tree.sessions.length === 0)
  card.toggleAttribute('data-fresh', fresh)
  row.className = 'card-row'
  body.className = 'card-body'
  title.className = 'card-title'
  name.className = 'card-name'
  name.textContent = treeTitle(tree)
  title.append(name)

  if (tree.primary && tree.project.git) title.append(Object.assign(document.createElement('span'), { className: 'badge-primary', textContent: '기본' }))

  if (!tree.project.git) title.append(Object.assign(document.createElement('span'), { className: 'badge-primary', textContent: '폴더' }))

  if (pins.has(key)) title.insertAdjacentHTML('beforeend', `<span class="pin-mark" title="고정">${icon('pin', 11)}</span>`)

  // The branch line; a folder workspace shows its folder instead.
  meta.className = 'card-meta'
  branch.className = tree.project.git ? 'card-branch' : 'card-branch mono'
  branch.textContent = tree.project.git ? tree.branch || baseName(tree.path) : tree.path || '폴더'
  branch.title = tree.path ?? ''

  if (touch && tree.project.git && listGroup === 'none') {
    const repo = document.createElement('span')

    repo.className = 'card-repo'
    repo.innerHTML = `<i style="background:${repoColour(tree.project.name)}"></i>`
    repo.append(tree.project.name)
    meta.append(repo)
  }

  meta.append(branch)
  marks.className = 'card-marks'

  if (pr !== undefined) {
    const mark = document.createElement('span')

    mark.className = 'pr-mark'
    // GitHub lists open pull requests only: open, or a draft.
    mark.dataset.state = pr.draft ? 'draft' : 'open'
    mark.innerHTML = `${icon(pr.draft ? 'git-pull-request-draft' : 'git-pull-request', 14)}<span>#${pr.number}</span>`
    mark.title = pr.title
    marks.append(mark)
  }

  if (marks.childElementCount > 0) meta.append(marks)

  body.append(title, meta)

  // The agents working here: every one listed, or a one-line summary in that view.
  const showAll = agentsView === 'full' || tree.sessions.length < 2 || openTrees.has(key) || tree.sessions.some((session) => session.id === current)

  if (tree.sessions.length > 0) {
    const agentsBox = document.createElement('div')

    agentsBox.className = 'card-agents'

    if (showAll) {
      for (const session of tree.sessions) agentsBox.append(sessionItem(session, true))

      if (agentsView === 'compact' && tree.sessions.length > 1 && openTrees.has(key)) {
        const fold = document.createElement('button')

        fold.type = 'button'
        fold.className = 'agents-fold'
        fold.innerHTML = `${icon('chevron-down', 12)}에이전트 ${tree.sessions.length}개`
        fold.addEventListener('click', (event) => {
          event.stopPropagation()
          openTrees.delete(key)
          saveSet(OPEN_TREES_KEY, openTrees)
          renderDrawer()
        })
        agentsBox.prepend(fold)
      }
    } else {
      agentsBox.append(agentSummary(tree, key))
    }

    body.append(agentsBox)
  }

  row.append(treeStatus(tree), body)
  card.append(row)
  card.addEventListener('click', () => openTree(tree, card))
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === card) openTree(tree, card)
  })
  onLongPress(card, (at) => openTreeMenu(tree, at))

  return card
}

// A project's header: its folder mark and name; on the PC its fold, menu and + show on
// hover; on the phone the name is set small in capitals with a count.
function projectHead(project, count) {
  const head = document.createElement('div')
  const chev = document.createElement('span')
  const mark = document.createElement('span')
  const name = document.createElement('span')
  const tally = document.createElement('span')
  const actions = document.createElement('span')
  const more = document.createElement('button')
  const add = document.createElement('button')
  const key = keyOf(project.path ?? project.name)
  const isFolded = folded.has(key)

  head.className = 'proj-head'
  head.setAttribute('role', 'button')
  head.toggleAttribute('data-folded', isFolded)
  head.dataset.key = key

  if (!touch) {
    head.draggable = true
    head.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/choiterm-project', key)
      event.dataTransfer.effectAllowed = 'move'
      head.classList.add('dragging')
    })
    head.addEventListener('dragend', () => head.classList.remove('dragging'))
    head.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes('text/choiterm-project')) return

      event.preventDefault()

      const box = head.getBoundingClientRect()

      head.dataset.drop = event.clientY > box.top + box.height / 2 ? 'after' : 'before'
    })
    head.addEventListener('dragleave', () => delete head.dataset.drop)
    head.addEventListener('drop', (event) => {
      const moved = event.dataTransfer.getData('text/choiterm-project')
      const after = head.dataset.drop === 'after'

      delete head.dataset.drop
      event.preventDefault()

      if (moved !== '' && moved !== key) moveProject(moved, key, after)
    })
  }

  onLongPress(head, (at) => openProjectMenu(project, at))
  chev.className = 'proj-chev'
  chev.innerHTML = icon(isFolded ? 'chevron-right' : 'chevron-down', 12)
  mark.className = 'proj-mark'
  mark.innerHTML = icon(project.git ? 'folder' : 'folder-open', 14)

  if (project.git) mark.style.color = repoColour(project.name)

  name.className = 'proj-name'
  name.textContent = project.name
  name.title = project.path ?? ''
  tally.className = 'proj-count'
  tally.textContent = String(count)
  actions.className = 'proj-actions'
  more.type = 'button'
  more.className = 'icon-5'
  more.innerHTML = icon('ellipsis', 14)
  more.setAttribute('aria-label', '프로젝트 메뉴')
  more.addEventListener('click', (event) => {
    event.stopPropagation()

    const box = more.getBoundingClientRect()

    openProjectMenu(project, { mouse: true, x: box.left, y: box.bottom + 4 })
  })
  add.type = 'button'
  add.className = 'icon-5'
  add.innerHTML = icon('plus', 12)
  add.setAttribute('aria-label', `${project.name}에 새 작업 공간`)
  add.addEventListener('click', (event) => {
    event.stopPropagation()
    openCreate(project.path)
  })
  actions.append(more, add)
  head.append(chev, mark, name, tally, actions)
  head.addEventListener('click', () => {
    if (folded.has(key)) folded.delete(key)
    else folded.add(key)

    saveSet(GROUPS_KEY, folded)
    renderDrawer()
  })

  return head
}

function openProjectMenu(project, at) {
  const key = keyOf(project.path ?? project.name)
  const entries = [
    ['새 작업 공간', 'plus', () => openCreate(project.path)],
    ['새 에이전트', 'square-terminal', () => openAddMenuAt(document.body, project.path)],
    ['폴더 경로 복사', 'copy', () => void copyText(project.path ?? '')],
    ['위로 옮기기', 'arrow-up', () => stepProject(key, -1)],
    ['아래로 옮기기', 'arrow-down', () => stepProject(key, 1)],
  ]

  if (projectOrder.length > 0) entries.push(['프로젝트 이름순으로 되돌리기', 'case-sensitive', () => saveProjectOrder([])])

  showActions(project.name, entries, at)
}

// A menu at the pointer on the PC, an action sheet on the phone. Entries are
// [label, icon, run, danger?].
function showActions(title, entries, at) {
  if (at.mouse) {
    contextMenu.replaceChildren(...entries.map(([label, name, run, danger]) => menuEntry(label, () => {
      closeContextMenu()
      run()
    }, { 'data-danger': danger === true }, name)))
    placeContextMenu(at.x, at.y)

    return
  }

  sheetTitle.textContent = title
  sheetBody.replaceChildren()

  const group = document.createElement('div')

  group.className = 'action-group'

  for (const [label, name, run, danger] of entries) {
    const row = document.createElement('button')

    row.type = 'button'
    row.className = 'action-row'
    row.toggleAttribute('data-danger', danger === true)
    row.innerHTML = icon(name, 16)
    row.append(label)
    row.addEventListener('click', () => {
      sheet.hidden = true
      run()
    })
    group.append(row)
  }

  sheetBody.append(group)
  sheet.hidden = false
}

function sectionHead(text, onClick) {
  const head = document.createElement(onClick ? 'button' : 'div')

  head.className = 'section-head'
  head.textContent = text

  if (onClick) {
    head.type = 'button'
    head.addEventListener('click', onClick)
  }

  return head
}

// ---- Projects are listed by name, unless the owner dragged them into an order of their own (kept
// on this device; projects not in it follow by name).
const PROJECT_ORDER_KEY = 'choiterm.project-order'
let projectOrder = (load(PROJECT_ORDER_KEY) ?? '').split('\n').filter(Boolean)

function projectKey(project) {
  return keyOf(project.path ?? project.name)
}

function orderProjects(projects) {
  const rank = (project) => {
    const at = projectOrder.indexOf(projectKey(project))

    return at < 0 ? Number.MAX_SAFE_INTEGER : at
  }

  return [...projects].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko', { numeric: true }))
}

function saveProjectOrder(keys) {
  projectOrder = keys
  save(PROJECT_ORDER_KEY, keys.length === 0 ? null : keys.join('\n'))
  renderDrawer()
}

// The order on screen with `key` moved before (or after) `target`.
function moveProject(key, target, after) {
  const keys = [...list.querySelectorAll('.proj-head')].map((head) => head.dataset.key).filter((each) => each !== key)
  const at = keys.indexOf(target)

  if (at < 0) return

  keys.splice(after ? at + 1 : at, 0, key)
  saveProjectOrder(keys)
}

// Up or down one place (the phone, where there is no dragging).
function stepProject(key, by) {
  const keys = [...list.querySelectorAll('.proj-head')].map((head) => head.dataset.key)
  const at = keys.indexOf(key)
  const to = at + by

  if (at < 0 || to < 0 || to >= keys.length) return

  keys.splice(at, 1)
  keys.splice(to, 0, key)
  saveProjectOrder(keys)
}

// ---- Adding a project: a new one in the home folder, or an existing folder picked with Windows'
// own dialog when the page is on this PC (elsewhere the in-page folder walk).
const ON_THIS_PC = ['127.0.0.1', 'localhost'].includes(location.hostname)

async function pickFolderOnPc() {
  notice('PC 화면에 폴더 선택 창을 열었어요')

  const reply = await postJson('/pick-folder', {}).then((response) => response.json()).catch(() => null)

  return typeof reply?.picked === 'string' ? reply.picked : null
}

async function findProjectFolder() {
  if (!ON_THIS_PC) {
    openFolderSheet(null, true)

    return
  }

  const folder = await pickFolderOnPc()

  if (folder === null) return

  const reply = await postJson('/projects', { path: folder }).then((response) => response.json()).catch(() => null)

  if (reply?.ok) {
    notice(`프로젝트를 추가했어요: ${baseName(reply.project)}`)
    void refreshProjects()

    return
  }

  // Not a git repository: work in it as a folder instead.
  notice('git 저장소가 아니라서 폴더로 열어요')
  openAddMenuAt(document.body, folder)
}

// A folder to open an agent in: Windows' dialog on this PC, the in-page walk elsewhere.
async function openFolderAnywhere() {
  if (!ON_THIS_PC) {
    openFolderSheet(null)

    return
  }

  const folder = await pickFolderOnPc()

  if (folder !== null) openAddMenuAt(document.body, folder)
}

// A small question in the composer's frame: one line of text, OK and cancel.
function askText(title, label, placeholder, okLabel) {
  return new Promise((resolve) => {
    const dialog = document.createElement('div')
    const head = document.createElement('div')
    const field = document.createElement('input')
    const hint = document.createElement('div')
    const foot = document.createElement('div')
    const cancel = document.createElement('button')
    const ok = document.createElement('button')
    const finish = (value) => {
      closeCreate()
      resolve(value)
    }

    dialog.className = touch ? 'drawer composer' : 'dialog composer'
    head.className = 'dialog-head'
    head.innerHTML = `${touch ? '<div class="sheet-handle"></div>' : ''}<strong></strong>`
    head.querySelector('strong').textContent = title
    field.className = 'cmp-input-plain'
    field.placeholder = placeholder
    hint.className = 'cmp-label'
    hint.textContent = label
    foot.className = 'cmp-foot'
    cancel.type = 'button'
    cancel.className = 'cmp-switch'
    cancel.textContent = '취소'
    cancel.addEventListener('click', () => finish(null))
    ok.type = 'button'
    ok.className = 'cmp-submit'
    ok.textContent = okLabel
    ok.addEventListener('click', () => {
      if (field.value.trim() !== '') finish(field.value.trim())
    })
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) ok.click()

      if (event.key === 'Escape') {
        event.stopPropagation()
        finish(null)
      }
    })
    foot.append(cancel, ok)

    const body = document.createElement('div')

    body.className = 'cmp-body'
    body.append(Object.assign(document.createElement('div'), { className: 'cmp-block' }))
    body.firstChild.append(hint, field)
    dialog.append(head, body, foot)
    composer.replaceChildren(dialog)
    composer.hidden = false
    field.focus()
  })
}

async function createProjectPrompt() {
  const name = await askText('새 프로젝트', 'C:\\Users\\main 아래에 이 이름의 폴더와 git 저장소를 만들어요', '프로젝트 이름', '만들기')

  if (name === null) return

  const reply = await postJson('/projects/create', { name }).then((response) => response.json()).catch(() => null)

  if (!reply?.ok) {
    notice('만들지 못했어요. 이름에는 글자, 숫자, 공백, . _ - 만 쓸 수 있어요')

    return
  }

  notice(`새 프로젝트를 만들었어요: ${reply.project}`)
  await refreshProjects()
  openCreate(reply.project)
}

function openProjectAdd(at) {
  showActions('프로젝트 추가', [
    ['새 프로젝트 만들기', 'folder-plus', () => void createProjectPrompt()],
    [ON_THIS_PC ? '폴더 찾기… (탐색기)' : '폴더 찾기…', 'folder-open', () => void findProjectFolder()],
  ], at)
}

// ---- Workspace options (the sliders button on the PC, the "Workspace options" chip on the phone).
const OPTION_GROUPS = [
  ['작업 공간 정렬', () => listSort, (value) => {
    listSort = value
    save(SORT_KEY, value === 'recent' ? null : value)
  }, [['recent', '최근 활동'], ['name', '이름']]],
  ['묶기', () => listGroup, (value) => {
    listGroup = value
    save(GROUP_KEY, value === 'project' ? null : value)
  }, [['project', '프로젝트'], ['none', '묶지 않음']]],
  ['보기', () => listFilter, (value) => {
    listFilter = value
    save(FILTER_KEY, value === 'all' ? null : value)
  }, [['all', '모두'], ['busy', '작업 중만'], ['new', '새 소식만']]],
  ['에이전트', () => agentsView, (value) => {
    agentsView = value
    save(AGENTS_VIEW_KEY, value === 'full' ? null : value)
  }, [['full', '모두 보이기'], ['compact', '한 줄 요약']]],
]

// How many options differ from the defaults, for the phone chip's badge.
function changedOptions() {
  return [listSort !== 'recent', listGroup !== 'project', listFilter !== 'all', agentsView !== 'full'].filter(Boolean).length
}

function openListOptions(anchor) {
  if (!touch) {
    const box = anchor.getBoundingClientRect()
    const rows = []

    for (const [title, get, set, choices] of OPTION_GROUPS) {
      const label = document.createElement('div')

      label.className = 'menu-label'
      label.textContent = title
      rows.push(label)

      for (const [value, text] of choices) {
        rows.push(menuEntry(text, () => {
          set(value)
          renderDrawer()
          openListOptions(anchor)
        }, { 'data-checked': get() === value }, get() === value ? 'check' : 'blank'))
      }
    }

    contextMenu.replaceChildren(...rows)
    placeContextMenu(box.left, box.bottom + 4)

    return
  }

  sheetTitle.textContent = '작업 공간 옵션'
  sheetBody.replaceChildren()

  for (const [title, get, set, choices] of OPTION_GROUPS) {
    const label = document.createElement('div')
    const group = document.createElement('div')

    label.className = 'option-label'
    label.textContent = title
    group.className = 'action-group'

    for (const [value, text] of choices) {
      const row = document.createElement('button')

      row.type = 'button'
      row.className = 'action-row'
      row.toggleAttribute('data-checked', get() === value)
      row.append(text)
      row.insertAdjacentHTML('beforeend', get() === value ? `<span class="row-check">${icon('check', 14)}</span>` : '')
      row.addEventListener('click', () => {
        set(value)
        renderDrawer()
        openListOptions(anchor)
      })
      group.append(row)
    }

    sheetBody.append(label, group)
  }

  sheet.hidden = false
}

function renderDrawer() {
  list.replaceChildren()

  const { projects, archived } = buildTree()
  const order = (a, b) => (listSort === 'name' ? treeTitle(a).localeCompare(treeTitle(b), 'ko', { numeric: true }) : treeActive(b) - treeActive(a))
  const pinnedFirst = (a, b) => Number(pins.has(keyOf(b.path))) - Number(pins.has(keyOf(a.path))) || order(a, b)
  const searching = sideFilter.value.trim() !== ''

  const matching = (trees) => {
    const kept = []

    for (const tree of trees) {
      if (treeMatches(tree)) kept.push(tree)
    }

    return kept.sort(pinnedFirst)
  }

  if (listGroup === 'none') {
    for (const tree of matching(projects.flatMap((project) => project.worktrees))) list.append(worktreeRow(tree))
  } else {
    const ordered = orderProjects(projects)

    for (const project of ordered) {
      const trees = matching(project.worktrees)

      if (trees.length === 0 && (listFilter !== 'all' || searching)) continue

      const group = document.createElement('section')
      const key = keyOf(project.path ?? project.name)

      group.className = 'proj'
      group.append(projectHead(project, project.worktrees.length))

      if (!folded.has(key) || searching || trees.some((tree) => tree.sessions.some((session) => session.id === current))) {
        for (const tree of trees) group.append(worktreeRow(tree))
      }

      list.append(group)
    }
  }

  if (list.childElementCount === 0) list.append(note(searching ? '맞는 작업 공간이 없어요' : listFilter !== 'all' ? '조건에 맞는 작업 공간이 없어요' : '작업 공간이 없어요'))

  if (archived.length > 0) {
    const head = document.createElement('button')

    head.type = 'button'
    head.className = 'archive-head'
    head.innerHTML = `${icon('archive', 13)}<span>보관함 ${archived.length}</span>${icon(archiveOpen ? 'chevron-down' : 'chevron-right', 12)}`
    head.addEventListener('click', () => {
      archiveOpen = !archiveOpen
      renderDrawer()
    })
    list.append(head)

    if (archiveOpen || picking || searching) {
      for (const session of archived) list.append(sessionItem(session))
    }
  }

  // Picking (several sessions at once) lists every session, flat.
  if (picking) {
    list.replaceChildren(sectionHead('세션을 골라 주세요'), ...[...sessions].sort((a, b) => b.createdAt - a.createdAt).map((session) => sessionItem(session)))
  }

  const chosen = sessions.filter((session) => picked.has(session.id))
  const allArchived = chosen.length > 0 && chosen.every((session) => session.archived)
  const badge = $('optionsBadge')
  const changed = changedOptions()

  badge.hidden = changed === 0
  badge.textContent = String(changed)
  foot.hidden = !picking
  killButton.disabled = picked.size === 0
  killButton.textContent = killArmed > Date.now() ? `정말 ${picked.size}개를 종료할까요?` : `${picked.size}개 종료`
  archiveButton.disabled = picked.size === 0
  archiveButton.textContent = allArchived ? `${picked.size}개 꺼내기` : `${picked.size}개 보관`
  renderHostChrome()
  renderHosts()
}

// A workspace's actions: a menu at the pointer on the PC, an action sheet on the phone.
function openTreeMenu(tree, at) {
  const key = keyOf(tree.path)
  const entries = [
    ['새 에이전트', 'square-terminal', () => openAddMenuAt(document.body, tree.path)],
    ['파일 보기', 'folder', () => showTreePanel(tree, 'files')],
    ['변경 보기', 'git-compare-arrows', () => showTreePanel(tree, 'changes')],
    ['경로 복사', 'copy', () => void copyText(tree.path ?? '')],
    [pins.has(key) ? '고정 풀기' : '고정', pins.has(key) ? 'pin-off' : 'pin', () => {
      if (pins.has(key)) pins.delete(key)
      else pins.add(key)

      saveSet(PINS_KEY, pins)
      renderDrawer()
    }],
  ]

  if (tree.project.git && tree.branch && tree.project.worktrees.length > 1) entries.push(['다른 작업 공간 변경 가져오기', 'git-compare-arrows', () => takeFromOther(tree)])

  if (!tree.primary && tree.project.git && tree.branch) {
    entries.push(
      [`${tree.branch} 병합하기`, 'git-merge', () => void mergeTree(tree)],
      ['커밋 하나로 합쳐 병합하기', 'git-merge', () => void mergeTree(tree, true)],
      ['워크트리 지우기', 'trash-2', () => void removeTree(tree), true],
    )
  }

  showActions(treeTitle(tree), entries, at)
}

// The panel on a worktree's folder, through its latest session when it has one.
function showTreePanel(tree, view) {
  const session = latestSession(tree)

  if (session !== undefined) select(session.id)

  panelOverride = session === undefined ? tree.path : null
  setFilesOpen(true)
  setPanel(view)
}

async function mergeTree(tree, squash = false) {
  const reply = await postJson('/git/merge', { project: tree.project.path, branch: tree.branch, squash }).then((r) => r.json()).catch(() => null)

  notice(reply?.ok ? `${tree.branch}을 ${tree.project.name}에 ${squash ? '커밋 하나로 합쳐 ' : ''}병합했어요` : `${tree.branch}을 병합하지 못했어요 (충돌이나 커밋 안 된 변경이 있는지 확인해 주세요)`)
  void refreshProjects()
}

// Another worktree's commits into this one: its agent's work, saved after each turn, comes over.
function takeFromOther(tree) {
  const others = []

  for (const other of tree.project.worktrees) {
    if (other !== tree && other.branch) others.push([`${treeTitle(other)} (${other.branch})`, other.primary ? 'folder' : 'git-branch', () => void mergeIntoTree(tree, other.branch)])
  }

  if (others.length === 0) {
    notice('가져올 다른 작업 공간이 없어요')

    return
  }

  showActions(`${treeTitle(tree)}에 가져오기`, others, { mouse: false, x: 0, y: 0 })
}

async function mergeIntoTree(tree, branch) {
  const reply = await postJson('/git/merge-into', { folder: tree.path, branch }).then((r) => r.json()).catch(() => null)

  notice(reply?.ok ? `${branch}의 변경을 ${treeTitle(tree)}에 가져왔어요` : `가져오지 못했어요 (충돌이 났거나, 이 작업 공간에 커밋 안 된 변경이 있어요)`)
  void refreshProjects()
}

let removeArmed = ''

async function removeTree(tree) {
  if (tree.sessions.length > 0) {
    notice('이 워크트리의 세션을 먼저 닫아 주세요')

    return
  }

  // Asks once more: the folder goes (its branch stays).
  if (removeArmed !== tree.path) {
    removeArmed = tree.path
    notice(`${treeTitle(tree)} 폴더를 지워요. 한 번 더 고르면 지워집니다 (브랜치는 남아요)`)
    setTimeout(() => {
      removeArmed = ''
    }, 5000)

    return
  }

  removeArmed = ''

  const reply = await fetch('/git/worktree-remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: tree.project.path, path: tree.path }) }).then((r) => r.json()).catch(() => null)

  notice(reply?.ok ? `${treeTitle(tree)} 워크트리를 지웠어요` : '지우지 못했어요 (커밋 안 된 변경이 있으면 git이 막아요)')
  void refreshProjects()
}

// The + of a project: the agent menu, for that project's folder.
function openAddMenuAt(anchor, cwd) {
  renderAddMenu(cwd)
  menu.hidden = false

  // On the PC it hangs under its button, kept on screen; on a phone CSS makes it a bottom sheet.
  if (!touch) {
    const box = anchor.getBoundingClientRect()

    menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - menu.offsetWidth - 8))}px`
    menu.style.top = `${box.bottom + 4}px`
  }

  void refreshAgents().then(() => {
    if (!menu.hidden) renderAddMenu(cwd)
  })
}

$('listOptions').addEventListener('click', (event) => {
  event.stopPropagation()
  openListOptions(event.currentTarget)
})
$('locate').addEventListener('click', () => {
  sideFilter.value = ''
  listFilter = 'all'
  renderDrawer()
  list.querySelector('.agent-row[data-current]')?.scrollIntoView({ block: 'center' })
})
$('navSearch').addEventListener('click', () => openPalette())
$('navTasks').addEventListener('click', () => {
  setFilesOpen(true)
  setPanel('tasks')
})
$('addProject').addEventListener('click', (event) => {
  event.stopPropagation()

  const box = event.currentTarget.getBoundingClientRect()

  openProjectAdd({ mouse: !touch, x: box.left, y: box.bottom + 4 })
})

sideFilter.addEventListener('input', renderDrawer)
$('newWorktree').addEventListener('click', () => openCreate())

// The projects and their worktrees come from the server; asked now and every so often.
const PROJECTS_EVERY_MS = 30_000

void refreshProjects()
setInterval(() => void refreshProjects(), PROJECTS_EVERY_MS)

showList.addEventListener('click', openDrawer)
scrim.addEventListener('click', closeDrawer)
pickButton.addEventListener('click', () => setPicking(!picking))

// Ending sessions stops Claude on the PC too, so the button asks once more before it does.
killButton.addEventListener('click', () => {
  if (killArmed <= Date.now()) {
    killArmed = Date.now() + 3000
    renderDrawer()
    setTimeout(renderDrawer, 3100)

    return
  }

  killArmed = 0

  for (const id of picked) send({ t: 'close', id })

  setPicking(false)
})

archiveButton.addEventListener('click', () => {
  const chosen = sessions.filter((session) => picked.has(session.id))
  const archived = !chosen.every((session) => session.archived)

  for (const session of chosen) send({ t: 'archive', id: session.id, archived })

  notice(archived ? `${chosen.length}개 보관했어요` : `${chosen.length}개 꺼냈어요`)
  setPicking(false)
})

// Long press on a session: rename it, put it in the archive or take it out, start picking several,
// or end it (asked twice).
function openSessionSheet(id) {
  const session = sessions.find((each) => each.id === id)

  if (session === undefined) return

  const plainTitle = session.title.replace(/^[^\p{L}\p{N}]+/u, '') || session.title
  const field = document.createElement('input')
  let endArmed = 0

  const commitName = () => {
    const name = field.value.trim()
    const reset = name === '' || name === plainTitle

    send({ t: 'rename', id, name: reset ? null : name })
    sheet.hidden = true
    notice(reset ? '원래 이름으로 돌렸어요' : `이름을 바꿨어요: ${name}`)
  }

  sheetTitle.textContent = displayName(session).replace(/^[^\p{L}\p{N}]+/u, '')
  sheetBody.replaceChildren()

  const naming = section('이름')
  const nameRow = document.createElement('div')

  field.className = 'field'
  field.value = session.name ?? plainTitle
  field.maxLength = 80
  field.enterKeyHint = 'done'
  field.placeholder = plainTitle
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return

    event.preventDefault()
    commitName()
  })
  nameRow.className = 'chips'
  nameRow.append(chip('이름 저장', commitName, { 'data-primary': true }))

  if (session.name !== null) {
    nameRow.append(chip('원래 이름으로', () => {
      field.value = ''
      commitName()
    }))
  }

  naming.append(field, nameRow)

  const actions = section('세션')
  const row = document.createElement('div')
  const end = chip('종료', () => {
    if (endArmed <= Date.now()) {
      endArmed = Date.now() + 3000
      end.textContent = '정말 종료할까요?'
      setTimeout(() => {
        end.textContent = '종료'
      }, 3100)

      return
    }

    send({ t: 'close', id })
    sheet.hidden = true
  }, { 'data-danger': true })

  row.className = 'chips'
  row.append(
    chip(session.archived ? '보관함에서 꺼내기' : '보관하기', () => {
      send({ t: 'archive', id, archived: !session.archived })
      sheet.hidden = true
      notice(session.archived ? '보관함에서 꺼냈어요' : '보관했어요. 목록 아래 보관함에 있어요')
    }),
    chip(session.muted ? '알림 켜기' : '알림 끄기', () => {
      send({ t: 'mute', id, muted: !session.muted })
      sheet.hidden = true
      notice(session.muted ? '이 세션 알림을 다시 받아요' : '이 세션은 폰 알림을 보내지 않아요')
    }),
    chip('여러 개 선택', () => {
      sheet.hidden = true
      setPicking(true)
      picked.add(id)
      renderDrawer()
    }),
    end,
  )
  actions.append(row)
  sheet.hidden = false
}

// On the PC a right click on a session drops a menu at the pointer (the phone gets the sheet above).
// Renaming happens in the same menu, which turns into a name field.
const contextMenu = $('contextMenu')
const CONFIRM_MS = 3000

function closeContextMenu() {
  contextMenu.hidden = true
  contextMenu.replaceChildren()
}

// Keeps the menu on screen: left of the pointer near the right edge, above it near the bottom.
function placeContextMenu(x, y) {
  contextMenu.hidden = false

  const box = contextMenu.getBoundingClientRect()

  contextMenu.style.left = `${Math.max(8, x + box.width > innerWidth - 8 ? x - box.width : x)}px`
  contextMenu.style.top = `${Math.max(8, y + box.height > innerHeight - 8 ? y - box.height : y)}px`
}

// One row of a menu at the pointer: a 14px icon, then the words.
function menuEntry(label, run, attrs = {}, name = null) {
  const button = document.createElement('button')

  button.type = 'button'
  button.className = 'ctx-item'
  button.setAttribute('role', 'menuitem')

  if (name !== null) button.innerHTML = name === 'blank' ? '<span class="ctx-blank"></span>' : icon(name, 14)

  button.append(label)

  for (const [attr, value] of Object.entries(attrs)) button.toggleAttribute(attr, value)

  button.addEventListener('click', run)

  return button
}

function openSessionMenu(id, x, y) {
  const session = sessions.find((each) => each.id === id)

  if (session === undefined) return

  let endArmed = 0
  const end = menuEntry('종료', () => {
    if (endArmed <= Date.now()) {
      endArmed = Date.now() + CONFIRM_MS
      end.lastChild.textContent = '정말 종료할까요?'

      return
    }

    send({ t: 'close', id })
    closeContextMenu()
  }, { 'data-danger': true }, 'trash-2')
  const separator = document.createElement('div')

  separator.className = 'ctx-separator'
  contextMenu.replaceChildren(
    menuEntry('열기', () => {
      closeContextMenu()

      if (session.archived) send({ t: 'archive', id, archived: false })

      closeDrawer()
      select(id)
    }, {}, 'external-link'),
    menuEntry('이름 바꾸기', () => renameInMenu(session), {}, 'pencil'),
    menuEntry(session.archived ? '보관함에서 꺼내기' : '보관하기', () => {
      closeContextMenu()
      send({ t: 'archive', id, archived: !session.archived })
      notice(session.archived ? '보관함에서 꺼냈어요' : '보관했어요. 목록 아래 보관함에 있어요')
    }, {}, session.archived ? 'archive-restore' : 'archive'),
    menuEntry(session.muted ? '알림 켜기' : '알림 끄기', () => {
      closeContextMenu()
      send({ t: 'mute', id, muted: !session.muted })
      notice(session.muted ? '이 세션 알림을 다시 받아요' : '이 세션은 폰 알림을 보내지 않아요')
    }, {}, session.muted ? 'bell' : 'bell-off'),
    menuEntry('여러 개 선택', () => {
      closeContextMenu()
      setPicking(true)
      picked.add(id)
      renderDrawer()
    }, {}, 'list-checks'),
    separator,
    end,
  )
  placeContextMenu(x, y)
  contextMenu.querySelector('.ctx-item')?.focus()
}

function renameInMenu(session) {
  const plainTitle = session.title.replace(/^[^\p{L}\p{N}]+/u, '') || session.title
  const field = document.createElement('input')
  const box = contextMenu.getBoundingClientRect()
  const commit = () => {
    const name = field.value.trim()
    const reset = name === '' || name === plainTitle

    send({ t: 'rename', id: session.id, name: reset ? null : name })
    closeContextMenu()
    notice(reset ? '원래 이름으로 돌렸어요' : `이름을 바꿨어요: ${name}`)
  }

  field.className = 'field ctx-field'
  field.value = session.name ?? plainTitle
  field.maxLength = 80
  field.placeholder = plainTitle
  field.addEventListener('keydown', (event) => {
    event.stopPropagation()

    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      closeContextMenu()
    }
  })
  contextMenu.replaceChildren(field, menuEntry('저장', commit, { 'data-primary': true }, 'check'))
  placeContextMenu(box.left, box.top)
  field.focus()
  field.select()
}

contextMenu.addEventListener('click', (event) => event.stopPropagation())
contextMenu.addEventListener('contextmenu', (event) => event.preventDefault())
document.addEventListener('pointerdown', (event) => {
  if (!contextMenu.hidden && !contextMenu.contains(event.target)) closeContextMenu()
}, { capture: true })
addEventListener('blur', closeContextMenu)
list.addEventListener('scroll', closeContextMenu)

// Called by the phone app: a notification tap opens its session; an image from the keyboard, already
// uploaded by the app, arrives as its path.
// Back (the phone's back gesture, Esc on the PC) closes whatever is on top, one layer at a time:
// the viewer, a sheet, picking, the gallery (back to the terminal it was opened over), the + menu,
// the side list. False when only the terminal is left, and the app then goes to the home screen.
function back() {
  if (!composer.hidden) {
    const drawer = composer.querySelector('.pick-drawer')

    if (drawer !== null) drawer.remove()
    else closeCreate()

    return true
  }

  if (!palette.hidden) {
    closePalette()

    return true
  }

  if (!contextMenu.hidden) {
    closeContextMenu()

    return true
  }

  if (!searchForm.hidden) {
    closeSearch()

    return true
  }

  if (selecting()) {
    endCopy()

    return true
  }

  if (!viewer.hidden) {
    closeViewer()

    return true
  }

  if (!sheet.hidden) {
    sheet.hidden = true

    return true
  }

  if (!galleryPanel.hidden) {
    if (galleryPicking) setGalleryPicking(false)
    else galleryPanel.hidden = true

    return true
  }

  if (!menu.hidden) {
    menu.hidden = true
    addButton.setAttribute('aria-expanded', 'false')

    return true
  }

  if (!pcMenu.hidden) {
    closePcMenu()

    return true
  }

  if (picking) {
    setPicking(false)

    return true
  }

  if (touch && !filesPanel.hidden) {
    setFilesOpen(false)

    return true
  }

  if (touch && appEl.dataset.view === 'session') {
    setView('home')

    return true
  }

  if (touch && appEl.dataset.view === 'home') {
    setView('hosts')

    return true
  }

  return false
}

// Esc goes to the terminal (Claude uses it) unless a layer is open to close.
addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.target.closest?.('.tag-field')) return

  if (back()) {
    event.preventDefault()
    event.stopPropagation()
  }
}, { capture: true })


// ---- Documents: files and web pages in tabs, beside the sessions.
const docBox = $('doc')
const secondPane = $('secondPane')
const secondBar = $('secondBar')
const secondBody = $('secondBody')
const splitHandle = $('splitHandle')
const splitButton = $('splitButton')
const SPLIT_KEY = 'choiterm.split'
let split = !touch && load(SPLIT_KEY) === 'on'
// What the second pane shows: a session's terminal ({ session }) or a document ({ doc }).
let second = null
let mini = null

function saveDocs() {
  save(DOCS_KEY, docs.length === 0 ? null : JSON.stringify(docs))
}

function addDoc(doc) {
  const known = docs.find((each) => each.id === doc.id)
  // With the screen split, new documents open in the second pane.
  const pane = split ? 'second' : 'main'

  if (known === undefined) docs.push({ ...doc, pane })
  else known.pane = pane

  saveDocs()

  if (pane === 'second') showSecond({ doc: doc.id })
  else showDoc(doc.id)
}

function showDoc(id) {
  const doc = docs.find((each) => each.id === id)

  if (doc === undefined) return

  showHome(false)
  doc.pane = 'main'
  view = id
  saveDocs()
  render()
  fillDoc(docBox, doc)

  if (touch) setView('session')
}

function fillDoc(box, doc) {
  if (doc.type === 'file') {
    void showFile(box, doc.path, { line: doc.line ?? null, edit: doc.edit === true })
    // Opening in the editor is for the first showing only (a new note).
    doc.edit = false
  } else if (doc.type === 'diff') {
    void showDiff(box, doc.root, doc.path, (text) => openSendSheet(text, doc.session ?? current))
  } else {
    showWeb(box, doc.url, doc.title, (text) => openSendSheet(text, doc.session ?? current))
  }
}

function closeDoc(id) {
  docs = docs.filter((doc) => doc.id !== id)
  saveDocs()

  if (view === id) {
    view = null
    docBox.replaceChildren()
  }

  if (second?.doc === id) showSecond(null)

  render()
  renderSecond()
}

function openFile(path, line = null, edit = false) {
  addDoc({ id: `f:${path.toLowerCase()}`, type: 'file', path, line, edit, title: docName(path) })

  // Already open: show it again at the new line.
  const known = docs.find((doc) => doc.id === `f:${path.toLowerCase()}`)

  if (known !== undefined && (known.line !== line || edit)) {
    known.line = line
    known.edit = edit

    if (view === known.id) fillDoc(docBox, known)
  }
}

function openDiff(root, path) {
  addDoc({ id: `d:${root.toLowerCase()}|${path}`, type: 'diff', root, path, session: current, title: `${docName(path)} (변경)` })
}

// A session's dev server, through ChoiTerm's proxy (so elements can be annotated): at 127.0.0.1 on
// this PC, at its tailnet address anywhere else.
async function openWeb(port, sessionId = current) {
  const here = location.hostname === '127.0.0.1' || location.hostname === 'localhost'
  let links = null

  if (!here) notice(`localhost:${port}을 이 기기에서 볼 수 있게 여는 중…`)

  try {
    const reply = await fetch('/preview-open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) })

    links = reply.ok ? await reply.json() : null
  } catch {
    links = null
  }

  const url = here ? (links?.local ?? `http://localhost:${port}/`) : links?.url ?? null

  if (url === null) {
    notice(`localhost:${port}을 열지 못했어요`)

    return
  }

  addDoc({ id: `w:${port}`, type: 'web', url, session: sessionId, title: `localhost:${port}` })
}

// ---- Split: a second pane beside the terminal for another session, a file or a web page.
function setSplit(on) {
  split = on && !touch
  save(SPLIT_KEY, split ? 'on' : null)
  splitButton.setAttribute('aria-pressed', String(split))
  secondPane.hidden = !split
  splitHandle.hidden = !split

  if (split && second === null) {
    const other = openTabs.find((id) => id !== current) ?? allTabs.find((id) => id !== current)

    showSecond(other === undefined ? null : { session: other })
  }

  if (!split) {
    mini?.dispose()
    mini = null
  }

  renderSecond()
  requestAnimationFrame(() => claim())
}

function showSecond(item) {
  second = item

  if (!split && item !== null) {
    setSplit(true)

    return
  }

  secondBody.replaceChildren()

  if (item?.session !== undefined) {
    mini?.dispose()
    mini = createMiniTerm(secondBody, { font: FONT, fontSize: touch ? 12 : 14, theme: dark.matches ? PALETTES.dark : PALETTES.light })
    mini.show(item.session)
  } else {
    mini?.dispose()
    mini = null

    const doc = docs.find((each) => each.id === item?.doc)

    if (doc !== undefined) {
      const box = document.createElement('div')

      box.className = 'doc'
      secondBody.append(box)
      fillDoc(box, doc)
    }
  }

  renderSecond()
}

function renderSecond() {
  secondBar.replaceChildren()

  if (!split) return

  for (const id of allTabs) {
    const session = sessions.find((each) => each.id === id)

    if (session === undefined || id === current) continue

    const tab = document.createElement('button')
    const name = document.createElement('span')

    tab.className = 'tab'
    tab.setAttribute('aria-selected', String(second?.session === id))
    name.className = 'name'
    name.textContent = plainName(session)
    tab.append(agentIcon(session.kind), name)
    tab.addEventListener('click', () => showSecond({ session: id }))
    secondBar.append(tab)
  }

  for (const doc of docs) {
    if (doc.pane !== 'second') continue

    secondBar.append(docTab(doc, () => showSecond({ doc: doc.id }), second?.doc === doc.id))
  }
}

splitButton.addEventListener('click', () => setSplit(!split))

// Dragging the line between the panes sets how wide the second one is.
splitHandle.addEventListener('pointerdown', (event) => {
  event.preventDefault()
  splitHandle.setPointerCapture(event.pointerId)

  const box = $('panes').getBoundingClientRect()
  const move = (moved) => {
    const width = Math.min(0.8, Math.max(0.2, (box.right - moved.clientX) / box.width))

    $('panes').style.setProperty('--second-width', `${Math.round(width * 100)}%`)
  }
  const stop = () => {
    splitHandle.removeEventListener('pointermove', move)
    claim()
    mini?.claim()
  }

  splitHandle.addEventListener('pointermove', move)
  splitHandle.addEventListener('pointerup', stop, { once: true })
})

dark.addEventListener('change', () => mini?.setTheme(dark.matches ? PALETTES.dark : PALETTES.light))

// ---- Files: the open session's project as a tree; a file opens in a tab.
const filesPanel = $('filesPanel')
const filesButton = $('filesButton')
const tree = $('tree')
const FILES_KEY = 'choiterm.files'
let filesRoot = null

// Every image this session sent or got, newest first: the gallery, for the session on screen.
function renderSessionImages() {
  const box = panelViews.images
  const items = [...sessionImages()].sort((a, b) => b.at - a.at)

  $('filesPath').textContent = items.length === 0 ? '' : `${items.length}개`

  if (current === null || items.length === 0) {
    box.replaceChildren(note(current === null ? '세션을 열면 그 세션의 이미지가 보여요' : '이 세션에서 주고받은 이미지가 아직 없어요'))

    return
  }

  const grid = document.createElement('div')

  grid.className = 'panel-images'
  items.forEach((item, index) => {
    const cell = document.createElement('button')
    const image = document.createElement('img')
    const caption = document.createElement('span')

    cell.type = 'button'
    cell.className = 'panel-image'
    cell.title = item.path
    cell.dataset.from = item.from
    image.alt = ''
    image.loading = 'lazy'
    image.draggable = false
    image.src = previewUrl(item.path)
    image.addEventListener('error', () => cell.setAttribute('data-missing', ''))
    caption.className = 'panel-image-caption'
    caption.textContent = `${item.from === 'me' ? '보냄' : '받음'} · ${timeLabel(item.at)}`
    cell.append(image, caption)
    cell.addEventListener('click', () => openViewer(items, index))
    grid.append(cell)
  })
  box.replaceChildren(grid)
}

function setFilesOpen(open) {
  filesPanel.hidden = !open
  filesButton.setAttribute('aria-pressed', String(open && panel !== 'images'))
  $('imagesButton').setAttribute('aria-pressed', String(open && panel === 'images'))

  if (!touch) save(FILES_KEY, open ? 'open' : null)

  if (open) setPanel(panel)

  requestAnimationFrame(() => claim())
}

// The tree shows the open session's checkout (else its folder, else home).
function followFiles(force = false) {
  if (filesPanel.hidden) return

  const root = panelRoot()

  if (!force && root === filesRoot) return

  if (root === null) {
    filesRoot = null
    $('filesTitle').textContent = '파일'
    $('filesPath').textContent = ''
    tree.replaceChildren(Object.assign(document.createElement('p'), { className: 'doc-note', textContent: '세션을 열면 그 폴더가 보여요' }))

    return
  }

  void loadRoot(root)
}

async function listFolder(path) {
  try {
    const reply = await fetch(`/fs/list?path=${encodeURIComponent(path)}`, { cache: 'no-store' })

    return reply.ok ? (await reply.json()).entries : null
  } catch {
    return null
  }
}

async function loadRoot(root) {
  filesRoot = root

  if (panel === 'files') $('filesTitle').textContent = docName(root) || root

  $('filesPath').textContent = root
  tree.replaceChildren()

  const entries = await listFolder(root)

  if (filesRoot !== root) return

  if (entries === null) {
    tree.append(Object.assign(document.createElement('p'), { className: 'doc-note', textContent: '폴더를 열 수 없어요' }))

    return
  }

  for (const node of treeNodes(entries, 0)) tree.append(node)
}

// Folders (and files) that are usually noise are dimmed, not hidden.
const DIM = /^(\.git|node_modules|\.next|dist|build|target|\.venv|__pycache__|\.gradle|\.idea|\.vscode)$/i

function treeNodes(entries, depth) {
  const nodes = []

  for (const entry of entries) {
    const row = document.createElement('button')
    const twist = document.createElement('span')
    const icon = document.createElement('span')
    const name = document.createElement('span')

    row.type = 'button'
    row.className = 'node'
    row.draggable = true
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', entry.path)
      event.dataTransfer.setData('application/x-choiterm-path', entry.path)
    })
    row.style.paddingLeft = `${6 + depth * 14}px`
    row.title = entry.path
    row.toggleAttribute('data-dim', DIM.test(entry.name) || entry.name.startsWith('.'))
    twist.className = 'tw'
    icon.className = 'ico'
    name.className = 'nm'
    name.textContent = entry.name

    if (entry.dir) {
      twist.innerHTML = CHEVRON_ICON
      icon.innerHTML = FOLDER_ICON
    } else {
      icon.innerHTML = FILE_ICON
    }

    row.append(twist, icon, name)

    let children = null

    row.addEventListener('click', async () => {
      if (!entry.dir) {
        openFile(entry.path)

        if (touch) setFilesOpen(false)

        return
      }

      if (children !== null) {
        for (const child of children) child.remove()

        children = null
        row.removeAttribute('data-expanded')

        return
      }

      row.setAttribute('data-expanded', '')

      const inside = await listFolder(entry.path)

      children = treeNodes(inside ?? [], depth + 1)
      row.after(...children)
    })
    nodes.push(row)
  }

  return nodes
}

// The panel's views: files, search, git changes, GitHub tasks.
const PANEL_KEY = 'choiterm.panel'
const PANEL_ICONS = { files: UI.files, search: UI.search, changes: UI.changes, tasks: UI.tasks, images: icon('images', 15) }
const panelViews = { files: $('filesView'), search: $('searchView'), changes: $('changesView'), tasks: $('tasksView'), images: $('imagesView') }
let panel = load(PANEL_KEY) in panelViews ? load(PANEL_KEY) : 'files'

for (const button of document.querySelectorAll('#panelTabs [data-panel]')) {
  button.innerHTML = PANEL_ICONS[button.dataset.panel]
  button.addEventListener('click', () => setPanel(button.dataset.panel))
}

function setPanel(name) {
  panel = name
  save(PANEL_KEY, name === 'files' ? null : name)

  for (const [key, box] of Object.entries(panelViews)) box.hidden = key !== name

  for (const button of document.querySelectorAll('#panelTabs [data-panel]')) button.setAttribute('aria-pressed', String(button.dataset.panel === name))

  $('filesUp').hidden = name !== 'files'
  refreshPanel()
}

// The checkout the panel works on: the open session's, or a worktree picked in the list that has
// no session.
let panelOverride = null

function panelRoot() {
  return panelOverride ?? metaById.get(current)?.repo?.root ?? currentFolder()
}

function refreshPanel() {
  if (filesPanel.hidden) return

  const root = panelRoot()

  $('filesTitle').textContent = panel === 'files' ? (docName(filesRoot ?? '') || '파일') : { search: '검색', changes: '변경', tasks: 'GitHub 작업', images: '이 세션의 이미지' }[panel]
  $('imagesButton').setAttribute('aria-pressed', String(panel === 'images'))
  filesButton.setAttribute('aria-pressed', String(panel !== 'images'))

  if (panel === 'images') renderSessionImages()
  else if (panel === 'files') followFiles(true)
  else if (root === null) panelViews[panel].replaceChildren(note('세션을 열면 그 프로젝트가 보여요'))
  else if (panel === 'changes') void loadChanges(root)
  else if (panel === 'tasks') void loadTasks(root)
  else $('panelQuery').focus()
}

function note(text) {
  return Object.assign(document.createElement('p'), { className: 'doc-note', textContent: text })
}

async function getJson(url) {
  try {
    const reply = await fetch(url, { cache: 'no-store' })

    return reply.ok ? await reply.json() : null
  } catch {
    return null
  }
}

// Search: hits grouped by file; a hit opens the file at its line.
$('panelSearch').addEventListener('submit', async (event) => {
  event.preventDefault()

  const root = panelRoot()
  const query = $('panelQuery').value.trim()
  const results = $('searchResults')

  if (root === null || query === '') return

  results.replaceChildren(note('찾는 중…'))

  const reply = await getJson(`/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`)
  const hits = reply?.hits ?? null

  if (hits === null) {
    results.replaceChildren(note('찾을 수 없어요'))

    return
  }

  results.replaceChildren()

  if (hits.length === 0) results.append(note('맞는 곳이 없어요'))

  let file = null

  for (const hit of hits) {
    if (hit.path !== file) {
      file = hit.path

      const head = document.createElement('div')

      head.className = 'result-file mono-path'
      head.textContent = hit.path
      results.append(head)
    }

    const row = document.createElement('button')
    const number = document.createElement('span')
    const words = document.createElement('span')
    const at = hit.text.toLowerCase().indexOf(query.toLowerCase())

    row.type = 'button'
    row.className = 'result'
    number.className = 'dn'
    number.textContent = String(hit.line)
    words.className = 'result-text'

    if (at >= 0) {
      const mark = document.createElement('mark')

      mark.textContent = hit.text.slice(at, at + query.length)
      words.append(hit.text.slice(Math.max(0, at - 40), at).trimStart(), mark, hit.text.slice(at + query.length))
    } else {
      words.textContent = hit.text.trim()
    }

    row.append(number, words)
    row.addEventListener('click', () => {
      openFile(`${root}\\${hit.path.replaceAll('/', '\\')}`, hit.line)

      if (touch) setFilesOpen(false)
    })
    results.append(row)
  }
})

// ---- Finding in the files panel: file names match as you type; the words inside files below them.
const treeFind = $('treeFind')
const treeResults = $('treeResults')
let treeFindTimer = 0

function hitRows(box, root, query, hits) {
  let file = null

  for (const hit of hits) {
    if (hit.path !== file) {
      file = hit.path
      box.append(Object.assign(document.createElement('div'), { className: 'result-file mono-path', textContent: hit.path }))
    }

    const row = document.createElement('button')
    const number = document.createElement('span')
    const words = document.createElement('span')
    const at = hit.text.toLowerCase().indexOf(query.toLowerCase())

    row.type = 'button'
    row.className = 'result'
    number.className = 'dn'
    number.textContent = String(hit.line)
    words.className = 'result-text'

    if (at >= 0) {
      const mark = document.createElement('mark')

      mark.textContent = hit.text.slice(at, at + query.length)
      words.append(hit.text.slice(Math.max(0, at - 40), at).trimStart(), mark, hit.text.slice(at + query.length))
    } else {
      words.textContent = hit.text.trim()
    }

    row.append(number, words)
    row.addEventListener('click', () => {
      openFile(`${root}\\${hit.path.replaceAll('/', '\\')}`, hit.line)

      if (touch) setFilesOpen(false)
    })
    box.append(row)
  }
}

async function findInTree() {
  const root = panelRoot()
  const query = treeFind.value.trim()
  const searching = query !== '' && root !== null

  tree.hidden = searching
  treeResults.hidden = !searching

  if (!searching) return

  treeResults.replaceChildren(note('찾는 중…'))

  const [names, words] = await Promise.all([getJson(`/files?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`), getJson(`/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`)])

  // A newer search has started meanwhile.
  if (treeFind.value.trim() !== query) return

  treeResults.replaceChildren()

  const files = names?.files ?? []
  const hits = words?.hits ?? []

  if (files.length > 0) {
    treeResults.append(Object.assign(document.createElement('div'), { className: 'find-head', textContent: `파일 이름 ${files.length}` }))

    for (const path of files.slice(0, 30)) {
      const row = document.createElement('button')

      row.type = 'button'
      row.className = 'result'
      row.innerHTML = icon('file', 13)
      row.append(Object.assign(document.createElement('span'), { className: 'result-text mono-path', textContent: path }))
      row.addEventListener('click', () => {
        openFile(`${root}\\${path.replaceAll('/', '\\')}`)

        if (touch) setFilesOpen(false)
      })
      treeResults.append(row)
    }
  }

  if (hits.length > 0) {
    treeResults.append(Object.assign(document.createElement('div'), { className: 'find-head', textContent: `내용 ${hits.length}` }))
    hitRows(treeResults, root, query, hits)
  }

  if (files.length === 0 && hits.length === 0) treeResults.append(note('맞는 것이 없어요'))
}

treeFind.addEventListener('input', () => {
  clearTimeout(treeFindTimer)
  treeFindTimer = setTimeout(() => void findInTree(), 250)
})
treeFind.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && treeFind.value !== '') {
    event.stopPropagation()
    treeFind.value = ''
    void findInTree()
  }
})

// Changes: files git sees as changed; one opens as a diff to comment on.
const CHANGE_NAMES = { M: '수정', A: '추가', D: '삭제', R: '이름 바뀜', C: '복사', '?': '새 파일', U: '충돌' }

async function loadChanges(root) {
  const box = panelViews.changes

  box.replaceChildren(note('읽는 중…'))

  const reply = await getJson(`/git/status?root=${encodeURIComponent(root)}`)

  if (reply === null) {
    box.replaceChildren(note('git 저장소가 아니에요'))

    return
  }

  box.replaceChildren()

  const branch = metaById.get(current)?.repo?.branch
  const head = document.createElement('div')

  head.className = 'changes-head'
  head.innerHTML = `${BRANCH_ICON}<span></span>`
  head.lastElementChild.textContent = `${branch || '브랜치'} · 바뀐 파일 ${reply.changes.length}개`
  box.append(head)

  if (reply.changes.length === 0) box.append(note('바뀐 파일이 없어요'))

  for (const change of reply.changes) {
    const letter = change.work !== ' ' ? change.work : change.index
    const row = document.createElement('button')
    const mark = document.createElement('span')
    const name = document.createElement('span')

    row.type = 'button'
    row.className = 'change'
    mark.className = 'change-mark'
    mark.dataset.kind = letter
    mark.textContent = letter === '?' ? 'U' : letter
    mark.title = CHANGE_NAMES[letter] ?? letter
    name.className = 'mono-path'
    name.textContent = change.path
    row.append(mark, name)
    row.addEventListener('click', () => {
      openDiff(root, change.path)

      if (touch) setFilesOpen(false)
    })
    box.append(row)
  }
}

// GitHub: open pull requests and issues of the project (gh on the PC); a pull request can open as
// a worktree on its branch.
async function loadTasks(root) {
  const box = panelViews.tasks

  box.replaceChildren(note('GitHub에서 읽는 중…'))

  const reply = await getJson(`/tasks?root=${encodeURIComponent(root)}`)

  if (reply === null) {
    box.replaceChildren(note('GitHub 저장소가 아니거나 gh에 로그인돼 있지 않아요'))

    return
  }

  box.replaceChildren()

  for (const [kind, title] of [['pr', '풀 리퀘스트'], ['issue', '이슈']]) {
    const items = reply.tasks.filter((task) => task.kind === kind)
    const head = document.createElement('div')

    head.className = 'result-file'
    head.textContent = `${title} ${items.length}`
    box.append(head)

    for (const task of items) {
      const row = document.createElement('div')
      const open = document.createElement('button')
      const words = document.createElement('span')
      const sub = document.createElement('small')

      row.className = 'task'
      open.type = 'button'
      open.className = 'task-open'
      words.textContent = `#${task.number} ${task.title}`
      sub.textContent = [task.draft ? '초안' : '', task.author, task.branch ?? ''].filter(Boolean).join(' · ')
      open.append(words, sub)
      open.addEventListener('click', () => openUrl(task.url))
      row.append(open)

      if (task.branch !== null) {
        const work = document.createElement('button')

        work.type = 'button'
        work.className = 'icon'
        work.title = `${task.branch} 워크트리로 열기`
        work.innerHTML = BRANCH_ICON.replace('width="11" height="11"', 'width="15" height="15"')
        work.addEventListener('click', () => openWorktreeSheet(task.branch))
        row.append(work)
      }

      box.append(row)
    }
  }
}

filesButton.addEventListener('click', () => {
  if (!filesPanel.hidden && panel === 'images') setPanel('files')
  else setFilesOpen(filesPanel.hidden)
})
$('imagesButton').addEventListener('click', () => {
  if (!filesPanel.hidden && panel === 'images') {
    setFilesOpen(false)

    return
  }

  setFilesOpen(true)
  setPanel('images')
})

// The phone's session bar: source control, and the rest under "more".
$('changesButton').addEventListener('click', () => {
  setFilesOpen(true)
  setPanel('changes')
})
$('moreButton').addEventListener('click', () => {
  const entries = [
    ['터미널에서 찾기', 'search', () => void openSearch()],
    ['상태와 모델', 'activity', openStatusSheet],
    ['키 줄 편집', 'keyboard', openKeyEditor],
    ['갤러리', 'images', openGallery],
    ['메모', 'sticky-note', () => $('openNotes').click()],
  ]
  const session = sessions.find((each) => each.id === current)

  if (session !== undefined) entries.push(['세션 메뉴', 'ellipsis', () => openSessionSheet(session.id)])

  showActions('더 보기', entries, { mouse: false, x: 0, y: 0 })
})
$('filesClose').addEventListener('click', () => setFilesOpen(false))
$('filesRefresh').addEventListener('click', () => {
  if (panel !== 'files') refreshPanel()
  else if (filesRoot !== null) void loadRoot(filesRoot)
})
$('filesUp').addEventListener('click', () => {
  if (filesRoot === null) return

  const parent = filesRoot.replace(/[\\/][^\\/]+[\\/]?$/, '')

  if (parent !== '' && parent !== filesRoot) void loadRoot(/^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent)
})

if (!touch && load(FILES_KEY) === 'open') setFilesOpen(true)

// ---- The PC's bottom line: the Claude account's limits, the open session, this PC.
const footer = $('statusFooter')

function meter(percent) {
  const bar = document.createElement('span')
  const fill = document.createElement('i')

  bar.className = 'meter'
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`

  const mood = tone(percent)

  if (mood !== '') fill.dataset.tone = mood

  bar.append(fill)

  return bar
}

// The PC's bottom line (status bar): "사용" and each account's tightest limit (percent first,
// then the time to its reset), then on the right the open session, ports, memory and the PCs.
function limitLabel(limit) {
  const left = limit.resetsAt === null ? null : Date.parse(limit.resetsAt) - Date.now()

  return left !== null && Number.isFinite(left) && left > 0 ? shortSpan(left) : limitName(limit.kind).toLowerCase()
}

function providerSegment(kind, limits) {
  const segment = document.createElement('span')
  const tightest = [...limits].sort((a, b) => b.percent - a.percent)[0]

  segment.className = 'usage-seg'
  segment.innerHTML = agentMark(kind, 13)

  if (tightest === undefined) {
    segment.append('--')

    return segment
  }

  const value = document.createElement('span')

  value.className = 'usage-num'
  value.dataset.tone = tone(tightest.percent)
  value.textContent = `${Math.round(tightest.percent)}% ${limitLabel(tightest)}`
  segment.title = limits.map((limit) => `${limitName(limit.kind)} ${Math.round(limit.percent)}% · ${limitLabel(limit)}`).join('\n')
  segment.append(value)

  return segment
}

function renderFooter() {
  if (touch) return

  footer.replaceChildren()

  const latest = [...statuses.values()].at(-1)
  const usage = document.createElement('button')

  usage.type = 'button'
  usage.className = 'usage-button'
  usage.setAttribute('aria-label', '사용량')
  usage.append(Object.assign(document.createElement('span'), { className: 'usage-unit', textContent: '사용' }))

  if (latest !== undefined) usage.append(providerSegment('claude', latest.limits))
  if (codexLimits !== null) usage.append(providerSegment('codex', codexLimits))

  usage.addEventListener('click', openStatusSheet)

  const refresh = document.createElement('button')

  refresh.type = 'button'
  refresh.className = 'status-icon'
  refresh.innerHTML = icon('refresh-cw', 11)
  refresh.title = '사용량 새로 고침'
  refresh.addEventListener('click', () => void refreshUsage())

  if (latest !== undefined || codexLimits !== null) footer.append(usage, refresh)

  const status = statuses.get(current)

  if (status !== undefined && sessions.find((each) => each.id === current)?.kind === 'claude') {
    const here = document.createElement('span')
    const parts = []

    if (status.contextPercent !== null) parts.push(`컨텍스트 ${status.contextPercent}%`)

    const left = cacheLeft(status.cache)

    if (left !== null) parts.push(left > 0 ? `캐시 ${shortSpan(left)}` : '캐시 식음')

    parts.push(modelLabel(status.model))

    if (status.effort !== null) parts.push(status.effort)

    here.className = 'status-text'
    here.textContent = parts.join(' · ')
    footer.append(here)
  }

  footer.append(Object.assign(document.createElement('span'), { className: 'grow' }))

  for (const item of metaById.get(current)?.ports ?? []) {
    const link = document.createElement('button')

    link.type = 'button'
    link.className = 'status-seg'
    link.innerHTML = icon('globe', 11)
    link.append(`localhost:${item.port}`)
    link.addEventListener('click', () => void openWeb(item.port))
    footer.append(link)
  }

  if (system !== null && system.memTotal > 0) {
    const memory = document.createElement('span')
    const used = (system.memTotal - system.memFree) / 1024 ** 3

    memory.className = 'status-text'
    memory.title = 'PC 메모리 사용'
    memory.textContent = `메모리 ${used.toFixed(1)} / ${(system.memTotal / 1024 ** 3).toFixed(0)} GB`
    footer.append(memory)
  }

  const counts = hereCounts()

  footer.append(Object.assign(document.createElement('span'), { className: 'status-text', textContent: countLine(counts) }))

  // The hosts segment: the PCs and whether this page's connection is up.
  const pcs = document.createElement('button')
  const live = machines.filter((machine) => machine.here || machine.online).length

  pcs.type = 'button'
  pcs.className = 'status-seg'
  pcs.dataset.state = dot.dataset.state ?? ''
  pcs.innerHTML = icon('server', 12)
  pcs.append(machines.length > 1 ? `PC ${live}/${machines.length}대` : location.hostname.endsWith('.ts.net') ? 'Tailscale' : '이 PC')
  pcs.insertAdjacentHTML('beforeend', '<i class="seg-dot"></i>')
  pcs.title = '다른 PC 고르기'
  pcs.addEventListener('click', (event) => {
    event.stopPropagation()

    if (machines.length > 1) openPcMenu()
  })
  footer.append(pcs)
}

// Codex's limits and the PC's memory, asked for now and then.
async function refreshUsage() {
  const [usage, stats] = await Promise.all([getJson('/usage'), getJson('/system')])

  codexLimits = usage?.codex?.limits ?? null
  system = stats
  renderFooter()
  renderHosts()
}

void refreshUsage()
setInterval(() => void refreshUsage(), 60_000)

setInterval(renderFooter, STATUS_TICK_MS)

// ---- Sending text from one session to another (a Claude answer for Codex to review, …).
// It goes in as a paste, so several lines arrive as one input; Enter is the owner's to press.
function openSendSheet(text, preferred = null) {
  if (text.trim() === '') return

  sheetTitle.textContent = '다른 세션에 보내기'
  sheetBody.replaceChildren()

  const preview = document.createElement('p')
  const box = section('받을 세션')
  const rows = document.createElement('div')
  const andEnter = chip('보내고 Enter까지', () => {
    enter = !enter
    andEnter.toggleAttribute('data-on', enter)
  })
  let enter = false

  preview.className = 'preview'
  preview.textContent = text.length > 160 ? `${text.slice(0, 160)}…` : text
  rows.className = 'sheet-list'

  // The session the text is about (the one owning the diff or the preview) comes first.
  const order = preferred === null ? allTabs : [preferred, ...allTabs.filter((id) => id !== preferred)]

  for (const id of order) {
    const session = sessions.find((each) => each.id === id)

    if (session === undefined || (id === current && preferred === null)) continue

    const row = document.createElement('button')
    const words = document.createElement('span')
    const where = document.createElement('small')

    row.type = 'button'
    row.className = 'sheet-row'
    words.textContent = plainName(session)
    where.textContent = ` ${agentName(session.kind)}${metaById.get(id)?.repo?.branch ? ` · ${metaById.get(id).repo.branch}` : ''}`
    words.append(where)
    row.append(agentIcon(session.kind, 16), words)
    row.addEventListener('click', () => {
      send({ t: 'in', id, d: `\x1b[200~${text}\x1b[201~` })

      if (enter) setTimeout(() => send({ t: 'in', id, d: '\r' }), 150)

      sheet.hidden = true
      notice(`${plainName(session)}에 보냈어요`)
    })
    rows.append(row)
  }

  if (rows.childElementCount === 0) rows.append(Object.assign(document.createElement('p'), { className: 'doc-note', textContent: '보낼 다른 세션이 없어요' }))

  box.append(rows)
  sheetBody.append(preview, Object.assign(document.createElement('div'), { className: 'chips' }), box)
  sheetBody.querySelector('.chips').append(andEnter)
  sheet.hidden = false
}

$('copySend').addEventListener('click', () => {
  const text = selectionText()

  endCopy()
  openSendSheet(text)
})

// On the PC a right click on a selection offers copying it or sending it to another session.
// On the PC a right click in the terminal: copy or send a selection, paste what was copied last
// (text, or an image, which is uploaded and its path typed), or the latest image ChoiTerm has.
screen.addEventListener('contextmenu', (event) => {
  if (touch) return

  event.preventDefault()

  const entries = []

  if (term.hasSelection()) {
    const text = selectionText()

    entries.push(
      menuEntry('복사', () => {
        closeContextMenu()
        void copyText(text)
        term.clearSelection()
      }),
      menuEntry('다른 세션에 보내기…', () => {
        closeContextMenu()
        term.clearSelection()
        openSendSheet(text)
      }),
    )
  }

  entries.push(menuEntry('붙여넣기', () => {
    closeContextMenu()
    void pasteClipboard()
  }))

  const image = [...gallery].sort((a, b) => b.at - a.at)[0]

  if (image !== undefined) {
    entries.push(menuEntry(`최근 이미지 붙여넣기 · ${fileName(image.path)}`, () => {
      closeContextMenu()
      insertPaths([image.path], false)
    }))
  }

  contextMenu.replaceChildren(...entries)
  placeContextMenu(event.clientX, event.clientY)
})

// ---- Notes: markdown files kept by ChoiTerm, opened and edited in tabs.
async function openNotesSheet() {
  sheetTitle.textContent = '메모'
  sheetBody.replaceChildren(note('불러오는 중…'))
  sheet.hidden = false

  const reply = await getJson('/notes')

  sheetBody.replaceChildren()

  if (reply === null) {
    sheetBody.append(note('메모를 열 수 없어요'))

    return
  }

  const actions = document.createElement('div')
  const rows = document.createElement('div')

  actions.className = 'chips'
  rows.className = 'sheet-list'
  actions.append(chip('새 메모', async () => {
    const stamp = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    const name = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.md`
    const path = `${reply.folder}\\${name}`
    const made = await fetch('/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, text: '# 새 메모\n\n', expected: null }) }).catch(() => null)

    if (!made?.ok) {
      notice('메모를 만들지 못했어요')

      return
    }

    sheet.hidden = true
    openFile(path, null, true)
  }, { 'data-primary': true }))

  const entries = [...reply.entries].sort((a, b) => b.modified - a.modified)

  for (const entry of entries) {
    const row = document.createElement('button')
    const words = document.createElement('span')
    const when = document.createElement('small')

    row.type = 'button'
    row.className = 'sheet-row'
    row.innerHTML = UI.note
    words.textContent = entry.name.replace(/\.md$/i, '')
    when.textContent = ` ${since(entry.modified)} 전`
    words.append(when)
    row.append(words)
    row.addEventListener('click', () => {
      sheet.hidden = true
      openFile(entry.path)
    })
    rows.append(row)
  }

  if (entries.length === 0) rows.append(note('메모가 없어요'))

  sheetBody.append(actions, rows)
}

$('openNotes').addEventListener('click', () => void openNotesSheet())

// ---- New workspace (composer): a project, what to create it from (a name, a branch, a
// GitHub PR or issue) and from which base branch, the agent to start there, and more under 고급.
// A modal on the PC; a drawer from the bottom on a phone, with its pickers in drawers of their own.
function knownProjects() {
  const found = new Map()

  for (const project of projectList) found.set(keyOf(project.path), { project: project.path, name: project.name, git: true })

  for (const meta of metaById.values()) {
    if (meta.repo && !found.has(keyOf(meta.repo.project))) found.set(keyOf(meta.repo.project), { project: meta.repo.project, name: meta.repo.name, git: true })
  }

  for (const session of sessions) {
    if (!session.archived && session.cwd && !metaById.get(session.id)?.repo && !found.has(keyOf(session.cwd))) found.set(keyOf(session.cwd), { project: session.cwd, name: baseName(session.cwd) || session.cwd, git: false })
  }

  return [...found.values()]
}

// A branch name from words: latin words kept, the rest dropped; a time stamp otherwise.
function branchFromPrompt(prompt) {
  const words = prompt.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')

  return words.length > 0 ? words.slice(0, 5).join('-') : `task-${stamp}`
}

const composer = document.createElement('div')

composer.className = touch ? 'drawer-scrim' : 'modal-scrim'
composer.hidden = true
document.body.append(composer)
composer.addEventListener('pointerdown', (event) => {
  if (event.target === composer) closeCreate()
})

function closeCreate() {
  composer.hidden = true
  composer.replaceChildren()
}

// A list to pick from: under its field on the PC, a drawer of its own on a phone (a picker
// drawer). `options` are { value, label, detail?, mark? }; resolves with the value or null.
function pickFrom(anchor, title, options, chosen, searchHint = '') {
  return new Promise((resolve) => {
    const pop = document.createElement('div')
    const field = document.createElement('input')
    const rows = document.createElement('div')
    const finish = (value) => {
      pop.remove()
      removeEventListener('pointerdown', outside, true)
      resolve(value)
    }
    const outside = (event) => {
      if (!pop.contains(event.target) && event.target !== anchor) finish(null)
    }
    const draw = () => {
      const words = field.value.trim().toLowerCase()

      rows.replaceChildren()

      for (const option of options) {
        if (words !== '' && !`${option.label} ${option.detail ?? ''}`.toLowerCase().includes(words)) continue

        const row = document.createElement('button')

        row.type = 'button'
        row.className = 'pick-row'
        row.toggleAttribute('data-chosen', option.value === chosen)
        row.innerHTML = `<span class="pick-check">${option.value === chosen ? icon('check', 14) : ''}</span>${option.mark ?? ''}`
        row.append(Object.assign(document.createElement('span'), { className: 'pick-label', textContent: option.label }))

        if (option.detail) row.append(Object.assign(document.createElement('span'), { className: 'pick-detail', textContent: option.detail }))

        row.addEventListener('click', () => finish(option.value))
        rows.append(row)
      }

      if (rows.childElementCount === 0) rows.append(note('맞는 것이 없어요'))
    }

    pop.className = touch ? 'pick-drawer' : 'pick-pop'
    field.className = 'pick-search'
    field.type = 'search'
    field.placeholder = searchHint || '찾기…'
    field.addEventListener('input', draw)
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        finish(null)
      }

      if (event.key === 'Enter') rows.querySelector('.pick-row')?.click()
    })
    rows.className = 'pick-rows'

    if (touch) pop.append(Object.assign(document.createElement('div'), { className: 'pick-title', textContent: title }))

    if (options.length > 6 || searchHint !== '') pop.append(field)

    pop.append(rows)
    draw()

    if (touch) {
      composer.append(pop)
    } else {
      const box = anchor.getBoundingClientRect()

      document.body.append(pop)
      pop.style.left = `${box.left}px`
      pop.style.width = `${Math.max(box.width, 288)}px`
      pop.style.top = `${Math.min(box.bottom + 4, innerHeight - pop.offsetHeight - 8)}px`

      if (pop.contains(field)) field.focus()
    }

    setTimeout(() => addEventListener('pointerdown', outside, true))
  })
}

function openCreate(projectPath = null) {
  closeAddMenu()

  const projects = knownProjects()
  const mine = metaById.get(current)?.repo
  let project = projects.find((each) => keyOf(each.project) === keyOf(projectPath ?? mine?.project ?? '')) ?? projects.find((each) => each.git) ?? projects[0] ?? null
  let agent = agents.some((each) => each.id === 'claude' && each.installed) ? 'claude' : 'shell'
  let mode = 'smart'
  let base = null
  let defaultBase = ''
  let branches = []
  let picked = null
  let tasks = []
  let advancedOpen = false
  let more = false

  const dialog = document.createElement('div')
  const head = document.createElement('div')
  const body = document.createElement('div')
  const projectField = document.createElement('button')
  const pcField = document.createElement('button')
  const fromBlock = document.createElement('div')
  const baseChip = document.createElement('button')
  const tabsRow = document.createElement('div')
  const inputWrap = document.createElement('div')
  const nameInput = document.createElement('input')
  const results = document.createElement('div')
  const agentField = document.createElement('button')
  const advancedToggle = document.createElement('button')
  const advanced = document.createElement('div')
  const advName = document.createElement('input')
  const advBranch = document.createElement('input')
  const advNote = document.createElement('textarea')
  const foot = document.createElement('div')
  const moreSwitch = document.createElement('button')
  const submit = document.createElement('button')
  const error = document.createElement('div')

  const label = (text, optional = false, extra = null) => {
    const row = document.createElement('div')
    const words = document.createElement('span')

    row.className = 'cmp-label-row'
    words.className = 'cmp-label'
    words.textContent = text

    if (optional) words.append(Object.assign(document.createElement('span'), { className: 'cmp-optional', textContent: ' [선택]' }))

    row.append(words)

    if (extra !== null) row.append(extra)

    return row
  }
  const block = (...children) => {
    const box = document.createElement('div')

    box.className = 'cmp-block'
    box.append(...children)

    return box
  }
  const isGit = () => project?.git === true
  const title = () => (isGit() ? '워크트리 만들기' : '작업 공간 만들기')
  const agentLabel = () => (agent === 'shell' ? '빈 터미널' : agentName(agent))

  const drawProject = () => {
    projectField.innerHTML = `<span class="cmp-mark">${icon(project?.git ? 'folder' : 'folder-open', 16)}</span>`
    projectField.append(Object.assign(document.createElement('span'), { className: 'cmp-value', textContent: project?.name ?? '프로젝트 고르기' }))
    projectField.insertAdjacentHTML('beforeend', `<span class="cmp-chev">${icon('chevron-down', 14)}</span>`)

    if (project !== null) projectField.title = project.project
  }
  const drawBase = () => {
    baseChip.innerHTML = icon('git-branch', 12)
    baseChip.append(Object.assign(document.createElement('span'), { className: 'mono', textContent: base ?? (defaultBase ? `${defaultBase} (기본)` : '기본 브랜치') }))
    baseChip.insertAdjacentHTML('beforeend', icon('chevrons-up-down', 12))
  }
  const placeholder = () => (mode === 'github' ? 'GitHub PR과 이슈 찾기' : mode === 'branch' ? '브랜치 찾기' : mode === 'name' ? '작업 공간 이름' : '이름, #1234, 브랜치, GitHub URL 입력')
  const drawTabs = () => {
    tabsRow.replaceChildren()

    for (const [key, name, mark] of [['smart', '스마트', 'sparkles'], ['github', 'GitHub', 'github'], ['branch', '브랜치', 'git-branch'], ['name', '이름', 'case-sensitive']]) {
      const tab = document.createElement('button')

      tab.type = 'button'
      tab.className = 'cmp-tab'
      tab.setAttribute('aria-selected', String(mode === key))
      tab.innerHTML = icon(mark, 14)
      tab.append(name)
      tab.addEventListener('click', () => {
        mode = key
        picked = null
        drawTabs()
        drawSource()
        nameInput.focus()
      })
      tabsRow.append(tab)
    }
  }
  // What the typed words match: GitHub items or branches, as rows under the field.
  const drawResults = () => {
    const words = nameInput.value.trim().toLowerCase()
    const number = words.match(/^#?(\d+)$/)?.[1] ?? words.match(/\/(?:pull|issues)\/(\d+)/)?.[1]
    const rows = []

    if (picked === null && (mode === 'github' || (mode === 'smart' && number !== undefined))) {
      for (const task of tasks) {
        if (number !== undefined ? String(task.number) === number : words === '' || `${task.title} ${task.number}`.toLowerCase().includes(words)) rows.push({ kind: task.kind, task })
      }
    }

    if (picked === null && (mode === 'branch' || (mode === 'smart' && words.length > 1))) {
      for (const name of branches) {
        if (words === '' ? mode === 'branch' : name.toLowerCase().includes(words)) rows.push({ kind: 'branch', name })
      }
    }

    results.replaceChildren()
    results.hidden = rows.length === 0

    for (const row of rows.slice(0, 8)) {
      const button = document.createElement('button')

      button.type = 'button'
      button.className = 'cmp-result'

      if (row.kind === 'branch') {
        button.innerHTML = icon('git-branch', 14)
        button.append(Object.assign(document.createElement('span'), { className: 'mono', textContent: row.name }))
      } else {
        button.innerHTML = icon(row.kind === 'pr' ? 'git-pull-request' : 'circle-dot', 14)
        button.append(Object.assign(document.createElement('span'), { textContent: row.task.title }), Object.assign(document.createElement('span'), { className: 'cmp-result-num', textContent: `#${row.task.number}` }))
      }

      button.addEventListener('click', () => {
        picked = row
        drawSource()
        agentField.focus()
      })
      results.append(button)
    }
  }
  // The source field: the typed words, or the picked PR, issue or branch as a chip with ×.
  const drawSource = () => {
    inputWrap.replaceChildren()

    if (picked !== null) {
      const chip = document.createElement('div')
      const clear = document.createElement('button')

      chip.className = 'cmp-chip'
      chip.innerHTML = icon(picked.kind === 'branch' ? 'git-branch' : picked.kind === 'pr' ? 'git-pull-request' : 'circle-dot', 15)
      chip.append(Object.assign(document.createElement('span'), { className: 'cmp-chip-text', textContent: picked.kind === 'branch' ? picked.name : `${picked.task.title} #${picked.task.number}` }))
      clear.type = 'button'
      clear.className = 'icon-6'
      clear.innerHTML = icon('x', 14)
      clear.setAttribute('aria-label', '지우기')
      clear.addEventListener('click', () => {
        picked = null
        drawSource()
        nameInput.focus()
      })
      chip.append(clear)
      inputWrap.append(chip)
      results.hidden = true

      return
    }

    inputWrap.insertAdjacentHTML('beforeend', `<span class="cmp-input-icon">${icon(mode === 'name' ? 'case-sensitive' : 'search', 14)}</span>`)
    nameInput.placeholder = placeholder()
    inputWrap.append(nameInput)
    drawResults()
  }
  const drawAgent = () => {
    agentField.innerHTML = `<span class="cmp-mark">${agentMark(agent, 14)}</span>`
    agentField.append(Object.assign(document.createElement('span'), { className: 'cmp-value', textContent: agentLabel() }))
    agentField.insertAdjacentHTML('beforeend', `<span class="cmp-chev">${icon('chevrons-up-down', 14)}</span>`)
  }
  const drawFor = () => {
    head.querySelector('strong').textContent = title()
    fromBlock.hidden = !isGit()
    submit.querySelector('.submit-text').textContent = title()
    advBranch.closest('.cmp-block').hidden = !isGit()
  }
  // The project's branches and its open GitHub items, for the pickers and the smart field.
  const loadProject = async () => {
    branches = []
    tasks = []
    base = null
    defaultBase = ''
    drawBase()

    if (!isGit()) return

    const [found, work] = await Promise.all([getJson(`/git/branches?root=${encodeURIComponent(project.project)}`), getJson(`/tasks?root=${encodeURIComponent(project.project)}`)])

    branches = found?.branches ?? []
    defaultBase = found?.base ?? ''
    tasks = work?.tasks ?? []
    drawBase()
    drawResults()
  }

  // What to make: a branch name, the branch to start from, and what to tell the agent.
  const plan = () => {
    const typed = nameInput.value.trim()
    const named = advName.value.trim()
    const branchName = advBranch.value.trim()
    let branch = branchName || named || typed
    let from = base
    let prompt = advNote.value.trim()

    if (picked?.kind === 'branch') {
      branch = branchName || picked.name.replace(/^origin\//, '')
      from = picked.name.startsWith('origin/') ? picked.name : null
    } else if (picked?.kind === 'pr') {
      branch = branchName || picked.task.branch || `pr-${picked.task.number}`
      from = picked.task.branch ? `origin/${picked.task.branch}` : from
    } else if (picked?.kind === 'issue') {
      branch = branchName || `issue-${picked.task.number}-${branchFromPrompt(picked.task.title)}`
      prompt = prompt || `GitHub 이슈 #${picked.task.number}: ${picked.task.title}\n${picked.task.url ?? ''}`.trim()
    } else if (mode !== 'name' && branches.includes(typed)) {
      from = null
    }

    if (branch === '') branch = branchFromPrompt(prompt || 'task')

    return { branch: branch.replace(/\s+/g, '-'), base: from, prompt: prompt || null }
  }

  const create = () => {
    error.hidden = true

    if (project === null) {
      error.textContent = '프로젝트를 먼저 골라 주세요'
      error.hidden = false

      return
    }

    const size = fit.proposeDimensions() ?? { cols: 100, rows: 30 }

    if (!isGit()) {
      send({ t: 'new', kind: agent, cols: size.cols, rows: size.rows, cwd: project.project })
    } else {
      const made = plan()

      send({ t: 'worktree', kinds: [agent], project: project.project, branch: made.branch, base: made.base, prompt: made.prompt, cols: size.cols, rows: size.rows })
      notice(`${made.branch} 워크트리를 만들어요`)
      setTimeout(() => void refreshProjects(), 3000)
    }

    if (more) {
      nameInput.value = ''
      advName.value = ''
      advBranch.value = ''
      advNote.value = ''
      picked = null
      drawSource()
      nameInput.focus()

      return
    }

    closeCreate()
  }

  dialog.className = touch ? 'drawer composer' : 'dialog composer'
  dialog.setAttribute('role', 'dialog')
  head.className = 'dialog-head'
  head.innerHTML = `${touch ? '<div class="sheet-handle"></div>' : ''}<strong></strong>`

  if (!touch) {
    const close = document.createElement('button')

    close.type = 'button'
    close.className = 'dialog-close'
    close.innerHTML = icon('x', 16)
    close.setAttribute('aria-label', '닫기')
    close.addEventListener('click', closeCreate)
    head.append(close)
  }

  body.className = 'cmp-body'

  const addProjectButton = document.createElement('button')

  addProjectButton.type = 'button'
  addProjectButton.className = 'icon-5'
  addProjectButton.innerHTML = icon('folder-plus', 12)
  addProjectButton.title = '프로젝트 추가'
  addProjectButton.addEventListener('click', () => {
    closeCreate()

    const box = addProjectButton.getBoundingClientRect()

    openProjectAdd({ mouse: !touch, x: box.left, y: box.bottom + 4 })
  })
  projectField.type = 'button'
  projectField.className = 'cmp-field'
  projectField.addEventListener('click', async () => {
    const value = await pickFrom(projectField, '프로젝트', projects.map((each) => ({ value: each.project, label: each.name, detail: each.project, mark: icon(each.git ? 'folder' : 'folder-open', 15) })), project?.project ?? null, projects.length > 6 ? '프로젝트 찾기…' : '')

    if (value === null) return

    project = projects.find((each) => each.project === value) ?? project
    picked = null
    drawProject()
    drawFor()
    drawSource()
    void loadProject()
  })
  body.append(block(label('프로젝트', false, addProjectButton), projectField))

  // "Run on": the other PCs run their own sessions, so picking one opens its composer there.
  if (machines.length > 1) {
    const here = machines.find((machine) => machine.here)

    pcField.type = 'button'
    pcField.className = 'cmp-field'
    pcField.innerHTML = `<span class="cmp-mark">${icon('monitor', 15)}</span>`
    pcField.append(Object.assign(document.createElement('span'), { className: 'cmp-value', textContent: here?.name ?? '이 PC' }), Object.assign(document.createElement('span'), { className: 'cmp-detail', textContent: '이 PC' }))
    pcField.insertAdjacentHTML('beforeend', `<span class="cmp-chev">${icon('chevron-down', 14)}</span>`)
    pcField.addEventListener('click', async () => {
      const options = []

      for (const machine of [...machines].sort(machineOrder)) {
        if (machine.here || machine.online) options.push({ value: machine.url, label: machine.name, detail: machine.here ? '이 PC' : countLine({ sessions: machine.sessions, busy: machine.busy }), mark: icon(machine.here ? 'monitor' : 'server', 15) })
      }

      const value = await pickFrom(pcField, '실행할 PC', options, here?.url ?? null)

      if (value !== null && value !== here?.url) location.href = `${value}#create`
    })
    body.append(block(label('실행할 PC'), pcField))
  }

  baseChip.type = 'button'
  baseChip.className = 'cmp-base'
  baseChip.title = '시작할 브랜치'
  baseChip.addEventListener('click', async () => {
    const options = [{ value: '', label: defaultBase ? `${defaultBase} (기본)` : '프로젝트 기본' }, ...branches.map((name) => ({ value: name, label: name, mark: icon('git-branch', 14) }))]
    const value = await pickFrom(baseChip, '시작할 브랜치', options, base ?? '', '브랜치 찾기…')

    if (value === null) return

    base = value === '' ? null : value
    drawBase()
  })
  tabsRow.className = 'cmp-tabs'
  inputWrap.className = 'cmp-input'
  nameInput.className = 'cmp-text'
  nameInput.type = 'text'
  nameInput.autocomplete = 'off'
  nameInput.addEventListener('input', drawResults)
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !(event.ctrlKey || event.metaKey)) {
      event.preventDefault()

      const first = results.hidden ? null : results.querySelector('.cmp-result')

      if (first !== null) first.click()
      else agentField.focus()
    }
  })
  results.className = 'cmp-results'
  results.hidden = true
  fromBlock.className = 'cmp-block'
  fromBlock.append(label('이름 또는 시작점', true, baseChip), tabsRow, inputWrap, results)
  body.append(fromBlock)

  const settings = document.createElement('span')

  settings.className = 'cmp-hint-icon'
  settings.innerHTML = icon('settings-2', 12)
  settings.title = '이 PC에 설치된 에이전트만 고를 수 있어요'
  agentField.type = 'button'
  agentField.className = 'cmp-field'
  agentField.addEventListener('click', async () => {
    const options = [{ value: 'shell', label: '빈 터미널', mark: agentMark('shell', 14) }]

    for (const each of agents) {
      if (each.id !== 'shell' && each.installed) options.push({ value: each.id, label: each.label, mark: agentMark(each.id, 14) })
    }

    const value = await pickFrom(agentField, '에이전트', options, agent, '에이전트 찾기…')

    if (value === null) return

    agent = value
    drawAgent()
  })
  agentField.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !(event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      create()
    }
  })
  body.append(block(label('에이전트', true, settings), agentField))

  advancedToggle.type = 'button'
  advancedToggle.className = 'cmp-advanced'
  advancedToggle.innerHTML = `고급${icon('chevron-down', 14)}`
  advancedToggle.addEventListener('click', () => {
    advancedOpen = !advancedOpen
    advanced.hidden = !advancedOpen
    advancedToggle.toggleAttribute('data-open', advancedOpen)
  })
  advanced.className = 'cmp-adv'
  advanced.hidden = true
  advName.className = 'cmp-input-plain'
  advName.placeholder = '작업 공간 이름'
  advBranch.className = 'cmp-input-plain mono'
  advBranch.placeholder = 'feature/my-branch'
  advNote.className = 'cmp-input-plain'
  advNote.rows = 2
  advNote.placeholder = '에이전트에게 처음 보낼 말 (선택)'
  advanced.append(block(label('이름'), advName), block(label('브랜치 이름'), advBranch), block(label('메모'), advNote))
  body.append(advancedToggle, advanced)

  error.className = 'cmp-error'
  error.hidden = true
  foot.className = 'cmp-foot'
  moreSwitch.type = 'button'
  moreSwitch.className = 'cmp-switch'
  moreSwitch.setAttribute('role', 'switch')
  moreSwitch.setAttribute('aria-checked', 'false')
  moreSwitch.innerHTML = '<span class="track"><span class="thumb"></span></span>계속 만들기'
  moreSwitch.addEventListener('click', () => {
    more = !more
    moreSwitch.setAttribute('aria-checked', String(more))
  })
  submit.type = 'button'
  submit.className = 'cmp-submit'
  submit.innerHTML = `<span class="submit-text"></span>${touch ? '' : `<span class="kbd">Ctrl${icon('corner-down-left', 12)}</span>`}`
  submit.addEventListener('click', create)
  foot.append(moreSwitch, submit)
  dialog.append(head, body, error, foot)
  dialog.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      create()
    }

    if (event.key === 'Escape') {
      event.stopPropagation()
      closeCreate()
    }
  })

  if (projects.length === 0) {
    body.replaceChildren(note('먼저 프로젝트 폴더를 추가하거나, 프로젝트 폴더에서 세션을 열어 주세요'))
    submit.disabled = true
  }

  drawProject()
  drawTabs()
  drawSource()
  drawAgent()
  drawFor()
  composer.replaceChildren(dialog)
  composer.hidden = false

  if (!touch) nameInput.focus()

  void loadProject()
  void refreshAgents().then(drawAgent)
}

// The old name, still used by the list's buttons.
const openWorktreeSheet = (branchName = '', projectPath = null) => openCreate(projectPath)

// ---- Search (Ctrl+J): worktrees, sessions and file names at once; Enter opens the
// first; "내용에서 찾기" searches inside the files.
const palette = document.createElement('div')

palette.className = 'palette'
palette.hidden = true
palette.innerHTML = '<div class="palette-box"><input type="search" placeholder="워크트리, 세션, 파일 찾기" autocomplete="off"><div class="palette-list"></div></div>'
document.body.append(palette)

const paletteInput = palette.querySelector('input')
const paletteList = palette.querySelector('.palette-list')
let paletteTimer = 0

function openPalette() {
  palette.hidden = false
  paletteInput.value = ''
  void fillPalette()
  paletteInput.focus()
}

function closePalette() {
  palette.hidden = true
}

function paletteRow(icon, title, sub, run) {
  const row = document.createElement('button')
  const words = document.createElement('span')
  const small = document.createElement('small')

  row.type = 'button'
  row.className = 'palette-row'
  words.textContent = title
  small.textContent = sub
  row.append(icon, words, small)
  row.addEventListener('click', () => {
    closePalette()
    run()
  })

  return row
}

async function fillPalette() {
  const words = paletteInput.value.trim().toLowerCase()
  const { projects } = buildTree()
  const rows = []
  const matches = (text) => words === '' || text.toLowerCase().includes(words)

  for (const tree of projects.flatMap((project) => project.worktrees)) {
    if (matches(`${treeTitle(tree)} ${tree.branch} ${tree.project.name}`)) {
      const icon = document.createElement('span')

      icon.innerHTML = BRANCH_ICON
      rows.push(paletteRow(icon, treeTitle(tree), `${tree.project.name} · ${tree.branch}`, () => openTree(tree, document.body)))
    }
  }

  for (const session of sessions) {
    if (matches(`${displayName(session)} ${session.kind}`)) rows.push(paletteRow(agentIcon(session.kind, 14), plainName(session), agentName(session.kind), () => select(session.id)))
  }

  const root = panelRoot()

  if (words !== '' && root !== null) {
    const found = await getJson(`/files?root=${encodeURIComponent(root)}&q=${encodeURIComponent(words)}`)

    for (const path of found?.files ?? []) {
      const icon = document.createElement('span')

      icon.innerHTML = FILE_ICON
      rows.push(paletteRow(icon, docName(path), path, () => openFile(`${root}\\${path.replaceAll('/', '\\')}`)))
    }

    const icon = document.createElement('span')

    icon.innerHTML = UI.search
    rows.push(paletteRow(icon, `"${paletteInput.value.trim()}" 내용에서 찾기`, docName(root), () => {
      setFilesOpen(true)
      setPanel('search')
      $('panelQuery').value = paletteInput.value.trim()
      $('panelSearch').requestSubmit()
    }))
  }

  paletteList.replaceChildren(...rows.slice(0, 60))

  if (rows.length === 0) paletteList.append(note('맞는 것이 없어요'))
}

paletteInput.addEventListener('input', () => {
  clearTimeout(paletteTimer)
  paletteTimer = setTimeout(() => void fillPalette(), 150)
})
paletteInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') paletteList.querySelector('.palette-row')?.click()
  if (event.key === 'Escape') closePalette()
})
palette.addEventListener('click', (event) => {
  if (event.target === palette) closePalette()
})

addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'n') return

  event.preventDefault()
  event.stopPropagation()
  openCreate()
}, { capture: true })

addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'j') return

  event.preventDefault()
  event.stopPropagation()

  if (palette.hidden) openPalette()
  else closePalette()
}, { capture: true })

// ---- Another folder: walk the PC's folders and open an agent there.
function openFolderSheet(start, addProject = false) {
  let folder = start ?? null
  let kind = agents.find((agent) => agent.id === 'claude' && agent.installed) ? 'claude' : 'shell'

  sheetTitle.textContent = addProject ? '프로젝트 폴더 추가' : '폴더에서 열기'

  const draw = async () => {
    sheetBody.replaceChildren()

    const head = document.createElement('div')
    const up = iconChip(UI.up, '위 폴더', () => {
      if (folder === null) return

      const parent = folder.replace(/[\\/][^\\/]+[\\/]?$/, '')

      folder = parent === '' || parent === folder ? null : /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
      void draw()
    })
    const here = document.createElement('p')
    const agentChips = document.createElement('div')
    const rows = document.createElement('div')

    head.className = 'chips'
    here.className = 'preview mono-path'
    here.textContent = folder ?? '드라이브'
    agentChips.className = 'chips'
    agentChips.append(...agents.filter((agent) => agent.installed).map((agent) => chip(agent.label, () => {
      kind = agent.id
      void draw()
    }, { 'data-on': agent.id === kind })))
    head.append(up, chip(addProject ? '이 프로젝트 추가' : '여기서 열기', async () => {
      sheet.hidden = true

      if (!addProject) {
        openSession(kind, folder)

        return
      }

      const reply = await fetch('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }) }).then((r) => r.json()).catch(() => null)

      notice(reply?.ok ? `프로젝트를 추가했어요: ${reply.project}` : 'git 저장소가 아니에요')
      void refreshProjects()
    }, { 'data-primary': true, disabled: folder === null }))

    if (addProject) agentChips.hidden = true
    rows.className = 'sheet-list'
    sheetBody.append(here, agentChips, head, rows)

    const entries = folder === null ? ['C:\\', 'D:\\', 'E:\\'].map((path) => ({ name: path, path, dir: true })) : ((await listFolder(folder)) ?? []).filter((entry) => entry.dir)

    for (const entry of entries) {
      const row = document.createElement('button')

      row.type = 'button'
      row.className = 'sheet-row'
      row.innerHTML = FOLDER_ICON
      row.append(entry.name)
      row.toggleAttribute('data-dim', entry.name.startsWith('.'))
      row.addEventListener('click', () => {
        folder = entry.path
        void draw()
      })
      rows.append(row)
    }
  }

  void draw()
  sheet.hidden = false
}

window.choiterm = {
  back,
  // For checks from outside (and the phone app): show a screen, start a new workspace.
  view: setView,
  create: openCreate,
  open(id) {
    if (sessions.some((session) => session.id === id)) select(id)
    else pendingOpen = id
  },
  addPaths(paths) {
    // The app uploads keyboard images itself, without a session; this files them under this one.
    for (const path of paths) postJson('/gallery/add', { path, session: current }).catch(() => {})

    insertPaths(paths, true)
    notice(paths.length === 1 ? `보냈어요: ${paths[0]}` : `${paths.length}개 보냈어요`)
  },
  notice(message) {
    notice(message)
  },
}

new ResizeObserver(() => {
  // Hidden behind a document or the home screen there is nothing to measure.
  if (stage.clientWidth === 0 || stage.clientHeight === 0) return

  // A phone on screen is the one in use; right after coming back from the home screen it does not
  // count as focused yet, and keeping the size from while the keyboard was up left the bottom of the
  // screen empty. A PC window claims only while in front.
  if (document.visibilityState === 'visible' && (touch || document.hasFocus())) claim()
  else applySize(serverSize.cols || term.cols, serverSize.rows || term.rows)
}).observe(stage)

// Files go to the PC's Downloads\ChoiTerm folder; their paths then land in the prompt so Claude
// can be asked about them. On the phone the paths wait in the input bar, on the PC they are typed
// straight into the terminal.
const toast = $('toast')
const attach = $('attach')
const picker = $('files')
let toastTimer = 0

function notice(message) {
  toast.textContent = message
  toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.hidden = true
  }, 3000)
}

// A pasted screenshot often has no name, and Claude needs the extension to read it as an image.
function uploadName(file) {
  if (file.name !== '') return file.name

  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin'

  return `clipboard.${ext}`
}

async function upload(file) {
  const name = uploadName(file)
  const session = current === null ? '' : `&session=${encodeURIComponent(current)}`
  const response = await fetch(`/upload?name=${encodeURIComponent(name)}${session}`, { method: 'POST', body: file })

  if (!response.ok) throw new Error(`${name}: ${response.status}`)

  const reply = await response.json()

  return reply.path
}

function insertPaths(paths, toPrompt) {
  const joined = `${paths.join(' ')} `

  if (toPrompt) {
    text.value = text.value === '' || text.value.endsWith(' ') ? `${text.value}${joined}` : `${text.value} ${joined}`
    sync()
    grow()
    text.focus()
  } else {
    input(joined)
    term.focus()
  }
}

async function sendFiles(list, toPrompt) {
  const chosen = [...list]

  if (chosen.length === 0) return

  attach.disabled = true
  notice(`파일 ${chosen.length}개 보내는 중`)

  try {
    const paths = []

    for (const file of chosen) paths.push(await upload(file))

    insertPaths(paths, toPrompt)
    notice(chosen.length === 1 ? `보냈어요: ${paths[0]}` : `${chosen.length}개 보냈어요`)
  } catch (error) {
    notice(`보내지 못했어요 (${error.message})`)
  } finally {
    attach.disabled = false
  }
}

function pastedImages(event) {
  const images = []

  for (const file of event.clipboardData?.files ?? []) {
    if (file.type.startsWith('image/')) images.push(file)
  }

  return images
}

// A pasted image goes up like an attached file: into the input bar on the phone, typed into the
// terminal on the PC. Plain text pastes are left alone.
document.addEventListener('paste', (event) => {
  const images = pastedImages(event)

  if (images.length === 0) return

  event.preventDefault()
  event.stopPropagation()
  void sendFiles(images, event.target === text)
}, { capture: true })

attach.addEventListener('click', () => picker.click())

picker.addEventListener('change', () => {
  void sendFiles(picker.files ?? [], true)
  picker.value = ''
})

stage.addEventListener('dragover', (event) => {
  event.preventDefault()
  stage.dataset.drop = ''
})

stage.addEventListener('dragleave', () => {
  delete stage.dataset.drop
})

stage.addEventListener('drop', (event) => {
  event.preventDefault()
  delete stage.dataset.drop

  // A file dragged from the file panel: its path, quoted when it has spaces, typed in.
  const path = event.dataTransfer?.getData('application/x-choiterm-path') ?? ''

  if (path !== '') {
    insertPaths([/\s/.test(path) ? `"${path}"` : path], touch)

    return
  }

  void sendFiles(event.dataTransfer?.files ?? [], touch)
})

window.addEventListener('focus', claim)

// The phone app shrinks the page for the keyboard. When it grows back by a keyboard's height the
// keyboard was put away (back gesture, its own button), so the input bar lets go too; still focused,
// it would call the keyboard back up on the next touch.
const KEYBOARD_PX = 120
let pageHeight = innerHeight

addEventListener('resize', () => {
  if (touch && innerHeight - pageHeight > KEYBOARD_PX && document.activeElement === text) text.blur()

  pageHeight = innerHeight
})

// The phone app keeps one page open for days, so page fixes would never arrive. Coming back to the
// page checks whether its files changed and reloads (sessions live on the server); with a draft in
// the input bar it only says so.
const PAGE_FILES = ['/', '/app.js', '/style.css']

async function pageVersion() {
  const texts = await Promise.all(PAGE_FILES.map((path) => fetch(path, { cache: 'no-store' }).then((response) => response.text())))

  return texts.join('\n')
}

const loadedVersion = pageVersion().catch(() => null)

async function checkForUpdate() {
  const loaded = await loadedVersion
  const now = await pageVersion().catch(() => null)

  if (loaded === null || now === null || now === loaded) return

  // The input bar's draft is kept per session and comes back after the reload.
  keepDraft()
  location.reload()
}

// Back on screen: claim the size now and once more when the app has put its insets back (the
// keyboard's space goes away a moment after the page shows again).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return

  claim()
  setTimeout(claim, SETTLE_MS)
  void checkForUpdate()
})

// The first screen, once everything it draws from exists. Another PC's composer sent here (#create)
// opens this PC's.
if (startHash.has('create')) setTimeout(() => openCreate(), 0)

setView(!touch ? 'session' : startHash.has('open') ? 'session' : startHash.has('host') ? 'home' : 'hosts')
connect()
