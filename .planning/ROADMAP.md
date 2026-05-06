# claude-terminal — Roadmap

**Phases are sequential.** Each phase ends with a working, testable deliverable on Victor's machine. No phase is "done" until acceptance criteria pass.

---

## Phase 0 — Project scaffold + spec [in progress]

**Deliverable:** `Desktop/claude-terminal/` exists with: SPEC.md, ROADMAP.md, RESEARCH.md (from researcher agent), git initialized, README placeholder.

**Tasks:**
- [x] Create project directory + Desktop/claude shortcut
- [x] Write SPEC.md (this file's sibling)
- [x] Spawn researcher agent for stack recon
- [ ] Confirm Rust install with Victor
- [ ] Init git repo
- [ ] Write minimal README

**Exit criteria:** Victor approves spec, Rust toolchain installed (or alternative chosen), researcher brief reviewed.

---

## Phase 1 — Tauri shell + xterm.js terminal

**Deliverable:** A standalone Tauri app that opens a real PowerShell session, supports paste/Ctrl+A/scroll, and looks clean. No Claude yet.

**Tasks:**
- Init Tauri 2 project with React + Vite frontend
- Embed xterm.js with WebGL addon
- Wire PTY (node-pty sidecar OR Rust portable-pty — researcher recommendation)
- Handle resize, copy/paste, keybindings
- Basic dark theme + custom font

**Exit criteria:** Victor uses the app for one full work session as a cmd.exe replacement and reports zero copy/paste failures.

---

## Phase 2 — Claude Agent SDK integration

**Deliverable:** Typing `claude` (or pressing a key combo) inside the terminal starts an embedded Claude session running with bypassPermissions. Output streams into the terminal.

**Tasks:**
- Add @anthropic-ai/claude-agent-sdk to Node sidecar
- Secure API key storage via Tauri stronghold or Credential Manager
- Wire SDK streaming output to xterm.js writer
- Enable all built-in tools (Bash, Read, Write, Edit, Agent, etc.)
- Handle SIGINT to interrupt Claude mid-stream

**Exit criteria:** Claude inside the app has feature parity with Claude in cmd today.

---

## Phase 3 — Session Ledger (markdown journal)

**Deliverable:** Every Claude tool call appends a human-readable entry to `sessions/{id}.md`, indexed in SQLite, browsable from the sidebar.

**Tasks:**
- Hook into SDK's PostToolUse event (or equivalent)
- Generate 1-2 line summary per call (heuristic + optional Claude-assisted)
- Write to flat .md + SQLite mirror
- Sidebar UI: list sessions, click to open ledger in side panel

**Exit criteria:** A ledger from a 30-min coding session is readable end-to-end with no LLM context, and Victor can find what Claude did 2 hours ago.

---

## Phase 4 — Auto-resume on context full

**Deliverable:** When Claude session approaches context limit, a fresh session takes over in the same tab, reads the ledger, and continues without the user noticing more than a `↻ resumed` marker.

**Tasks:**
- Token counter on every SDK message
- Trigger at 95% of model context window
- Graceful end of current session + spawn new one
- New session's system prompt includes ledger + Anthropic compact
- UI: inline marker, no terminal clear

**Exit criteria:** Force a context-fill on a real coding task. Resume happens. Claude continues coherently for 10+ more turns. No lost work.

---

## Phase 5 — UI polish + history browser + installer

**Deliverable:** Shippable v1.0 — installer Victor can give to friends.

**Tasks:**
- UI polish pass (Warp-inspired, simpler)
- Custom titlebar
- Settings panel (font, theme, API key)
- Session history browser
- Windows .msi installer via tauri-cli
- README + screenshots

**Exit criteria:** Fresh Windows machine can install and use the app from the .msi alone.

---

## Out of scope for v1 (parking lot)

- Multi-tab / split panes
- SSH support
- macOS / Linux builds
- Voice input
- Web browser embed
- Multi-Claude orchestration UI (Ruflo swarm visualizer)
- Plugin system
- Cloud sync of sessions
