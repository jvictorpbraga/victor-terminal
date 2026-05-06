// Session usage monitor — polls the most-recently-modified session JSONL,
// extracts the latest usage block, and emits a Tauri event so the frontend can
// show a token-usage indicator and trigger the ledger export at thresholds.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Debug)]
pub struct UsageSnapshot {
    pub session_id: String,
    pub project_dir: String,
    pub model: String,
    pub limit: u64,
    pub used: u64,
    pub input: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    pub output: u64,
    pub used_pct: f32,
}

fn claude_root() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".claude").join("projects"))
}

/// Find the JSONL file that was last modified across all project dirs.
fn find_active_session() -> Option<(PathBuf, String, String)> {
    let root = claude_root()?;
    let mut best: Option<(PathBuf, String, SystemTime)> = None;
    let project_iter = fs::read_dir(&root).ok()?;
    for proj in project_iter.flatten() {
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

fn model_limit(model: &str) -> u64 {
    let m = model.to_lowercase();
    // Modern Claude models on the API:
    //   Opus 4.7:   1M context (verified — claude-code routinely fills past 600K)
    //   Sonnet 4.x: 1M context (extended-context beta, common in claude-code)
    //   Haiku 4.x:  200K
    if m.contains("haiku") {
        200_000
    } else {
        1_000_000
    }
}

fn read_last_usage(path: &Path) -> Option<UsageSnapshot> {
    let content = fs::read_to_string(path).ok()?;
    let mut last_usage: Option<(Value, String)> = None;
    for line in content.lines() {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|x| x.as_str()) == Some("assistant") {
            let model = v
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
                .unwrap_or("claude-sonnet-4")
                .to_string();
            if let Some(usage) = v.get("message").and_then(|m| m.get("usage")) {
                last_usage = Some((usage.clone(), model));
            }
        }
    }
    let (usage, model) = last_usage?;
    let input = usage.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let cache_create = usage
        .get("cache_creation_input_tokens")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let output = usage.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    let used = input + cache_read + cache_create;
    let limit = model_limit(&model);
    let used_pct = (used as f32 / limit as f32) * 100.0;

    Some(UsageSnapshot {
        session_id: String::new(),
        project_dir: String::new(),
        model,
        limit,
        used,
        input,
        cache_read,
        cache_create,
        output,
        used_pct,
    })
}

pub fn spawn_monitor(app: AppHandle) -> Arc<AtomicBool> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop = stop_flag.clone();
    std::thread::spawn(move || {
        let mut last_emit_key = String::new();
        let mut last_mtime: SystemTime = SystemTime::UNIX_EPOCH;
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_secs(3));
            let active = match find_active_session() {
                Some(a) => a,
                None => continue,
            };
            let (path, project, id) = active;
            let mtime = match fs::metadata(&path).and_then(|m| m.modified()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let key = format!("{}|{:?}", id, mtime);
            if key == last_emit_key {
                continue;
            }
            // Skip files that haven't changed in 30 minutes (stale).
            if SystemTime::now()
                .duration_since(mtime)
                .map(|d| d.as_secs())
                .unwrap_or(0)
                > 1800
            {
                continue;
            }
            if let Some(mut snap) = read_last_usage(&path) {
                snap.session_id = id.clone();
                snap.project_dir = project.clone();
                let _ = app.emit("session-usage", &snap);
                last_emit_key = key;
                last_mtime = mtime;
            }
            let _ = last_mtime;
        }
    });
    stop_flag
}
