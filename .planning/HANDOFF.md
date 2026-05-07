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
| 3 — Session Ledger panel | ✅ done | `src-tauri/src/ledger.rs` + `src/Ledger.tsx`. Reads `~/.claude/projects/<...>/*.jsonl`, renders as markdown on demand. |
| 4 — Live context monitor | ✅ done | `src-tauri/src/monitor.rs` polls active JSONL every 3s, emits `session-usage` event. Token pill in titlebar with color states. |
| 5 — UI polish + installer | ✅ done (committed 657987f) | Recipe 1 metallic background, SVG grain overlay, IBM Plex / Geist Mono, sibling drag region (Tauri 2 + WebView2 fix). |
| 6 — Continuous ledger writer | ⚠ pending verify | `src-tauri/src/ledger_watcher.rs` tails active JSONL every 3s, appends one-line markdown summaries to `Desktop/claude-terminal/sessions/<id>.md`. **Built this session, not yet runtime-tested.** |
| 7 — Auto-resume in same tab | ⚠ pending verify | App.tsx polls usage every 2s; at ≥92% context AND ≥5s idle, sends Ctrl+C×2 to exit claude, then `claude --continue --append-system-prompt "..."` pointing the new claude at the ledger MD path. **Built this session, not yet runtime-tested.** |

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

## Step 2 + Step 3 — what was built this session

### Continuous ledger writer (Step 2) — `src-tauri/src/ledger_watcher.rs`

A 3s-polling background thread spawned from `lib.rs setup()`. For the most-recent JSONL
across all `~/.claude/projects/*/*.jsonl`:
- First poll: writes a header to `Desktop/claude-terminal/sessions/<id>.md` and resets offset.
- Subsequent polls: reads from `last_offset` to last newline, parses each new entry, appends
  a one-line markdown summary per relevant entry, advances offset.
- Skips stale sessions (>30 min idle).

Markdown format examples:
- `` `[14:32:15]` **user** — fix the auth bug ``
- `` `[14:32:18]` 🔧 `Bash` → `npm test` ``
- `` `[14:32:21]` 🔧 `Edit` → .../src/login.js ``
- `` `[14:32:30]` **claude** — Found the issue. Updating handler... ``
- `  ↳ ✓ tool result summary`

System reminders, IDE selection, and prompt-injection-shaped strings are filtered out so
the narrative stays readable.

Note: this file overwrites the on-demand snapshot from `ledger_export_session` if both
ever target the same path — but the 85%-threshold export call was removed from App.tsx
(continuous writer makes it redundant). The export Tauri command still exists for ad-hoc
use from `Ledger.tsx`.

### Auto-resume in same tab (Step 3) — modifications to `src/App.tsx` + `src/Terminal.tsx`

App.tsx — every 2s checks: usage ≥ 92% AND last `session-usage` event > 5s ago AND not
yet resumed for this session_id. If trigger fires:

1. Dispatch `ct:write` custom event so Terminal.tsx writes a cyan `↻ session at NN% — auto-resuming…` line into the xterm display.
2. `pty_write("\x03")` — first Ctrl+C (interrupt any claude operation in flight).
3. Wait 250ms.
4. `pty_write("\x03")` — second Ctrl+C (claude exits cleanly back to PowerShell).
5. Wait 1500ms for PowerShell prompt to redraw.
6. `pty_write("claude --continue --dangerously-skip-permissions --append-system-prompt \"<note>\"\r")`.

The `<note>` does NOT inline the full ledger (Windows 32K command-line limit). Instead it
points the new claude at `Desktop/claude-terminal/sessions/<id>.md` and tells it to Read
the file if it needs historical context. This is the practical workaround for the Windows
arg length limit while still giving the new claude session full continuity.

`resumedRef` (Set) prevents a re-fire — one auto-resume per session_id, regardless of
how many times the threshold is crossed.

Terminal.tsx now listens for the `ct:write` window event and pipes the string into
`term.write(...)` so external components can inject UI markers.

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

Phases 0–7 are all coded. The build kicked off at the end of the 2026-05-07 second session
to bundle Steps 2+3 into the installer. **What's left is runtime verification:**

1. Confirm the new installer at `Desktop/claude/claude-terminal-installers/` has been run.
2. Open the app — claude should auto-launch as before.
3. Have a real claude conversation. While it runs, open
   `Desktop/claude-terminal/sessions/<your-session-id>.md` in a separate viewer and
   confirm new lines are being appended every few seconds.
4. Push usage close to 92% (or temporarily lower `RESUME_THRESHOLD_PCT` in App.tsx for
   testing). After 5s idle, watch for the cyan `↻ session at …%` marker, claude exiting,
   and a fresh `claude --continue --append-system-prompt "…"` line being typed automatically.
5. The new claude session should be able to `Read` the ledger MD file when it needs
   historical context.

If Ctrl+C × 2 doesn't cleanly exit claude on the user's setup, swap to `\x04` (Ctrl+D)
or send `/exit\r` instead — it's a one-line change in App.tsx.

If anything in the UI still looks off, re-read `.planning/DESIGN-RESEARCH.md` Section A
recipes — that's the authoritative source. Don't iterate without re-reading it.
