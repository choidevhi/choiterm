// ChoiTerm on the PC as a program of its own: one window on a ChoiTerm page (this PC's server, or
// another of the owner's PCs over the tailnet), a tray icon, Windows notifications for finished
// turns and questions from every PC, one instance only, and a start at login. It also sets up and
// starts this PC's own server from what it ships (install.ts), so any PC it is installed on can
// be reached from the others.

pub mod notice;
pub mod servers;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

use crate::notice::{headline, parse_notice};
use crate::servers::{parse_machines, server_origin, startup_order, LOCAL_SERVER};

const LOCAL_ADDRESS: ([u8; 4], u16) = ([127, 0, 0, 1], 47190);
// The owner's main PC, tried when neither the last one shown nor this PC's answers, and told how
// setting up this PC went. Built in (CHOITERM_MAIN_SERVER=https://pc.tailnet.ts.net:8449/ when
// building); empty means none: this PC's own server is the one to use.
const MAIN_SERVER: &str = match option_env!("CHOITERM_MAIN_SERVER") {
    Some(server) => server,
    None => "",
};
const HIDDEN_FLAG: &str = "--hidden";
// A notification click starts the program again; within this long it opens that notice's session.
const OPEN_FROM_NOTICE_FOR: Duration = Duration::from_secs(120);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const MACHINES_EVERY: Duration = Duration::from_secs(300);
// While this PC's server is being set up, the waiting page gives it this long before trying others.
const INSTALL_WAIT_MS: u32 = 30_000;
const SERVER_CHECK_EVERY: Duration = Duration::from_secs(30);
const SERVER_CHECK_MAX: Duration = Duration::from_secs(600);
// Hides the console window of install.ts and its Node.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The server and session of the last notification shown, to open when the owner clicks it.
#[derive(Default)]
struct LastNotice(Mutex<Option<(String, String, Instant)>>);

/// What the program learned about the owner's PCs.
#[derive(Default)]
struct Known {
    // This PC's own tailnet address (its server's /hello), which the window shows as LOCAL_SERVER.
    own: Mutex<Option<String>>,
    // PC names by server, for notification titles.
    names: Mutex<HashMap<String, String>>,
    // Servers whose notices are already followed.
    listening: Mutex<HashSet<String>>,
}

// What install.ts printed: `server` is "ok" when it started (or restarted) this PC's server;
// `skipped` when this PC runs ChoiTerm from a clone, which the program leaves alone.
#[derive(Deserialize)]
struct Installed {
    #[serde(default)]
    server: String,
    skipped: Option<String>,
}

#[derive(Deserialize)]
struct Hello {
    url: String,
}

fn local_up() -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(LOCAL_ADDRESS), Duration::from_millis(400)).is_ok()
}

/// A test copy of the server to use instead (`CHOITERM_SERVER=http://127.0.0.1:47192/`), so trying
/// the program never resizes or touches the real sessions; such a run also leaves login, the
/// remembered PC and this PC's server alone.
fn test_server() -> Option<&'static str> {
    let url = std::env::var("CHOITERM_SERVER").ok()?;

    Url::parse(&url).ok()?;

    Some(Box::leak(url.into_boxed_str()))
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The server whose page the window shows now.
fn shown_server(app: &AppHandle) -> Option<String> {
    main_window(app)?.url().ok().and_then(|url| server_origin(&url))
}

fn log_line(app: &AppHandle, line: &str) {
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let line = format!("{line}\n");
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("choiterm-desktop.log")).and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
    }
}

fn last_server_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("last-server"))
}

/// The PC shown when the program was last used, so it opens there again.
fn last_server(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(last_server_file(app)?).ok()?;

    server_origin(&Url::parse(text.trim()).ok()?)
}

fn remember_server(app: &AppHandle, server: &str) {
    if let Some(file) = last_server_file(app) {
        let _ = std::fs::create_dir_all(file.parent().unwrap_or(&file));
        let _ = std::fs::write(file, server);
    }
}

fn quick_get(url: &str) -> Option<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().into();
    let mut response = agent.get(url).call().ok()?;

    response.body_mut().read_to_string().ok()
}

/// The server and its Node that the installer put beside the program.
fn bundled_server(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let resources = app.path().resource_dir().ok()?;
    let node = resources.join("node").join("node.exe");
    let script = resources.join("server").join("install.ts");

    (node.exists() && script.exists()).then_some((node, script))
}

// Sets this PC's server up the first time and after an update, else starts it if it is down; a PC
// running ChoiTerm from a clone is left alone (install.ts decides, and says what it did).
fn set_up_this_pc(app: &AppHandle) -> Option<Installed> {
    let (node, script) = bundled_server(app)?;
    let mut command = Command::new(node);

    // install.ts tells the main PC how it went, with this PC's server log.
    command.arg("--no-warnings").arg(script);

    if !MAIN_SERVER.is_empty() {
        command.env("CHOITERM_REPORT_TO", MAIN_SERVER);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.output() {
        Ok(out) => {
            let said = String::from_utf8_lossy(&out.stdout).trim().to_string();

            log_line(app, &format!("install {said}"));
            serde_json::from_str::<Installed>(&said).ok()
        }
        Err(error) => {
            log_line(app, &format!("install did not run: {error}"));
            None
        }
    }
}

// This PC's server is started again whenever it stops answering, however it went down.
// A server that keeps failing to start is tried less and less often (up to SERVER_CHECK_MAX), so a
// broken install does not start Node every half minute.
fn keep_server_up(app: &AppHandle) {
    let mut wait = SERVER_CHECK_EVERY;

    loop {
        thread::sleep(wait);

        if local_up() {
            wait = SERVER_CHECK_EVERY;
            continue;
        }

        log_line(app, "this PC's server stopped answering; starting it again");

        if set_up_this_pc(app).is_some_and(|installed| installed.server == "ok") {
            wait = SERVER_CHECK_EVERY;
            reload_local(app);
        } else {
            wait = (wait * 2).min(SERVER_CHECK_MAX);
            log_line(app, &format!("next try in {}s", wait.as_secs()));
        }
    }
}

// A page shown before an update came from the old server (old code and design); once the new one
// answers, the window opens this PC's page again. Another PC's page is left as it is.
fn reload_local(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    let Ok(shown) = window.url() else { return };

    if server_origin(&shown).as_deref() != Some(LOCAL_SERVER) {
        return;
    }

    if let Ok(mut local) = Url::parse(LOCAL_SERVER) {
        local.set_fragment(shown.fragment());
        log_line(app, "reloaded the page from the restarted server");
        let _ = window.navigate(local);
    }
}

// Opens the session of a notification that was just clicked: on the page shown, or on its PC's.
fn open_noticed_session(app: &AppHandle) {
    let state = app.state::<LastNotice>();
    let picked = state.0.lock().ok().and_then(|mut last| last.take());

    let Some((server, session, at)) = picked else { return };

    if at.elapsed() > OPEN_FROM_NOTICE_FOR {
        return;
    }

    let Some(window) = main_window(app) else { return };

    if shown_server(app).as_deref() == Some(server.as_str()) {
        if let Ok(id) = serde_json::to_string(&session) {
            let _ = window.eval(format!("window.choiterm && window.choiterm.open({id})"));
        }

        return;
    }

    if let Ok(url) = Url::parse(&format!("{server}#open={session}")) {
        let _ = window.navigate(url);
    }
}

// WebView2 keeps browser shortcuts (Ctrl+Tab, Ctrl+F, Ctrl+W, F5 …) for itself; ChoiTerm wants them.
#[cfg(windows)]
fn give_shortcuts_to_page(window: &WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let _ = window.with_webview(|webview| {
        // SAFETY: the controller belongs to this live webview and is used on its own thread.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };

            if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
}

#[cfg(not(windows))]
fn give_shortcuts_to_page(_window: &WebviewWindow) {}

// Follows one server's event stream (like the phone app's service) and shows a Windows notification
// for each notice, unless the window is in front showing that same server (its page shows it).
fn listen_for_notices(app: &AppHandle, base: String) {
    let known = app.state::<Known>();

    if !known.listening.lock().map(|mut listening| listening.insert(base.clone())).unwrap_or(false) {
        return;
    }

    let app = app.clone();

    thread::spawn(move || {
        let mut backoff = Duration::from_secs(2);
        // Only notices from now on: a huge last id makes the server skip what it kept.
        let mut last_id = u64::MAX / 2;

        loop {
            let request = ureq::get(&format!("{base}events")).header("Last-Event-ID", &last_id.to_string()).call();

            if let Ok(response) = request {
                backoff = Duration::from_secs(2);

                let reader = BufReader::new(response.into_body().into_reader());

                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let Some(notice) = parse_notice(&line) else { continue };

                    last_id = notice.id;

                    let focused = main_window(&app).and_then(|window| window.is_focused().ok()).unwrap_or(false);

                    if focused && shown_server(&app).as_deref() == Some(base.as_str()) {
                        continue;
                    }

                    if let Ok(mut last) = app.state::<LastNotice>().0.lock() {
                        *last = Some((base.clone(), notice.session.clone(), Instant::now()));
                    }

                    let machine = app.state::<Known>().names.lock().ok().and_then(|names| if names.len() > 1 { names.get(&base).cloned() } else { None });
                    let _ = app.notification().builder().title(headline(&notice, machine.as_deref())).body(&notice.text).show();
                }
            }

            thread::sleep(backoff);
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    });
}

// Every few minutes asks a server which of the owner's PCs run ChoiTerm and follows the notices of
// each. This PC's own is followed at 127.0.0.1, never twice.
fn watch_machines(app: AppHandle) {
    thread::spawn(move || loop {
        let local = local_up();
        let from = if local || MAIN_SERVER.is_empty() { LOCAL_SERVER } else { MAIN_SERVER };

        if local {
            let own = quick_get(&format!("{LOCAL_SERVER}hello")).and_then(|text| serde_json::from_str::<Hello>(&text).ok()).map(|hello| hello.url).filter(|url| !url.is_empty());

            if let Ok(mut known) = app.state::<Known>().own.lock() {
                known.clone_from(&own);
            }

            listen_for_notices(&app, LOCAL_SERVER.to_string());
        }

        let own = app.state::<Known>().own.lock().ok().and_then(|own| own.clone());

        for machine in parse_machines(&quick_get(&format!("{from}machines")).unwrap_or_default()) {
            let base = if local && (machine.here || own.as_deref() == Some(machine.url.as_str())) { LOCAL_SERVER.to_string() } else { machine.url.clone() };

            if let Ok(mut names) = app.state::<Known>().names.lock() {
                names.insert(base.clone(), machine.name.clone());
            }

            listen_for_notices(&app, base);
        }

        thread::sleep(MACHINES_EVERY);
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "ChoiTerm 열기", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "로그인할 때 자동 실행", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &autostart, &separator, &quit])?;
    let autostart_item = autostart.clone();

    let mut tray = TrayIconBuilder::with_id("main").tooltip("ChoiTerm").menu(&menu).show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.on_menu_event(move |app, event| match event.id.as_ref() {
        "open" => show(app),
        "autostart" => {
            let launcher = app.autolaunch();
            let on = launcher.is_enabled().unwrap_or(false);
            let _ = if on { launcher.disable() } else { launcher.enable() };
            let _ = autostart_item.set_checked(launcher.is_enabled().unwrap_or(false));
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            show(tray.app_handle());
        }
    })
    .build(app)?;

    Ok(())
}

// Links the page opens (window.open) go to the owner's default browser, not a bare WebView window.
fn open_in_browser(url: &Url) {
    if url.scheme() != "http" && url.scheme() != "https" {
        return;
    }

    let mut command = Command::new("rundll32.exe");

    command.args(["url.dll,FileProtocolHandler", url.as_str()]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(CREATE_NO_WINDOW);
    }

    let _ = command.spawn();
}

// Where a page goes: a ChoiTerm server is remembered for next time; this PC's own tailnet address is
// shown at 127.0.0.1 instead (same sessions, and the page keeps this PC's settings).
fn on_page(app: &AppHandle, url: &Url, testing: bool) -> bool {
    let Some(server) = server_origin(url) else { return true };
    let own = app.state::<Known>().own.lock().ok().and_then(|own| own.clone());

    if own.as_deref() == Some(server.as_str()) && local_up() {
        if let Ok(mut local) = Url::parse(LOCAL_SERVER) {
            local.set_fragment(url.fragment());

            let app = app.clone();

            thread::spawn(move || {
                if let Some(window) = main_window(&app) {
                    let _ = window.navigate(local);
                }
            });
        }

        return false;
    }

    if !testing {
        remember_server(app, &server);
    }

    true
}

pub fn run() {
    let mut builder = tauri::Builder::default();

    // A test copy runs beside the owner's own program instead of handing over to it.
    if test_server().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second start (the Start menu, a notification click) brings this one forward.
            show(app);
            open_noticed_session(app);
        }));
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_FLAG])))
        .manage(LastNotice::default())
        .manage(Known::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let testing = test_server();
            let hidden = std::env::args().any(|arg| arg == HIDDEN_FLAG);
            let local = local_up();
            let installing = testing.is_none() && !local && bundled_server(&handle).is_some();
            let order = startup_order(last_server(&handle).as_deref(), MAIN_SERVER);
            // This PC's server opens at once when it is the one wanted; anything else goes through a
            // small local page that tries each in order (and keeps trying) before moving on.
            let (url, waiting) = match testing.map(Url::parse) {
                Some(Ok(test)) => (WebviewUrl::External(test), None),
                _ if order[0] == LOCAL_SERVER && local => (WebviewUrl::External(Url::parse(LOCAL_SERVER)?), None),
                _ => {
                    let wait = if installing && order[0] == LOCAL_SERVER { INSTALL_WAIT_MS } else { 0 };

                    (WebviewUrl::App("index.html".into()), Some(format!("window.__choiterm = {{ servers: {}, wait: {wait} }}", serde_json::to_string(&order)?)))
                }
            };

            // One line per start: which server this run chose, for when it seems to talk to the wrong one.
            log_line(&handle, &format!("start order={order:?} test={} local={local} url={url:?} args={:?}", testing.is_some(), std::env::args().collect::<Vec<_>>()));

            let navigating = handle.clone();
            let mut builder = WebviewWindowBuilder::new(app, "main", url)
                .title("ChoiTerm")
                .inner_size(1280.0, 800.0)
                .min_inner_size(480.0, 360.0)
                // Files dropped on the window go to the page, which uploads them to the PC.
                .disable_drag_drop_handler()
                .on_navigation(move |url| on_page(&navigating, url, testing.is_some()))
                .on_new_window(|url, _features| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .visible(!hidden);

            if let Some(script) = waiting {
                builder = builder.initialization_script(script);
            }

            // A test copy's WebView keeps its own data: two programs on one folder must start the
            // browser the same way, and a test may start it with other options (remote debugging).
            if testing.is_some()
                && let Ok(dir) = handle.path().app_local_data_dir()
            {
                builder = builder.data_directory(dir.join("test-webview"));
            }

            let window = builder.build()?;

            give_shortcuts_to_page(&window);

            // Closing the window keeps ChoiTerm in the tray (notifications keep coming).
            let keep = window.clone();

            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = keep.hide();
                }
            });

            // Starting with Windows is on unless the owner turned it off once.
            let marker = handle.path().app_config_dir().map(|dir| dir.join("autostart-set"));

            if let Ok(marker) = marker
                && testing.is_none()
                && !marker.exists()
            {
                let _ = handle.autolaunch().enable();
                let _ = std::fs::create_dir_all(marker.parent().unwrap_or(&marker));
                let _ = std::fs::write(&marker, "1");
            }

            build_tray(&handle)?;

            match testing {
                Some(test) => listen_for_notices(&handle, test.to_string()),
                None => {
                    let setup = handle.clone();

                    thread::spawn(move || {
                        let installed = set_up_this_pc(&setup);

                        if installed.as_ref().is_some_and(|installed| installed.server == "ok") {
                            reload_local(&setup);
                        }

                        watch_machines(setup.clone());

                        if installed.is_some_and(|installed| installed.skipped.is_none()) {
                            keep_server_up(&setup);
                        }
                    });
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("ChoiTerm 창을 띄우지 못했습니다");
}
