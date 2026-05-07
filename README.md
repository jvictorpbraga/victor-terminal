# Victor Terminal

A native chat app for Claude Code — looks like Claude.ai, runs locally,
endless context, real-time action ledger.

**Built with Tauri 2 + React 19 + TypeScript.** Works on Windows, macOS,
and Linux from the same source. Friends without Windows: build from source
with the steps below.

---

## What it does

- Chat with Claude (Opus / Sonnet / Haiku) in a clean modern UI — no terminal
  noise, just bubbles with markdown, expandable thinking + tool calls, copy
  buttons everywhere
- **Endless context.** When the model hits 75% of its context window the app
  silently spawns a new claude session in the background, hands it a summary
  of your conversation built from the running ledger, and your chat keeps
  going. UI never resets.
- **Conversation sidebar** with title + content search across every chat
- **Voice input** (Web Speech API) with a live language switcher (10 langs)
- **Image paste** (Ctrl+V) and `+` button for attachments
- **Live markdown ledger** written for every chat (`Desktop/claude-terminal/sessions/<id>.md`),
  capturing every claude action — feeds the auto-restart context handoff
- Dark metallic UI with custom Vt branding

Architecture overview is in `.planning/PROJECT-V2.md`. Phase-by-phase audit
of features in `.planning/AUDIT.md`.

---

## Stack

| Layer | Tech |
|---|---|
| Native shell + windowing | Tauri 2 (Rust) |
| Chat backend | `claude-code` CLI driven via `--print --input-format=stream-json --output-format=stream-json`, spawned + brokered by `src-tauri/src/claude_session.rs` |
| Frontend | React 19 + Vite + TypeScript, `react-markdown` + `remark-gfm` for rendering |
| Session ledger | Background polling thread `src-tauri/src/ledger_watcher.rs` tails `~/.claude/projects/<cwd>/<id>.jsonl` and appends a markdown narrative |
| Voice | Browser Web Speech API (works in WebView2 / WKWebView / WebKitGTK) |

The legacy xterm-based terminal mode (`src/Terminal.tsx`) is still in the
codebase but unused since the Phase 2 rewrite — kept for reference.

---

## Prerequisites (any platform)

You need:

1. **Node.js 20+** — https://nodejs.org
2. **Rust toolchain** — https://rustup.rs (`rustup default stable`)
3. **Tauri 2 OS deps** — see https://v2.tauri.app/start/prerequisites/
   - macOS: just Xcode Command Line Tools (`xcode-select --install`)
   - Linux (Debian/Ubuntu):
     ```
     sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev
     ```
   - Windows: Visual Studio Build Tools 2022 with the "Desktop development with C++" workload, plus the WebView2 runtime (preinstalled on Windows 10+ 1809+)
4. **Claude Code CLI** with auth set up:
   ```
   npm install -g @anthropic-ai/claude-code
   claude auth
   ```
   Auth is per-user in `~/.claude/`. The app shells out to `claude` at runtime — bring your own Anthropic account.

---

## Run from source (development)

```bash
git clone https://github.com/jvictorpbraga/victor-terminal.git
cd victor-terminal
npm install
npm run tauri dev
```

`tauri dev` starts a hot-reloading dev build. First compile is ~5 minutes on
a cold machine.

---

## Build a release binary

```bash
npm run tauri build
```

Outputs:

- **Windows**: `src-tauri/target/release/bundle/nsis/Victor Terminal_0.1.0_x64-setup.exe` and a `.msi` next to it
- **macOS**: `src-tauri/target/release/bundle/dmg/Victor Terminal_0.1.0_x64.dmg` (or `.app` bundle)
- **Linux**: `src-tauri/target/release/bundle/deb/` and/or `appimage/`, depending on the host distro

Release builds use full LTO + size optimization — expect ~3–4 minutes.

---

## How the auto-restart works

1. `monitor.rs` polls the active claude JSONL every 3 s and emits a `session-usage` Tauri event with `used_pct`.
2. `Chat.tsx` keeps a 1.5 s ticker. When `used_pct ≥ 75 %` AND no `claude-event` has fired for 5 s AND this `session_id` hasn't been refreshed yet:
   1. Reads `Desktop/claude-terminal/sessions/<id>.md` via `read_session_ledger`.
   2. Trims to the last ~18 KB (Windows command-line length safety).
   3. Composes a system prompt: *"Previous internal session reached N % … below is the recent narrative … the full ledger is at PATH — Read it if you need older context"*.
   4. Calls `claude_start({ append_system_prompt: note })`. The existing claude subprocess is killed and a fresh one spawned with the ledger pre-loaded.
   5. Renders a `↻ Context refreshed in the background` notice for 3.5 s.
3. The chat React state is **never** wiped — visible messages all stay. The user keeps typing; subsequent inputs go to the new claude.

Known limitation: each refresh creates a new internal session ID, so the
sidebar lists multiple entries for one logical conversation. Phase 4.1 work
would unify them via a manifest. See `.planning/AUDIT.md`.

---

## Permissions

The app spawns claude with `--dangerously-skip-permissions`. Claude can run
any tool (Bash, Edit, Write, WebFetch, etc.) without confirmation. It runs as
your user — same privileges you have. To make claude prompt before each tool,
remove that flag from `src-tauri/src/claude_session.rs`.

---

## Layout

```
src/                       React frontend
├── App.tsx                top-level — titlebar, sidebar rail, signature
├── chat/
│   ├── Chat.tsx           message list + claude-event subscription + auto-restart
│   ├── Message.tsx        bubble with markdown, thinking + tool blocks, copy buttons
│   ├── PromptBar.tsx      attach + model + voice + send
│   ├── Sidebar.tsx        slide-in conversation list with search
│   ├── Welcome.tsx        empty-state hero
│   └── types.ts
├── Ledger.tsx             [legacy — pre-V2 ledger panel, unused]
├── Terminal.tsx           [legacy — xterm-based terminal, unused]
└── styles.css             single CSS file, dark metallic

src-tauri/src/             Rust backend
├── claude_session.rs      spawns + brokers `claude --print --input-format=stream-json`
├── ledger.rs              session-list / search / get-session-jsonl Tauri commands
├── ledger_watcher.rs      background thread tailing the active JSONL → MD ledger
├── monitor.rs             usage % polling
├── pty.rs                 [legacy PTY backend, unused but still mounted]
└── lib.rs                 Tauri builder + command registry

scripts/make-icon.ps1      generates the metallic Vt PNG (PowerShell — Windows-only). Pre-rendered icons in src-tauri/icons/ work everywhere.

.planning/                 design docs
├── AUDIT.md               feature-by-feature audit
├── PROJECT-V2.md          V2 architecture + phase plan
└── HANDOFF.md             cross-session handoff notes
```

---

## License

No license specified. All rights reserved unless and until a LICENSE file is added.

## Author

[Victor Braga](https://github.com/jvictorpbraga)
