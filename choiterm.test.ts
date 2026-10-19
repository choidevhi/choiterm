import { test } from 'node:test'
import headless from '@xterm/headless'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { cleanTags, createGallery, parseGalleryFile, type GalleryItem } from './gallery.ts'
import { conversationOf, reportFor } from './hook.ts'
import { createNotices, shorten } from './notices.ts'
import { cleanName, createSessions, cwdFromOsc7, unwrapPadded, type Pty, type Resume, type ServerMessage, type SessionInfo, type SessionKind } from './sessions.ts'
import { parseStatusReport, usageWarnings } from './status.ts'
import { launchFolder, loadSessions, parseSavedSessions, saveSessions } from './store.ts'
import { findRepositories, projectKey, trustFolders, trustRoot } from './trust.ts'
import { createMachines, parseHello, parseTailnet } from './machines.ts'
import { configFor, listenerPids, withOurHooks, withoutOurHooks, type JsonObject } from './setup.ts'
import { addWorktree, cleanBranch, cleanProjectName, createProject, identity, initProject, listBranches, parseBranches, parseRevParse, parseWorktrees, tooWideForProject, worktreeFolder } from './repo.ts'
import { pickerScript } from './folder-picker.ts'
import { applyInput, createDrafts } from './drafts.ts'
import { autoCommit, createdNote, createRelay, mergeToProject, turnNote } from './teamwork.ts'
import { createProjects } from './projects.ts'
import { deleteNote, listNotes, noteTitle, projectNotesFolder } from './notes.ts'
import { cleanRepoName, createGithub, parseRepos, parseSignIn, type GhResult, type SignInProcess } from './github.ts'
import { createTurnWatch } from './turns.ts'
import { parseProcessTable, portsBySession } from './ports.ts'
import { parseRolloutHead, pickRollout } from './codex.ts'
import { createAgentCheck, isAgentId } from './agents.ts'
import { createPreviews } from './previews.ts'
import { looksBinary, readText, writeText } from './files.ts'
import { injectScript, startProxy } from './proxy.ts'
import { currentLimit, parseCodexLimits } from './usage.ts'
import { filterFileNames, parseHits, parseStatus, parseTasks } from './work.ts'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fromOwner, parseClientMessage, parseConversationReport, parseMachineReport, safeFileName, sameOrigin, startServer, type Settings } from './server.ts'

interface FakePty extends Pty {
  kind: SessionKind
  written: string[]
  sizes: string[]
  killed: boolean
  emit(data: string): void
  end(): void
}

function fakeSpawner(): { spawned: FakePty[]; spawn: (kind: SessionKind) => FakePty } {
  const spawned: FakePty[] = []

  return {
    spawned,
    spawn(kind) {
      let onData = (_data: string): void => {}
      let onExit = (): void => {}

      const pty: FakePty = {
        kind,
        pid: 1000 + spawned.length,
        written: [],
        sizes: [],
        killed: false,
        onData(listener) {
          onData = listener
        },
        onExit(listener) {
          onExit = listener
        },
        write(data) {
          pty.written.push(data)
        },
        resize(cols, rows) {
          pty.sizes.push(`${cols}x${rows}`)
        },
        kill() {
          pty.killed = true
        },
        emit(data) {
          onData(data)
        },
        end() {
          onExit()
        },
      }

      spawned.push(pty)

      return pty
    },
  }
}

function recorder(): { messages: ServerMessage[]; send: (message: ServerMessage) => void } {
  const messages: ServerMessage[] = []

  return { messages, send: (message) => messages.push(message) }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

test('a viewer that joins late gets the screen so far, then live output once', async () => {
  const { spawned, spawn } = fakeSpawner()
  const sessions = createSessions(spawn, () => {})
  const info = sessions.create('claude', 80, 24)
  const pty = spawned[0]

  pty.emit('hello ')
  pty.emit('world')

  const viewer = recorder()

  assert.equal(sessions.attach(info.id, viewer), true)
  pty.emit('!')
  await settle()

  assert.equal(viewer.messages[0]?.t, 'snapshot')

  const snapshot = viewer.messages[0]

  assert.ok(snapshot.t === 'snapshot' && snapshot.d.includes('hello world') && !snapshot.d.includes('!'))
  assert.deepEqual(viewer.messages.slice(1), [{ t: 'out', id: info.id, d: '!' }])

  pty.emit('?')
  assert.deepEqual(viewer.messages.at(-1), { t: 'out', id: info.id, d: '?' })
  sessions.closeAll()
})

test('two viewers share one terminal: input reaches the process, resize reaches both', async () => {
  const { spawned, spawn } = fakeSpawner()
  const sessions = createSessions(spawn, () => {})
  const info = sessions.create('shell', 80, 24)
  const pc = recorder()
  const phone = recorder()

  sessions.attach(info.id, pc)
  sessions.attach(info.id, phone)
  await settle()

  sessions.input(info.id, 'ls\r')
  sessions.resize(info.id, 40, 30)
  sessions.resize(info.id, 40, 30)
  sessions.resize(info.id, 5000, 1)

  assert.deepEqual(spawned[0].written, ['ls\r'])
  assert.deepEqual(spawned[0].sizes, ['40x30', '400x5'])
  assert.deepEqual(pc.messages.at(-2), { t: 'size', id: info.id, cols: 40, rows: 30 })
  assert.deepEqual(phone.messages.at(-1), { t: 'size', id: info.id, cols: 400, rows: 5 })
  sessions.closeAll()
})

test('a process that exits leaves the list and tells its viewers', async () => {
  const { spawned, spawn } = fakeSpawner()
  const lists: number[] = []
  const sessions = createSessions(spawn, (list) => lists.push(list.length))
  const info = sessions.create('claude', 80, 24)
  const viewer = recorder()

  sessions.attach(info.id, viewer)
  await settle()
  spawned[0].end()

  assert.deepEqual(lists, [1, 0])
  assert.deepEqual(viewer.messages.at(-1), { t: 'exit', id: info.id })
  assert.deepEqual(sessions.list(), [])
})

test('closing kills the process; the window title becomes the tab name', async () => {
  const { spawned, spawn } = fakeSpawner()
  const sessions = createSessions(spawn, () => {})
  const info = sessions.create('claude', 80, 24)

  spawned[0].emit('\x1b]0;✳ 리팩터링\x07')
  await settle()
  assert.equal(sessions.list()[0]?.title, '✳ 리팩터링')

  sessions.close(info.id)
  assert.equal(spawned[0].killed, true)
  assert.deepEqual(sessions.list(), [])
})

test('client messages are parsed strictly', () => {
  assert.deepEqual(parseClientMessage('{"t":"in","id":"a","d":"x"}'), { t: 'in', id: 'a', d: 'x' })
  assert.deepEqual(parseClientMessage('{"t":"new","kind":"claude","cols":80,"rows":24}'), {
    t: 'new',
    kind: 'claude',
    cwd: null,
    cols: 80,
    rows: 24,
  })
  assert.equal(parseClientMessage('{"t":"new","kind":"cmd","cols":80,"rows":24}'), null)
  assert.equal(parseClientMessage('{"t":"resize","id":"a","cols":0,"rows":24}'), null)
  assert.equal(parseClientMessage('{"t":"in","id":"a"}'), null)
  assert.equal(parseClientMessage('null'), null)
  assert.equal(parseClientMessage('not json'), null)
})

const settings: Settings = { owner: 'me@example.com', hosts: ['pc.ts.net:8449'], port: 47999 }

function request(headers: Record<string, string>): IncomingMessage {
  // SAFETY: the checks read only `headers`, which this literal fills like Node would.
  return { headers } as IncomingMessage
}

test('only the owner through tailscale, or this PC directly, gets in', () => {
  assert.equal(fromOwner(request({ host: 'pc.ts.net:8449', 'tailscale-user-login': 'me@example.com' }), settings), true)
  assert.equal(fromOwner(request({ host: 'pc.ts.net:8449', 'tailscale-user-login': 'other@example.com' }), settings), false)
  assert.equal(fromOwner(request({ host: 'pc.ts.net:8449' }), settings), false)
  assert.equal(fromOwner(request({ host: '127.0.0.1:47999' }), settings), true)
  assert.equal(fromOwner(request({ host: 'evil.example:47999' }), settings), false)
  assert.equal(sameOrigin(request({ host: '127.0.0.1:47999', origin: 'http://127.0.0.1:47999' })), true)
  assert.equal(sameOrigin(request({ host: '127.0.0.1:47999', origin: 'https://evil.example' })), false)
  assert.equal(sameOrigin(request({ host: '127.0.0.1:47999' })), false)
})

test('end to end over a real socket: open, type, see output; foreign origins are refused', async () => {
  const { spawned, spawn } = fakeSpawner()
  let announce = (_message: ServerMessage): void => {}
  const sessions = createSessions(spawn, (list) => announce({ t: 'list', sessions: list }))
  const running = startServer(settings, sessions, new Map(), () => {})

  announce = running.announce
  await new Promise((resolve) => running.server.once('listening', resolve))

  const url = `ws://127.0.0.1:${settings.port}/ws`
  const foreign = new WebSocket(url, { origin: 'https://evil.example' })
  const refused = await new Promise<boolean>((resolve) => {
    foreign.on('open', () => resolve(false))
    foreign.on('error', () => resolve(true))
  })

  assert.equal(refused, true)

  const client = new WebSocket(url, { origin: `http://127.0.0.1:${settings.port}` })
  const received: ServerMessage[] = []

  client.on('message', (data) => received.push(JSON.parse(data.toString())))
  await new Promise((resolve) => client.on('open', resolve))

  client.send(JSON.stringify({ t: 'new', kind: 'claude', cols: 90, rows: 20 }))
  await settle()

  const pty = spawned[0]

  assert.equal(pty.kind, 'claude')
  pty.emit('ready>')
  await settle()

  const snapshot = received.find((message) => message.t === 'snapshot')

  assert.ok(snapshot !== undefined && snapshot.t === 'snapshot')
  client.send(JSON.stringify({ t: 'in', id: snapshot.id, d: '안녕\r' }))
  await settle()

  assert.deepEqual(pty.written, ['안녕\r'])
  assert.ok(received.some((message) => message.t === 'out' && message.d === 'ready>'))

  client.close()
  sessions.closeAll()
  await new Promise((resolve) => running.server.close(resolve))
})

test('the APK downloads only for the owner', async () => {
  const sessions = createSessions(fakeSpawner().spawn, () => {})
  const apk = { name: 'ChoiTerm-0.1.0.apk', body: Buffer.from('PK-fake') }
  const local: Settings = { ...settings, port: 47998 }
  const running = startServer(local, sessions, new Map(), () => {}, { latestApk: () => apk })

  await new Promise((resolve) => running.server.once('listening', resolve))

  const ok = await fetch(`http://127.0.0.1:${local.port}/ChoiTerm.apk`)

  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'application/vnd.android.package-archive')
  assert.match(ok.headers.get('content-disposition') ?? '', /ChoiTerm-0\.1\.0\.apk/)
  assert.equal(await ok.text(), 'PK-fake')

  // fetch drops a custom Host header, so ask the way tailscale serve would without the login.
  const outsider = await new Promise<number | undefined>((resolve) => {
    get({ port: local.port, path: '/ChoiTerm.apk', headers: { host: 'pc.ts.net:8449' } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
  })

  assert.equal(outsider, 403)
  await new Promise((resolve) => running.server.close(resolve))
})

test('file names are reduced to something safe to save and to type', () => {
  assert.equal(safeFileName('스크린샷 2026-10-18 01.20.png'), '스크린샷_2026-10-18_01.20.png')
  assert.equal(safeFileName('../../evil.txt'), 'evil.txt')
  assert.equal(safeFileName('a:b*c?.txt'), 'a_b_c_.txt')
  assert.equal(safeFileName('...'), 'file')
})

test('uploads land in the uploads folder, only from the page itself', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'choiterm-upload-'))
  const sessions = createSessions(fakeSpawner().spawn, () => {})
  const local: Settings = { ...settings, port: 47997 }
  const running = startServer(local, sessions, new Map(), () => {}, { uploadFolder: folder })
  const base = `http://127.0.0.1:${local.port}`

  await new Promise((resolve) => running.server.once('listening', resolve))

  try {
    const ok = await fetch(`${base}/upload?name=${encodeURIComponent('사진 1.png')}`, {
      method: 'POST',
      headers: { origin: base },
      body: 'pixels',
    })
    const reply = await ok.json()

    assert.equal(ok.status, 200)
    assert.match(reply.path, /\d{8}-\d{6}-사진_1\.png$/)
    assert.equal(readFileSync(reply.path, 'utf8'), 'pixels')

    const foreign = await fetch(`${base}/upload?name=x.txt`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: 'x' })

    assert.equal(foreign.status, 403)
    assert.equal(readdirSync(folder).length, 1)
  } finally {
    await new Promise((resolve) => running.server.close(resolve))
    rmSync(folder, { recursive: true, force: true })
  }
})

test('hooks turn into notices: answers, questions and alerts, not the idle reminder', () => {
  assert.deepEqual(reportFor(JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: '다 고쳤어요' })), { kind: 'done', text: '다 고쳤어요', answers: [] })

  const options = [{ label: '왼쪽' }, { label: '오른쪽' }, { label: '가운데' }, { label: '넷째' }]

  assert.deepEqual(
    reportFor(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '어느 쪽으로 할까요?', options }] } })),
    {
      kind: 'question',
      text: '어느 쪽으로 할까요?',
      answers: [
        { label: '왼쪽', keys: '1' },
        { label: '오른쪽', keys: '2' },
        { label: '가운데', keys: '3' },
      ],
    },
  )
  // Several questions or a multi-select are answered on screen only.
  assert.deepEqual(
    reportFor(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'a', options }, { question: 'b', options }] } }))?.answers,
    [],
  )
  assert.deepEqual(
    reportFor(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'a', multiSelect: true, options }] } }))?.answers,
    [],
  )
  assert.equal(reportFor(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })), null)
  assert.deepEqual(reportFor(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: '권한이 필요해요' })), {
    kind: 'attention',
    text: '권한이 필요해요',
    answers: [
      { label: '허용', keys: '1' },
      { label: '거절', keys: '\u001b' },
    ],
  })
  assert.equal(reportFor(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' })), null)
  assert.equal(reportFor('not json'), null)
})

test('notice text becomes one short plain line', () => {
  assert.equal(shorten('**끝났어요.**\n\n```ts\ncode\n```\n→ `npm test` 통과'), '끝났어요. → npm test 통과')
  assert.equal(shorten('가'.repeat(500)).length, 400)
})

test('a hook notice reaches the page and the event stream; browsers and phones cannot post one', async () => {
  const { spawn } = fakeSpawner()
  const notices = createNotices()
  const sessions = createSessions(spawn, () => {})
  const info = sessions.create('claude', 80, 24)
  const local: Settings = { ...settings, port: 47996 }
  const running = startServer(local, sessions, new Map(), () => {}, { notices })
  const base = `http://127.0.0.1:${local.port}`

  await new Promise((resolve) => running.server.once('listening', resolve))

  const client = new WebSocket(`ws://127.0.0.1:${local.port}/ws`, { origin: base })
  const opened = new Promise((resolve) => client.once('open', resolve))
  const pushed: ServerMessage[] = []

  client.on('message', (data) => pushed.push(JSON.parse(data.toString())))

  try {
    await opened

    const stream = await fetch(`${base}/events`, { headers: { 'last-event-id': '0' } })
    const reader = stream.body!.getReader()

    const posted = await fetch(`${base}/notify`, { method: 'POST', body: JSON.stringify({ session: info.id, kind: 'done', text: '**다 됐어요**' }) })

    assert.equal(posted.status, 200)

    let streamed = ''

    while (!streamed.includes('data:')) streamed += new TextDecoder().decode((await reader.read()).value)

    assert.match(streamed, /"text":"다 됐어요"/)
    await settle()
    assert.ok(pushed.some((message) => message.t === 'notice' && message.notice.session === info.id))

    const fromPage = await fetch(`${base}/notify`, { method: 'POST', headers: { origin: base }, body: JSON.stringify({ session: info.id, kind: 'done', text: 'x' }) })
    const unknown = await fetch(`${base}/notify`, { method: 'POST', body: JSON.stringify({ session: 'nope', kind: 'done', text: 'x' }) })

    assert.equal(fromPage.status, 403)
    assert.equal(unknown.status, 404)
    await reader.cancel()
  } finally {
    client.terminate()
    sessions.closeAll()
    running.server.closeAllConnections()
    await new Promise((resolve) => running.server.close(resolve))
  }
})

test('previews serve image files only', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'choiterm-preview-'))
  const image = join(folder, 'shot.png')
  const secret = join(folder, 'key.txt')
  const sessions = createSessions(fakeSpawner().spawn, () => {})
  const local: Settings = { ...settings, port: 47995 }
  const running = startServer(local, sessions, new Map(), () => {})
  const base = `http://127.0.0.1:${local.port}`

  writeFileSync(image, 'png-bytes')
  writeFileSync(secret, 'secret')
  await new Promise((resolve) => running.server.once('listening', resolve))

  try {
    const ok = await fetch(`${base}/preview?path=${encodeURIComponent(image)}`)

    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'image/png')
    assert.equal(await ok.text(), 'png-bytes')
    assert.equal((await fetch(`${base}/preview?path=${encodeURIComponent(secret)}`)).status, 400)
    assert.equal((await fetch(`${base}/preview?path=shot.png`)).status, 400)
    assert.equal((await fetch(`${base}/preview?path=${encodeURIComponent(join(folder, 'none.png'))}`)).status, 404)
  } finally {
    await new Promise((resolve) => running.server.close(resolve))
    rmSync(folder, { recursive: true, force: true })
  }
})

test('previews answer "unchanged" while the file stays the same', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'choiterm-etag-'))
  const image = join(folder, 'shot.png')
  const sessions = createSessions(fakeSpawner().spawn, () => {})
  const local: Settings = { ...settings, port: 47994 }
  const running = startServer(local, sessions, new Map(), () => {})
  const url = `http://127.0.0.1:${local.port}/preview?path=${encodeURIComponent(image)}`

  writeFileSync(image, 'first')
  await new Promise((resolve) => running.server.once('listening', resolve))

  try {
    const first = await fetch(url)
    const tag = first.headers.get('etag') ?? ''

    assert.notEqual(tag, '')
    assert.equal((await fetch(url, { headers: { 'if-none-match': tag } })).status, 304)
    writeFileSync(image, 'second, longer')
    assert.equal((await fetch(url, { headers: { 'if-none-match': tag } })).status, 200)
  } finally {
    await new Promise((resolve) => running.server.close(resolve))
    rmSync(folder, { recursive: true, force: true })
  }
})

test('the gallery keeps uploads and shown images, tags them, and deletes only its own files', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'choiterm-gallery-'))
  const uploads = join(folder, 'uploads')
  const elsewhere = join(folder, 'project.png')
  const store = join(folder, 'data', 'gallery.json')
  const gallery = createGallery(store, uploads, () => {})
  const sessions = createSessions(fakeSpawner().spawn, () => {})
  const local: Settings = { ...settings, port: 47993 }
  const running = startServer(local, sessions, new Map(), () => {}, { uploadFolder: uploads, gallery })
  const base = `http://127.0.0.1:${local.port}`
  const post = (action: string, body: Record<string, string | string[]>, origin = base): Promise<Response> =>
    fetch(`${base}/gallery/${action}`, { method: 'POST', headers: { origin }, body: JSON.stringify(body) })
  const pushed: number[] = []

  gallery.subscribe((items) => pushed.push(items.length))
  writeFileSync(elsewhere, 'pixels')
  await new Promise((resolve) => running.server.once('listening', resolve))

  try {
    const sent = await (await fetch(`${base}/upload?name=a.png&session=s1`, { method: 'POST', headers: { origin: base }, body: 'a' })).json()

    await fetch(`${base}/upload?name=notes.txt`, { method: 'POST', headers: { origin: base }, body: 'n' })

    const shown = await post('add', { path: elsewhere, session: 's1' })

    assert.equal(shown.status, 200)
    assert.equal((await post('add', { path: elsewhere, session: 's1' })).status, 200)
    assert.equal((await post('add', { path: join(folder, 'none.png') })).status, 404)
    assert.equal((await post('add', { path: 'relative.png' })).status, 400)
    assert.equal((await post('add', { path: elsewhere }, 'https://evil.example')).status, 403)

    const listed = await (await fetch(`${base}/gallery`)).json()

    assert.deepEqual(listed.items.map((item: GalleryItem) => [item.from, item.sessions]), [['me', ['s1']], ['claude', ['s1']]])

    await post('add', { path: elsewhere, session: 's2' })

    const again = await (await fetch(`${base}/gallery`)).json()

    assert.deepEqual(again.items[1].sessions, ['s1', 's2'])

    const [mine, theirs] = listed.items

    // Closing a thumbnail in one session is kept for every screen, and only for that session.
    assert.equal((await post('unpin', { ids: [theirs.id], session: 's2' })).status, 200)

    const unpinned = await (await fetch(`${base}/gallery`)).json()

    assert.deepEqual(unpinned.items[1].unpinned, ['s2'])
    assert.equal((await post('unpin', { ids: [theirs.id] })).status, 400)
    const tagged = await (await post('tags', { id: theirs.id, tags: [' 고양이 ', '고양이', '', 'ui  mock'] })).json()

    assert.deepEqual(tagged.item.tags, ['고양이', 'ui mock'])

    const removed = await (await post('delete', { ids: [mine.id, theirs.id, 'nope'] })).json()

    assert.deepEqual(removed.removed, [mine.id, theirs.id])
    assert.equal(existsSync(sent.path), false)
    assert.equal(existsSync(elsewhere), true)
    // Still on someone's screen, a deleted image is not taken back, until the file changes.
    assert.equal((await post('add', { path: elsewhere, session: 's1' })).status, 404)
    writeFileSync(elsewhere, 'new pixels')
    assert.equal((await post('add', { path: elsewhere, session: 's1' })).status, 200)
    await post('delete', { ids: [(await (await fetch(`${base}/gallery`)).json()).items[0].id] })
    assert.deepEqual(pushed, [1, 2, 2, 2, 2, 0, 1, 0])
    assert.deepEqual(parseGalleryFile(readFileSync(store, 'utf8')), [])
  } finally {
    sessions.closeAll()
    await new Promise((resolve) => running.server.close(resolve))
    rmSync(folder, { recursive: true, force: true })
  }
})

test('the gallery file survives a restart and bad entries are dropped', () => {
  const folder = mkdtempSync(join(tmpdir(), 'choiterm-gallery-file-'))
  const image = join(folder, 'a.png')
  const store = join(folder, 'gallery.json')

  writeFileSync(image, 'x')

  try {
    const first = createGallery(store, folder, () => {})
    const item = first.add(image, 'claude', null)

    assert.notEqual(item, null)
    first.setTags(item?.id ?? '', ['one'])

    const again = createGallery(store, folder, () => {})

    assert.deepEqual(again.list().map((each) => each.tags), [['one']])
    assert.deepEqual(parseGalleryFile('{"items":[{"id":1},{"id":"a","path":"C:\\a.png","from":"x","at":1}]}'), [])
    assert.deepEqual(parseGalleryFile('not json'), [])
    assert.deepEqual(cleanTags(['a', ' a ', 'b'.repeat(40)]), ['a', 'b'.repeat(30)])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('sessions can be renamed and archived, and those messages are parsed strictly', () => {
  const lists: SessionInfo[][] = []
  const sessions = createSessions(fakeSpawner().spawn, (list) => lists.push(list))
  const info = sessions.create('claude', 80, 24)

  try {
    sessions.rename(info.id, '  고양이   그림 작업 ')
    sessions.archive(info.id, true)
    assert.deepEqual(sessions.list().map((each) => [each.name, each.archived]), [['고양이 그림 작업', true]])
    sessions.rename(info.id, '   ')
    sessions.archive(info.id, true)
    assert.deepEqual(sessions.list().map((each) => [each.name, each.archived]), [[null, true]])
    assert.equal(lists.length, 4)
    assert.equal(cleanName('a'.repeat(200))?.length, 80)
    assert.deepEqual(parseClientMessage('{"t":"rename","id":"x","name":null}'), { t: 'rename', id: 'x', name: null })
    assert.equal(parseClientMessage('{"t":"rename","id":"x","name":5}'), null)
    assert.deepEqual(parseClientMessage('{"t":"archive","id":"x","archived":false}'), { t: 'archive', id: 'x', archived: false })
    assert.equal(parseClientMessage('{"t":"archive","id":"x","archived":"yes"}'), null)
  } finally {
    sessions.closeAll()
  }
})

test('saved sessions come back with their id, name, archive state and conversation', () => {
  const folder = mkdtempSync(join(tmpdir(), 'choiterm-store-'))
  const file = join(folder, 'data', 'sessions.json')
  const resumes: (Resume | null)[] = []
  const fake = fakeSpawner()
  const spawn = (kind: SessionKind, _cols: number, _rows: number, _id: string, resume: Resume | null): FakePty => {
    resumes.push(resume)

    return fake.spawn(kind)
  }
  const conversation = '9dffe4a1-4545-4ed3-aaf4-d899156df441'

  try {
    const first = createSessions(spawn, (list) => saveSessions(file, list))
    const info = first.create('claude', 80, 24)

    first.rename(info.id, '그림 작업')
    first.archive(info.id, true)
    first.setConversation(info.id, conversation, 'C:/work')
    first.create('shell', 80, 24)

    const saved = loadSessions(file)

    assert.equal(saved.length, 2)

    const second = createSessions(spawn, () => {})

    for (const each of saved) second.create(each.kind, 120, 40, each)

    const back = second.list().find((each) => each.id === info.id)

    assert.deepEqual([back?.name, back?.archived, back?.conversation, back?.cwd], ['그림 작업', true, conversation, 'C:/work'])
    assert.deepEqual(resumes.at(-2), { conversation, cwd: 'C:/work', createdAt: back?.createdAt })
    assert.deepEqual(resumes.slice(0, 2), [null, null])
    first.closeAll()
    second.closeAll()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('only UUID conversations are kept, since they end up on a command line', () => {
  const text = JSON.stringify({
    sessions: [
      { id: 'a', kind: 'claude', createdAt: 1, conversation: '9dffe4a1-4545-4ed3-aaf4-d899156df441' },
      { id: 'b', kind: 'claude', createdAt: 1, conversation: 'x; Remove-Item C:/' },
      { id: 'c', kind: 'other', createdAt: 1 },
    ],
  })

  assert.deepEqual(parseSavedSessions(text).map((each) => each.conversation), ['9dffe4a1-4545-4ed3-aaf4-d899156df441', null])
  assert.deepEqual(parseSavedSessions('nope'), [])
  assert.equal(parseConversationReport('{"session":"s","conversation":"$(evil)"}'), null)
  assert.deepEqual(conversationOf('{"session_id":"abc","cwd":"C:/x","hook_event_name":"SessionStart"}'), { conversation: 'abc', cwd: 'C:/x' })
  assert.equal(conversationOf('{}'), null)
})

test('the hook reports a conversation only from this PC, and it lands on the session', async () => {
  const sessions = createSessions(fakeSpawner().spawn, () => {})
  const local: Settings = { ...settings, port: 47992 }
  const running = startServer(local, sessions, new Map(), () => {})
  const info = sessions.create('claude', 80, 24)
  const url = `http://127.0.0.1:${local.port}/conversation`
  const body = JSON.stringify({ session: info.id, conversation: '29c0ac07-b175-478d-8a23-7cb297e75abd', cwd: 'C:/Users/me' })

  await new Promise((resolve) => running.server.once('listening', resolve))

  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example' }, body })).status, 403)
    assert.equal(sessions.list()[0].conversation, null)
    assert.equal((await fetch(url, { method: 'POST', body })).status, 200)
    assert.equal(sessions.list()[0].conversation, '29c0ac07-b175-478d-8a23-7cb297e75abd')
  } finally {
    sessions.closeAll()
    await new Promise((resolve) => running.server.close(resolve))
  }
})

test('the status mod reports reach the pages; only from this PC and for a running session', async () => {
  const sessions = createSessions(fakeSpawner().spawn, () => {})
  const local: Settings = { ...settings, port: 47991 }
  const running = startServer(local, sessions, new Map(), () => {})
  const info = sessions.create('claude', 80, 24)
  const base = `http://127.0.0.1:${local.port}`
  const report = (session: string, origin?: string): Promise<Response> =>
    fetch(`${base}/status`, {
      method: 'POST',
      headers: origin === undefined ? {} : { origin },
      body: JSON.stringify({ session, status: { contextPercent: 14, limits: [{ kind: 'five_hour', percent: 3, resetsAt: null }], model: 'claude-opus-5-5', effort: 'medium', cache: { at: 1, read: 9, written: 0, ttlMs: 3600000 } } }),
    })

  await new Promise((resolve) => running.server.once('listening', resolve))

  const client = new WebSocket(`ws://127.0.0.1:${local.port}/ws`, { headers: { origin: base } })
  const seen: ServerMessage[] = []

  client.on('message', (data) => seen.push(JSON.parse(data.toString())))
  await new Promise((resolve) => client.once('open', resolve))

  try {
    assert.equal((await report(info.id, 'https://evil.example')).status, 403)
    assert.equal((await report('no-such-session')).status, 400)
    assert.equal((await report(info.id)).status, 200)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const pushed = seen.find((message) => message.t === 'status')

    assert.equal(pushed?.t === 'status' ? pushed.status.model : null, 'claude-opus-5-5')
    assert.equal(parseStatusReport('{"session":"s","status":{"effort":3000}}')?.status.effort, '3000')
    assert.equal(parseStatusReport('{"session":"s"}'), null)
  } finally {
    client.terminate()
    sessions.closeAll()
    running.server.closeAllConnections()
    await new Promise((resolve) => running.server.close(resolve))
  }
})

test('usage warns once per window and threshold, again after the window resets', () => {
  const warned = new Set<string>()
  const now = Date.parse('2026-10-18T03:00:00Z')
  const at = (percent: number, resetsAt = '2026-10-18T04:30:00Z') => ({
    contextPercent: null,
    contextTokens: null,
    contextWindow: null,
    limits: [{ kind: 'five_hour', percent, resetsAt }],
    model: null,
    effort: null,
    cache: null,
  })

  assert.deepEqual(usageWarnings(at(50), warned, now), [])
  assert.deepEqual(usageWarnings(at(81), warned, now), ['5시간 사용량 81% · 1시간 30분 뒤 초기화'])
  assert.deepEqual(usageWarnings(at(85), warned, now), [])
  assert.deepEqual(usageWarnings(at(96), warned, now), ['5시간 사용량 96% · 1시간 30분 뒤 초기화'])
  assert.deepEqual(usageWarnings(at(97), warned, now), [])
  assert.equal(usageWarnings(at(82, '2026-10-18T09:30:00Z'), warned, now).length, 1)
})

test('a notification button answers the open question once; typing or a newer notice closes it', async () => {
  const { spawn, spawned } = fakeSpawner()
  const notices = createNotices()
  const sessions = createSessions(spawn, () => {})
  const info = sessions.create('claude', 80, 24)
  const local: Settings = { ...settings, port: 47990 }
  const running = startServer(local, sessions, new Map(), () => {}, { notices })
  const base = `http://127.0.0.1:${local.port}`
  const ask = async (): Promise<number> => {
    const reply = await fetch(`${base}/notify`, {
      method: 'POST',
      body: JSON.stringify({ session: info.id, kind: 'question', text: '어느 쪽?', answers: [{ label: '왼쪽', keys: '1' }, { label: '오른쪽', keys: '2' }] }),
    })

    return (await reply.json()).id
  }
  const answer = (notice: number, index: number, origin = base): Promise<Response> =>
    fetch(`${base}/answer`, { method: 'POST', headers: { origin }, body: JSON.stringify({ notice, index }) })

  await new Promise((resolve) => running.server.once('listening', resolve))

  try {
    const first = await ask()

    assert.equal((await answer(first, 1, 'https://evil.example')).status, 403)
    assert.equal((await answer(first, 5)).status, 409)
    assert.equal((await answer(first, 1)).status, 200)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(spawned[0]?.written, ['2', '\r'])
    // The same button twice does nothing.
    assert.equal((await answer(first, 0)).status, 409)

    // A newer notice without buttons (Claude finished) closes the question.
    const second = await ask()

    await fetch(`${base}/notify`, { method: 'POST', body: JSON.stringify({ session: info.id, kind: 'done', text: '끝' }) })
    assert.equal((await answer(second, 0)).status, 409)

    // Typing into the session closes it too.
    const third = await ask()
    const client = new WebSocket(`ws://127.0.0.1:${local.port}/ws`, { origin: base })

    await new Promise((resolve) => client.once('open', resolve))
    client.send(JSON.stringify({ t: 'in', id: info.id, d: '1' }))
    await settle()
    assert.equal((await answer(third, 0)).status, 409)
    client.terminate()

    // Bad answers from a hook are dropped, so the notice carries no buttons.
    const bad = await fetch(`${base}/notify`, {
      method: 'POST',
      body: JSON.stringify({ session: info.id, kind: 'question', text: 'x', answers: [{ label: 'rm', keys: 'rm -rf\r' }] }),
    })

    assert.equal((await answer((await bad.json()).id, 0)).status, 409)
  } finally {
    sessions.closeAll()
    running.server.closeAllConnections()
    await new Promise((resolve) => running.server.close(resolve))
  }
})

test('a muted session sends no notices, and the mute survives a restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'choiterm-mute-'))
  const file = join(folder, 'sessions.json')
  const notices = createNotices()
  const sessions = createSessions(fakeSpawner().spawn, (list) => saveSessions(file, list))
  const info = sessions.create('claude', 80, 24)
  const local: Settings = { ...settings, port: 47989 }
  const running = startServer(local, sessions, new Map(), () => {}, { notices })
  const added: number[] = []

  notices.subscribe((notice) => added.push(notice.id))
  await new Promise((resolve) => running.server.once('listening', resolve))

  try {
    sessions.mute(info.id, true)

    const reply = await fetch(`http://127.0.0.1:${local.port}/notify`, { method: 'POST', body: JSON.stringify({ session: info.id, kind: 'done', text: '끝' }) })

    assert.equal(reply.status, 200)
    assert.deepEqual(added, [])
    assert.equal(loadSessions(file)[0]?.muted, true)
    assert.deepEqual(parseClientMessage('{"t":"mute","id":"x","muted":false}'), { t: 'mute', id: 'x', muted: false })
    assert.equal(parseClientMessage('{"t":"mute","id":"x","muted":1}'), null)
  } finally {
    sessions.closeAll()
    running.server.closeAllConnections()
    await new Promise((resolve) => running.server.close(resolve))
    rmSync(folder, { recursive: true, force: true })
  }
})

test('the shell reports its folder with OSC 7, and that is where it opens again', async () => {
  const { spawn, spawned } = fakeSpawner()
  const lists: SessionInfo[][] = []
  const sessions = createSessions(spawn, (list) => lists.push(list))
  const info = sessions.create('shell', 80, 24)

  try {
    spawned[0]?.emit('\u001b]7;file:///C:/Users/me/%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8\u0007PS C:\\Users\\me> ')
    await settle()
    assert.equal(sessions.list().find((each) => each.id === info.id)?.cwd, 'C:\\Users\\me\\프로젝트')
    assert.equal(cwdFromOsc7('file://desktop/D:/work'), 'D:\\work')
    assert.equal(cwdFromOsc7('file:///home/me'), null)
    assert.equal(cwdFromOsc7('nonsense'), null)
  } finally {
    sessions.closeAll()
  }
})

test('a conversation resumes in the folder it started in, not where Claude last cd-ed to', () => {
  const projects = mkdtempSync(join(tmpdir(), 'choiterm-projects-'))
  const id = '2623665b-b279-4a38-ab88-2f20e93bb41d'

  try {
    mkdirSync(join(projects, 'C--Users-me'))
    writeFileSync(
      join(projects, 'C--Users-me', `${id}.jsonl`),
      [
        JSON.stringify({ type: 'summary', summary: 'x' }),
        'not json',
        JSON.stringify({ type: 'user', cwd: 'C:/Users/me', message: '시작' }),
        JSON.stringify({ type: 'assistant', cwd: 'C:/Users/me/Desktop/app' }),
      ].join('\n'),
    )

    assert.equal(launchFolder(projects, id), 'C:/Users/me')
    assert.equal(launchFolder(projects, '00000000-0000-0000-0000-000000000000'), null)
    assert.equal(launchFolder(join(projects, 'missing'), id), null)
  } finally {
    rmSync(projects, { recursive: true, force: true })
  }
})

test('folders are trusted at their repository root, found repositories too, and nothing else changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'choiterm-trust-'))
  const config = join(root, 'claude.json')
  const repo = join(root, 'work', 'app')
  const inner = join(repo, 'src', 'deep')
  const plain = join(root, 'notes')

  try {
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(inner, { recursive: true })
    mkdirSync(join(root, 'work', 'node_modules', 'dep', '.git'), { recursive: true })
    mkdirSync(plain, { recursive: true })
    writeFileSync(config, JSON.stringify({ numStartups: 7, projects: { 'C:/kept': { hasTrustDialogAccepted: true, allowedTools: ['x'] } } }))

    assert.equal(trustRoot(inner), repo)
    assert.equal(trustRoot(plain), plain)
    assert.deepEqual(findRepositories(root, 4), [repo])
    assert.equal(trustFolders(config, [trustRoot(inner), plain]), 2)
    assert.equal(trustFolders(config, [repo]), 0)

    const saved = JSON.parse(readFileSync(config, 'utf8'))

    assert.equal(saved.numStartups, 7)
    assert.deepEqual(saved.projects['C:/kept'].allowedTools, ['x'])
    assert.equal(saved.projects[projectKey(repo)].hasTrustDialogAccepted, true)
    assert.equal(saved.projects[projectKey(plain)].hasTrustDialogAccepted, true)
    assert.ok(!projectKey(repo).includes('\\'))
    assert.equal(trustFolders(join(root, 'missing.json'), [repo]), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const TAILNET_STATUS = JSON.stringify({
  Self: { DNSName: 'desk.tail1.ts.net.', HostName: 'DESK', UserID: 7, OS: 'windows' },
  User: { '7': { LoginName: 'me@example.com' } },
  Peer: {
    a: { DNSName: 'office.tail1.ts.net.', HostName: '사무실', UserID: 7, OS: 'windows', Online: true },
    b: { DNSName: 'laptop.tail1.ts.net.', HostName: 'LAPTOP', UserID: 7, OS: 'windows', Online: false },
    c: { DNSName: 'phone.tail1.ts.net.', HostName: 'Phone', UserID: 7, OS: 'android', Online: true },
    d: { DNSName: 'server.tail1.ts.net.', HostName: 'srv', UserID: 7, OS: 'linux', Online: true, Tags: ['tag:server'] },
    e: { DNSName: 'friend.tail1.ts.net.', HostName: 'friend', UserID: 9, OS: 'windows', Online: true },
  },
})

test('the tailnet gives this PC, its owner and the owner\'s own computers', () => {
  const tailnet = parseTailnet(TAILNET_STATUS)

  assert.equal(tailnet?.owner, 'me@example.com')
  assert.deepEqual(tailnet?.self, { name: 'desk', dns: 'desk.tail1.ts.net', online: true })
  assert.deepEqual(tailnet?.peers.map((peer) => peer.name), ['office', 'laptop'])
  assert.equal(parseTailnet('not json'), null)
  assert.deepEqual(configFor(tailnet, 47190), { owner: 'me@example.com', hosts: ['desk.tail1.ts.net:8449'], port: 47190 })
  assert.deepEqual(configFor(null, 47190), { owner: '', hosts: [], port: 47190 })
})

test('PCs running ChoiTerm are listed, and one seen before stays listed while off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choiterm-machines-'))
  const file = join(root, 'machines.json')
  let now = 0
  let answering = new Set(['https://office.tail1.ts.net:8449/'])
  const probed: string[] = []
  const machines = () =>
    createMachines({
      file,
      read: async () => TAILNET_STATUS,
      probe: async (url) => {
        probed.push(url)

        return answering.has(url) ? { sessions: 3, busy: 1 } : null
      },
      now: () => now,
    })

  try {
    const first = machines()

    assert.deepEqual(await first.list(), [
      { name: 'desk', url: 'https://desk.tail1.ts.net:8449/', online: true, here: true, sessions: null, busy: null },
      { name: 'office', url: 'https://office.tail1.ts.net:8449/', online: true, here: false, sessions: 3, busy: 1 },
    ])
    // Only online computers are asked; the offline laptop and the phone never are.
    assert.deepEqual(probed, ['https://office.tail1.ts.net:8449/'])

    // Cached for a while, then asked again: office stopped answering but stays, greyed out.
    await first.list()
    assert.equal(probed.length, 1)
    answering = new Set()
    now = 60_000

    const later = await first.list()

    assert.deepEqual(later[1], { name: 'office', url: 'https://office.tail1.ts.net:8449/', online: false, here: false, sessions: null, busy: null })

    // Remembered on disk for the next start.
    assert.equal((await machines().list())[1]?.name, 'office')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ChoiTerm\'s hooks go in beside everyone else\'s and replace its older ones', () => {
  const others: JsonObject = {
    Stop: [{ hooks: [{ type: 'command', command: 'other.cmd' }] }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '"C:/Users/x/.choiterm/app/node/node.exe" "C:/Users/x/.choiterm/app/server/hook.ts"' }, { type: 'command', command: 'keep.cmd' }] }],
  }
  const node = String.raw`C:\Users\x\.choiterm\app\node\node.exe`
  const hook = String.raw`C:\Users\x\.choiterm\app\server\hook.ts`
  const app = String.raw`C:\Users\x\.choiterm\app`
  const added = withOurHooks(others, app, node, hook)
  const command = '"C:/Users/x/.choiterm/app/node/node.exe" --no-warnings "C:/Users/x/.choiterm/app/server/hook.ts"'

  assert.deepEqual(added.Stop, [{ hooks: [{ type: 'command', command: 'other.cmd' }] }, { hooks: [{ type: 'command', command, timeout: 5 }] }])
  assert.deepEqual(added.PreToolUse, [{ matcher: '*', hooks: [{ type: 'command', command: 'keep.cmd' }] }, { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command, timeout: 5 }] }])
  assert.deepEqual(Object.keys(added).sort(), ['Notification', 'PreToolUse', 'SessionStart', 'Stop'])
  // Adding twice changes nothing; taking them out leaves only the others.
  assert.deepEqual(withOurHooks(added, app, node, hook), added)
  assert.deepEqual(withoutOurHooks(added, app), { Stop: others.Stop, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'keep.cmd' }] }] })
})

test('/hello says ChoiTerm runs here and /machines lists the PCs', async () => {
  const sessions = createSessions(fakeSpawner().spawn, () => {})
  const local: Settings = { ...settings, port: 47980 }
  const list = [{ name: 'office', url: 'https://office.tail1.ts.net:8449/', online: true, here: false, sessions: 2, busy: 0 }]
  const running = startServer(local, sessions, new Map(), () => {}, { version: '9.9.9', machines: { list: async () => list } })

  await new Promise((resolve) => running.server.once('listening', resolve))

  try {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${local.port}/hello`)).json(), { app: 'choiterm', version: '9.9.9', url: 'https://pc.ts.net:8449/', sessions: 0, busy: 0 })
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${local.port}/machines`)).json(), { machines: list })
  } finally {
    await new Promise((resolve) => running.server.close(resolve))
  }
})

test('git tells a session\'s project and branch, worktrees grouped under their main repository', () => {
  assert.deepEqual(parseRevParse('C:\\work\\app', 'C:/work/app\n.git\nmain\n'), { project: 'C:\\work\\app', name: 'app', root: 'C:\\work\\app', branch: 'main', worktree: false })
  assert.deepEqual(parseRevParse('C:\\work\\app.worktrees\\fix', 'C:/work/app.worktrees/fix\nC:/work/app/.git\nfix/login\n'), {
    project: 'C:\\work\\app',
    name: 'app',
    root: 'C:\\work\\app.worktrees\\fix',
    branch: 'fix/login',
    worktree: true,
  })
  assert.equal(parseRevParse('C:\\x', ''), null)
  assert.equal(cleanBranch('  fix login page!  '), 'fix-login-page')
  assert.equal(cleanBranch('feat/모바일 화면'), 'feat/모바일-화면')
  assert.equal(cleanBranch('../escape'), 'escape')
  assert.equal(cleanBranch('a/../b'), null)
  assert.equal(cleanBranch('///'), null)
  assert.equal(worktreeFolder('C:\\work\\app', 'feat/mobile'), 'C:\\work\\app.worktrees\\feat-mobile')
})

test('a session\'s web servers are the ports its own processes listen on', () => {
  const table = parseProcessTable(JSON.stringify({
    listen: [{ port: 3000, pid: 30 }, { port: 47190, pid: 30 }, { port: 5173, pid: 99 }, { port: 9229, pid: 31 }, { port: 135, pid: 30 }, { port: 4000, pid: 40 }],
    procs: [
      { pid: 10, ppid: 1, name: 'powershell.exe' },
      { pid: 20, ppid: 10, name: 'pnpm.exe' },
      { pid: 30, ppid: 20, name: 'node.exe' },
      { pid: 31, ppid: 10, name: 'claude.exe' },
      { pid: 40, ppid: 40, name: 'loop.exe' },
      { pid: 99, ppid: 1, name: 'node.exe' },
    ],
  }))

  assert.ok(table !== null)
  // Its own node on 3000; not ChoiTerm's port, not a low port, not the agent's own, not someone else's.
  assert.deepEqual(portsBySession(table, new Map([['s1', 10], ['s2', 40]]), new Set([47190])), new Map([['s1', [3000]], ['s2', [4000]]]))
  assert.equal(parseProcessTable('nope'), null)
})

test('a Codex tab resumes the newest conversation kept in its folder, each one once', () => {
  assert.deepEqual(parseRolloutHead('{"type":"session_meta","payload":{"id":"abc","cwd":"C:\\\\work"}}\n{"type":"x"}'), { id: 'abc', cwd: 'C:\\work' })
  assert.equal(parseRolloutHead('{"type":"event"}'), null)

  const rollouts = [
    { id: 'old', cwd: 'C:\\work', modified: 1 },
    { id: 'new', cwd: 'c:\\work\\', modified: 5 },
    { id: 'other', cwd: 'C:\\else', modified: 9 },
  ]

  assert.equal(pickRollout(rollouts, 'C:\\work', new Set()), 'new')
  assert.equal(pickRollout(rollouts, 'C:\\work', new Set(['new'])), 'old')
  assert.equal(pickRollout(rollouts, 'C:\\none', new Set()), null)
})

test('agents a PC lacks are listed as not installed; a plain shell always is', async () => {
  const check = createAgentCheck(async (command) => command === 'claude' || command === 'codex', () => 0)
  const states = await check()

  assert.equal(states.find((agent) => agent.id === 'claude')?.installed, true)
  assert.equal(states.find((agent) => agent.id === 'codex')?.installed, true)
  assert.equal(states.find((agent) => agent.id === 'grok')?.installed, false)
  assert.equal(states.find((agent) => agent.id === 'shell')?.installed, true)
  assert.equal(isAgentId('codex'), true)
  assert.equal(isAgentId('rm -rf'), false)
  assert.deepEqual(parseClientMessage('{"t":"new","kind":"codex","cols":80,"rows":24,"cwd":"C:\\\\work"}'), { t: 'new', kind: 'codex', cols: 80, rows: 24, cwd: 'C:\\work' })
  assert.equal(parseClientMessage('{"t":"new","kind":"evil","cols":80,"rows":24}'), null)
  assert.deepEqual(parseClientMessage('{"t":"new","kind":"shell","cols":80,"rows":24,"cwd":"relative"}'), { t: 'new', kind: 'shell', cols: 80, rows: 24, cwd: null })
  assert.deepEqual(parseClientMessage('{"t":"worktree","kind":"claude","project":"C:\\\\work\\\\app","branch":"fix login","cols":80,"rows":24}'), {
    t: 'worktree',
    kinds: ['claude'],
    project: 'C:\\work\\app',
    branch: 'fix-login',
    base: null,
    prompt: null,
    cols: 80,
    rows: 24,
  })
  // A task fanned out to several agents, with its prompt; unknown and repeated agents are dropped.
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'worktree', kinds: ['claude', 'codex', 'claude', 'evil'], project: 'C:\\work', branch: 'feat/x', base: 'dev', prompt: '결제 고쳐줘', cols: 80, rows: 24 })), {
    t: 'worktree',
    kinds: ['claude', 'codex'],
    project: 'C:\\work',
    branch: 'feat/x',
    base: 'dev',
    prompt: '결제 고쳐줘',
    cols: 80,
    rows: 24,
  })
  assert.equal(parseClientMessage(JSON.stringify({ t: 'worktree', kinds: [], project: 'C:\\work', branch: 'x', cols: 80, rows: 24 })), null)
  assert.equal(parseClientMessage('{"t":"worktree","kind":"claude","project":"C:\\\\work","branch":"../..","cols":80,"rows":24}'), null)
})

test('a preview gets a proxy and a tailnet port once, and gives them back when its server is gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choiterm-previews-'))
  const served: string[] = []
  const closed: string[] = []
  let proxies = 0
  let now = 0
  const previews = createPreviews({
    file: join(root, 'previews.json'),
    host: 'pc.ts.net',
    proxy: async (target) => {
      proxies += 1

      const url = `http://127.0.0.1:${50000 + proxies}`

      return { url, close: () => closed.push(target) }
    },
    serve: async (port, target) => {
      served.push(`${port} ${target}`)

      return true
    },
    unserve: async (port) => {
      served.push(`off ${port}`)
    },
    now: () => now,
  })

  try {
    assert.deepEqual(await previews.open(3000, 'http://127.0.0.1:3000'), { local: 'http://127.0.0.1:50001/', tailnet: 'https://pc.ts.net:8460/' })
    assert.deepEqual(await previews.open(3000, 'http://127.0.0.1:3000'), { local: 'http://127.0.0.1:50001/', tailnet: 'https://pc.ts.net:8460/' })
    assert.deepEqual(await previews.open(5173, 'http://[::1]:5173'), { local: 'http://127.0.0.1:50002/', tailnet: 'https://pc.ts.net:8461/' })
    // The tailnet serves the proxy, not the dev server itself.
    assert.deepEqual(served, ['8460 http://127.0.0.1:50001', '8461 http://127.0.0.1:50002'])
    now = 60_000
    await previews.sweep(new Set([3000]))
    assert.equal(served.length, 2)
    now = 200_000
    await previews.sweep(new Set([3000]))
    assert.deepEqual(served.slice(2), ['off 8461'])
    assert.deepEqual(closed, ['http://[::1]:5173'])
    assert.equal(previews.url(5173), null)
    assert.equal(previews.url(3000), 'https://pc.ts.net:8460/')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the preview proxy adds the annotate script to pages and passes everything else', async () => {
  const dev = createHttpServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>a</title></head></html>')
    } else if (req.url === '/go') {
      res.writeHead(302, { location: `http://127.0.0.1:${(dev.address() as AddressInfo).port}/` })
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ host: req.headers.host, encoding: req.headers['accept-encoding'] }))
    }
  })

  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve))

  // SAFETY: a server listening on a TCP port has an AddressInfo address.
  const target = `http://127.0.0.1:${(dev.address() as AddressInfo).port}`
  const proxy = await startProxy(target, () => 'window.annotated = 1')

  try {
    const page = await (await fetch(`${proxy.url}/`)).text()

    assert.equal(page, '<html><head><script src="/__choiterm__/annotate.js"></script><title>a</title></head></html>')
    assert.equal(await (await fetch(`${proxy.url}/__choiterm__/annotate.js`)).text(), 'window.annotated = 1')
    assert.deepEqual(await (await fetch(`${proxy.url}/api`)).json(), { host: target.slice(7), encoding: 'identity' })
    assert.equal((await fetch(`${proxy.url}/go`, { redirect: 'manual' })).headers.get('location'), '/')
    assert.equal(injectScript('plain'), '<script src="/__choiterm__/annotate.js"></script>plain')
  } finally {
    proxy.close()
    dev.close()
  }
})

test('Codex\'s limits come from the newest conversation file\'s last count', () => {
  const line = (used: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1800000000 }, secondary: { used_percent: 8, window_minutes: 10080, resets_at: null } } } })

  assert.deepEqual(parseCodexLimits(`${line(5)}\n{"type":"x"}\n${line(12)}\n{"cut`), [
    { kind: 'five_hour', percent: 12, resetsAt: new Date(1800000000 * 1000).toISOString() },
    { kind: 'seven_day', percent: 8, resetsAt: null },
  ])
  assert.equal(parseCodexLimits('{"type":"x"}'), null)
  assert.deepEqual(currentLimit({ kind: 'five_hour', percent: 40, resetsAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-01-02')), { kind: 'five_hour', percent: 0, resetsAt: null })
  assert.equal(currentLimit({ kind: 'five_hour', percent: 40, resetsAt: '2026-01-03T00:00:00.000Z' }, Date.parse('2026-01-02')).percent, 40)
})

test('git changes, search hits and GitHub tasks are read from their command output', () => {
  assert.deepEqual(parseStatus(' M web/app.js\0?? new file.md\0R  b.ts\0a.ts\0'), [
    { path: 'web/app.js', index: ' ', work: 'M' },
    { path: 'new file.md', index: '?', work: '?' },
    { path: 'b.ts', index: 'R', work: ' ' },
  ])
  assert.deepEqual(parseHits('.\\src\\a.ts:12:const x = 1\nweb/b.js:3:hello: world\nnot a hit'), [
    { path: 'src\\a.ts', line: 12, text: 'const x = 1' },
    { path: 'web/b.js', line: 3, text: 'hello: world' },
  ])

  const tasks = parseTasks(
    JSON.stringify([{ number: 7, title: '모바일 페이지', url: 'https://x/7', headRefName: 'feat/mobile', author: { login: 'me' }, updatedAt: 't', isDraft: true }]),
    JSON.stringify([{ number: 9, title: '알림 버그', url: 'https://x/9', author: null }, { title: 'no number' }]),
  )

  assert.deepEqual(tasks.map((task) => [task.kind, task.number, task.branch, task.author, task.draft]), [['pr', 7, 'feat/mobile', 'me', true], ['issue', 9, null, '', false]])
  assert.deepEqual(parseTasks('nope', ''), [])
})

test('saving a file refuses when it changed on disk since it was opened', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choiterm-write-'))
  const file = join(root, 'plan.md')

  try {
    writeFileSync(file, 'one')

    const opened = await readText(file)

    assert.ok(opened !== null && 'modified' in opened)

    const saved = await writeText(file, 'two', opened.modified)

    assert.ok(saved !== null && !('conflict' in saved))
    assert.equal(readFileSync(file, 'utf8'), 'two')

    const stale = await writeText(file, 'three', opened.modified - 5000)

    assert.ok(stale !== null && 'conflict' in stale)
    assert.equal(readFileSync(file, 'utf8'), 'two')
    assert.ok((await writeText(join(root, 'new.md'), 'fresh', null)) !== null)
    assert.equal(await writeText(join(root, 'no', 'such', 'x.md'), 'x', null), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the file view lists folders first, reads text, and shows other files sandboxed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choiterm-files-'))
  const sessions = createSessions(fakeSpawner().spawn, () => {})
  const local: Settings = { ...settings, port: 47979 }
  const running = startServer(local, sessions, new Map(), () => {})

  await new Promise((resolve) => running.server.once('listening', resolve))

  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'b10.txt'), '\uFEFF열 번째')
    writeFileSync(join(root, 'b9.txt'), 'nine')
    writeFileSync(join(root, 'page.html'), '<script>alert(1)</script>')
    writeFileSync(join(root, 'blob.bin'), Buffer.from([1, 0, 2]))

    const base = `http://127.0.0.1:${local.port}`
    const list = await (await fetch(`${base}/fs/list?path=${encodeURIComponent(root)}`)).json()

    assert.deepEqual(list.entries.map((entry: { name: string }) => entry.name), ['src', 'b9.txt', 'b10.txt', 'blob.bin', 'page.html'])

    const text = await (await fetch(`${base}/fs/read?path=${encodeURIComponent(join(root, 'b10.txt'))}`)).json()

    assert.equal(text.file.text, '열 번째')
    assert.equal((await (await fetch(`${base}/fs/read?path=${encodeURIComponent(join(root, 'blob.bin'))}`)).json()).file.binary, true)

    const raw = await fetch(`${base}/fs/raw?path=${encodeURIComponent(join(root, 'page.html'))}`)

    assert.equal(raw.headers.get('content-type'), 'application/octet-stream')
    assert.equal(raw.headers.get('content-security-policy'), 'sandbox')
    await raw.arrayBuffer()
    assert.equal((await fetch(`${base}/fs/list?path=relative`)).status, 400)
    assert.equal(looksBinary(Buffer.from('plain')), false)
  } finally {
    await new Promise((resolve) => running.server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})

test('a project lists every worktree, its own checkout first; added projects are kept', async () => {
  const listing = 'worktree C:/work/app\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/work/app.worktrees/fix\nHEAD 2\nbranch refs/heads/fix/login\n\nworktree C:/work/app.worktrees/old\nHEAD 3\ndetached\n'

  assert.deepEqual(parseWorktrees(listing), [
    { path: 'C:\\work\\app', branch: 'main', primary: true },
    { path: 'C:\\work\\app.worktrees\\fix', branch: 'fix/login', primary: false },
    { path: 'C:\\work\\app.worktrees\\old', branch: '', primary: false },
  ])

  const root = mkdtempSync(join(tmpdir(), 'choiterm-projects-'))
  const repos: Record<string, string> = { 'c:\\work\\app\\src': 'C:\\work\\app', 'c:\\work\\app': 'C:\\work\\app', 'c:\\other': 'C:\\other' }
  const make = () =>
    createProjects({
      file: join(root, 'projects.json'),
      repo: async (dir) => {
        const project = repos[dir.toLowerCase()]

        return project === undefined ? null : { project, name: 'x', root: project, branch: 'main', worktree: false }
      },
      worktrees: async (project) => (project === 'C:\\work\\app' ? parseWorktrees(listing) : project === 'C:\\other' ? [] : null),
    })

  try {
    const projects = make()

    assert.equal(await projects.add('C:\\work\\app\\src'), 'C:\\work\\app')
    assert.equal(await projects.add('C:\\not-a-repo'), null)

    const listed = await make().list(['C:\\other', 'c:\\work\\app'])

    assert.deepEqual(listed.map((project) => [project.name, project.worktrees.length]), [['app', 3], ['other', 0]])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file names for search: names that match before paths that do', () => {
  assert.deepEqual(filterFileNames(['src/app/page.tsx', 'web/app.js', 'app.js', 'README.md', ''].join('\n'), 'app'), ['web/app.js', 'app.js', 'src/app/page.tsx'])
  assert.deepEqual(filterFileNames('a.ts', ''), [])
})

test('a wider terminal joins a long line again but not rows that were padded to the edge', async () => {
  const screen = new headless.Terminal({ cols: 10, rows: 5, allowProposedApi: true })
  const write = (data: string) => new Promise<void>((resolve) => screen.write(data, resolve))
  const rows = () => {
    const out: string[] = []

    for (let index = 0; index < screen.buffer.active.length; index += 1) out.push((screen.buffer.active.getLine(index)?.translateToString(true) ?? '').trimEnd())

    return out.filter((row) => row !== '')
  }

  await write('abcdefghijklm\r\n')
  await write('xyz       NEXT\r\n')
  unwrapPadded(screen)
  screen.resize(20, 5)
  assert.deepEqual(rows(), ['abcdefghijklm', 'xyz', 'NEXT'])
  screen.dispose()
})

test('an agent without hooks has finished when a long run of output goes quiet; typing never counts', () => {
  const watch = createTurnWatch(6000, 3000)
  const seen: boolean[] = []

  // Typing: short bursts.
  for (const [busy, at] of [[true, 0], [false, 2000], [false, 6000], [true, 7000], [false, 9000], [false, 13000]] as const) seen.push(watch.see('a', busy, at))

  assert.ok(seen.every((done) => !done))

  // A turn: output for 10 seconds, then quiet for 3.
  for (let at = 20_000; at <= 30_000; at += 2000) assert.equal(watch.see('a', true, at), false)

  assert.equal(watch.see('a', false, 32_000), false)
  assert.equal(watch.see('a', false, 34_000), true)
  assert.equal(watch.see('a', false, 40_000), false)
})

test('an update finds the installed server by the port it listens on, not other ports or states', () => {
  const netstat = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:47190        0.0.0.0:0              LISTENING       4120',
    '  TCP    127.0.0.1:47190        127.0.0.1:50001        ESTABLISHED     4120',
    '  TCP    127.0.0.1:471900       0.0.0.0:0              LISTENING       77',
    '  TCP    0.0.0.0:47190          0.0.0.0:0              LISTENING       88',
    '  TCP    127.0.0.1:47191        0.0.0.0:0              LISTENING       99',
  ].join('\r\n')

  assert.deepEqual(listenerPids(netstat, 47190), [4120])
  assert.deepEqual(listenerPids('', 47190), [])
})

test('a PC report names the PC as a safe file name', () => {
  assert.deepEqual(parseMachineReport('{"machine":"office","text":"{\\"server\\":\\"ok\\"}"}'), { machine: 'office', text: '{"server":"ok"}' })
  assert.equal(parseMachineReport('{"machine":"../x","text":"a"}'), null)
  assert.equal(parseMachineReport('{"machine":"office"}'), null)
  assert.equal(parseMachineReport('not json'), null)
})

test('a PC answers /hello with its counts; a proxy error page is no ChoiTerm', () => {
  assert.deepEqual(parseHello('{"app":"choiterm","version":"1","url":"","sessions":4,"busy":2}'), { sessions: 4, busy: 2 })
  assert.deepEqual(parseHello('{"app":"choiterm","version":"0.8.0","url":""}'), { sessions: null, busy: null })
  assert.equal(parseHello('<html>502 Bad Gateway</html>'), null)
  assert.equal(parseHello('{"app":"other"}'), null)
})

test('branches: local ones first, remote ones only when no local branch has the name', async () => {
  assert.deepEqual(parseBranches('main\nfeature/login\norigin/HEAD\norigin/main\norigin/fix-a\norigin\n'), ['main', 'feature/login', 'origin/fix-a'])

  const calls: string[][] = []
  const git = async (args: string[]): Promise<string | null> => {
    calls.push(args)

    if (args[0] === 'for-each-ref') return 'main\ndev\n'
    if (args[0] === 'symbolic-ref') return 'origin/main\n'

    return 'dev\n'
  }

  assert.deepEqual(await listBranches('C:\\work\\app', git), { branches: ['main', 'dev'], base: 'main' })
  assert.equal(await addWorktree('C:\\work\\nowhere', 'fix', 'dev', async (args) => {
    calls.push(args)

    return ''
  }), 'C:\\work\\nowhere.worktrees\\fix')
  assert.deepEqual(calls.at(-1)?.slice(0, 3), ['worktree', 'add', '-b'])
  assert.equal(calls.at(-1)?.at(-1), 'dev')
})

test('a new project: a safe folder name in the home folder, a repository with a first commit', async () => {
  assert.equal(cleanProjectName('  my app  '), 'my app')
  assert.equal(cleanProjectName('새 프로젝트'), '새 프로젝트')
  assert.equal(cleanProjectName('../up'), null)
  assert.equal(cleanProjectName('a\\b'), null)
  assert.equal(cleanProjectName(''), null)

  const parent = mkdtempSync(join(tmpdir(), 'choiterm-new-project-'))
  const calls: string[][] = []

  try {
    const folder = await createProject(parent, 'demo', async (args) => {
      calls.push(args)

      return args[0] === 'config' ? 'me@example.com\n' : ''
    })

    assert.equal(folder, join(parent, 'demo'))
    assert.deepEqual(calls[0], ['init', '-b', 'main'])
    assert.deepEqual(calls[2], ['commit', '--allow-empty', '-m', '시작'])
    assert.equal(await createProject(parent, '../escape', async () => ''), null)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('the folder picker script quotes what it is given', () => {
  const script = pickerScript("C:\\Users\\o'neil", "it's")

  assert.ok(script.includes("'C:\\Users\\o''neil'"))
  assert.ok(script.includes("'it''s'"))
  assert.ok(script.includes('PICK_FOLDERS'))
})

test('a worktree agent\'s turn end commits its changes, and only when there are any', async () => {
  const calls: string[][] = []
  const git = (status: string) => async (args: string[]): Promise<string | null> => {
    calls.push(args)

    if (args[0] === 'config') return 'me@example.com\n'

    return args[0] === 'status' ? status : ''
  }

  assert.equal(await autoCommit('C:\\w', 0, git('')), null)
  assert.equal(calls.length, 1)

  const saved = await autoCommit('C:\\w', new Date(2026, 9, 19, 21, 5).getTime(), git(' M a.ts\n?? b.ts\n'))

  assert.deepEqual(saved, { files: 2 })
  assert.deepEqual(calls.at(-3), ['add', '-A'])
  assert.deepEqual(calls.at(-1), ['commit', '-m', '자동 저장 21:05'])
})

test('a PC where git has no name and email yet still commits, as its own user', async () => {
  assert.deepEqual(await identity('C:\\w', async () => 'me@example.com\n'), [])

  const stand = await identity('C:\\w', async () => null)

  assert.equal(stand[0], '-c')
  assert.match(stand[1] ?? '', /^user\.name=.+/)
  assert.match(stand[3] ?? '', /^user\.email=.+@.+\.local$/)
})

test('a plain folder becomes a git project, never a drive or the home folder', async () => {
  const home = 'C:\\Users\\me'

  assert.equal(tooWideForProject('C:\\', home), true)
  assert.equal(tooWideForProject('D:\\', home), true)
  assert.equal(tooWideForProject('C:\\Users\\me', home), true)
  assert.equal(tooWideForProject('C:\\Users\\me\\Desktop\\', home), true)
  assert.equal(tooWideForProject('C:\\Users', home), true)
  assert.equal(tooWideForProject('C:\\Program Files\\App', home), true)
  assert.equal(tooWideForProject('C:\\Users\\me\\Desktop\\app', home), false)
  assert.equal(tooWideForProject('C:\\Users\\me\\work', home), false)

  const root = mkdtempSync(join(tmpdir(), 'choiterm-init-'))
  const folder = join(root, 'app')

  try {
    mkdirSync(join(folder, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(folder, 'index.js'), 'hi')
    writeFileSync(join(folder, '.env'), 'SECRET=1')
    writeFileSync(join(folder, 'node_modules', 'x', 'a.js'), 'x')

    const made = await initProject(folder, 'C:\\nowhere')

    assert.deepEqual(made, { ok: true, folder })
    assert.ok(readFileSync(join(folder, '.gitignore'), 'utf8').includes('node_modules/'))

    const { execFileSync } = await import('node:child_process')
    const tracked = execFileSync('git', ['ls-files'], { cwd: folder, encoding: 'utf8' }).trim().split('\n').sort()

    assert.deepEqual(tracked, ['.gitignore', 'index.js'])
    // Again: already a repository, nothing more to do.
    assert.deepEqual(await initProject(folder, 'C:\\nowhere'), { ok: true, folder })

    // Far too many files: everything it made is taken away again.
    const big = join(root, 'big')

    mkdirSync(big)

    const tooMany = await initProject(big, 'C:\\nowhere', async (args, cwd) => {
      if (args[0] === 'rev-parse') return null

      if (args[0] === 'ls-files') return 'f\n'.repeat(25_000)

      if (args[0] === 'init') mkdirSync(join(cwd, '.git'))

      return ''
    })

    assert.deepEqual(tooMany, { ok: false, error: '파일이 너무 많아서 git으로 만들지 않았어요' })
    assert.equal(existsSync(join(big, '.git')), false)
    assert.equal(existsSync(join(big, '.gitignore')), false)
    assert.deepEqual(await initProject('C:\\Users\\me', 'C:\\Users\\me'), { ok: false, error: '폴더가 없어요' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('notes for the project\'s agent wait while it works and go in together', () => {
  const delivered: [string, string][] = []
  let busy = true
  const relay = createRelay({ busy: () => busy, alive: (id) => id !== 'gone', deliver: (id, text) => delivered.push([id, text]) })

  relay.post('main', 'one')
  relay.post('main', 'two')
  relay.post('gone', 'lost')
  assert.equal(relay.tick(), 0)
  assert.equal(relay.pending('main'), 2)
  assert.equal(relay.pending('gone'), 0)
  busy = false
  assert.equal(relay.tick(), 2)
  assert.deepEqual(delivered, [['main', 'one\n\ntwo']])
  assert.equal(relay.tick(), 0)
})

test('the notes say what happened where', () => {
  assert.ok(createdNote({ branch: 'login-fix', base: 'main', agent: 'Codex', folder: 'C:\\p.worktrees\\login-fix' }).includes('main에서 시작'))
  assert.ok(turnNote({ name: 'login-fix', branch: 'login-fix', agent: 'Codex', folder: 'C:\\x', saved: { files: 3 }, ahead: 2, base: 'main' }).includes('파일 3개'))
  assert.ok(turnNote({ name: 'x', branch: 'x', agent: 'Codex', folder: 'C:\\x', saved: null, ahead: null, base: 'main' }).includes('바뀐 파일 없음'))
})

test('a squash merge makes one commit of the branch', async () => {
  const calls: string[][] = []

  assert.equal(await mergeToProject('C:\\p', 'feat', true, async (args) => {
    calls.push(args)

    return ''
  }), true)
  assert.deepEqual(calls[0], ['merge', '--squash', 'feat'])
  assert.deepEqual(calls[1], ['commit', '-m', 'feat 병합'])
})

test('unsent input is followed key by key: Enter sends it, LF is a new line, keys that move are skipped', () => {
  assert.equal(applyInput('', '안녕 hello'), '안녕 hello')
  assert.equal(applyInput('abc', '\x7f'), 'ab')
  assert.equal(applyInput('한글', '\x7f'), '한')
  assert.equal(applyInput('fix the bug', '\x17'), 'fix the ')
  assert.equal(applyInput('line one', '\nline two'), 'line one\nline two')
  assert.equal(applyInput('send me', '\r'), '')
  assert.equal(applyInput('typed', '\x15'), '')
  assert.equal(applyInput('ab', '\x1b[D\x1b[1;5C\x1bOAc'), 'abc')
  assert.equal(applyInput('', '\x1b[200~pasted\r\nlines\x1b[201~'), 'pasted\nlines')
  assert.equal(applyInput('x', '\x1b'), 'x')
})

test('drafts are kept on disk and survive a restart; an ended session\'s goes', () => {
  const root = mkdtempSync(join(tmpdir(), 'choiterm-drafts-'))
  const file = join(root, 'drafts.json')

  try {
    const first = createDrafts(file)

    first.feed('a', '반쯤 쓴 질문')
    first.feed('b', 'gone')
    first.forget('b')
    first.flush()

    const second = createDrafts(file)

    assert.equal(second.get('a'), '반쯤 쓴 질문')
    assert.equal(second.get('b'), '')
    second.feed('a', '\r')
    assert.equal(second.get('a'), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('github: the device code and the repository list are read from gh', () => {
  assert.deepEqual(parseSignIn('! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n'), { code: 'AB12-CD34', url: 'https://github.com/login/device' })
  assert.deepEqual(parseSignIn('\n! One-time code (1E91-D12B) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n'), { code: '1E91-D12B', url: 'https://github.com/login/device' })
  assert.equal(parseSignIn('- Waiting for login...'), null)
  assert.deepEqual(parseRepos('{"n":"me/app","d":null,"p":true,"t":"2026-10-01T00:00:00Z"}\nnot json\n{"n":"org/site","d":"web","p":false,"t":"2026-10-02T00:00:00Z"}\n'), [
    { name: 'me/app', description: '', private: true, pushed: '2026-10-01T00:00:00Z' },
    { name: 'org/site', description: 'web', private: false, pushed: '2026-10-02T00:00:00Z' },
  ])
  assert.equal(cleanRepoName('me/my.app-2'), 'me/my.app-2')
  assert.equal(cleanRepoName('me/..'), null)
  assert.equal(cleanRepoName('me/app; rm'), null)
  assert.equal(cleanRepoName('../x'), null)
})

test('github: state, sign-in by code, cached repositories and cloning', async () => {
  const home = mkdtempSync(join(tmpdir(), 'choiterm-gh-'))
  const calls: string[][] = []
  let signedIn = false
  let listed = 0
  let clock = 0
  const answer = (out: string, ok = true): GhResult => ({ ok, out, missing: false })

  const run = (args: string[]): Promise<GhResult> => {
    calls.push(args)

    if (args[0] === 'api' && args[1] === 'user') return Promise.resolve(signedIn ? answer('me\n') : answer('', false))

    if (args[0] === 'api') {
      listed += 1

      return Promise.resolve(answer('{"n":"me/old","d":"","p":false,"t":"2026-01-01T00:00:00Z"}\n{"n":"me/new","d":"","p":true,"t":"2026-09-01T00:00:00Z"}\n'))
    }

    if (args[0] === 'repo' && args[1] === 'clone') {
      mkdirSync(args[3], { recursive: true })

      return Promise.resolve(answer(''))
    }

    return Promise.resolve(answer(''))
  }

  let output: (text: string) => void = () => {}
  let exit: (ok: boolean) => void = () => {}
  const typed: string[] = []

  const login: SignInProcess = {
    onOutput: (listener) => { output = listener },
    onExit: (listener) => { exit = listener },
    write: (text) => typed.push(text),
    stop: () => {},
  }

  try {
    const github = createGithub(home, run, () => login, () => clock)

    assert.deepEqual(await github.state(), { installed: true, login: null, signIn: null })
    assert.equal(await github.repos(false), null)

    const asked = github.signIn()

    output('! First copy your one-time code: ')
    output('WXYZ-1234\n')
    assert.deepEqual(await asked, { code: 'WXYZ-1234', url: 'https://github.com/login/device' })
    assert.deepEqual(typed, ['\n'])
    // Asking again while it waits gives the same code, not a second gh.
    assert.deepEqual(await github.signIn(), { code: 'WXYZ-1234', url: 'https://github.com/login/device' })
    assert.deepEqual((await github.state()).signIn, { code: 'WXYZ-1234', url: 'https://github.com/login/device' })

    signedIn = true
    exit(true)
    assert.ok(calls.some((args) => args.join(' ') === 'auth setup-git'))
    assert.deepEqual(await github.state(), { installed: true, login: 'me', signIn: null })

    assert.deepEqual((await github.repos(false))?.map((repo) => repo.name), ['me/new', 'me/old'])
    await github.repos(false)
    assert.equal(listed, 1)
    clock += 61_000
    await github.repos(false)
    assert.equal(listed, 2)
    await github.repos(true)
    assert.equal(listed, 3)

    assert.deepEqual(await github.clone('me/new'), { ok: true, folder: join(home, 'new') })
    assert.deepEqual(calls.at(-1), ['repo', 'clone', 'me/new', join(home, 'new')])
    assert.deepEqual(await github.clone('me/new'), { ok: false, error: `${join(home, 'new')} 폴더가 이미 있어요` })
    assert.deepEqual(await github.clone('me/../x'), { ok: false, error: '저장소 이름이 이상해요' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('github: no gh on this PC', async () => {
  const github = createGithub(tmpdir(), () => Promise.resolve({ ok: false, out: '', missing: true }), () => null)

  assert.deepEqual(await github.state(), { installed: false, login: null, signIn: null })
  assert.equal(await github.signIn(), null)
})

test('notes: loose and per project, titled by their first line, removed only inside the notes folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'choiterm-notes-'))

  try {
    assert.equal(noteTitle('\n\n#  Plan for today\nmore', 'a.md'), 'Plan for today')
    assert.equal(noteTitle('', '2026-10-20-0100.md'), '2026-10-20-0100')

    const one = projectNotesFolder(root, 'C:\\work\\app')
    const other = projectNotesFolder(root, 'D:\\elsewhere\\app')

    assert.ok(one.startsWith(join(root, 'projects', 'app-')))
    assert.notEqual(one, other)
    assert.equal(projectNotesFolder(root, 'c:\\WORK\\app'), one)

    writeFileSync(join(root, 'a.md'), '# A note')
    writeFileSync(join(root, 'skip.txt'), 'not a note')

    const listed = listNotes(root)

    assert.deepEqual(listed.map((each) => each.title), ['A note'])
    assert.deepEqual(listNotes(one), [])
    assert.ok(existsSync(one))

    const outside = join(tmpdir(), `choiterm-not-a-note-${Date.now()}.md`)

    writeFileSync(outside, 'keep')
    assert.equal(deleteNote(root, outside), false)
    assert.ok(existsSync(outside))
    rmSync(outside)
    assert.equal(deleteNote(root, join(root, 'skip.txt')), false)
    assert.equal(deleteNote(root, join(root, '..', 'a.md')), false)
    assert.equal(deleteNote(root, join(root, 'a.md')), true)
    assert.equal(existsSync(join(root, 'a.md')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
