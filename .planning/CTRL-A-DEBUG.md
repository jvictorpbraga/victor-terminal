# Ctrl+A Debug — Root Cause

**File:** `src/Terminal.tsx`
**Line:** 184

## Bug

```js
if (event.type !== "keydown") return true;
```

`attachCustomKeyEventHandler` is invoked for `keydown`, `keypress`, AND `keyup`. Returning `true` from the `keypress` event tells xterm.js "go ahead and process this key normally" — which for Ctrl+A means xterm writes `\x01` to the PTY via its internal `_keyPress` / `_keyDown` path.

The `keydown` handler correctly intercepts and returns `false`, setting `tuiInputSelected = true`. But the **subsequent `keypress` event** for the same Ctrl+A is then approved by line 184, and xterm sends `\x01` to claude. Claude itself treats `\x01` as "go to start of line" — visible as nothing happens. Then when the user types, `tuiInputSelected` IS true, `\x0c` gets sent — but claude already moved its cursor, so the clear may visually appear partial or the next char inserts at col 0 instead of replacing.

Ctrl+U works because the user sends it directly with no prior `\x01` corruption.

## Patch

```
old_string: if (event.type !== "keydown") return true;
new_string: if (event.type !== "keydown") return false;
```

Returning `false` for non-keydown events tells xterm.js "I handled it" — preventing the spurious PTY write on the `keypress` follow-up. All real handling already lives in the `keydown` branch, so suppressing keypress/keyup is safe.
