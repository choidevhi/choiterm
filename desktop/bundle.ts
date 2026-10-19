// Gathers what the PC program ships so any PC it is installed on can run the server too: the
// server's code and page, only the packages it loads at run time (node-pty for this OS, without
// debug symbols or tests), the choiterm-status mod, and the Node running this script.
// Run before `npx tauri build`; the program runs install.ts from here at start (see lib.rs).
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = dirname(fileURLToPath(import.meta.url))
const root = join(desktop, '..')
const out = join(desktop, 'bundle')
const server = join(out, 'server')
const modules = join(root, 'node_modules')
const PACKAGES = ['ws', '@xterm/xterm', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11', '@xterm/addon-fit', '@xterm/addon-search', '@fontsource/noto-sans-symbols-2', '@fontsource-variable/geist', 'marked', 'html2canvas']
const PTY_BUILD = `prebuilds/${process.platform}-${process.arch}`

rmSync(out, { recursive: true, force: true })
mkdirSync(server, { recursive: true })

for (const name of readdirSync(root)) {
  if ((name.endsWith('.ts') && !name.endsWith('.test.ts')) || name === 'package.json') copyFileSync(join(root, name), join(server, name))
}

cpSync(join(root, 'web'), join(server, 'web'), { recursive: true })
cpSync(join(root, 'mod'), join(server, 'mod'), { recursive: true, filter: (source) => !source.includes(join('choiterm-status', 'test')) })

for (const name of PACKAGES) cpSync(join(modules, name), join(server, 'node_modules', name), { recursive: true })

const pty = join(modules, 'node-pty')
const ptyOut = join(server, 'node_modules', 'node-pty')
const keep = (source: string): boolean => !/\.(pdb|map)$|\.test\.js$/.test(source)

mkdirSync(ptyOut, { recursive: true })
copyFileSync(join(pty, 'package.json'), join(ptyOut, 'package.json'))
cpSync(join(pty, 'lib'), join(ptyOut, 'lib'), { recursive: true, filter: keep })
cpSync(join(pty, PTY_BUILD), join(ptyOut, PTY_BUILD), { recursive: true, filter: keep })

// highlight.js ships every language as its own file; the page loads only the one bundle.
const highlight = join(server, 'node_modules', '@highlightjs', 'cdn-assets')

mkdirSync(join(highlight, 'es'), { recursive: true })
copyFileSync(join(modules, '@highlightjs', 'cdn-assets', 'package.json'), join(highlight, 'package.json'))
copyFileSync(join(modules, '@highlightjs', 'cdn-assets', 'es', 'highlight.min.js'), join(highlight, 'es', 'highlight.min.js'))

mkdirSync(join(out, 'node'), { recursive: true })
copyFileSync(process.execPath, join(out, 'node', 'node.exe'))
console.log(`bundled the server and Node ${process.version} into ${out}`)
