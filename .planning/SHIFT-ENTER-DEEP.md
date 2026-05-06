# Shift+Enter — Deep Investigation

## TL;DR

Two distinct consumers, two different protocols. The current code targets PSReadLine but is being tested inside `claude` CLI, which uses a different protocol. **Both** must be handled.

| Consumer (what's reading the bytes) | Protocol it accepts | What we send today |
|---|---|---|
| PSReadLine (raw PowerShell) | win32-input-mode | `\x1b[13;28;13;1;16_\x1b[13;28;13;0;16_` (correct) |
| Claude Code CLI 2.1.0+ | Kitty CSI u | `\x1b[13;2u` (we don't send this) |

Anthropic's official docs explicitly list **Windows Terminal: "Not available; use Ctrl+J or `\` then Enter"** ([source](https://code.claude.com/docs/en/terminal-config)). The terminal must opt in by responding to the Kitty query.

## Verified Facts

1. **portable-pty 0.8.1 DOES enable `PSEUDOCONSOLE_WIN32_INPUT_MODE` by default.** Confirmed by reading `pty/src/win/psuedocon.rs` at the `portable-pty-0.8.1` git tag: flags = `PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE` (no manual opt-in needed).
2. **The win32-input-mode byte sequence we send is correct** per Microsoft Terminal spec #4999: `ESC [ 13 ; 28 ; 13 ; 1 ; 16 _` (down) + `… ; 0 ; 16 _` (up). VK=13, SC=28, Char=13, Cs=0x10 (LEFT_SHIFT).
3. **However, ConPTY only forwards win32-input-mode bytes to the child app if the child has opted in by sending the activation sequence `ESC [ ? 9001 h`.** PSReadLine does this on init. Anything else (cmd.exe, claude.exe) does NOT, so the bytes are dropped. This is the actual reason "the user's plain Enter still gets triggered" — ConPTY converted our sequence into a regular CR for the non-PSReadLine consumer.
4. **Claude Code 2.1.0+ uses Kitty CSI u**, not win32-input-mode. Verified in anthropics/claude-code issues #11192, #17400. The byte for Shift+Enter is `ESC [ 13 ; 2 u` (= `\x1b[13;2u`).
5. **xterm.js 5.5.0 (our version) lacks Kitty protocol support** — PR #5600 was merged 2026-01-10 into master, not yet in a 5.x release. It does NOT auto-respond to `CSI ? u` queries. Claude Code therefore stays in legacy mode and treats Shift+Enter as plain Enter.

## Root Cause

We send win32-input-mode bytes unconditionally. When `claude` is in the foreground, ConPTY strips them (claude never enabled mode 9001), and the terminal sees only the plain CR that ConPTY synthesizes — which `claude` interprets as submit.

## Fix — Apply Both Patches

### Patch 1: Detect what the foreground app supports and route accordingly

`src/Terminal.tsx` — replace the existing Shift+Enter block:

```tsx
// Track whether the foreground app advertised Kitty keyboard protocol support.
// Claude Code 2.1+ pushes flags via CSI > 1 u on startup; xterm.js 5.5 ignores
// the query, so we infer support by sniffing the CSI u push from PTY output.
let kittyKeyboardActive = false;
const KITTY_PUSH_RE = /\x1b\[>\d+u/;
const KITTY_POP_RE = /\x1b\[<u/;

unlistenOutput = await listen<string>("pty-output", (event) => {
  const s = event.payload;
  if (KITTY_PUSH_RE.test(s)) kittyKeyboardActive = true;
  else if (KITTY_POP_RE.test(s)) kittyKeyboardActive = false;
  term.write(s);
});

// Inside attachCustomKeyEventHandler, replace Shift+Enter branch:
if (shift && !ctrl && !alt && event.key === "Enter") {
  if (kittyKeyboardActive) {
    // Claude Code / Ink — Kitty CSI u
    invoke("pty_write", { data: "\x1b[13;2u" });
  } else {
    // PSReadLine — win32-input-mode (only delivered if app sent CSI ?9001h)
    // Plus a guaranteed fallback: Ctrl+J (LF, 0x0A) which PSReadLine and Claude
    // Code both bind to AddLine. PSReadLine's CR/LF dedup makes this safe.
    invoke("pty_write", { data: "\n" }); // 0x0A — universal "newline without submit"
  }
  return false;
}
```

Rationale: `\n` (0x0A, Ctrl+J) is **the documented Anthropic workaround** ("press Ctrl+J") AND PSReadLine's default `AddLine` chord. It works in both contexts without any negotiation. We drop the win32-input-mode path entirely because (a) it's silently dropped by ConPTY for non-opted-in apps, and (b) `\n` is strictly simpler and works in the same target (PSReadLine).

### Patch 2: Comment cleanup in `src-tauri/src/pty.rs`

```rust
// PowerShell: ensure UTF-8 output. Shift+Enter is sent by the frontend as
// 0x0A (Ctrl+J), which is PSReadLine's AddLine chord and also the documented
// Claude Code workaround. portable-pty 0.8 already enables
// PSEUDOCONSOLE_WIN32_INPUT_MODE, but we no longer rely on it because ConPTY
// only forwards those bytes to apps that send CSI ?9001h (PSReadLine yes,
// claude.exe no), making detection-free routing impossible.
```

No Rust logic changes required. Lines 67-78 stay otherwise as-is.

## Sources

- portable-pty 0.8.1 source: github.com/wezterm/wezterm tag `portable-pty-0.8.1`, file `pty/src/win/psuedocon.rs`
- Microsoft Terminal spec #4999 (win32-input-mode format)
- Anthropic docs: code.claude.com/docs/en/terminal-config (Windows Terminal "not available")
- anthropics/claude-code issues #11192, #17400 (Kitty CSI u in 2.1+)
- xterm.js PR #5600 (Kitty protocol, post-5.5)
