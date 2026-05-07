// Session Ledger — turns Claude Code's JSONL session files into readable markdown.
//
// Claude Code writes session JSONL files to:
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// where encoded-cwd is e.g. `C:\Users\Victor` -> `C--Users-Victor` (replace
// path separators and colons with `-`, collapse runs).
//
// Each line is a JSON object. Types we care about:
//   - user        → user message (often contains tool_result blocks too)
//   - assistant   → claude's reply (text, thinking, tool_use blocks, usage)
//   - attachment  → file attached to a message
//   - ai-title    → auto-generated session title

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub modified_unix: u64,
    pub size: u64,
    pub title: Option<String>,
    pub first_user: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct UsageInfo {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

fn claude_root() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".claude").join("projects"))
}

/// `C:\Users\Victor` -> `C--Users-Victor`
fn encode_cwd(cwd: &str) -> String {
    let mut s = String::with_capacity(cwd.len());
    for ch in cwd.chars() {
        match ch {
            '\\' | '/' | ':' => s.push('-'),
            other => s.push(other),
        }
    }
    s
}

fn pick_project_dir(cwd: Option<&str>) -> Result<PathBuf, String> {
    let root = claude_root().ok_or("USERPROFILE not set")?;
    if !root.exists() {
        return Err(format!("No claude projects dir at {}", root.display()));
    }
    if let Some(cwd) = cwd {
        let dir = root.join(encode_cwd(cwd));
        if dir.exists() {
            return Ok(dir);
        }
    }
    // Fallback: the most recently modified subdirectory.
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map_or(true, |(_, t)| mtime > *t) {
            best = Some((path, mtime));
        }
    }
    best.map(|(p, _)| p).ok_or_else(|| "No project dirs found".into())
}

#[tauri::command]
pub fn ledger_list_sessions(cwd: Option<String>) -> Result<Vec<SessionMeta>, String> {
    let dir = pick_project_dir(cwd.as_deref())?;
    let mut sessions: Vec<SessionMeta> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("?")
            .to_string();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let modified_unix = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let (title, first_user) = peek_session_title(&path);
        sessions.push(SessionMeta {
            id,
            modified_unix,
            size: meta.len(),
            title,
            first_user,
        });
    }
    sessions.sort_by(|a, b| b.modified_unix.cmp(&a.modified_unix));
    Ok(sessions)
}

fn peek_session_title(path: &Path) -> (Option<String>, Option<String>) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (None, None),
    };
    let mut title: Option<String> = None;
    let mut first_user: Option<String> = None;
    for line in content.lines().take(60) {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t == "ai-title" {
            if let Some(s) = v.get("title").and_then(|x| x.as_str()) {
                title = Some(s.to_string());
            }
        } else if t == "user" && first_user.is_none() {
            first_user = Some(extract_first_user_text(&v));
        }
        if title.is_some() && first_user.is_some() {
            break;
        }
    }
    (title, first_user)
}

fn extract_first_user_text(entry: &Value) -> String {
    let msg = entry.get("message").cloned().unwrap_or(Value::Null);
    let content = msg.get("content");
    match content {
        Some(Value::String(s)) => first_visible(s),
        Some(Value::Array(arr)) => {
            for block in arr {
                if block.get("type").and_then(|x| x.as_str()) == Some("text") {
                    if let Some(s) = block.get("text").and_then(|x| x.as_str()) {
                        return first_visible(s);
                    }
                }
            }
            "(no text)".into()
        }
        _ => "(no content)".into(),
    }
}

fn first_visible(s: &str) -> String {
    // Strip leading <ide_selection>, <system-reminder>, and similar tag blocks.
    let s = s.trim();
    let after_tags = if s.starts_with('<') {
        if let Some(idx) = s.find('>') {
            // Skip the rest of the line up to the matching closing tag if simple,
            // else just skip to end of opening tag.
            s.get(idx + 1..).unwrap_or(s).trim_start()
        } else {
            s
        }
    } else {
        s
    };
    let trimmed: String = after_tags.chars().take(120).collect();
    if after_tags.chars().count() > 120 {
        format!("{}…", trimmed)
    } else {
        trimmed
    }
}

#[tauri::command]
pub fn ledger_get_session(
    session_id: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let dir = pick_project_dir(cwd.as_deref())?;
    let path = dir.join(format!("{}.jsonl", session_id));
    if !path.exists() {
        return Err(format!("Session not found: {}", path.display()));
    }
    render_markdown(&path)
}

/// Return the raw JSONL contents of a session — one JSON object per line.
/// Used by the chat UI when resuming a past conversation: the frontend
/// replays each line through the same event reducer it uses for the live
/// claude-event stream.
#[tauri::command]
pub fn ledger_get_session_jsonl(
    session_id: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let dir = pick_project_dir(cwd.as_deref())?;
    let path = dir.join(format!("{}.jsonl", session_id));
    if !path.exists() {
        return Err(format!("Session not found: {}", path.display()));
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn render_markdown(path: &Path) -> Result<String, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut out = String::new();
    let mut title: Option<String> = None;
    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut tool_calls = 0usize;
    let mut user_msgs = 0usize;

    // Pass 1: collect title + totals (header).
    for line in content.lines() {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t == "ai-title" {
            if let Some(s) = v.get("title").and_then(|x| x.as_str()) {
                title = Some(s.to_string());
            }
        } else if t == "user" {
            user_msgs += 1;
        } else if t == "assistant" {
            if let Some(usage) = v
                .get("message")
                .and_then(|m| m.get("usage"))
                .and_then(|u| serde_json::from_value::<UsageInfo>(u.clone()).ok())
            {
                total_in += usage.input_tokens;
                total_out += usage.output_tokens;
                total_cache_read += usage.cache_read_input_tokens;
            }
            if let Some(c) = v.get("message").and_then(|m| m.get("content")) {
                if let Some(arr) = c.as_array() {
                    for b in arr {
                        if b.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                            tool_calls += 1;
                        }
                    }
                }
            }
        }
    }

    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("?");
    out.push_str(&format!(
        "# Session — {}\n\n",
        title.as_deref().unwrap_or(id)
    ));
    out.push_str(&format!("- **id:** `{}`\n", id));
    out.push_str(&format!("- **user messages:** {}\n", user_msgs));
    out.push_str(&format!("- **tool calls:** {}\n", tool_calls));
    out.push_str(&format!(
        "- **tokens:** in={} cache_read={} out={}\n\n",
        total_in, total_cache_read, total_out
    ));
    out.push_str("---\n\n");

    // Pass 2: timeline.
    for line in content.lines() {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let ts = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .chars()
            .take(19)
            .collect::<String>();
        match t {
            "user" => {
                let text = extract_first_user_text(&v);
                if !text.is_empty() && !text.starts_with('(') {
                    out.push_str(&format!("**{}** — `user`\n\n> {}\n\n", ts, text));
                }
                // Also surface tool_result blocks.
                if let Some(arr) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for b in arr {
                        if b.get("type").and_then(|x| x.as_str()) == Some("tool_result") {
                            let tu = b
                                .get("tool_use_id")
                                .and_then(|x| x.as_str())
                                .unwrap_or("?");
                            let summary = match b.get("content") {
                                Some(Value::String(s)) => first_visible(s),
                                Some(Value::Array(a)) => a
                                    .iter()
                                    .find_map(|c| {
                                        c.get("text").and_then(|x| x.as_str()).map(first_visible)
                                    })
                                    .unwrap_or_else(|| "(structured)".into()),
                                _ => "(empty)".into(),
                            };
                            out.push_str(&format!(
                                "  ↳ result of `{}`: {}\n\n",
                                tu, summary
                            ));
                        }
                    }
                }
            }
            "assistant" => {
                if let Some(arr) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for b in arr {
                        let bt = b.get("type").and_then(|x| x.as_str()).unwrap_or("");
                        if bt == "text" {
                            if let Some(s) = b.get("text").and_then(|x| x.as_str()) {
                                out.push_str(&format!(
                                    "**{}** — `claude`\n\n{}\n\n",
                                    ts, s.trim()
                                ));
                            }
                        } else if bt == "tool_use" {
                            let name =
                                b.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                            let input = b
                                .get("input")
                                .map(|x| serde_json::to_string(x).unwrap_or_default())
                                .unwrap_or_default();
                            let trimmed: String = input.chars().take(180).collect();
                            let suffix = if input.chars().count() > 180 { "…" } else { "" };
                            out.push_str(&format!(
                                "**{}** — 🔧 `{}`\n\n```\n{}{}\n```\n\n",
                                ts, name, trimmed, suffix
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Ok(out)
}

#[derive(Serialize)]
pub struct SearchHit {
    pub id: String,
    pub modified_unix: u64,
    pub size: u64,
    pub title: Option<String>,
    pub first_user: Option<String>,
    /// "title" | "first_user" | "content"
    pub matched: String,
    /// Short text excerpt where the query was found
    pub snippet: Option<String>,
}

/// Search across all sessions in the cwd's project dir. Matches case-insensitively
/// against title, first user message, and message content (one pass per file).
#[tauri::command]
pub fn ledger_search(
    query: String,
    cwd: Option<String>,
) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let dir = pick_project_dir(cwd.as_deref())?;
    let mut hits: Vec<SearchHit> = Vec::new();

    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("?")
            .to_string();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let modified_unix = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let size = meta.len();
        let (title, first_user) = peek_session_title(&path);

        let title_match = title
            .as_deref()
            .map(|s| s.to_lowercase().contains(&q))
            .unwrap_or(false);
        let user_match = first_user
            .as_deref()
            .map(|s| s.to_lowercase().contains(&q))
            .unwrap_or(false);

        let (matched, snippet) = if title_match {
            ("title".to_string(), title.clone())
        } else if user_match {
            ("first_user".to_string(), first_user.clone())
        } else {
            // Content scan — find the first line that contains the query and
            // extract a readable snippet from any text fields it has.
            match fs::read_to_string(&path) {
                Ok(content) => {
                    let mut found_snip: Option<String> = None;
                    for line in content.lines() {
                        if line.to_lowercase().contains(&q) {
                            let v: Value = match serde_json::from_str(line) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            // Try to extract a clean text from this entry rather
                            // than showing raw JSON to the user.
                            let text = extract_searchable_text(&v);
                            if let Some(t) = text {
                                if t.to_lowercase().contains(&q) {
                                    let trimmed: String = t.chars().take(140).collect();
                                    let suffix = if t.chars().count() > 140 { "…" } else { "" };
                                    found_snip = Some(format!("{}{}", trimmed, suffix));
                                    break;
                                }
                            }
                        }
                    }
                    if let Some(s) = found_snip {
                        ("content".to_string(), Some(s))
                    } else {
                        continue;
                    }
                }
                Err(_) => continue,
            }
        };

        hits.push(SearchHit {
            id,
            modified_unix,
            size,
            title,
            first_user,
            matched,
            snippet,
        });
    }

    hits.sort_by(|a, b| b.modified_unix.cmp(&a.modified_unix));
    Ok(hits)
}

/// Pull human-readable text out of a session JSONL entry. Used for search
/// snippets — we don't want to surface raw JSON to the user.
fn extract_searchable_text(v: &Value) -> Option<String> {
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    if t == "ai-title" {
        return v.get("title").and_then(|x| x.as_str()).map(|s| s.to_string());
    }
    let msg = v.get("message")?;
    let content = msg.get("content")?;
    if let Value::String(s) = content {
        return Some(s.clone());
    }
    if let Value::Array(arr) = content {
        let mut buf = String::new();
        for b in arr {
            let bt = b.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if bt == "text" {
                if let Some(s) = b.get("text").and_then(|x| x.as_str()) {
                    if !buf.is_empty() {
                        buf.push(' ');
                    }
                    buf.push_str(s);
                }
            } else if bt == "tool_result" {
                let s = match b.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(a)) => a
                        .iter()
                        .find_map(|c| c.get("text").and_then(|x| x.as_str()))
                        .unwrap_or("")
                        .to_string(),
                    _ => String::new(),
                };
                if !s.is_empty() {
                    if !buf.is_empty() {
                        buf.push(' ');
                    }
                    buf.push_str(&s);
                }
            }
        }
        if buf.is_empty() {
            return None;
        }
        return Some(buf);
    }
    None
}

#[tauri::command]
pub fn ledger_export_session(
    session_id: String,
    cwd: Option<String>,
    out_path: String,
) -> Result<String, String> {
    let md = ledger_get_session(session_id, cwd)?;
    let path = PathBuf::from(&out_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, md).map_err(|e| e.to_string())?;
    Ok(out_path)
}
