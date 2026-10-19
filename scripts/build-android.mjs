// `npm run build:android`: the phone app's APK, into android/dist (the PC's server hands the newest
// one out at /ChoiTerm.apk). Needs JDK 21 (JAVA_HOME) and the Android SDK (ANDROID_HOME, or
// sdk.dir in android/local.properties). Without your own release key the debug key signs it.
// Build your PC's address in with -Pchoiterm.home=... in ~/.gradle/gradle.properties, or leave it
// out and the app asks on its first start.
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const android = join(root, 'android')
// By full path: Windows may be set not to run programs from the current folder.
const gradle = join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')

execSync(`"${gradle}" assembleRelease`, { cwd: android, stdio: 'inherit' })

const version = readFileSync(join(android, 'app', 'build.gradle.kts'), 'utf8').match(/versionName = "([^"]+)"/)?.[1] ?? 'dev'
const apk = `ChoiTerm-${version}.apk`

mkdirSync(join(android, 'dist'), { recursive: true })
copyFileSync(join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'), join(android, 'dist', apk))
console.log(`\napk: android/dist/${apk}`)
