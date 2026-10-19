// A second terminal for the split pane: another session beside the main one, with a connection of
// its own (the server shows one session per connection). Typing, pasting and resizing work as in
// the main terminal; links, copy handles and the phone gestures stay with the main one.
import { Terminal } from '/vendor/xterm.mjs'
import { FitAddon } from '/vendor/addon-fit.mjs'
import { Unicode11Addon } from '/vendor/addon-unicode11.mjs'

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

export function createMiniTerm(box, { font, theme, fontSize }) {
  const term = new Terminal({ fontFamily: font, fontSize, lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar', scrollback: 5000, allowProposedApi: true, theme })
  const fit = new FitAddon()
  let socket = null
  let id = null
  let closed = false
  let size = { cols: 0, rows: 0 }

  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.open(box)

  const send = (message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  // Like the main terminal: this screen sets the size while someone uses it.
  const claim = () => {
    const wanted = fit.proposeDimensions()

    if (id === null || wanted === undefined) return

    if (wanted.cols !== size.cols || wanted.rows !== size.rows) send({ t: 'resize', id, cols: wanted.cols, rows: wanted.rows })
  }

  const apply = (cols, rows) => {
    size = { cols, rows }

    if (term.cols !== cols || term.rows !== rows) {
      unwrapPadded(term)
      term.resize(cols, rows)
    }
  }

  // The same guard as the main terminal's (app.js): Windows' Korean IME can commit a syllable twice.
  let lastData = ''
  let lastAt = 0

  term.onData((data) => {
    if (id === null || data === '') return

    if (data === lastData && performance.now() - lastAt < 40 && /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(data)) return

    lastData = data
    lastAt = performance.now()

    claim()
    send({ t: 'in', id, d: data })
  })

  term.attachCustomKeyEventHandler((event) => {
    const key = event.key.toLowerCase()
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey

    // Ctrl+V pastes (text, or an image the page uploads); Ctrl+C copies a selection.
    if (mod && key === 'v') return false

    if (mod && key === 'c' && (event.shiftKey || term.hasSelection())) {
      if (event.type === 'keydown') void navigator.clipboard?.writeText(term.getSelection())

      event.preventDefault()

      return false
    }

    return true
  })

  function connect() {
    if (closed) return

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'

    socket = new WebSocket(`${scheme}://${location.host}/ws`)
    socket.addEventListener('open', () => {
      if (id !== null) send({ t: 'attach', id })
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)

      if (message.id !== id) return

      if (message.t === 'snapshot') {
        term.reset()
        apply(message.cols, message.rows)
        term.write(message.d)
        claim()
      } else if (message.t === 'out') {
        term.write(message.d)
      } else if (message.t === 'size') {
        apply(message.cols, message.rows)
      } else if (message.t === 'exit') {
        term.write('\r\n\x1b[2m[세션이 끝났어요]\x1b[0m\r\n')
      }
    })
    socket.addEventListener('close', () => setTimeout(connect, 1500))
  }

  const observer = new ResizeObserver(() => {
    if (box.clientWidth > 0) claim()
  })

  observer.observe(box)
  connect()

  return {
    show(sessionId) {
      id = sessionId
      term.reset()
      send({ t: 'attach', id })
    },
    focus: () => term.focus(),
    setTheme(next) {
      term.options.theme = next
    },
    claim,
    dispose() {
      closed = true
      observer.disconnect()
      socket?.close()
      term.dispose()
    },
  }
}
