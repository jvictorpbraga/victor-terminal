# claude-terminal

A modern, minimal Windows terminal built around Claude Code. Replaces `cmd.exe` for daily Claude work with:

- Smooth GPU-rendered terminal (xterm.js)
- Reliable copy/paste (large blocks, Unicode, Ctrl+A — no breakage)
- Embedded Claude Agent SDK with full machine access
- **Session ledger** — every Claude action appended to a markdown journal
- **Auto-resume** — when context fills, Claude continues seamlessly in the same tab using the ledger as memory

## Stack

- Tauri 2 (Rust backend, native Windows shell, ~15 MB binary)
- React 19 + Vite + TypeScript (frontend)
- xterm.js + WebGL renderer
- portable-pty (Rust PTY for PowerShell)
- @anthropic-ai/claude-agent-sdk (Node sidecar)
- SQLite via tauri-plugin-sql (chat history index)
- keyring-rs (secure API key storage in Windows Credential Manager)

## Status

See `.planning/ROADMAP.md`. Currently in Phase 1 — Tauri shell + xterm.js terminal.

## Dev

```powershell
npm install
npm run tauri dev
```

Requires Rust + VS Build Tools (installed automatically by setup).
