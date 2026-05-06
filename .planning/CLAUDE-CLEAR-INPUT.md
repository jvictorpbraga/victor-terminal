# Claude Code — Clear Input Buffer (Verified)

## Source of truth

Disassembled the readable JS bundle that ships inside `claude.exe` (Windows, v2.1.129):

- `C:\Users\Victor\AppData\Local\npm-cache\_npx\85fb20e3e7e3a233\node_modules\@anthropic-ai\claude-agent-sdk\cli.js` lines ~3482-3487
- Function `yH1` is the prompt input handler (Ink-based `useTextInput` clone).
- Same handler code is embedded inside `claude.exe` (255 MB pkg-bundled Node).

## The control-key dispatch table (verbatim from bundle)

```js
let kA = X79([
  ["a", () => _.startOfLine()],         // \x01 — cursor move only
  ["b", () => _.left()],                 // \x02
  ["c", x],                              // \x03 — Ctrl-C exit handler
  ["d", t],                              // \x04 — del char / EOF
  ["e", () => _.endOfLine()],           // \x05
  ["f", () => _.right()],                // \x06
  ["h", () => _.backspace()],            // \x08
  ["k", p],                              // \x0b — deleteToLineEnd ONLY
  ["l", () => u()],                      // \x0c — FULL CLEAR + push to history
  ["n", () => FA()],                     // \x0e
  ["p", () => s()],                      // \x10
  ["u", AA],                             // \x15 — deleteToLineStart ONLY
  ["w", JA],                             // \x17 — deleteWordBefore
  ["y", MA],                             // \x19 — paste
]);
```

Where `u()` is:

```js
function u() {
  if (A.trim() !== "") aQA(A), X?.();    // push to history
  return $6.fromText("", H, 0);          // BUFFER -> "" cursor -> 0
}
```

## Why `\x01\x0b` (Ctrl-A + Ctrl-K) does NOT clear

`\x01` moves the cursor with `startOfLine()`, `\x0b` runs `deleteToLineEnd()`. On
multi-line input this only clears the CURRENT logical line. Even on a single
line it works only if Ink's keypress decoder receives them as two distinct
`useInput` events. Sent as one back-to-back write, Windows ConPTY can collapse
them, the second byte can land while the IME or paste-detector is still
holding `\x01`, or the `<Tab>` / autocomplete state can intercept. Empirically
unreliable — matches user's report.

## What ACTUALLY clears the buffer

| Sequence            | Bytes        | Mechanism                                      | Confidence |
|---------------------|--------------|------------------------------------------------|------------|
| Ctrl-L              | `\x0c`       | `u()` wipes whole buffer, saves to history     | HIGH (verified in source) |
| Esc Esc (double)    | `\x1b\x1b`   | Handler `m`: 2nd Esc within 1s calls `Q("")`   | HIGH but needs ~50-300 ms gap so Ink doesn't parse as CSI |
| Repeated backspace  | `\x7f` x N   | One per character                              | HIGH but slow / needs known length |

Esc-Esc requires a delay because a tight `\x1b\x1b` can be misread as the
prefix of a CSI escape sequence by Ink's parser. Ctrl-L has no such ambiguity.

## Recommended TS clear-input function (priority order)

```ts
import type { Writable } from 'node:stream';

/**
 * Clear the Claude Code prompt buffer. Sends Ctrl-L, which maps to the
 * internal `u()` handler that resets buffer to "" and cursor to 0,
 * pushing the previous content to ↑ history.
 *
 * Verified against @anthropic-ai/claude-agent-sdk cli.js v2.1.129
 * (function yH1, dispatch table kA, key "l" -> u()).
 */
export async function clearClaudeInput(stdin: Writable): Promise<void> {
  // Primary: Ctrl-L = full buffer wipe, atomic, single byte.
  stdin.write('\x0c');

  // Optional fallback if Ctrl-L is ever rebound: double-Esc with gap.
  // await new Promise(r => setTimeout(r, 80));
  // stdin.write('\x1b');
  // await new Promise(r => setTimeout(r, 120));
  // stdin.write('\x1b');
}
```
