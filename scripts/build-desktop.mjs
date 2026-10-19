// `npm run build:desktop`: the PC program's installer, with the server, its page and Node inside,
// into desktop/dist. Needs Rust (rustup) and the Tauri prerequisites for Windows.
// Set CHOITERM_MAIN_SERVER=https://your-pc.your-tailnet.ts.net:8449/ to build in a main PC that
// other PCs fall back to and report to; without it each PC uses its own server.
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'desktop')
const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' })

run('node --no-warnings desktop/bundle.ts', root)
// The Tauri CLI is one of this package's dev dependencies (npm install).
run('npx --no-install tauri build', desktop)

const version = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8')).version
const built = join(desktop, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const installer = readdirSync(built).find((name) => name.includes(version) && name.endsWith('-setup.exe'))

if (installer === undefined) throw new Error(`no ${version} installer in ${built}`)

mkdirSync(join(desktop, 'dist'), { recursive: true })
copyFileSync(join(built, installer), join(desktop, 'dist', installer))
console.log(`\ninstaller: desktop/dist/${installer}`)
