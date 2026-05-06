# TUI Mode Ctrl+A — Code Review

## Summary
- Quality Score: 7/10
- Files: 1 (`src/Terminal.tsx`)
- Critical bugs: 1 (coordinate-system mismatch)
- Likely root cause of "Ctrl+A doesn't work in Claude Code": **BUG #1**

## Critical Issues

### BUG #1 — Wrong absolute-row formula (HIGH)
**File**: `src/Terminal.tsx:217` and `:61` (also `menuSelectInput`)

`buf.cursorY` is **already relative to `ybase`** (verified in xterm
source: `BufferApiView.ts:22` returns `this._buffer.y`, and `Buffer.ts:96`
computes `absoluteY = this.ybase + this.y`). The code uses
`buf.viewportY` (= `ydisp`, the scroll display offset), so
`absRow = cursorY + viewportY` is wrong whenever `ydisp != ybase`
(any time the user scrolls). For Claude Code, which often re-renders
and may scroll, this reads the wrong line — `lastIndexOf` finds no
marker → `startCol < 0` → `return true` → keystroke forwarded to
Claude (BeginningOfLine). User sees no highlight, no flag set.

Correct formula: `absRow = buf.baseY + buf.cursorY`.

### BUG #2 — Marker order/precedence (LOW)
The `"│ "` marker matches Claude's box border at column 0. Combined
with `"> "` at column 2 inside the input, both qualify. The loop picks
the rightmost end-position so `"> "` wins — works as intended, but
**only because `"> "` happens to be longer-end than `"│ "`**. If the
input itself contains `│` (rare but possible in code paste) the wrong
marker could win. Low priority.

### BUG #3 — `tuiInputSelected` reset on Claude re-render (MEDIUM)
Claude Code re-renders constantly. Each re-render that overwrites
selected cells fires `onSelectionChange` with `hasSelection() = false`.
The flag itself isn't reset (good — line 144 only set in handler), and
`lastSelection` survives 1.5s. So this is OK in practice, but the
**visual** highlight disappears immediately on Claude's next paint —
matching the user's report of "no visual highlight".

This is a symptom, not the root cause; fix BUG #1 first.

## Patch (Edit-tool ready)

```
old_string:
          const buf = term.buffer.active;
          const col = buf.cursorX;
          const absRow = buf.cursorY + buf.viewportY;
          const line = buf.getLine(absRow)?.translateToString(false) ?? "";
          // Claude Code prompts have markers like `> `, `│ > `, `╭─...`. Walk back
          // from the cursor on this line to find the rightmost marker.
new_string:
          const buf = term.buffer.active;
          const col = buf.cursorX;
          // cursorY is already relative to baseY — NOT viewportY (= ydisp/scroll).
          const absRow = buf.baseY + buf.cursorY;
          const line = buf.getLine(absRow)?.translateToString(false) ?? "";
          // Claude Code prompts have markers like `> `, `│ > `, `╭─...`. Walk back
          // from the cursor on this line to find the rightmost marker.
```

Also fix `menuSelectInput` (line 61):

```
old_string:
    const absRow = buf.cursorY + buf.viewportY;
new_string:
    const absRow = buf.baseY + buf.cursorY;
```

## Positive Findings
- `lastSelection` 1.5s grace handles xterm clearing selection between events.
- Marker-loop "rightmost wins" logic is correct.
- `key === "a"` check matches `event.key.toLowerCase()` correctly.
- Falls back to `return true` (forward to app) when no marker found.
