// Writes web/icons.js: the line icons from lucide-static and the agents' marks from
// @lobehub/icons-static-svg (both dev dependencies). Run `npm run icons` after changing NAMES or
// AGENTS; the page loads only the generated file.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lucide = join(root, 'node_modules', 'lucide-static', 'icons')
const lobe = join(root, 'node_modules', '@lobehub', 'icons-static-svg', 'icons')

const NAMES = [
  'activity', 'archive', 'archive-restore', 'arrow-big-up', 'arrow-down', 'arrow-down-to-line', 'arrow-left', 'arrow-right', 'arrow-up',
  'bell', 'bell-off', 'bold', 'book-open', 'calendar-clock', 'case-sensitive', 'check', 'chevron-down', 'chevron-left', 'chevron-right',
  'chevron-up', 'chevrons-up-down', 'circle-check', 'circle-dashed', 'circle-dot', 'circle-help', 'circle-user', 'circle-x', 'clipboard-paste',
  'code', 'columns-2', 'copy', 'corner-down-left', 'crosshair', 'delete', 'ellipsis', 'ellipsis-vertical', 'external-link', 'eye', 'file',
  'file-diff', 'file-plus', 'file-text', 'files', 'folder', 'folder-open', 'folder-plus', 'folder-tree', 'git-branch',
  'git-compare-arrows', 'git-merge', 'git-pull-request', 'git-pull-request-closed', 'git-pull-request-draft', 'github', 'globe',
  'heading-1', 'heading-2', 'heading-3', 'history', 'house', 'image', 'images', 'italic', 'keyboard', 'layout-grid', 'list', 'list-checks',
  'list-ordered', 'list-todo', 'loader-circle', 'message-circle-question', 'message-square-plus', 'monitor', 'moon', 'mouse-pointer-click',
  'panel-left', 'panel-right', 'paperclip', 'pencil', 'pin', 'pin-off', 'play', 'plus', 'qr-code', 'quote', 'refresh-cw', 'rotate-ccw', 'save',
  'search', 'send', 'server', 'server-off', 'settings', 'settings-2', 'sliders-horizontal', 'smartphone', 'sparkles', 'square-check',
  'square-chevron-right', 'square-split-horizontal', 'square-terminal', 'sticky-note', 'strikethrough', 'tag', 'terminal', 'trash-2',
  'triangle-alert', 'upload', 'x', 'zap',
]

// ChoiTerm's agent ids and the mark each one wears.
const AGENTS = { claude: 'claude-color', codex: 'openai', grok: 'grok', gemini: 'gemini-color', opencode: 'opencode', cursor: 'cursor', copilot: 'githubcopilot', qwen: 'qwen-color' }

// A plain shell: a terminal tile drawn for ChoiTerm.
const SHELL = '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" aria-hidden="true"><rect x="2" y="3.5" width="20" height="17" rx="3" fill="#2B5797"/><path d="M6.5 8.5l4 3.5-4 3.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.5 15.5h5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>'

const inner = (svg) => svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>')).replace(/\s*\n\s*/g, '').replace(/ \/>/g, '/>')

const lines = {}

for (const name of NAMES) lines[name] = inner(readFileSync(join(lucide, `${name}.svg`), 'utf8'))

const marks = { shell: SHELL }

for (const [id, file] of Object.entries(AGENTS)) {
  const svg = readFileSync(join(lobe, `${file}.svg`), 'utf8')
  const fill = svg.match(/<svg[^>]*\sfill="([^"]+)"/)?.[1]
  const body = inner(svg).replace(/<title>[^<]*<\/title>/, '')

  marks[id] = `<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" aria-hidden="true"${fill ? ` fill="${fill}" fill-rule="evenodd"` : ''}>${body}</svg>`
}

const out = `// Icons: lucide (ISC) for lines, lobe-icons (MIT) for the agents' marks. Written by
// scripts/make-icons.mjs; edit the lists there and run \`npm run icons\`, not the paths here.
const LUCIDE = ${JSON.stringify(lines, null, 2)}

// One lucide icon as SVG markup, in the current text colour.
export function icon(name, size = 16, stroke = 2) {
  return \`<svg class="lucide" viewBox="0 0 24 24" width="\${size}" height="\${size}" fill="none" stroke="currentColor" stroke-width="\${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${LUCIDE[name] ?? ''}</svg>\`
}

const AGENT_MARKS = ${JSON.stringify(marks, null, 2)}

// An agent's mark; an unknown agent gets its first letter.
export function agentMark(kind, size = 14) {
  if (AGENT_MARKS[kind] !== undefined) return AGENT_MARKS[kind].replaceAll('SIZE', String(size))

  return \`<svg viewBox="0 0 14 14" width="\${size}" height="\${size}" aria-hidden="true"><rect width="14" height="14" rx="3" fill="currentColor" fill-opacity=".2"/><text x="7" y="10" text-anchor="middle" font-size="8.5" font-weight="700" fill="currentColor">\${String(kind).slice(0, 1).toUpperCase()}</text></svg>\`
}

export function agentIcon(kind, size = 14) {
  const span = document.createElement('span')

  span.className = 'agent'
  span.innerHTML = agentMark(kind, size)

  return span
}

export const FOLDER_ICON = icon('folder', 14)
export const FILE_ICON = icon('file', 14)
export const GLOBE_ICON = icon('globe', 13)
export const CHEVRON_ICON = icon('chevron-right', 12)
export const PLUS_ICON = icon('plus', 14)
export const BRANCH_ICON = icon('git-branch', 11)
export const REFRESH_ICON = icon('refresh-cw', 14)
export const OPEN_ICON = icon('external-link', 14)
export const CLOSE_ICON = icon('x', 13)

// Short names for the page's buttons and keys.
export const UI = {
  up: icon('arrow-up', 16),
  down: icon('arrow-down', 16),
  left: icon('arrow-left', 16),
  right: icon('arrow-right', 16),
  backspace: icon('delete', 17),
  enter: icon('corner-down-left', 16),
  shift: icon('arrow-big-up', 15),
  paste: icon('clipboard-paste', 16),
  close: icon('x', 13),
  chevronDown: icon('chevron-down', 13),
  chevronUp: icon('chevron-up', 13),
  chevronLeft: icon('chevron-left', 20),
  chevronRight: icon('chevron-right', 20),
  search: icon('search', 16),
  changes: icon('git-compare-arrows', 15),
  tasks: icon('list-todo', 15),
  files: icon('folder', 15),
  edit: icon('pencil', 15),
  save: icon('save', 15),
  aim: icon('crosshair', 15),
  send: icon('send', 15),
  note: icon('sticky-note', 15),
  comment: icon('message-square-plus', 15),
}
`

writeFileSync(join(root, 'web', 'icons.js'), out)
console.log(`web/icons.js: ${NAMES.length} line icons, ${Object.keys(marks).length} agent marks`)
