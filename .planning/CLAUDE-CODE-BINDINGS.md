# Claude Code TUI — Verified Keybindings

Sources (all official docs, fetched May 2026):
- https://code.claude.com/docs/en/interactive-mode (key reference table)
- https://code.claude.com/docs/en/keybindings (action map, defaults, syntax)
- https://code.claude.com/docs/en/terminal-config (multiline, Option-as-Meta)

The Claude Code binary at `C:\Users\Victor\.local\bin\claude.exe` is a 255 MB compiled native; source is not readable. All bindings below are taken from the docs verbatim.

## Verified bindings (Chat context)

| Behavior                                | Binding (per docs)                             | Byte sequence to send over PTY |
| --------------------------------------- | ---------------------------------------------- | ------------------------------ |
| Move cursor to start of current line    | `Ctrl+A`                                       | `\x01`                         |
| Move cursor to end of current line      | `Ctrl+E`                                       | `\x05`                         |
| Move cursor back one word               | `Alt+B` (Meta+B; needs Option-as-Meta on mac)  | `\x1bb`                        |
| Move cursor forward one word            | `Alt+F` (Meta+F)                               | `\x1bf`                        |
| Delete from cursor to start of line     | `Ctrl+U`                                       | `\x15`                         |
| Delete from cursor to end of line       | `Ctrl+K`                                       | `\x0b`                         |
| Delete previous word                    | `Ctrl+W`                                       | `\x17`                         |
| Delete previous word (Win alt)          | `Ctrl+Backspace` (docs: Windows only)          | `\x7f` with Ctrl — UNKNOWN exact |
| Delete next word                        | UNKNOWN — no `Alt+D` documented in Chat ctx    | UNKNOWN                        |
| Paste last killed text                  | `Ctrl+Y`                                       | `\x19`                         |
| Cycle paste history (after Ctrl+Y)      | `Alt+Y`                                        | `\x1by`                        |
| Submit input                            | `Enter`                                        | `\r`                           |
| Insert newline (universal)              | `Ctrl+J`                                       | `\n` (`\x0a`)                  |
| Insert newline (escape)                 | `\` then `Enter`                               | `\\\r`                         |
| Insert newline (mac, Option-as-Meta on) | `Option+Enter` = `Meta+Enter`                  | `\x1b\r`                       |
| Insert newline (Shift+Enter)            | Terminal-dependent; works in iTerm2/Kitty/etc. | `\x1b[13;2u` (CSI-u, kitty proto) |
| Cancel current input / generation       | `Ctrl+C` (RESERVED, cannot rebind)             | `\x03`                         |
| Exit Claude Code                        | `Ctrl+D` (RESERVED)                            | `\x04`                         |
| Force redraw / clear input view         | `Ctrl+L` → action `chat:clearInput`            | `\x0c`                         |
| Reverse history search                  | `Ctrl+R`                                       | `\x12`                         |
| History previous (multiline-aware)      | `Up` or `Ctrl+P`                               | `\x1b[A` / `\x10`              |
| History next                            | `Down` or `Ctrl+N`                             | `\x1b[B` / `\x0e`              |
| Tab completion / accept suggestion      | `Tab`                                          | `\x09`                         |
| External editor                         | `Ctrl+G` or chord `Ctrl+X Ctrl+E`              | `\x07` or `\x18\x05`           |
| Stash prompt                            | `Ctrl+S`                                       | `\x13`                         |
| Paste image                             | `Ctrl+V` (Win: `Alt+V`)                        | `\x16` / `\x1bv`               |
| Open in transcript / verbose            | `Ctrl+O`                                       | `\x0f`                         |
| Toggle task list                        | `Ctrl+T`                                       | `\x14`                         |
| Background current task                 | `Ctrl+B`                                       | `\x02`                         |
| Cycle permission modes                  | `Shift+Tab`                                    | `\x1b[Z`                       |
| Rewind / summarize                      | `Esc Esc`                                      | `\x1b\x1b`                     |
| **Clear entire input (single shortcut)**| UNKNOWN — no documented "clear all" binding. Closest: `Ctrl+A` then `Ctrl+K`, or `Esc Esc` then choose. |
| **Copy current input to clipboard**     | UNKNOWN — no documented `chat:copy` action. `selection:copy` (`Ctrl+Shift+C`/`Cmd+C`) only applies in `Scroll` context (fullscreen mode). |

Notes:
- Reserved (cannot rebind): `Ctrl+C`, `Ctrl+D`, `Ctrl+M` (== Enter), Caps Lock.
- `Ctrl+M` is identical to `Enter` at the byte level (both `\r`); never send it as "newline".
- "Meta+X" on Windows = `\x1b` prefix (ESC+key), same as `Alt+X` from xterm.
- `Shift+Enter` only reaches Claude Code if the emulator emits CSI-u extended keys; xterm.js can be configured for kitty keyboard protocol, otherwise fall back to `Ctrl+J`.

## TypeScript map for our Tauri shell

```ts
export const CLAUDE_TUI_KEYS = {
  cursorLineStart:    "\x01",        // Ctrl+A
  cursorLineEnd:      "\x05",        // Ctrl+E
  cursorWordBack:     "\x1bb",       // Alt+B
  cursorWordForward:  "\x1bf",       // Alt+F
  deleteToLineStart:  "\x15",        // Ctrl+U
  deleteToLineEnd:    "\x0b",        // Ctrl+K
  deletePrevWord:     "\x17",        // Ctrl+W
  deleteNextWord:     null,          // UNKNOWN — not documented
  yankPaste:          "\x19",        // Ctrl+Y
  yankCycle:          "\x1by",       // Alt+Y
  submit:             "\r",          // Enter
  newline:            "\n",          // Ctrl+J (universal)
  newlineShiftEnter:  "\x1b[13;2u",  // CSI-u kitty; only if peer enabled extended keys
  newlineMetaEnter:   "\x1b\r",      // Option/Alt+Enter
  cancel:             "\x03",        // Ctrl+C  (reserved)
  exit:               "\x04",        // Ctrl+D  (reserved)
  redrawInput:        "\x0c",        // Ctrl+L  (chat:clearInput)
  historySearch:      "\x12",        // Ctrl+R
  historyPrev:        "\x1b[A",      // Up
  historyNext:        "\x1b[B",      // Down
  tabComplete:        "\x09",        // Tab
  externalEditor:     "\x07",        // Ctrl+G
  externalEditorAlt:  "\x18\x05",    // Ctrl+X Ctrl+E (chord)
  stashPrompt:        "\x13",        // Ctrl+S
  pasteImage:         "\x16",        // Ctrl+V
  pasteImageWin:      "\x1bv",       // Alt+V (Windows)
  toggleTranscript:   "\x0f",        // Ctrl+O
  toggleTodos:        "\x14",        // Ctrl+T
  backgroundTask:     "\x02",        // Ctrl+B
  cycleMode:          "\x1b[Z",      // Shift+Tab
  rewind:             "\x1b\x1b",    // Esc Esc
  killAgents:         "\x18\x0b",    // Ctrl+X Ctrl+K (chord; press twice within 3s)
  clearEntireInput:   null,          // UNKNOWN — synthesize as "\x01\x0b" (Ctrl+A then Ctrl+K)
  copyInput:          null,          // UNKNOWN — no built-in
} as const;
```
