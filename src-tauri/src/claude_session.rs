// Claude Code subprocess manager — supports MULTIPLE concurrent claude sessions
// (one per app-side chat). Each session is keyed by an opaque string the
// frontend assigns; commands route to the right subprocess by that key.
//
// Frontend lifecycle:
//   1. invoke claude_start({ key, args }) when a chat is created/resumed
//   2. invoke claude_send({ key, json_line }) for each user turn
//   3. invoke claude_stop({ key }) when the user explicitly closes the chat
//   4. invoke claude_stop_all() when the window is closing
//
// Reader threads emit `claude-event` events with payload {"key": "<key>",
// "line": "<original stdout line>"} so the frontend can route to the right
// chat state. `claude-stderr` and `claude-exit` follow the same shape.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct ClaudeSessionState {
    inner: Mutex<HashMap<String, Instance>>,
}

struct Instance {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Serialize, Deserialize)]
pub struct StartArgs {
    pub model: Option<String>,
    pub resume: Option<String>,
    pub cwd: Option<String>,
    pub append_system_prompt: Option<String>,
}

#[tauri::command]
pub fn claude_start(
    app: AppHandle,
    state: State<'_, ClaudeSessionState>,
    key: String,
    args: StartArgs,
) -> Result<(), String> {
    if key.is_empty() {
        return Err("session key required".into());
    }

    // Kill any existing instance for THIS key (e.g. on model switch / refresh).
    {
        let mut guard = state.inner.lock().unwrap();
        if let Some(mut prev) = guard.remove(&key) {
            let _ = prev.child.kill();
        }
    }

    // On Windows, claude installed via npm is `claude.cmd` (a batch shim), not
    // `claude.exe`. Rust's std::process::Command on Windows uses CreateProcess
    // which CANNOT launch `.cmd`/`.bat` files directly — that's why a plain
    // `Command::new("claude")` works for the native Anthropic Windows installer
    // (which drops claude.exe) but fails with "%1 is not a valid Win32
    // application" for npm installs (where PATH only resolves to `claude.cmd`
    // or the extensionless shell-script shim).
    //
    // resolve_claude_command walks PATH itself, picks the first existing
    // variant (preferring .exe, falling back to .cmd/.bat, finally bare),
    // and wraps non-.exe variants through `cmd.exe /C` so the batch shim
    // resolves correctly on every Rust version.
    let (program, prefix_args) = resolve_claude_command();
    let mut cmd = Command::new(&program);
    for a in &prefix_args {
        cmd.arg(a);
    }
    cmd.arg("--print")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .arg("--dangerously-skip-permissions");

    if let Some(m) = &args.model {
        if !m.is_empty() {
            cmd.arg("--model").arg(m);
        }
    }
    if let Some(id) = &args.resume {
        if !id.is_empty() {
            cmd.arg("--resume").arg(id);
        }
    }
    if let Some(p) = &args.append_system_prompt {
        if !p.is_empty() {
            cmd.arg("--append-system-prompt").arg(p);
        }
    }

    if let Some(dir) = &args.cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    } else if let Some(home) = std::env::var_os("USERPROFILE") {
        cmd.current_dir(home);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {}", e))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app_out = app.clone();
    let key_out = key.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    let payload = json!({ "key": &key_out, "line": l }).to_string();
                    let _ = app_out.emit("claude-event", payload);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let payload = json!({ "key": &key_out }).to_string();
        let _ = app_out.emit("claude-exit", payload);
    });

    let app_err = app.clone();
    let key_err = key.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                if !l.trim().is_empty() {
                    let payload = json!({ "key": &key_err, "line": l }).to_string();
                    let _ = app_err.emit("claude-stderr", payload);
                }
            }
        }
    });

    state
        .inner
        .lock()
        .unwrap()
        .insert(key, Instance { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn claude_send(
    state: State<'_, ClaudeSessionState>,
    key: String,
    json_line: String,
) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    let inst = guard
        .get_mut(&key)
        .ok_or_else(|| format!("session {} not started", key))?;
    writeln!(inst.stdin, "{}", json_line.trim_end()).map_err(|e| e.to_string())?;
    inst.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_stop(
    state: State<'_, ClaudeSessionState>,
    key: String,
) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    if let Some(mut inst) = guard.remove(&key) {
        let _ = inst.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn claude_stop_all(state: State<'_, ClaudeSessionState>) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    let keys: Vec<String> = guard.keys().cloned().collect();
    for k in keys {
        if let Some(mut inst) = guard.remove(&k) {
            let _ = inst.child.kill();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn claude_running(state: State<'_, ClaudeSessionState>, key: String) -> bool {
    state.inner.lock().unwrap().contains_key(&key)
}

#[tauri::command]
pub fn claude_active_keys(state: State<'_, ClaudeSessionState>) -> Vec<String> {
    state.inner.lock().unwrap().keys().cloned().collect()
}

/// Resolve the claude executable to spawn.
///
/// Returns (program, prefix_args). For `.exe` and POSIX claude, prefix_args is
/// empty and program is the binary. For Windows `.cmd`/`.bat` shims (npm
/// installs), program is `cmd.exe` and prefix_args is `["/C", "<absolute path
/// to claude.cmd>"]` so the batch shim runs through cmd.exe — this is the
/// only reliable way to launch `.cmd` files across all Rust versions.
#[cfg(windows)]
fn resolve_claude_command() -> (String, Vec<String>) {
    use std::path::PathBuf;
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return ("claude".to_string(), vec![]),
    };
    for dir in std::env::split_paths(&path) {
        // Try claude.exe first — direct spawn, no shell wrapper needed.
        let exe: PathBuf = dir.join("claude.exe");
        if exe.is_file() {
            return (exe.to_string_lossy().into_owned(), vec![]);
        }
        // Then any of the batch shim variants — wrap through cmd.exe /C.
        for ext in ["cmd", "bat"] {
            let shim: PathBuf = dir.join(format!("claude.{}", ext));
            if shim.is_file() {
                return (
                    "cmd.exe".to_string(),
                    vec!["/C".to_string(), shim.to_string_lossy().into_owned()],
                );
            }
        }
    }
    // Last resort — let std do its own PATH lookup. Works if claude.exe is
    // somewhere PATHEXT can find; produces the original error otherwise.
    ("claude".to_string(), vec![])
}

#[cfg(not(windows))]
fn resolve_claude_command() -> (String, Vec<String>) {
    ("claude".to_string(), vec![])
}
