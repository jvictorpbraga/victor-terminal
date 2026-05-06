# Phase 2 — Claude Agent SDK Integration (Design)

**Pre-implementation design.** Locked before coding begins. Builds on Phase 1.

---

## Goal

Typing `claude` (or pressing `Ctrl+J`) inside the terminal starts an embedded Claude session with full machine access. Output streams into the same xterm.js view. Feature parity with `claude` running inside cmd today.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Tauri webview (React)                                      │
│   xterm.js terminal ←→ Tauri commands                      │
└────────────────────────┬───────────────────────────────────┘
                         │ IPC
┌────────────────────────▼───────────────────────────────────┐
│ Tauri Rust backend                                         │
│   pty.rs       → PowerShell PTY (Phase 1)                  │
│   claude.rs    → Node sidecar manager (Phase 2)            │
│   ledger.rs    → markdown ledger writer (Phase 3)          │
└────────────────────────┬───────────────────────────────────┘
                         │ stdin/stdout (newline-delimited JSON)
┌────────────────────────▼───────────────────────────────────┐
│ Node sidecar (one per Claude session)                      │
│   claude-host.mjs                                          │
│   - imports @anthropic-ai/claude-agent-sdk                 │
│   - calls query() with bypassPermissions + all tools       │
│   - streams messages back over stdout as JSON lines        │
│   - reads user input from stdin as JSON lines              │
└────────────────────────────────────────────────────────────┘
```

## Why a Node sidecar (not in-process)

- @anthropic-ai/claude-agent-sdk is Node-only. Renderer is webview, can't run it. Tauri Rust can't run JS.
- Sidecar gives us crash isolation: if Claude SDK panics, terminal stays alive.
- Spawning is cheap (~100 ms cold start).

## IPC protocol (newline-delimited JSON over stdin/stdout)

### Rust → Sidecar (stdin)
```json
{"type": "user_input", "text": "fix the bug in login.js"}
{"type": "interrupt"}
{"type": "shutdown"}
```

### Sidecar → Rust (stdout)
```json
{"type": "ready", "session_id": "abc123"}
{"type": "assistant_text", "delta": "I'll look at the file..."}
{"type": "tool_use", "name": "Read", "args": {"path": "login.js"}, "id": "tu_1"}
{"type": "tool_result", "id": "tu_1", "summary": "Read login.js (152 lines)"}
{"type": "turn_end"}
{"type": "compact_started"}
{"type": "compact_complete", "summary": "..."}
{"type": "session_end", "session_id": "abc123"}
{"type": "error", "message": "..."}
```

Stderr from sidecar is captured to `.planning/sidecar-{session}.log` for debugging.

## File structure additions

```
src-tauri/src/
  claude.rs        ← sidecar lifecycle (spawn, send, recv, kill)

resources/
  claude-host.mjs  ← the sidecar script

src/
  ClaudeMode.tsx   ← React state for "in Claude" vs "in shell" mode indicator
```

`claude-host.mjs` is shipped as a Tauri resource (declared in tauri.conf.json `bundle.resources`), not bundled with `pkg`. Avoids 80MB sidecar binary. Requires Node on host machine — already a project dependency.

## API key flow

1. First `claude` invocation: prompt for API key in a modal, store via `keyring-rs` under service `claude-terminal`, account `anthropic-api-key`.
2. Subsequent invocations: load from keyring silently.
3. Settings panel (Phase 5) exposes a "rotate API key" button.

## Activation UX

- Type `claude` and press Enter at any shell prompt → backend detects, intercepts, spawns sidecar, **does not** forward `claude` to the PTY shell.
- Or press `Ctrl+J` from anywhere → same effect.
- While in Claude mode: prompt prefix changes to `claude › ` (rendered by sidecar, not shell).
- `/exit` or `Ctrl+D` exits Claude mode, returns to shell.

## Tool config (matches today's Claude experience)

```js
const result = query({
  prompt: userInput,
  options: {
    model: "claude-opus-4-7",
    permissionMode: "bypassPermissions",
    cwd: process.env.PWD,
    allowedTools: [
      "Bash", "Read", "Write", "Edit", "Glob", "Grep",
      "Agent", "WebSearch", "WebFetch", "TodoWrite"
    ],
    settingSources: ["user", "project"],
    canUseTool: undefined,  // bypassPermissions handles this
  },
});
```

## Streaming output to xterm.js

Sidecar emits `assistant_text` deltas. Rust forwards them via the same `pty-output` event channel. Frontend writes them straight to xterm. ANSI color codes are preserved (Claude SDK output is plain text — we add subtle dim color via prefix).

## Error handling

- Sidecar dies unexpectedly → emit `pty-output` red text, return user to shell prompt
- API key invalid → modal asking for new key
- Network error → display retry prompt, don't kill session

## Open question (decide before coding)

**Should Claude run inside the active PowerShell PTY, or in a separate stream?**

Options:
- **A — replace PTY temporarily**: pause PTY, route all input/output through sidecar, resume PTY on exit. Simpler UX (one stream). Risk: PTY commands while in Claude mode are weird.
- **B — overlay**: PTY keeps running underneath. Claude mode renders on top. Restored when exiting. Cleaner separation but harder to implement.

Default: **A** — matches what `claude` does in cmd.exe today.

## Acceptance criteria

1. `claude` in shell starts Claude with full tools — same as cmd.exe today
2. API key stored securely once, never re-prompted
3. Output streams smoothly (no buffering hiccups)
4. `Ctrl+C` interrupts Claude mid-response without crashing the app
5. Sidecar crash → graceful recovery, terminal usable

## Estimated work

- Sidecar `claude-host.mjs`: ~150 LoC
- Rust `claude.rs`: ~200 LoC
- Frontend mode switch: ~80 LoC
- Keyring integration: ~50 LoC
- **Total: ~480 LoC + manual API testing**

Phase 3 (ledger) hooks into the sidecar's `tool_use` / `tool_result` messages — designed in concert with this.
