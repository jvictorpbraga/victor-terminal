// Claude Code subprocess manager — spawns `claude --print --input-format=stream-json
// --output-format=stream-json` and brokers JSON line events to the frontend
// over Tauri events. This replaces the xterm/PTY approach for V2 (chat UI).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct ClaudeSessionState {
    inner: Mutex<Option<Instance>>,
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
    args: StartArgs,
) -> Result<(), String> {
    // If already running, kill first.
    {
        let mut guard = state.inner.lock().unwrap();
        if let Some(mut prev) = guard.take() {
            let _ = prev.child.kill();
        }
    }

    let mut cmd = Command::new("claude");
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

    // Hide console window on Windows for the spawned child.
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
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    let _ = app_out.emit("claude-event", l);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = app_out.emit("claude-exit", ());
    });

    let app_err = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                if !l.trim().is_empty() {
                    let _ = app_err.emit("claude-stderr", l);
                }
            }
        }
    });

    *state.inner.lock().unwrap() = Some(Instance { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn claude_send(state: State<'_, ClaudeSessionState>, json_line: String) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    let inst = guard.as_mut().ok_or("claude session not started")?;
    writeln!(inst.stdin, "{}", json_line.trim_end()).map_err(|e| e.to_string())?;
    inst.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_stop(state: State<'_, ClaudeSessionState>) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    if let Some(mut inst) = guard.take() {
        let _ = inst.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn claude_running(state: State<'_, ClaudeSessionState>) -> bool {
    state.inner.lock().unwrap().is_some()
}
