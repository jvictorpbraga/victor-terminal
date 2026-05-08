mod claude_session;
mod ledger;
mod ledger_watcher;
mod monitor;
mod pty;

use claude_session::ClaudeSessionState;
use pty::PtyState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(PtyState::default());
            app.manage(ClaudeSessionState::default());
            monitor::spawn_monitor(app.handle().clone());
            ledger_watcher::spawn_ledger_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            ledger::ledger_list_sessions,
            ledger::ledger_get_session,
            ledger::ledger_get_session_jsonl,
            ledger::ledger_export_session,
            ledger::ledger_search,
            ledger_watcher::read_session_ledger,
            ledger_watcher::get_sessions_dir,
            claude_session::claude_start,
            claude_session::claude_send,
            claude_session::claude_stop,
            claude_session::claude_stop_all,
            claude_session::claude_running,
            claude_session::claude_active_keys,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
