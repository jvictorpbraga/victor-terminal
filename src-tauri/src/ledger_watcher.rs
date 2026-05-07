// Continuous ledger writer — tails the active Claude Code JSONL and appends a
// running, human-readable markdown narrative to:
//   Desktop/claude-terminal/sessions/<session-id>.md
//
// Spawned from lib.rs setup(). Polls every 3s. Per-session offset tracking so
// each new JSONL entry appended produces exactly one new markdown line.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde_json::Value;
use tauri::AppHandle;

struct SessionState {
    offset: u64,
    initialized: bool,
}

fn claude_root() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".claude").join("projects"))
}

fn sessions_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join("Desktop").join("claude-terminal").join("sessions"))
}

fn find_active_session() -> Option<(PathBuf, String, String)> {
    let root = claude_root()?;
    let mut best: Option<(PathBuf, String, SystemTime)> = None;
    for proj in fs::read_dir(&root).ok()?.flatten() {
        let proj_path = proj.path();
        if !proj_path.is_dir() {
            continue;
        }
        let proj_name = proj_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("?")
            .to_string();
        if let Ok(files) = fs::read_dir(&proj_path) {
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let mtime = f
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                if best.as_ref().map_or(true, |(_, _, t)| mtime > *t) {
                    best = Some((p, proj_name.clone(), mtime));
                }
            }
        }
    }
    best.map(|(p, n, _)| {
        let id = p.file_stem().and_then(|s| s.to_str()).unwrap_or("?").to_string();
        (p, n, id)
    })
}

fn ts_short(v: &Value) -> String {
    v.get("timestamp")
        .and_then(|x| x.as_str())
        .and_then(|s| s.get(11..19))
        .unwrap_or("--:--:--")
        .to_string()
}

fn first_line_snippet(s: &str, max: usize) -> String {
    let s = s.trim();
    let line = s.lines().next().unwrap_or("").trim();
    let trimmed: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        format!("{}…", trimmed)
    } else {
        trimmed
    }
}

fn looks_like_tag_payload(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with("<system-reminder>")
        || t.starts_with("<command-")
        || t.starts_with("<local-command-")
        || t.starts_with("<ide_selection>")
        || t.starts_with("Caveat: The messages below were generated")
}

fn summarize_tool(name: &str, input: &Value) -> String {
    match name {
        "Bash" | "PowerShell" => {
            let cmd = input.get("command").and_then(|x| x.as_str()).unwrap_or("");
            format!("→ `{}`", first_line_snippet(cmd, 100))
        }
        "Read" => {
            let p = input.get("file_path").and_then(|x| x.as_str()).unwrap_or("?");
            format!("→ {}", short_path(p))
        }
        "Write" => {
            let p = input.get("file_path").and_then(|x| x.as_str()).unwrap_or("?");
            format!("→ {}", short_path(p))
        }
        "Edit" => {
            let p = input.get("file_path").and_then(|x| x.as_str()).unwrap_or("?");
            format!("→ {}", short_path(p))
        }
        "Glob" => {
            let pat = input.get("pattern").and_then(|x| x.as_str()).unwrap_or("?");
            format!("→ `{}`", pat)
        }
        "Grep" => {
            let pat = input.get("pattern").and_then(|x| x.as_str()).unwrap_or("?");
            format!("→ `{}`", first_line_snippet(pat, 80))
        }
        "WebFetch" | "WebSearch" => {
            let q = input
                .get("url")
                .or_else(|| input.get("query"))
                .and_then(|x| x.as_str())
                .unwrap_or("?");
            format!("→ {}", first_line_snippet(q, 80))
        }
        "Agent" | "Task" => {
            let d = input.get("description").and_then(|x| x.as_str()).unwrap_or("");
            format!("→ {}", first_line_snippet(d, 80))
        }
        _ => {
            let s = serde_json::to_string(input).unwrap_or_default();
            format!("→ {}", first_line_snippet(&s, 80))
        }
    }
}

fn short_path(p: &str) -> String {
    let parts: Vec<&str> = p.split(|c| c == '\\' || c == '/').collect();
    if parts.len() <= 3 {
        p.to_string()
    } else {
        format!(
            ".../{}/{}",
            parts[parts.len() - 2],
            parts[parts.len() - 1]
        )
    }
}

fn format_entry(v: &Value) -> Option<String> {
    let typ = v.get("type")?.as_str()?;
    let ts = ts_short(v);
    match typ {
        "user" => {
            let content = v.get("message")?.get("content")?;
            // Plain string content
            if let Value::String(s) = content {
                if looks_like_tag_payload(s) {
                    return None;
                }
                let snip = first_line_snippet(s, 160);
                if snip.is_empty() {
                    return None;
                }
                return Some(format!("`[{}]` **user** — {}\n\n", ts, snip));
            }
            // Array content
            if let Value::Array(arr) = content {
                let mut out = String::new();
                for b in arr {
                    let bt = b.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    if bt == "text" {
                        if let Some(s) = b.get("text").and_then(|x| x.as_str()) {
                            if looks_like_tag_payload(s) {
                                continue;
                            }
                            let snip = first_line_snippet(s, 160);
                            if !snip.is_empty() {
                                out.push_str(&format!(
                                    "`[{}]` **user** — {}\n\n",
                                    ts, snip
                                ));
                            }
                        }
                    } else if bt == "tool_result" {
                        let is_err = b
                            .get("is_error")
                            .and_then(|x| x.as_bool())
                            .unwrap_or(false);
                        let icon = if is_err { "✗" } else { "✓" };
                        let summary = match b.get("content") {
                            Some(Value::String(s)) => first_line_snippet(s, 90),
                            Some(Value::Array(a)) => a
                                .iter()
                                .find_map(|c| {
                                    c.get("text")
                                        .and_then(|x| x.as_str())
                                        .map(|s| first_line_snippet(s, 90))
                                })
                                .unwrap_or_default(),
                            _ => String::new(),
                        };
                        if !summary.is_empty() {
                            out.push_str(&format!(
                                "  &nbsp;&nbsp;↳ {} {}\n\n",
                                icon, summary
                            ));
                        }
                    }
                }
                if !out.is_empty() {
                    return Some(out);
                }
            }
            None
        }
        "assistant" => {
            let arr = v.get("message")?.get("content")?.as_array()?;
            let mut out = String::new();
            for b in arr {
                let bt = b.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if bt == "text" {
                    if let Some(s) = b.get("text").and_then(|x| x.as_str()) {
                        let snip = first_line_snippet(s, 160);
                        if !snip.is_empty() {
                            out.push_str(&format!(
                                "`[{}]` **claude** — {}\n\n",
                                ts, snip
                            ));
                        }
                    }
                } else if bt == "tool_use" {
                    let name =
                        b.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                    let summary = b
                        .get("input")
                        .map(|i| summarize_tool(name, i))
                        .unwrap_or_default();
                    out.push_str(&format!(
                        "`[{}]` 🔧 `{}` {}\n\n",
                        ts, name, summary
                    ));
                } else if bt == "thinking" {
                    out.push_str(&format!("`[{}]` 💭 *(thinking)*\n\n", ts));
                }
            }
            if !out.is_empty() {
                Some(out)
            } else {
                None
            }
        }
        "ai-title" => {
            v.get("title")
                .and_then(|x| x.as_str())
                .map(|t| format!("\n> **Auto-title:** {}\n\n", t))
        }
        _ => None,
    }
}

fn write_header(md_path: &Path, session_id: &str, project: &str) -> std::io::Result<()> {
    if let Some(parent) = md_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let started = chrono_iso_now();
    let header = format!(
        "# Session — {}\n\n- **id:** `{}`\n- **project:** `{}`\n- **started (writer):** {}\n\n---\n\n",
        session_id, session_id, project, started
    );
    fs::write(md_path, header)
}

fn chrono_iso_now() -> String {
    use std::time::UNIX_EPOCH;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02} UTC", h, m, s)
}

fn append_chunk(md_path: &Path, chunk: &str) -> std::io::Result<()> {
    let mut f = OpenOptions::new().append(true).create(true).open(md_path)?;
    f.write_all(chunk.as_bytes())
}

fn process_jsonl(
    jsonl_path: &Path,
    md_path: &Path,
    state: &mut SessionState,
    session_id: &str,
    project: &str,
) -> std::io::Result<()> {
    if !state.initialized || !md_path.exists() {
        write_header(md_path, session_id, project)?;
        state.initialized = true;
        state.offset = 0;
    }

    let mut f = fs::File::open(jsonl_path)?;
    let total_len = f.metadata()?.len();
    if total_len < state.offset {
        // File was truncated/rotated — reset.
        state.offset = 0;
    }
    if total_len == state.offset {
        return Ok(());
    }
    f.seek(SeekFrom::Start(state.offset))?;
    let mut buf = String::new();
    f.read_to_string(&mut buf)?;

    // Only process complete lines. Track how many bytes of complete lines we consumed.
    let last_newline = buf.rfind('\n');
    let (complete, _) = match last_newline {
        Some(i) => buf.split_at(i + 1),
        None => return Ok(()), // no full line yet
    };

    let mut chunk = String::new();
    for line in complete.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(rendered) = format_entry(&v) {
                chunk.push_str(&rendered);
            }
        }
    }
    if !chunk.is_empty() {
        append_chunk(md_path, &chunk)?;
    }
    state.offset += complete.len() as u64;
    Ok(())
}

/// Read the live ledger MD file the watcher is appending to for a session.
/// Used by the Phase 4 background-restart logic to compose a system-prompt
/// context for the replacement claude process.
#[tauri::command]
pub fn read_session_ledger(session_id: String) -> Result<String, String> {
    let dir = sessions_dir().ok_or("no USERPROFILE")?;
    let path = dir.join(format!("{}.md", session_id));
    if !path.exists() {
        return Err(format!("ledger not found: {}", path.display()));
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Return the absolute path to the sessions directory for this user.
/// Used by the frontend to compose absolute paths in claude system prompts.
#[tauri::command]
pub fn get_sessions_dir() -> Result<String, String> {
    sessions_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "USERPROFILE not set".to_string())
}

pub fn spawn_ledger_watcher(_app: AppHandle) -> Arc<AtomicBool> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop = stop_flag.clone();
    std::thread::spawn(move || {
        let mut sessions: HashMap<String, SessionState> = HashMap::new();
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_secs(3));
            let active = match find_active_session() {
                Some(a) => a,
                None => continue,
            };
            let (jsonl_path, project, id) = active;
            // Skip stale (>30 min idle).
            if let Ok(mtime) = fs::metadata(&jsonl_path).and_then(|m| m.modified()) {
                if SystemTime::now()
                    .duration_since(mtime)
                    .map(|d| d.as_secs())
                    .unwrap_or(0)
                    > 1800
                {
                    continue;
                }
            }
            let md_path = match sessions_dir() {
                Some(d) => d.join(format!("{}.md", id)),
                None => continue,
            };
            let state = sessions.entry(id.clone()).or_insert(SessionState {
                offset: 0,
                initialized: false,
            });
            let _ = process_jsonl(&jsonl_path, &md_path, state, &id, &project);
        }
    });
    stop_flag
}
