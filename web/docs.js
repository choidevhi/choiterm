// What a document tab shows: a file from the PC (code with colours and line numbers, markdown as a
// page, images, PDFs, video), editable when it is text; a git diff, where lines can be commented
// and the comments sent to an agent; or a web page a session serves, where elements can be pointed
// at and sent to an agent the same way.
import { OPEN_ICON, REFRESH_ICON, UI, icon } from '/icons.js'

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i
const VIDEO = /\.(mp4|webm|mp3|wav)$/i
const PDF = /\.pdf$/i
const MARKDOWN = /\.(md|markdown|mdx)$/i
// Files bigger than this are shown without colours: highlighting them would freeze the page.
const HIGHLIGHT_LIMIT = 300_000
const AUTOSAVE_MS = 1200

const LANGUAGES = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  py: 'python', rs: 'rust', go: 'go', kt: 'kotlin', kts: 'kotlin', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  sh: 'bash', bash: 'bash', ps1: 'powershell', psm1: 'powershell', bat: 'dos', cmd: 'dos',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql', rb: 'ruby', php: 'php', swift: 'swift', lua: 'lua', gd: 'python',
  dockerfile: 'dockerfile', makefile: 'makefile', diff: 'diff', patch: 'diff',
}

let libraries = null

// marked and highlight.js load the first time a file is opened.
function load() {
  libraries ??= Promise.all([import('/vendor/marked.mjs'), import('/vendor/highlight.mjs')]).then(([marked, hljs]) => ({ marked: marked.marked, hljs: hljs.default }))

  return libraries
}

const el = (tag, className, text) => {
  const node = document.createElement(tag)

  if (className) node.className = className
  if (text !== undefined) node.textContent = text

  return node
}

function iconButton(icon, label, onClick) {
  const button = el('button', 'icon')

  button.type = 'button'
  button.innerHTML = icon
  button.title = label
  button.setAttribute('aria-label', label)
  button.addEventListener('click', onClick)

  return button
}

export const rawUrl = (path) => `/fs/raw?path=${encodeURIComponent(path)}`

export function fileName(path) {
  return path.split(/[\\/]/).at(-1) ?? path
}

function languageOf(path) {
  const name = fileName(path).toLowerCase()
  const ext = name.includes('.') ? name.split('.').at(-1) : name

  return LANGUAGES[ext] ?? null
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

// Highlighted HTML split into lines, each line's open spans closed and reopened, so every line
// can be its own row with a number.
function splitLines(html) {
  const lines = []
  let open = []
  let line = ''

  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === '\n') {
      lines.push(line + '</span>'.repeat(open.length))
      line = open.join('')
    } else if (part.startsWith('<span')) {
      open.push(part)
      line += part
    } else if (part === '</span>') {
      open = open.slice(0, -1)
      line += part
    } else {
      line += part
    }
  }

  lines.push(line)

  return lines
}

function codeView(text, html) {
  const pre = el('pre', 'code')
  const lines = html === null ? text.split('\n').map(escapeHtml) : splitLines(html)

  pre.innerHTML = lines.map((line) => `<div class="ln"><code>${line === '' ? ' ' : line}</code></div>`).join('')

  return pre
}

async function highlighted(text, path) {
  if (text.length > HIGHLIGHT_LIMIT) return null

  const { hljs } = await load()
  const language = languageOf(path)

  try {
    return language !== null && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value
  } catch {
    return null
  }
}

// Markdown as a page. Raw HTML in it is shown as text, so a file can never run script here.
async function markdownView(text) {
  const { marked, hljs } = await load()
  const body = el('article', 'markdown')
  const renderer = new marked.Renderer()

  renderer.html = (token) => escapeHtml(typeof token === 'string' ? token : token.text)
  renderer.code = (token) => {
    const language = token.lang && hljs.getLanguage(token.lang) ? token.lang : null
    const html = language === null ? escapeHtml(token.text) : hljs.highlight(token.text, { language }).value

    return `<pre><code>${html}</code></pre>`
  }

  body.innerHTML = marked.parse(text, { renderer, gfm: true })

  for (const link of body.querySelectorAll('a[href]')) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }

  return body
}

function head(path, extra = []) {
  const bar = el('div', 'doc-head')
  const where = el('span', 'path', path)

  where.title = path
  bar.append(where, ...extra)

  return bar
}

async function readFile(path) {
  try {
    return (await (await fetch(`/fs/read?path=${encodeURIComponent(path)}`, { cache: 'no-store' })).json()).file ?? null
  } catch {
    return null
  }
}

// Markdown shortcuts in the editor: each wraps the selection or starts the line.
// [lucide icon, what it does, its name].
const MD_TOOLS = [
  ['heading-1', (line) => `# ${line.replace(/^#+\s*/, '')}`, '제목 1'],
  ['heading-2', (line) => `## ${line.replace(/^#+\s*/, '')}`, '제목 2'],
  ['heading-3', (line) => `### ${line.replace(/^#+\s*/, '')}`, '제목 3'],
  ['bold', '**', '굵게'],
  ['italic', '*', '기울임'],
  ['strikethrough', '~~', '취소선'],
  ['list', (line) => `- ${line}`, '목록'],
  ['list-ordered', (line) => `1. ${line}`, '번호 목록'],
  ['square-check', (line) => `- [ ] ${line}`, '할 일'],
  ['quote', (line) => `> ${line}`, '인용'],
  ['code', '`', '코드'],
]

function applyTool(area, tool) {
  const { selectionStart: start, selectionEnd: end, value } = area

  if (typeof tool === 'string') {
    area.setRangeText(`${tool}${value.slice(start, end)}${tool}`, start, end, 'end')
  } else {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const lineEnd = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end)

    area.setRangeText(tool(value.slice(lineStart, lineEnd)), lineStart, lineEnd, 'end')
  }

  area.dispatchEvent(new Event('input'))
  area.focus()
}

// A text file being edited: saved a moment after each change (and on Ctrl+S), never over a newer
// version on disk (an agent may have changed it); markdown shows its page beside the text.
async function editor(box, path, file, onDone) {
  const area = el('textarea', 'editor')
  const state = el('span', 'save-state', '자동 저장')
  const done = el('button', 'text-button', '보기')
  const markdown = MARKDOWN.test(path)
  const page = el('div', 'editor-page')
  let modified = file.modified
  let timer = 0
  let saving = Promise.resolve()

  area.value = file.text
  area.spellcheck = false

  const save = () => {
    clearTimeout(timer)
    saving = saving.then(async () => {
      state.textContent = '저장 중…'

      const reply = await fetch('/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, text: area.value, expected: modified }) }).catch(() => null)
      const body = reply === null ? null : await reply.json().catch(() => null)

      if (reply?.ok && body?.saved?.modified !== undefined) {
        modified = body.saved.modified
        state.textContent = '저장됨'
        state.removeAttribute('data-bad')
      } else if (reply?.status === 409) {
        state.textContent = '디스크에서 바뀌었어요 · 저장 안 함'
        state.dataset.bad = ''
      } else {
        state.textContent = '저장하지 못했어요'
        state.dataset.bad = ''
      }
    })

    return saving
  }

  const renderPage = async () => {
    if (markdown) page.replaceChildren(await markdownView(area.value))
  }

  area.addEventListener('input', () => {
    state.textContent = '바뀜'
    clearTimeout(timer)
    timer = setTimeout(save, AUTOSAVE_MS)
    void renderPage()
  })
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }

    // Tab indents instead of leaving the box.
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end')
      area.dispatchEvent(new Event('input'))
    }
  })
  done.type = 'button'
  done.addEventListener('click', async () => {
    if (state.textContent === '바뀜') await save()
    else await saving

    onDone()
  })

  const tools = el('div', 'md-tools')

  if (markdown) {
    for (const [name, tool, label] of MD_TOOLS) {
      const button = el('button', '', '')

      button.type = 'button'
      button.innerHTML = icon(name, 14)
      button.title = label
      button.setAttribute('aria-label', label)
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => applyTool(area, tool))
      tools.append(button)
    }
  }

  const body = el('div', markdown ? 'doc-body editor-split' : 'doc-body editor-body')

  body.append(area)

  if (markdown) body.append(page)

  box.replaceChildren(head(path, [state, done]), ...(markdown ? [tools] : []), body)
  await renderPage()
  area.focus()
}

// A code file to edit in place: the coloured text (highlight.js) under a see-through text box of
// the same size and font, so typing looks like editing the coloured code; saved a moment after
// each change and on Ctrl+S, never over a newer version on disk.
async function codeEditor(box, path, file, line) {
  const state = el('span', 'save-state', '자동 저장')
  const body = el('div', 'doc-body code-edit')
  const stack = el('div', 'code-stack')
  const area = el('textarea', 'code-area')
  let modified = file.modified
  let timer = 0
  let paintTimer = 0
  let saving = Promise.resolve()
  let shown = el('pre', 'code')

  const paint = async () => {
    const fresh = codeView(area.value, await highlighted(area.value, path))

    fresh.classList.add('code-under')
    shown.replaceWith(fresh)
    shown = fresh
  }

  const save = () => {
    clearTimeout(timer)
    saving = saving.then(async () => {
      state.textContent = '저장 중…'

      const reply = await fetch('/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, text: area.value, expected: modified }) }).catch(() => null)
      const answer = reply === null ? null : await reply.json().catch(() => null)

      if (reply?.ok && answer?.saved?.modified !== undefined) {
        modified = answer.saved.modified
        state.textContent = '저장됨'
        state.removeAttribute('data-bad')
      } else if (reply?.status === 409) {
        state.textContent = '디스크에서 바뀌었어요 · 저장 안 함'
        state.dataset.bad = ''
      } else {
        state.textContent = '저장하지 못했어요'
        state.dataset.bad = ''
      }
    })

    return saving
  }

  area.value = file.text
  area.spellcheck = false
  area.wrap = 'off'
  area.setAttribute('autocapitalize', 'off')
  area.addEventListener('input', () => {
    state.textContent = '바뀜'
    clearTimeout(timer)
    timer = setTimeout(save, AUTOSAVE_MS)
    clearTimeout(paintTimer)
    paintTimer = setTimeout(() => void paint(), 120)
  })
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }

    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end')
      area.dispatchEvent(new Event('input'))
    }
  })
  shown.classList.add('code-under')
  stack.append(shown, area)
  body.append(stack)
  box.replaceChildren(head(path, [state]), body)
  await paint()

  // From a search hit: the line in view, the cursor at its start.
  if (line !== null) {
    const start = area.value.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0)
    const row = shown.querySelectorAll('.ln')[line - 1]

    row?.setAttribute('data-hit', '')
    area.setSelectionRange(start, start)
    row?.scrollIntoView({ block: 'center' })
  }

  area.focus({ preventScroll: true })
}

// Fills `box` with the file at `path`. `line` scrolls to (and marks) a line, from a search hit;
// `edit` opens it in the editor at once (a new note).
export async function showFile(box, path, { line = null, edit: editing = false } = {}) {
  box.replaceChildren(head(path), el('div', 'doc-body'))

  const body = box.lastElementChild

  if (IMAGE.test(path) || VIDEO.test(path)) {
    const media = el('div', 'doc-media')
    const item = el(VIDEO.test(path) ? (/\.(mp3|wav)$/i.test(path) ? 'audio' : 'video') : 'img')

    item.src = rawUrl(path)

    if (item.tagName !== 'IMG') item.controls = true

    media.append(item)
    body.append(media)

    return
  }

  if (PDF.test(path)) {
    const frame = el('iframe', 'doc-frame')

    frame.src = rawUrl(path)
    body.append(frame)

    return
  }

  body.append(el('p', 'doc-note', '불러오는 중…'))

  const file = await readFile(path)

  if (file === null) {
    body.replaceChildren(el('p', 'doc-note', '파일을 열 수 없어요'))

    return
  }

  if (file.tooBig || file.binary) {
    const note = el('p', 'doc-note', file.tooBig ? '너무 커서 미리 볼 수 없어요' : '글자로 된 파일이 아니에요')
    const link = el('a', '', '파일 받기')

    link.href = rawUrl(path)
    link.download = fileName(path)
    note.append(document.createElement('br'), link)
    body.replaceChildren(note)

    return
  }

  const text = file.text
  const edit = iconButton(UI.edit, '편집', () => void editor(box, path, file, () => void showFile(box, path)))

  if (editing) {
    await editor(box, path, file, () => void showFile(box, path))

    return
  }

  box.firstElementChild.append(edit)

  if (MARKDOWN.test(path)) {
    const seg = el('div', 'seg')
    const page = el('button', '', '보기')
    const raw = el('button', '', '원본')
    const show = async (rendered) => {
      page.toggleAttribute('data-on', rendered)
      raw.toggleAttribute('data-on', !rendered)
      body.replaceChildren(rendered ? await markdownView(text) : codeView(text, await highlighted(text, 'x.md')))
    }

    page.type = 'button'
    raw.type = 'button'
    page.addEventListener('click', () => void show(true))
    raw.addEventListener('click', () => void show(false))
    seg.append(page, raw)
    box.firstElementChild.insertBefore(seg, edit)
    await show(line === null)
  } else {
    // Code is edited where it is shown.
    edit.remove()
    await codeEditor(box, path, file, line)

    return
  }

  const row = line === null ? null : body.querySelectorAll('.code .ln')[line - 1]

  if (row) {
    row.dataset.hit = ''
    row.scrollIntoView({ block: 'center' })
  }
}

// ---- Diff: the change of one file, lines commented and the comments sent to an agent.
function diffKind(line) {
  if (line.startsWith('@@')) return 'hunk'
  if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'

  return 'ctx'
}

export async function showDiff(box, root, path, onSend) {
  box.replaceChildren(head(path), el('div', 'doc-body'))

  const body = box.lastElementChild
  const reply = await fetch(`/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)

  if (typeof reply?.diff !== 'string') {
    body.append(el('p', 'doc-note', '변경 내용을 읽을 수 없어요'))

    return
  }

  if (reply.diff === '') {
    body.append(el('p', 'doc-note', '바뀐 내용이 없어요'))

    return
  }

  const comments = []
  const bar = el('div', 'annotate-bar')
  const count = el('span', '', '')
  const sendAll = el('button', 'chip', '에이전트에게 보내기')
  const table = el('div', 'diff')
  let newLine = 0
  let oldLine = 0

  const drawBar = () => {
    count.textContent = comments.length === 0 ? '줄을 눌러 주석을 달 수 있어요' : `주석 ${comments.length}개`
    sendAll.disabled = comments.length === 0
  }

  sendAll.type = 'button'
  sendAll.dataset.primary = ''
  sendAll.addEventListener('click', () => {
    const lines = comments.map((comment) => `- ${comment.line}: \`${comment.code.trim()}\`\n  → ${comment.text}`)

    onSend(`[ChoiTerm 코드 주석] ${path}\n${lines.join('\n')}`)
  })
  bar.append(count, sendAll)

  for (const text of reply.diff.replace(/\n$/, '').split('\n')) {
    const kind = diffKind(text)
    const row = el('div', `dl ${kind}`)
    const number = el('span', 'dn')
    const code = el('code', '', text === '' ? ' ' : text)

    if (kind === 'hunk') {
      const match = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)

      oldLine = Number(match?.[1] ?? 0)
      newLine = Number(match?.[2] ?? 0)
    } else if (kind === 'add') {
      number.textContent = String(newLine)
      newLine += 1
    } else if (kind === 'del') {
      number.textContent = String(oldLine)
      oldLine += 1
    } else if (kind === 'ctx') {
      number.textContent = String(newLine)
      newLine += 1
      oldLine += 1
    }

    row.append(number, code)

    if (kind === 'add' || kind === 'del' || kind === 'ctx') {
      const where = `${kind === 'del' ? '삭제 ' : ''}${number.textContent}`

      row.addEventListener('click', () => {
        if (row.nextElementSibling?.classList.contains('comment-box')) return

        const form = el('form', 'comment-box')
        const field = el('input', 'field')
        const add = el('button', 'chip', '주석')

        field.placeholder = '이 줄에 대해 에이전트에게 할 말'
        add.type = 'submit'
        add.dataset.primary = ''
        form.append(field, add)
        form.addEventListener('submit', (event) => {
          event.preventDefault()

          const note = field.value.trim()

          if (note === '') return

          comments.push({ line: where, code: text.slice(1), text: note })
          form.replaceWith(Object.assign(el('div', 'comment'), { textContent: `${where}: ${note}` }))
          row.dataset.commented = ''
          drawBar()
        })
        row.after(form)
        field.focus()
      })
    }

    table.append(row)
  }

  drawBar()
  body.append(table)
  box.append(bar)
}

// A picture of an element goes up like any upload; its path goes to the agent with the note.
async function uploadShot(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const reply = await fetch('/upload?name=annotate.png', { method: 'POST', body: blob })

    return reply.ok ? (await reply.json()).path : null
  } catch {
    return null
  }
}

// ---- Web pages: a dev server preview, with pointing at elements (ChoiTerm's proxy adds the
// script that answers inside the page; see proxy.ts and annotate.js).
export function showWeb(box, url, label, onSend) {
  const frame = el('iframe', 'doc-frame')
  const address = el('div', 'address')
  const notes = []
  const count = el('span', 'badge')
  let pointing = false

  frame.src = url
  // The page is the owner's own dev server, on its own origin: it gets no access to ChoiTerm.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads')
  address.textContent = label ?? url
  address.title = url

  const aim = iconButton(UI.aim, '요소를 골라 주석 달기', () => {
    pointing = !pointing
    aim.setAttribute('aria-pressed', String(pointing))
    frame.contentWindow?.postMessage({ choiterm: 'annotate', on: pointing }, '*')
  })
  // Pictures of picked elements by selector, arriving a moment after the element itself.
  const shots = new Map()
  const send = iconButton(UI.send, '주석을 에이전트에게 보내기', async () => {
    if (notes.length === 0) return

    const lines = []

    for (const [index, note] of notes.entries()) {
      const shot = shots.get(note.info.selector)
      const path = shot ? await uploadShot(shot) : null

      lines.push(`${index + 1}. ${note.info.tag}${note.info.text ? ` "${note.info.text}"` : ''} (${note.info.selector})\n   → ${note.text}\n   ${note.info.html}\n   스타일: ${note.info.styles}${path ? `\n   스크린샷: ${path}` : ''}`)
    }

    onSend(`[ChoiTerm 화면 주석] ${url}\n${lines.join('\n')}`)
  })
  const draw = () => {
    count.textContent = notes.length === 0 ? '' : String(notes.length)
    send.disabled = notes.length === 0
  }

  // An element picked in the page: ask what to say about it, beside where it was picked.
  const listener = (event) => {
    if (!box.isConnected) {
      removeEventListener('message', listener)

      return
    }

    if (event.source === frame.contentWindow && event.data?.choiterm === 'annotated-shot' && typeof event.data.shot === 'string') {
      shots.set(event.data.selector, event.data.shot)

      return
    }

    if (event.source !== frame.contentWindow || event.data?.choiterm !== 'annotated') return

    const info = event.data.info
    const form = el('form', 'pin-note')
    const title = el('strong', '', `${info.tag}${info.text ? ` "${info.text.slice(0, 40)}"` : ''}`)
    const field = el('input', 'field')
    const add = el('button', 'chip', '추가')
    const frameBox = frame.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()

    box.querySelector('.pin-note')?.remove()
    field.placeholder = '이 요소에 대해 에이전트에게 할 말'
    add.type = 'submit'
    add.dataset.primary = ''
    form.style.left = `${Math.min(Math.max(8, frameBox.left - boxRect.left + event.data.x), boxRect.width - 300)}px`
    form.style.top = `${Math.min(frameBox.top - boxRect.top + event.data.y + 12, boxRect.height - 140)}px`
    form.append(title, field, add)
    form.addEventListener('submit', (submitted) => {
      submitted.preventDefault()

      if (field.value.trim() === '') return

      notes.push({ info, text: field.value.trim() })
      form.remove()
      draw()
    })
    box.append(form)
    field.focus()
  }

  addEventListener('message', listener)

  const bar = el('div', 'webbar')

  bar.append(
    address,
    aim,
    count,
    send,
    iconButton(REFRESH_ICON, '새로 고침', () => {
      frame.src = url
    }),
    iconButton(OPEN_ICON, '새 창에서 열기', () => window.open(url, '_blank', 'noopener')),
  )
  draw()
  box.replaceChildren(bar, frame)
}
