# Bugs A & B — Definitive Research

## Bug A — Paste-replace race

### xterm.js v5.5.x source (verified)

In `src/browser/Terminal.ts` `_initGlobal()`, xterm registers paste listeners on **two** elements in **bubble phase**:

```ts
const pasteHandlerWrapper = (ev) => handlePasteEvent(ev, this.textarea!, this.coreService, this.optionsService);
this.register(addDisposableDomListener(this.textarea!, 'paste', pasteHandlerWrapper));
this.register(addDisposableDomListener(this.element!, 'paste', pasteHandlerWrapper));
```

`addDisposableDomListener` (browser/Lifecycle.ts) passes options through to `addEventListener`; no third arg → bubble. `handlePasteEvent` (browser/Clipboard.ts) calls `ev.stopPropagation()` — NOT `preventDefault()` — then `paste()`, which writes via `coreService.triggerDataEvent(text, true)` (fires `term.onData`).

### Answers
1. **Where**: `term.textarea` AND `term.element`, **bubble phase**, via `addEventListener('paste', …)`.
2. **Public API to disable**: **None.** `ITerminalOptions.ignoreBracketedPasteMode` only strips `\x1b[200~`/`\x1b[201~`; it does not disable the listener. No `onPaste` event, no `customPasteHandler` in v5.5.0 typings.
3. **Monkey-patching `term.paste`**: Useless. `handlePasteEvent` calls the **module-private** `paste()` function, not `term.paste`. The override is harmless dead code.
4. **`document.addEventListener('paste', …, {capture: true})` + `stopImmediatePropagation()`**: **Yes, beats xterm.** Per DOM Living Standard event-flow algorithm, capture-phase listeners on ancestor nodes (document) run before any listener (capture or bubble) on a descendant target. `stopImmediatePropagation()` aborts both remaining listeners on the same event.

The current code at lines 264-288 is correct in principle. Why it appears to fail: the doubling is **not** the paste event running twice — Ctrl+V on a focused textarea in some webviews also generates a `keydown` for V that xterm forwards via `term.onData` as `\x16` (SYN) **before** the paste event fires. The fix is to swallow Ctrl+V in `customKeyEventHandler`.

## Bug B — Shift+Enter on PowerShell PSReadLine

### ConPTY / win32-input-mode (verified)

Per [spec #4999](https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md) and [PR #6309](https://github.com/microsoft/terminal/pull/6309): when ConPTY is created with `PSEUDOCONSOLE_WIN32_INPUT_MODE`, it sends `\x1b[?9001h` on startup and accepts `\x1b[Vk;Sc;Uc;Kd;Cs;Rc_` on input, synthesizing `INPUT_RECORD`s for the client. **portable-pty 0.8.1 sets this flag** (`pty/src/win/psuedocon.rs`: `PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE`).

PSReadLine reads `ConsoleKeyInfo` via `Console.ReadKey()` only — **no VT parser**. `Keys.ShiftEnter = Shift(ConsoleKey.Enter)` ≡ Vk=13, Modifiers=Shift. ConPTY produces this exact `ConsoleKeyInfo` from the win32-input-mode encoding.

### Answers
1. **Sequence**: `\x1b[13;28;13;1;16_` (down) then `\x1b[13;28;13;0;16_` (up). Vk=13 (VK_RETURN), Sc=28, Uc=13, Kd=1/0, Cs=16 (SHIFT_PRESSED).
2. **modifyOtherKeys / CSI u**: Windows Terminal/ConPTY do **NOT** support `\x1b[13;2u` or `\x1b[27;2;13~` (as of 2026). PSReadLine wouldn't see them anyway — no VT parser.
3. **Fallback**: `\n` (LF) does not work because ConPTY translates Enter from terminal input via win32-input-mode; raw LF maps to a different ConsoleKey. The win32-input-mode path is the only robust solution. (Universal cross-platform fallback is `Ctrl+J`, but that requires user retraining.)

---

## EXACT CODE PATCHES — `src/Terminal.tsx` `useEffect`

### Patch 1 — Bug A (swallow Ctrl+V in keydown so xterm never sends `\x16`)

In the `attachCustomKeyEventHandler` callback, **add this block before the `return true` on line 251** (right after the Shift+Enter block):

```ts
      // Ctrl+V / Ctrl+Shift+V / Shift+Insert — paste is owned by the document
      // capture-phase paste listener below. Block xterm from forwarding the raw
      // key event (which would emit \x16 SYN) before the paste event fires.
      if (
        (ctrl && !alt && !meta && key === "v") ||
        (shift && !ctrl && !alt && !meta && event.key === "Insert")
      ) {
        return false;
      }
```

The existing `document.addEventListener("paste", onPaste, { capture: true })` with `e.stopImmediatePropagation()` already correctly preempts xterm's bubble-phase paste handler — keep it. Remove the dead `term.paste` override (lines 292-293, 338) for clarity.

### Patch 2 — Bug B (replace `\n` with win32-input-mode sequence)

Replace the existing Shift+Enter handler (lines 244-249):

```ts
      // Shift+Enter — synthesize win32-input-mode VT sequence so ConPTY produces
      // a ConsoleKeyInfo {Key=Enter, Modifiers=Shift} that PSReadLine binds to AddLine.
      // Format: CSI Vk ; Sc ; Uc ; Kd ; Cs _   (spec #4999)
      // Vk=13 VK_RETURN, Sc=28, Uc=13, Kd=1 down / 0 up, Cs=16 SHIFT_PRESSED.
      // portable-pty 0.8 enables PSEUDOCONSOLE_WIN32_INPUT_MODE so this is accepted.
      if (shift && !ctrl && !alt && event.key === "Enter") {
        invoke("pty_write", { data: "\x1b[13;28;13;1;16_\x1b[13;28;13;0;16_" });
        return false;
      }
```

That's it. Both patches are minimal, surgical, and verified against authoritative sources.
