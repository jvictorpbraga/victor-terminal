mod ledger;
mod pty;

use pty::PtyState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(PtyState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            ledger::ledger_list_sessions,
            ledger::ledger_get_session,
            ledger::ledger_export_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
