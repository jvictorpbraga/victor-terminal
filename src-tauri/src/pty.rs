// PTY backend using portable-pty.
// One PTY per app instance (single-window, single-shell — per spec).
//
// Windows landmines handled here:
//  - UTF-8 buffering across reads (multi-byte chars never split)
//  - chcp 65001 sent on shell init (UTF-8 code page)
//  - Resize honored via PtySize
//
// Frontend contract:
//   invoke('pty_spawn', { shell, cols, rows, cwd })
//   invoke('pty_write', { data })
//   invoke('pty_resize', { cols, rows })
//   invoke('pty_kill')
// Events emitted:
//   'pty-output' (string)  — UTF-8 chunk from shell
//   'pty-exit'   (i32)     — exit code

use std::io::{Read, Write};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{Emitter, State};

#[derive(Default)]
pub struct PtyState {
    inner: Mutex<Option<PtySession>>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    code: i32,
}

#[tauri::command]
pub fn pty_spawn(
    app: tauri::AppHandle,
    state: State<'_, PtyState>,
    shell: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&shell);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    } else if let Some(home) = std::env::var_os("USERPROFILE") {
        cmd.cwd(home);
    }

    // PowerShell: ensure UTF-8 output and a clean prompt. Shift+Enter is delivered
    // by the frontend as a win32-input-mode sequence which PSReadLine reads natively.
    if shell.to_lowercase().contains("powershell") {
        cmd.args([
            "-NoLogo",
            "-NoExit",
            "-Command",
            "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); chcp 65001 > $null",
        ]);
    } else if shell.to_lowercase().contains("cmd") {
        cmd.args(["/K", "chcp 65001 > nul"]);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    *state.inner.lock() = Some(PtySession {
        master: pair.master,
        writer,
        child,
    });

    // Spawn reader thread — emits UTF-8 chunks to frontend, also signals exit on EOF.
    let app_handle = app.clone();
    std::thread::spawn(move || {
        spawn_reader(reader, app_handle);
    });

    Ok(())
}

fn spawn_reader(mut reader: Box<dyn Read + Send>, app: tauri::AppHandle) {
    // 4 KB buffer matches the IPC slice size we want for paste handling.
    let mut buf = [0u8; 4096];
    // Carry-over for partial UTF-8 at chunk boundaries.
    let mut leftover: Vec<u8> = Vec::new();

    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                let _ = app.emit("pty-exit", ExitPayload { code: 0 });
                break;
            }
            Ok(n) => {
                // Combine leftover from previous read with new bytes.
                let mut combined = std::mem::take(&mut leftover);
                combined.extend_from_slice(&buf[..n]);

                // Find the longest valid UTF-8 prefix.
                let valid_up_to = match std::str::from_utf8(&combined) {
                    Ok(_) => combined.len(),
                    Err(e) => e.valid_up_to(),
                };

                // Emit valid prefix; keep tail for next iteration.
                if valid_up_to > 0 {
                    let chunk = unsafe {
                        // Safe: valid_up_to is the upper bound of validated UTF-8.
                        std::str::from_utf8_unchecked(&combined[..valid_up_to]).to_string()
                    };
                    let _ = app.emit("pty-output", chunk);
                }
                leftover = combined[valid_up_to..].to_vec();
            }
            Err(e) => {
                let _ = app.emit("pty-output", format!("\r\n[pty read error: {}]\r\n", e));
                let _ = app.emit("pty-exit", ExitPayload { code: -1 });
                break;
            }
        }
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    let mut guard = state.inner.lock();
    let session = guard.as_mut().ok_or("pty not spawned")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.inner.lock();
    let session = guard.as_ref().ok_or("pty not spawned")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>) -> Result<i32, String> {
    let mut guard = state.inner.lock();
    if let Some(mut session) = guard.take() {
        let _ = session.child.kill();
        let status = session.child.wait().map_err(|e| e.to_string())?;
        Ok(status.exit_code() as i32)
    } else {
        Ok(0)
    }
}
