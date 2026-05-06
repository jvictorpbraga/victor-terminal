# claude-terminal — Session Handoff (2026-05-07)

> Read this first when starting the next session. Tells you exactly where things stand,
> what's done, what's broken, and how to keep going.

---

## What this project is

A **Tauri 2 + React + xterm.js** Windows terminal app at `C:\Users\Victor\Desktop\claude-terminal\`.
Built to replace `cmd.exe` for daily Claude Code use. Auto-launches `claude` on startup, fixes
every cmd.exe pain point (paste, Ctrl+A, Shift+Enter), tracks live token usage, exposes a
session ledger panel.

Distributed as a 1.6 MB NSIS installer at
`C:\Users\Victor\Desktop\claude\claude-terminal-installers\claude-terminal_0.1.0_x64-setup.exe`.
Installed copy lives at `C:\Users\Victor\AppData\Local\claude-terminal\claude-terminal.exe`.
Desktop shortcut at `C:\Users\Victor\Desktop\claude-terminal.lnk` (icon overridden to claude.exe).

---

## Phase status

| Phase | Status | Notes |
|---|---|---|
| 0 — spec/scaffold | ✅ done | `.planning/SPEC.md`, `ROADMAP.md` |
| 1 — Tauri shell + xterm | ✅ done | All editor shortcuts work in shell AND inside Claude Code |
| 2 — Claude SDK sidecar | ⏭ skipped | Not needed — claude CLI runs directly inside our PowerShell |
| 3 — Session Ledger panel | ✅ done | `src-tauri/src/ledger.rs` + `src/Ledger.tsx`. Reads `~/.claude/projects/<...>/*.jsonl`, renders as markdown. Auto-exports to `Desktop/claude-terminal/sessions/<id>.md` at 85% context. |
| 4 — Live context monitor | ✅ done | `src-tauri/src/monitor.rs` polls active JSONL every 3s, emits `session-usage` event. Token pill in titlebar with color states. **NOT a true auto-resume — only a warning + manual `/compact` suggestion.** |
| 5 — UI polish + installer | ⚠ in progress | Production .msi + NSIS built. UI iterated 6+ times. **Latest CSS+JSX changes uncommitted, in this session.** |

---

## Where Phase 5 actually stands (the UI saga)

User wanted "modern minimalistic metallic shine like Cursor". Iterated through:
GitHub Dark → Tokyo Night → glassmorphic + traffic lights left → metallic shine attempt 1
(failed: harsh shiny bar at top) → metallic shine attempt 2 (failed: dull dark square).
Researcher (`a66656e7ab286bfea`) returned definitive recipes — applied in this session,
**not yet rebuilt and tested**.

### Current uncommitted changes (in this session)

**`src/styles.css`** — applied Recipe 1 from `.planning/DESIGN-RESEARCH.md`:
- `.app` background: 3-layer gradient (top radial highlight + bottom-right ambient + vertical linear)
- `.app::after`: SVG noise grain overlay at 6% opacity, `mix-blend-mode: overlay` — "the trick that makes gradients read as metal"
- `1px inset white box-shadow` for the metallic rim
- New `.titlebar-drag` element styling (drag region as flex:1)
- `pointer-events:none` on `.titlebar-title` — **critical Tauri 2 + WebView2 fix** (text inside drag region was eating drag hit-tests)

**`src/App.tsx`** — restructured titlebar HTML:
- `.titlebar-drag` (drag region) and `.traffic-lights` (buttons) are now **siblings** (not parent/child) per Tauri 2 issue #9901
- Buttons moved to right side
- Order: min (yellow) / max (green) / close (red)
- Ledger button is its own sibling between drag area and traffic lights

**`src/Terminal.tsx`** — switched `fontFamily` to:
`'IBM Plex Mono', 'Geist Mono', 'JetBrains Mono', Consolas, monospace`
(researcher said Geist Mono is the top pick for Cursor/Linear feel — but I had IBM Plex
listed first; if the user prefers Geist primary, swap order or pin only `'Geist Mono'`).

### Known still-broken (likely)

- **Drag** — should now work because `.titlebar-drag` is the only drag region, with
  `pointer-events:none` on title text. Need to verify after rebuild.
- **Buttons** — should now work because they're siblings of the drag region.
- **Metallic shine** — should now look distributed/smooth instead of "bar at top". The
  SVG grain is the new ingredient.

---

## Critical implementation knowledge (don't relearn this)

### How shortcuts actually work in TUI mode (Claude Code is a TUI)

- **Detection**: `tuiSticky` flag in `Terminal.tsx`. Set when output contains box-drawing
  chars (`[─-╿]`). Cleared only when a shell prompt regex matches in output. Must NOT use
  a timeout — Claude Code only renders box chars at startup, then only updates input cells.
- **Ctrl+A inside claude**: scans the visible viewport bottom-up for the regex
  `^(\s*)(>|❯|›|»)\s+(\S.*?)\s*$`, picks the bottommost match. Buffer-absolute row =
  `baseY + cursorY` (NOT `viewportY + cursorY` — that was the original bug).
- **Backspace/Delete/Ctrl+X/typing while armed**: builds a clear sequence of
  `\x05` (Ctrl+E = end of line) + `"\x7f".repeat(armedSelLen + 8)` = N backspaces from
  end. Claude won't backspace past the prompt boundary, so overshoot is safe. Multi-line
  input works because we count the visual cells highlighted.
- **Ctrl+V**: ALWAYS read clipboard manually via `navigator.clipboard.readText()`. Never
  let xterm send `\x16` to claude — claude interprets that as "paste image", not "paste text".
- **Browser paste event**: a `document.addEventListener("paste", ..., {capture: true})`
  intercepts and `preventDefault + stopImmediatePropagation` IF `isTuiActive()`. In shell
  mode it lets the paste through normally.
- **Click-to-position cursor in claude**: convert click X/Y to terminal cell coords using
  `term.element.querySelector(".xterm-screen")` getBoundingClientRect (NOT `term.element`
  itself — that includes scrollbar). `Math.round` for X (snap to nearest cell boundary
  so clicks mid-glyph work). Synthesize `\x01 + N×\x1b[C` (Ctrl+A=BeginningOfLine + N
  Right arrows) OR `\x05 + N×\x1b[D` (Ctrl+E + N Lefts) — pick whichever side is closer.
- **Shift+Enter**: send `\n` (`\x0a` = Ctrl+J). PSReadLine treats it as AddLine; Claude
  Code treats it as multiline newline (Anthropic-documented universal). Also blocks the
  keypress event for Shift+Enter so xterm doesn't follow up with `\r` and submit.

### Trust dialog auto-skip

`~/.claude.json` has a `projects` map keyed by `path-with-forward-slashes` ; each entry
needs `hasTrustDialogAccepted: true`. We set this for `C:/Users/Victor` already. To
auto-trust ANY new cwd, we'd need a Rust startup hook that reads the file, ensures the
current cwd is in `projects`, and writes back. **NOT implemented yet** — would be a
~30-line `trust.rs` module called from `lib.rs setup`.

### Auto-launch claude on PowerShell start

In `src-tauri/src/pty.rs`, the PowerShell command is:
```
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();
chcp 65001 > $null;
if (Get-Command claude -ErrorAction SilentlyContinue) { claude --dangerously-skip-permissions }
```
The `--dangerously-skip-permissions` flag bypasses tool-permission prompts AND the trust
dialog (when combined with the .claude.json trust entry).

### TUI selection synthesis

In TUI mode, Ctrl+A doesn't truly highlight (claude redraws over it). We:
1. Visually highlight via `term.select(col, absRow, len)` for user feedback.
2. Set `tuiInputSelected = true` and store `armedSelLen` (visual cells count).
3. Next destructive key → send `\x05 + \x7f×(armedSelLen+8)` to clear, then new content.

---

## What's NOT yet built (the user's actual vision)

These are the two features the user explicitly wanted but **scoped down** during the session:

### Continuous ledger writer (Step 2)

**Vision:** As claude works, a markdown file is being written to in real time describing
every action ("Claude opened login.js", "Claude ran npm test", etc.). The user can open
this file at any moment and see a human-readable narrative.

**What exists:** Lazy generation via `ledger_get_session` Tauri command — reads JSONL
on demand. Auto-export to disk only at 85% context threshold.

**What's missing:** A file-watcher in Rust that polls/watches the active JSONL every
2-3s and *appends* to a running `Desktop/claude-terminal/sessions/<id>.md` so it's always
up to date (like a tail -f log).

**How to build:**
1. New `src-tauri/src/ledger_watcher.rs`. Reuse `monitor.rs`'s `find_active_session()`.
2. Track `last_byte_offset` per session. Each poll, read the file from that offset,
   parse the new lines, append a one-line markdown summary to the running MD file.
3. Markdown format: `[HH:MM:SS] 🔧 Bash → "npm test" → exit 0`,
   `[HH:MM:SS] 💬 user: "fix the auth bug"`,
   `[HH:MM:SS] ✏ Edit login.js`, etc.
4. Spawn from `lib.rs setup()` like `monitor.rs` already is.
5. Estimated 150 LOC.

### Auto-resume in same tab (Step 3)

**Vision:** When claude session approaches context limit (~95%), the app: (a) saves the
final ledger, (b) sends `\x04` (Ctrl+D) twice to gracefully exit current claude, (c)
runs `claude --continue --append-system-prompt "$(cat ledger.md)"` in the same PowerShell,
(d) the new claude continues with the ledger as background context. User sees a brief
`↻ resumed` marker, no work lost.

**What exists:** Token monitor + warning banner + auto-export of ledger. **No restart.**

**What's missing:** The actual exit-and-restart sequence. Hard parts:
- Detecting when claude is "idle" (no streaming response) so we can interrupt without
  losing a half-rendered answer.
- Sending the kill signal cleanly.
- Reading the ledger MD content and embedding it into the next `--append-system-prompt`
  flag (Windows command-line length limits — 32K chars — might force us to write to a
  temp file and use `--append-system-prompt-file` if that flag exists, else inline up
  to ~30K).

**How to build:**
1. Frontend listens to `session-usage` event. At ~92% AND `last_idle_for > 5s`,
   send via `pty_write`: `\r` (cancel any running claude operation), wait, then
   `\x04` (exit claude), wait 1s for PowerShell prompt to come back, then send
   `claude --continue --append-system-prompt-file "%USERPROFILE%\Desktop\claude-terminal\sessions\<id>.md"\r`.
2. Add an inline marker in xterm via `term.write("\r\n\x1b[36m↻ session resumed with ledger context\x1b[0m\r\n")`.
3. Estimated ~80 LOC (mostly frontend).

---

## Build/install/launch cycle

```powershell
# Build (frontend cached on incremental, full Rust LTO ~3-4 min)
cd $env:USERPROFILE\Desktop\claude-terminal
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
npm run tauri build

# Install silently (per-user, no UAC)
& "$env:USERPROFILE\Desktop\claude\claude-terminal-installers\claude-terminal_0.1.0_x64-setup.exe" /S

# Launch
& "$env:LOCALAPPDATA\claude-terminal\claude-terminal.exe"
```

Build artifacts land in `src-tauri/target/release/bundle/{msi,nsis}/`. Always copy to
`Desktop\claude\claude-terminal-installers\` after build (that's where the user's shortcut
points if anyone reinstalls).

---

## Files of interest

```
Desktop/claude-terminal/
├── .planning/
│   ├── SPEC.md, ROADMAP.md             ← phase 0 spec
│   ├── DESIGN-RESEARCH.md              ← latest research (Tokyo Night, Geist Mono, drag fix)
│   ├── BUGS-RESEARCH.md, SHIFT-ENTER-DEEP.md, CTRL-A-DEBUG.md, CLAUDE-CODE-BINDINGS.md,
│   │   CLAUDE-CLEAR-INPUT.md, TUI-CODE-REVIEW.md   ← all the reasoning that landed Phase 1 fixes
│   └── HANDOFF.md                      ← this file
├── src/
│   ├── App.tsx                         ← titlebar + ledger button + usage banner
│   ├── Terminal.tsx                    ← xterm wiring + ALL the keybinding logic (~600 LOC)
│   ├── Ledger.tsx                      ← session list + markdown render
│   └── styles.css                      ← all styling, recently overhauled
├── src-tauri/src/
│   ├── lib.rs                          ← tauri builder, spawns monitor on startup
│   ├── pty.rs                          ← PowerShell PTY + auto-claude command
│   ├── ledger.rs                       ← JSONL → markdown commands
│   └── monitor.rs                      ← live token usage poller
└── sessions/<id>.md                    ← auto-saved ledger exports (created at 85%)
```

---

## TL;DR for next session

1. Pull the build that's running right now into the installed app (or rebuild fresh).
2. Test: drag the window from titlebar empty space, click min/max/close, verify metallic
   shine looks smooth across the whole screen.
3. If UI is good → start **Step 2: continuous ledger writer** (`ledger_watcher.rs`).
4. Then **Step 3: auto-resume** (the actual differentiator the user wants).

If anything in the UI still looks off, re-read `.planning/DESIGN-RESEARCH.md` Section A
recipes — that's the authoritative source. Don't iterate without re-reading it.
