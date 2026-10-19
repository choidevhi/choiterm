// What the server's event stream says, turned into a Windows notification's title and text. Kept
// apart from the window code so it can be tested on its own.

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Notice {
    pub id: u64,
    pub session: String,
    pub title: String,
    pub kind: String,
    pub text: String,
}

/// One `data:` line of the event stream; `None` for comments, ids and anything unreadable.
pub fn parse_notice(line: &str) -> Option<Notice> {
    let json = line.strip_prefix("data:")?.trim();

    serde_json::from_str(json).ok()
}

/// The notification's title: the session's name and what happened, after the PC's name when the
/// owner has more than one.
pub fn headline(notice: &Notice, machine: Option<&str>) -> String {
    let what = match notice.kind.as_str() {
        "done" => "끝났어요",
        "question" => "질문이 있어요",
        _ => "확인이 필요해요",
    };

    match machine {
        Some(name) => format!("{name} · {} · {what}", notice.title),
        None => format!("{} · {what}", notice.title),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_notice_lines_only() {
        let notice = parse_notice(r#"data: {"id":12,"session":"s1","title":"리팩터링","kind":"done","text":"다 고쳤어요","answers":[],"at":1}"#);

        assert_eq!(
            notice,
            Some(Notice { id: 12, session: "s1".into(), title: "리팩터링".into(), kind: "done".into(), text: "다 고쳤어요".into() })
        );
        assert_eq!(parse_notice(": ping"), None);
        assert_eq!(parse_notice("id: 12"), None);
        assert_eq!(parse_notice("data: not json"), None);
    }

    #[test]
    fn headline_says_what_happened() {
        let notice = |kind: &str| Notice { id: 1, session: "s".into(), title: "작업".into(), kind: kind.into(), text: String::new() };

        assert_eq!(headline(&notice("done"), None), "작업 · 끝났어요");
        assert_eq!(headline(&notice("question"), None), "작업 · 질문이 있어요");
        assert_eq!(headline(&notice("attention"), None), "작업 · 확인이 필요해요");
        assert_eq!(headline(&notice("done"), Some("office")), "office · 작업 · 끝났어요");
    }
}
