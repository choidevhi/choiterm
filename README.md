# ChoiTerm

**One terminal for your PC and your phone.** Run Claude Code, Codex and other CLI agents on your Windows PC, split work into git worktrees, and pick any session up from your phone over Tailscale. The interface is in Korean.

PC와 폰이 같은 터미널을 같이 보고 같이 입력하는 도구예요. Claude Code, Codex 같은 CLI 에이전트를 PC에서 돌리고, 일을 git 워크트리로 나누고, 폰에서 Tailscale로 이어서 써요.

## 무엇이 되나

- **세션은 PC 서버 안에 살아 있어요.** 창을 닫아도 계속 돌고, 서버나 PC를 다시 켜도 같은 세션으로 열려요. Claude Code는 `claude --resume`, Codex는 `codex resume`으로 대화를 이어 가요. 입력하다 만 글도 다시 입력창에 들어가요.
- **PC와 폰이 같은 화면을 봐요.** PC는 사이드바·탭·상태 줄이 있는 창이고, 폰은 데스크톱 목록 → 작업 공간 목록 → 세션 화면이에요. 입력칸과 키 줄(Esc, Tab, 화살표, Ctrl 등)이 따로 있어요.
- **에이전트:** Claude Code, Codex, Grok, Gemini, OpenCode, Cursor, GitHub Copilot, Qwen Code, PowerShell. PC에 설치된 것만 켜져요.
- **워크트리 협업:** 새 작업 공간(Ctrl+N)이 `<프로젝트>.worktrees/<이름>` 폴더와 브랜치를 만들고, 그 안에서 에이전트를 켜요. 에이전트가 턴을 끝내면 그 워크트리 변경을 자동으로 커밋하고, 프로젝트 기본 폴더의 에이전트에게 알려요. 다른 워크트리 변경 가져오기, 병합, 하나로 합쳐 병합도 돼요.
- **프로젝트:** 새로 만들기, 폴더 찾기, **GitHub에서 가져오기**(GitHub CLI로 로그인해 내 저장소를 찾고, 고르면 홈 폴더로 받아요). 순서는 이름순이고, 끌어서 바꿀 수 있어요.
- **파일:** 파일 트리, 이름·내용 검색, 코드를 바로 고치고 자동 저장, git 변경과 diff(줄마다 주석을 달아 에이전트에게 보내기), GitHub PR·이슈(`gh`).
- **미리보기:** 세션이 띄운 개발 서버를 버튼 하나로 열고, 폰에서도 Tailscale로 봐요. 화면 요소를 찍어 주석과 스크린샷을 에이전트에게 보내요.
- **이미지:** 세션에서 주고받은 이미지를 모아 보고, 터미널의 이미지 경로에 마우스를 올리면 바로 미리 봐요.
- **여러 PC:** PC 프로그램을 설치한 PC마다 서버가 생기고, 폰과 다른 PC에서 고르면 그 PC로 가요. 모든 PC의 알림이 폰으로 와요.
- **알림:** 턴이 끝나거나 질문이 오면 폰과 PC에 알림이 오고, 질문은 알림에서 바로 답해요.

## 필요한 것

- Windows 10/11 PC
- [Tailscale](https://tailscale.com): PC와 폰을 **같은 계정**으로 로그인. 페이지는 tailnet 안에서 그 계정에게만 열려요.
- 쓰고 싶은 에이전트 CLI (예: [Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex](https://github.com/openai/codex))
- GitHub에서 가져오기를 쓰려면 [GitHub CLI](https://cli.github.com) (`winget install GitHub.cli`). 로그인은 ChoiTerm 화면에서 해요.
- 안드로이드 폰 (iPhone은 브라우저로 `https://<PC>.<tailnet>.ts.net:8449`를 열면 돼요)

## 빠른 시작 (만들어진 파일로)

1. [Releases](../../releases)에서 `ChoiTerm_<버전>_x64-setup.exe`를 받아 PC에 설치해요. 처음 켤 때 알아서 서버를 설치하고(`~/.choiterm`), `tailscale serve --https=8449`를 열고, Claude Code 훅과 상태 줄 플러그인을 넣고, 서버를 켜요.
2. PC에서 ChoiTerm을 열고 사이드바 **홈**의 **폰 연결** 카드에서 주소를 확인해요 (`https://내PC.tailnet이름.ts.net:8449/`).
3. 같은 카드의 **APK 받기**(또는 Releases의 `ChoiTerm-<버전>.apk`)로 폰 앱을 설치하고, 첫 화면에 그 주소를 넣어요.

## 직접 빌드하기

```powershell
git clone https://github.com/choidevhi/choiterm
cd choiterm
npm install
npm test
```

**PC 설치 파일** (`desktop/dist/`): [Rust](https://rustup.rs)와 [Tauri 준비물](https://tauri.app/start/prerequisites/)이 필요해요.

```powershell
npm run build:desktop
```

**폰 앱** (`android/dist/`): JDK 21(`JAVA_HOME`)과 Android SDK(`ANDROID_HOME`)가 필요해요. 자기 서명 키가 없으면 디버그 키로 서명돼서 바로 설치돼요.

```powershell
npm run build:android
```

만든 설치 파일을 실행하면 위의 빠른 시작과 같아요. 서버는 만든 APK와 설치 파일을 `/ChoiTerm.apk`, `/ChoiTerm-setup.exe`로 내줘요.

### 서버만 바로 켜기 (개발용)

```powershell
npm start                                              # 처음엔 Tailscale 정보로 config.json을 만들어요
tailscale serve --bg --https=8449 http://127.0.0.1:47190
```

PC에서는 `http://127.0.0.1:47190`, 폰에서는 `https://<PC>.<tailnet>.ts.net:8449`로 열어요. `web/` 파일은 요청마다 다시 읽어서, 페이지를 고치면 새로 고침만 하면 돼요.

## 설정

- `config.json` (서버 폴더, 설치판은 `~/.choiterm`): `owner`(이 페이지를 열 수 있는 Tailscale 로그인), `hosts`(tailnet 주소), `port`. 처음 켤 때 자동으로 만들어져요. 예시는 `config.example.json`.
- 폰 앱에 PC 주소를 넣어 빌드하려면: `~/.gradle/gradle.properties`에 `choiterm.home=https://내PC.tailnet이름.ts.net:8449/`.
- PC 프로그램에 기본 PC를 넣어 빌드하려면: `CHOITERM_MAIN_SERVER=https://내PC.tailnet이름.ts.net:8449/`로 `npm run build:desktop`. 다른 PC들이 그 PC를 기본으로 열고 설치 결과를 알려요.
- 자동 커밋과 새 프로젝트의 첫 커밋은 그 PC의 git 설정(`user.name`, `user.email`)으로 만들어요.

## 구조

- 서버: Node 24 (TypeScript를 바로 실행), node-pty, xterm.js headless. `main.ts`가 시작점이고 `server.ts`(HTTP·WebSocket), `sessions.ts`, `drafts.ts`, `teamwork.ts`, `repo.ts` 등이 있어요.
- 페이지: `web/` (빌드 없이 바로 쓰는 ES 모듈). 아이콘은 `npm run icons`로 `web/icons.js`를 만들어요.
- PC 프로그램: `desktop/` (Tauri 2). 서버와 Node를 함께 묶어 설치해요.
- 폰 앱: `android/` (WebView, 알림 서비스).
- Claude Code 상태 줄 플러그인: `mod/choiterm-status`.

## 보안

페이지와 WebSocket은 이 PC(127.0.0.1)와, Tailscale을 거쳐 `config.json`의 `owner` 계정으로 들어온 요청만 받아요. 파일 쓰기, 업로드 같은 바꾸는 요청은 같은 페이지에서 온 것만 받아요. 공개 인터넷에 직접 열지 마세요.

## 라이선스

MIT. 같이 들어간 다른 것들의 라이선스는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 있어요.
