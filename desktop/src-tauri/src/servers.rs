// Which ChoiTerm servers the window may show, and the list of the owner's PCs running one. Kept
// apart from the window code so it can be tested on its own.

use serde::Deserialize;
use tauri::Url;

pub const LOCAL_SERVER: &str = "http://127.0.0.1:47190/";
pub const TAILNET_PORT: u16 = 8449;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Machine {
    pub name: String,
    pub url: String,
    pub online: bool,
    pub here: bool,
}

#[derive(Deserialize)]
struct MachineList {
    machines: Vec<Machine>,
}

/// The server a page belongs to (`scheme://host:port/`): this PC's own, or any PC's on the tailnet
/// port. `None` for anything else (the program's own waiting page, links).
pub fn server_origin(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    let local = url.scheme() == "http" && host == "127.0.0.1" && port == 47190;
    let tailnet = url.scheme() == "https" && host.ends_with(".ts.net") && port == TAILNET_PORT;

    (local || tailnet).then(|| format!("{}://{host}:{port}/", url.scheme()))
}

/// `/machines` from a server; empty when it is unreadable.
pub fn parse_machines(text: &str) -> Vec<Machine> {
    serde_json::from_str::<MachineList>(text).map(|list| list.machines).unwrap_or_default()
}

/// The servers to try at start, best first, each once: the one shown last, this PC's, the main PC's.
pub fn startup_order(last: Option<&str>, main: &str) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();

    for server in [last, Some(LOCAL_SERVER), Some(main)].into_iter().flatten() {
        if !server.is_empty() && !order.iter().any(|known| known == server) {
            order.push(server.to_string());
        }
    }

    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(url: &str) -> Option<String> {
        server_origin(&Url::parse(url).unwrap())
    }

    #[test]
    fn knows_choiterm_pages_from_others() {
        assert_eq!(origin("http://127.0.0.1:47190/#open=x"), Some("http://127.0.0.1:47190/".into()));
        assert_eq!(origin("https://office.tail1.ts.net:8449/app.js"), Some("https://office.tail1.ts.net:8449/".into()));
        assert_eq!(origin("https://office.tail1.ts.net:8443/"), None);
        assert_eq!(origin("http://office.tail1.ts.net:8449/"), None);
        assert_eq!(origin("https://github.com/"), None);
        assert_eq!(origin("http://tauri.localhost/index.html"), None);
    }

    #[test]
    fn reads_the_machine_list() {
        let list = parse_machines(r#"{"machines":[{"name":"desk","url":"https://desk.t.ts.net:8449/","online":true,"here":true},{"name":"office","url":"https://office.t.ts.net:8449/","online":false,"here":false}]}"#);

        assert_eq!(list.len(), 2);
        assert_eq!(list[1], Machine { name: "office".into(), url: "https://office.t.ts.net:8449/".into(), online: false, here: false });
        assert!(parse_machines("not found").is_empty());
    }

    #[test]
    fn tries_the_last_pc_first_then_this_one_then_the_main_one() {
        let main = "https://main.t.ts.net:8449/";

        assert_eq!(startup_order(Some("https://office.t.ts.net:8449/"), main), vec!["https://office.t.ts.net:8449/", LOCAL_SERVER, main]);
        assert_eq!(startup_order(Some(LOCAL_SERVER), main), vec![LOCAL_SERVER, main]);
        assert_eq!(startup_order(None, main), vec![LOCAL_SERVER, main]);
        // No main PC built in: this PC's own server only.
        assert_eq!(startup_order(None, ""), vec![LOCAL_SERVER]);
    }
}
