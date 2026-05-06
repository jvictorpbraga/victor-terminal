# claude-terminal — Research Brief

Stack: Tauri 2 + React + xterm.js + PTY + @anthropic-ai/claude-agent-sdk + tauri-plugin-sql.

---

## A. Tauri 2 + xterm.js + PTY (Windows)

**Recommendation: Rust `portable-pty` invoked from Tauri commands.** Avoids the Node sidecar entirely for PTY duty, no native rebuilds across Node versions, and ships in one binary. `@lydell/node-pty` (April 2026, ConPTY-only, prebuilt) is the fallback if you decide to host the SDK in a Node sidecar anyway and want one process for both — but it adds ~30 MB and a second runtime.

`tauri-plugin-pty` (Tnze) wraps portable-pty and exposes `spawn / onData / write / resize` in JS — usable as-is or as reference. `marc2332/tauri-terminal` is the canonical xterm.js + portable-pty example.

**Data flow (one-PTY-per-tab):**
```ts
// renderer
await invoke('pty_spawn', { id, shell: 'powershell.exe', cols, rows });
listen<string>(`pty:data:${id}`, e => term.write(e.payload));
term.onData(d => invoke('pty_write', { id, data: d }));
term.onResize(({cols, rows}) => invoke('pty_resize', { id, cols, rows }));
```
Rust side: spawn a `tokio::task` reading the PTY's `Read` half, emit `app.emit(`pty:data:${id}`, chunk_as_utf8_lossy)`.

**Windows gotchas:**
1. Use ConPTY, requires Win10 1809+. `portable-pty` upstream omits modern flags; if you hit redraw artifacts on resize, vendor wezterm's patched `conpty.rs` with `PSEUDOCONSOLE_RESIZE_QUIRK | WIN32_INPUT_MODE | PASSTHROUGH_MODE`.
2. Read in raw bytes, decode UTF-8 with `from_utf8_lossy` and buffer split codepoints across reads — never decode per-chunk or you'll mangle emoji.
3. Resize: send to PTY *and* call `term.resize()` together, debounce ~50 ms.
4. Large paste: use `term.options.scrollback = 10000` and chunk writes into 4 KB slices to avoid blocking the IPC bridge.
5. Set `chcp 65001` on shell init for Unicode in legacy cmd output.

---

## B. Claude Agent SDK

**Run in a Node sidecar, not the renderer.** The SDK shells out to `claude` CLI under the hood and needs Node + filesystem access; the renderer is a webview. Use Tauri's [sidecar](https://v2.tauri.app/develop/sidecar/) with a bundled Node binary, communicate over stdio JSON-RPC or a local Unix-domain/named pipe.

**`query()` vs `ClaudeSDKClient`:** TypeScript only ships stable `query()` (V1). There is no `ClaudeSDKClient` in TS — that's Python. For multi-turn use `query({ prompt, options: { continue: true } })` (most-recent session in cwd) or `{ resume: sessionId }` for explicit. V2 preview has `createSession()` but is unstable — skip.

**Capture session id** from the result message:
```ts
for await (const m of query({...})) {
  if (m.type === 'result') sessionId = m.session_id;
}
```

**System prompt injection on resume:** pass `options.systemPrompt` (string) or `options.appendSystemPrompt` to layer onto the default. On resume this prepends to the new turn's context. Bypass permissions: `options.permissionMode: 'bypassPermissions'`.

**API key:** `tauri-plugin-stronghold` works but is being deprecated for v3. Prefer **`keyring-rs`** via a small Rust command (uses Windows Credential Manager natively, zero deps, no master password UX). Set `ANTHROPIC_API_KEY` in the sidecar's spawn env only — never in the renderer.

---

## C. Ledger + Auto-resume

**Tool-call → ledger:** register a `PostToolUse` hook with no matcher (catches all tools). Hook runs in the same Node sidecar, append to `ledger.md` synchronously:
```ts
hooks: {
  PostToolUse: [{ hooks: [async (input) => {
    const i = input as PostToolUseHookInput;
    await fs.appendFile(ledgerPath,
      `- [${new Date().toISOString()}] **${i.tool_name}** ${summarize(i.tool_input)} → ${truncate(i.tool_response)}\n`);
    return {};
  }]}],
}
```
Use `PreToolUse` only if you want the ledger to record *intent* even on denied calls.

**Compaction signal:** the SDK fires a **`PreCompact`** hook (TS + Python) right before Claude summarizes. This is your trigger. There's no public token-threshold event — `PreCompact` is the canonical hook. Anthropic's own auto-compact runs at ~95% of the model's context window.

**Auto-resume flow:**
1. `PreCompact` fires → write a `=== COMPACTION CHECKPOINT ===` divider into the ledger, capture current `session_id`.
2. Let Anthropic's compact run; capture the new compacted state.
3. Spawn fresh `query()` with `{ resume: sessionId, appendSystemPrompt: ledgerContents }`.
4. **Inject the ledger as `appendSystemPrompt`, not as a user message.** System-prompt injection is treated as instructions/context (high salience, doesn't pollute turn history); user-message injection makes Claude reply to the ledger as if it were a question. Tested behavior is significantly cleaner with system-prompt injection.

Persist `{tabId, sessionId, ledgerPath, cwd}` in SQLite (tauri-plugin-sql) so a restart can replay the same tab.

---

## D. Two YES/NO decisions for you

1. **Single Node sidecar shared by all tabs, or one sidecar per tab?** Shared = lower RAM, harder isolation/crashes cascade. Per-tab = clean kill, ~80 MB × N tabs.
2. **Should the ledger be human-curated (Claude can read/edit it) or append-only audit log (read-only to Claude, only the PostToolUse hook writes)?** Curated lets Claude prune noise on resume; append-only is forensically trustworthy.

---

## Sources
- [code.claude.com/docs/en/agent-sdk/sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [code.claude.com/docs/en/agent-sdk/hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [npm: @anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [npm: @lydell/node-pty](https://www.npmjs.com/package/@lydell/node-pty)
- [github.com/Tnze/tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty)
- [github.com/marc2332/tauri-terminal](https://github.com/marc2332/tauri-terminal)
- [docs.rs/portable-pty](https://docs.rs/portable-pty)
- [github.com/wezterm/wezterm/blob/main/pty/src/win/conpty.rs](https://github.com/wezterm/wezterm/blob/main/pty/src/win/conpty.rs)
- [v2.tauri.app/develop/sidecar](https://v2.tauri.app/develop/sidecar/)
- [v2.tauri.app/plugin/stronghold](https://v2.tauri.app/plugin/stronghold/)
- [github.com/xtermjs/xterm.js](https://github.com/xtermjs/xterm.js/)
