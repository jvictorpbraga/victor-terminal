import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

const THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#58a6ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#7ee787",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#e6edf3",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const initializedRef = useRef(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  const closeMenu = () => setMenuPos(null);

  const menuCopy = () => {
    const sel = xtermRef.current?.getSelection();
    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    xtermRef.current?.clearSelection();
    closeMenu();
  };

  const menuPaste = () => {
    navigator.clipboard.readText().then((text) => {
      if (text) invoke("pty_write", { data: text });
    }).catch(() => {});
    closeMenu();
  };

  const menuSelectInput = () => {
    const term = xtermRef.current;
    if (!term) return closeMenu();
    const buf = term.buffer.active;
    const col = buf.cursorX;
    const absRow = buf.cursorY + buf.viewportY;
    const line = buf.getLine(absRow)?.translateToString(false) ?? "";
    const beforeCursor = line.substring(0, col);
    const markers = ["> ", "$ ", "# ", "› ", "» "];
    let startCol = 0;
    for (const m of markers) {
      const idx = beforeCursor.lastIndexOf(m);
      if (idx >= 0 && idx + m.length > startCol) startCol = idx + m.length;
    }
    const length = col - startCol;
    if (length > 0) term.select(startCol, absRow, length);
    closeMenu();
  };

  const menuClear = () => {
    xtermRef.current?.clear();
    closeMenu();
  };

  useEffect(() => {
    if (!containerRef.current) return;
    // Guard against double-init (HMR, StrictMode, fast refresh).
    if (initializedRef.current) return;
    initializedRef.current = true;

    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: THEME,
      scrollback: 10000,
      allowProposedApi: true,
    });
    xtermRef.current = term;

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);

    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL not available — fall back to canvas
    }

    fitAddon.fit();

    // Detect when a TUI / raw-mode app is in control (Claude Code, vim, htop, etc).
    //   - alternate buffer  → true full-screen apps (vim, less, htop)
    //   - applicationCursorKeysMode  → terminal entered raw mode
    //   - tuiSticky → once we see Claude Code's box-drawing UI, we STAY in TUI mode
    //     until we observe a recognizable shell prompt return (e.g. `PS C:\>`).
    //     Necessary because Ink only redraws box chars at startup; subsequent renders
    //     only touch the input cells, so a timer-based detection misses everything
    //     after the first 8s of typing.
    let tuiSticky = false;
    const BOX_CHAR_RE = /[─-╿]/;  // Unicode "Box Drawing" block
    const SHELL_PROMPT_RE = /(^|\r?\n)(PS [A-Z]:\\.*?>|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.*?[$#])\s*$/;

    const isTuiActive = (): boolean => {
      if (term.buffer.active.type === "alternate") return true;
      if (term.modes.applicationCursorKeysMode) return true;
      if (tuiSticky) return true;
      return false;
    };

    const updateMode = () => {
      const mode = isTuiActive() ? "tui" : "shell";
      window.dispatchEvent(new CustomEvent("ct:mode", { detail: mode }));
    };
    updateMode();

    // TUI-mode "select" state. tuiInputSelected = armed; armedSelLen = number of
    // visual cells the highlight covers (used to compute how many Backspaces to
    // synthesize for clearing — Claude Code won't delete past the prompt boundary,
    // so overshooting is safe).
    let tuiInputSelected = false;
    let armedSelLen = 0;
    const clearTuiSel = () => {
      tuiInputSelected = false;
      armedSelLen = 0;
      term.clearSelection();
    };

    // Track the last known selection — keeps the data alive even if xterm clears
    // the visual selection between keydown events (which it does for some Ctrl combos).
    type SelSnapshot = { text: string; length: number; ts: number };
    let lastSelection: SelSnapshot | null = null;

    term.onSelectionChange(() => {
      if (term.hasSelection()) {
        const text = term.getSelection();
        lastSelection = { text, length: text.length, ts: Date.now() };
      } else {
        // Don't drop immediately — keep for 1.5s in case Ctrl+V follows Ctrl+A.
        const stale = lastSelection;
        setTimeout(() => {
          if (lastSelection === stale) lastSelection = null;
        }, 1500);
      }
    });

    // Returns the live selection if present, otherwise the last-known one if recent.
    const getEffectiveSelection = (): SelSnapshot | null => {
      if (term.hasSelection()) {
        const text = term.getSelection();
        return { text, length: text.length, ts: Date.now() };
      }
      if (lastSelection && Date.now() - lastSelection.ts < 1500) {
        return lastSelection;
      }
      return null;
    };

    // Windows-Terminal-style keybindings — fixes the cmd.exe pain points.
    // Returning false from the handler prevents the key from being forwarded to the PTY.
    term.attachCustomKeyEventHandler((event) => {
      // Suppress non-keydown events for Ctrl/Alt combos and for Shift+Enter —
      // otherwise xterm forwards the keypress char (e.g. \x01 for Ctrl+A, \r for
      // Shift+Enter) AFTER our keydown handler already sent the right thing.
      if (event.type !== "keydown") {
        if (event.ctrlKey || event.altKey || event.metaKey) return false;
        if (event.shiftKey && event.key === "Enter") return false;
        return true;
      }
      const key = event.key.toLowerCase();
      const ctrl = event.ctrlKey;
      const shift = event.shiftKey;
      const alt = event.altKey;
      const meta = event.metaKey;

      // TUI mode (Claude Code, vim, etc) — bridge text-editor expectations to the
      // app's readline/emacs bindings. Verified against Claude Code's documented
      // keymap: code.claude.com/docs/en/keybindings.
      if (isTuiActive()) {
        // Layout-agnostic key detection.
        const isKeyA = event.code === "KeyA" || key === "a";
        const isKeyC = event.code === "KeyC" || key === "c";
        const isKeyV = event.code === "KeyV" || key === "v";
        const isKeyX = event.code === "KeyX" || key === "x";

        // \x0c (Ctrl+L) — Claude Code's "clear input buffer" command (atomic, works
        // for both single-line and multi-line input). Sourced from the bundled SDK.
        // Send \x15 too as belt-and-braces for older claude versions where Ctrl+L
        // is "redraw" — \x15 clears at least the current line.
        const TUI_CLEAR = "\x0c";

        // Ctrl+Shift+C → always copy (overrides anything else)
        if (ctrl && shift && isKeyC) {
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        // Plain Ctrl+C with mouse-selected text → copy. Without selection → SIGINT.
        if (ctrl && !shift && isKeyC) {
          const sel = term.getSelection();
          if (sel && sel.length > 0) {
            navigator.clipboard.writeText(sel).catch(() => {});
            term.clearSelection();
            return false;
          }
          return true;
        }

        // Helper: build a "clear input" sequence. For multi-line input we send N
        // backspaces where N = visual cells highlighted by Ctrl+A. Claude Code won't
        // backspace past the prompt boundary, so overshoot is harmless.
        const clearSeqForLen = (len: number): string => {
          if (len <= 0) return TUI_CLEAR;
          // Move to end first so backspaces start from the very end of input.
          return "\x05" + "\x7f".repeat(len + 8);
        };

        // Paste shortcuts in TUI mode — manual clipboard read, never let xterm send
        // \x16 (Claude Code interprets that as "paste image").
        const isPasteCombo =
          (ctrl && isKeyV) || (shift && event.key === "Insert");
        if (isPasteCombo) {
          const armed = tuiInputSelected;
          const len = armedSelLen;
          if (armed) clearTuiSel();
          navigator.clipboard.readText().then((raw) => {
            // Normalize line endings — claude treats \r and \n separately, so \r\n
            // would create an extra blank line. Collapse to a single \n per break.
            const text = (raw ?? "").replace(/\r\n?/g, "\n");
            const prefix = armed ? clearSeqForLen(len) : "";
            const data = prefix + text;
            if (data) invoke("pty_write", { data });
          }).catch(() => {
            if (armed) invoke("pty_write", { data: clearSeqForLen(len) });
          });
          return false;
        }

        // Ctrl+A — find Claude Code's input range, possibly across multiple rows.
        if (ctrl && !shift && isKeyA) {
          armedSelLen = 0; // reset; we'll set it again below if we find input
          const buf = term.buffer.active;
          const viewTop = Math.max(0, buf.viewportY - 30); // also peek into scrollback
          const viewBottom = buf.viewportY + term.rows - 1;
          const PROMPT_RE = /^(\s*)(>|❯|›|»)\s+(\S.*?)\s*$/;
          // Match a "looks like a continuation" line: has at least one non-space
          // char and isn't a box border / status line.
          const isBorder = (s: string) => /[╰╭╮╯─━┘└]/.test(s);

          let startRow = -1, startCol = -1;
          let endRow = -1, endCol = -1;

          for (let r = viewBottom; r >= viewTop; r--) {
            const line = buf.getLine(r)?.translateToString(true) ?? "";
            const m = line.match(PROMPT_RE);
            if (m) {
              const leadingWs = m[1].length;
              const marker = m[2];
              const afterMarker = line.indexOf(marker, leadingWs) + marker.length;
              const tail = line.slice(afterMarker);
              const firstNs = tail.search(/\S/);
              startRow = r;
              startCol = afterMarker + (firstNs >= 0 ? firstNs : 0);
              endRow = r;
              endCol = line.replace(/\s+$/, "").length;
              // Walk DOWN to find continuation rows.
              for (let r2 = r + 1; r2 <= viewBottom; r2++) {
                const l2 = buf.getLine(r2)?.translateToString(true) ?? "";
                const trimmed = l2.replace(/\s+$/, "");
                if (trimmed === "") break;
                if (isBorder(trimmed)) break;
                // Avoid matching the status line `Opus 4.7 | Victor` etc.
                // Heuristic: status lines tend to live below an empty/border row,
                // so the empty-line/border break above already handled them.
                endRow = r2;
                endCol = trimmed.length;
              }
              break;
            }
          }

          if (startRow >= 0 && endRow >= startRow) {
            const cols = term.cols;
            const len = endRow === startRow
              ? endCol - startCol
              : (cols - startCol) + (endRow - startRow - 1) * cols + endCol;
            term.select(startCol, startRow, len);
            armedSelLen = len;
          }
          tuiInputSelected = true;
          return false;
        }

        // When armed, destructive keys send the calculated clear sequence first.
        if (tuiInputSelected) {
          const armedLen = armedSelLen;
          if (event.key === "Backspace" || event.key === "Delete") {
            clearTuiSel();
            invoke("pty_write", { data: clearSeqForLen(armedLen) });
            return false;
          }
          if (ctrl && !shift && isKeyX) {
            const sel = term.getSelection();
            if (sel) navigator.clipboard.writeText(sel).catch(() => {});
            clearTuiSel();
            invoke("pty_write", { data: clearSeqForLen(armedLen) });
            return false;
          }
          if (event.key.length === 1 && !ctrl && !alt && !meta) {
            clearTuiSel();
            invoke("pty_write", { data: clearSeqForLen(armedLen) + event.key });
            return false;
          }
          // Anything else (arrows, Enter, Esc) — drop the armed state, pass through
          clearTuiSel();
        }

        // Shift+Enter → universal newline (Ctrl+J = \n) per Claude Code docs.
        if (shift && !ctrl && !alt && event.key === "Enter") {
          invoke("pty_write", { data: "\n" });
          return false;
        }

        // Everything else: pass through to the TUI app
        return true;
      }


      // Selection-aware destructive editing — for Backspace/Delete/Cut/typing.
      // Paste is handled by the textarea `paste` event listener below (so we don't
      // race with xterm's built-in paste handler).
      const effSel = getEffectiveSelection();
      if (effSel && effSel.length > 0) {
        const selText = effSel.text;
        const selLen = effSel.length;
        const erase = "\x7f".repeat(selLen);

        // Backspace / Delete → erase
        if (event.key === "Backspace" || event.key === "Delete") {
          term.clearSelection();
          lastSelection = null;
          invoke("pty_write", { data: erase });
          return false;
        }

        // Ctrl+X — copy + erase
        if (ctrl && !shift && key === "x") {
          navigator.clipboard.writeText(selText).catch(() => {});
          term.clearSelection();
          lastSelection = null;
          invoke("pty_write", { data: erase });
          return false;
        }

        // Printable character → erase + insert (replace)
        if (event.key.length === 1 && !ctrl && !alt && !meta) {
          term.clearSelection();
          lastSelection = null;
          invoke("pty_write", { data: erase + event.key });
          return false;
        }
      }

      // Ctrl+A — smart "select current input line"
      // Walks back from cursor to find the most recent prompt marker on the same line
      // (`> `, `$ `, `# `, `› `) and selects from after the marker to the cursor.
      // This is a heuristic — works for default PowerShell/bash/zsh prompts, fails on
      // exotic prompts. Phase 5 will replace this with OSC 133 shell-integration markers.
      if (ctrl && !shift && key === "a") {
        const buf = term.buffer.active;
        const col = buf.cursorX;
        // Buffer-absolute row is baseY + cursorY (per xterm Buffer.ts). cursorY is
        // already relative to baseY; viewportY (ydisp) is the SCROLL offset and is
        // NOT what we want here.
        const absRow = buf.baseY + buf.cursorY;
        const line = buf.getLine(absRow)?.translateToString(false) ?? "";
        const beforeCursor = line.substring(0, col);

        const markers = ["> ", "$ ", "# ", "› ", "» "];
        let startCol = -1;
        for (const m of markers) {
          const idx = beforeCursor.lastIndexOf(m);
          if (idx >= 0 && idx + m.length > startCol) startCol = idx + m.length;
        }

        // No prompt marker on this line → let the app handle Ctrl+A.
        if (startCol < 0) return true;

        const length = col - startCol;
        if (length > 0) {
          term.select(startCol, absRow, length);
        }
        return false;
      }

      // Ctrl+Shift+A — select all visible terminal output (rarely useful but available)
      if (ctrl && shift && key === "a") {
        term.selectAll();
        return false;
      }

      // Ctrl+C — copy if there's a selection, otherwise let it through as SIGINT
      if (ctrl && !shift && key === "c") {
        const sel = term.getSelection();
        if (sel && sel.length > 0) {
          navigator.clipboard.writeText(sel).catch(() => {});
          term.clearSelection();
          return false;
        }
        return true; // no selection — forward as Ctrl+C interrupt
      }

      // Ctrl+Shift+C — explicit copy
      if (ctrl && shift && key === "c") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }

      // Paste — when there's a selection, fire erase chars synchronously here, then
      // return true so xterm's normal paste flow delivers the clipboard text.
      // Tauri pty_write calls are queued in JS order; the Rust writer serializes them.
      const isPasteCombo =
        (ctrl && !shift && key === "v") ||
        (ctrl && shift && key === "v") ||
        (shift && event.key === "Insert");
      if (isPasteCombo) {
        const sel = getEffectiveSelection();
        if (sel && sel.length > 0) {
          invoke("pty_write", { data: "\x7f".repeat(sel.length) });
          term.clearSelection();
          lastSelection = null;
        }
        return true; // let xterm/browser deliver the clipboard text
      }

      // Shift+Enter — insert a newline in the input.
      // Sends \n (0x0A = Ctrl+J), which works in BOTH contexts with zero negotiation:
      //   - PSReadLine: Ctrl+J is the default AddLine chord
      //   - Claude Code: Anthropic's documented Windows workaround
      //     (code.claude.com/docs/en/terminal-config)
      // The fancier protocols (CSI u, win32-input-mode) fail because the child
      // processes have to opt in, and Claude Code only opts in to Kitty CSI u which
      // xterm.js 5.5.0 doesn't yet advertise.
      if (shift && !ctrl && !alt && event.key === "Enter") {
        invoke("pty_write", { data: "\n" });
        return false;
      }

      return true;
    });

    // Right-click opens a custom context menu (Copy / Paste / Select Input / Clear).
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setMenuPos({ x: e.clientX, y: e.clientY });
    };
    containerRef.current.addEventListener("contextmenu", onContextMenu);

    // Click-to-position: in TUI mode, a single (non-drag) left click on the input
    // line moves the cursor to that column by synthesizing End + N Left arrows.
    // Drag still works for selection. Capture phase so we run before xterm.
    let mouseDownAt: { x: number; y: number; t: number } | null = null;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) mouseDownAt = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    const onMouseUp = (e: MouseEvent) => {
      const start = mouseDownAt;
      mouseDownAt = null;
      if (!start || e.button !== 0 || !isTuiActive()) return;
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > 4 || dy > 4) return; // a drag — let xterm's selection stand
      if (Date.now() - start.t > 500) return; // long press

      // Use the .xterm-screen element — that's the actual character grid, no
      // scrollbar or extra padding included.
      const screenEl = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
      if (!screenEl) return;
      const rect = screenEl.getBoundingClientRect();
      const cellW = rect.width / term.cols;
      const cellH = rect.height / term.rows;
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) return;
      // Round to nearest boundary so clicks on the right half of a glyph snap
      // AFTER it (like every other text editor).
      const clickCol = Math.round(relX / cellW);
      const clickViewRow = Math.floor(relY / cellH);
      const clickAbsRow = term.buffer.active.viewportY + clickViewRow;

      // Find the active input row (regex scan, same as Ctrl+A).
      const buf = term.buffer.active;
      const top = buf.viewportY;
      const bottom = top + term.rows - 1;
      const PROMPT_RE = /^(\s*)(>|❯|›|»)\s+(\S.*?)\s*$/;
      let inputRow = -1, inputStart = -1, inputEnd = -1;
      for (let r = bottom; r >= top; r--) {
        const line = buf.getLine(r)?.translateToString(true) ?? "";
        const m = line.match(PROMPT_RE);
        if (m) {
          const marker = m[2];
          const ms = line.indexOf(marker, m[1].length) + marker.length;
          let is = ms;
          while (is < line.length && line[is] === " ") is++;
          const ie = line.replace(/\s+$/, "").length;
          if (ie > is) { inputRow = r; inputStart = is; inputEnd = ie; break; }
        }
      }

      if (inputRow === -1) return;
      if (clickAbsRow !== inputRow) return;
      const targetCol = Math.max(inputStart, Math.min(inputEnd, clickCol));
      const distFromStart = targetCol - inputStart;
      const distFromEnd = inputEnd - targetCol;
      if (distFromStart === 0 && distFromEnd === 0) return;

      // Pick whichever anchor (start vs end) needs fewer arrow keys — halves the
      // worst-case render count claude has to do.
      let seq: string;
      if (distFromStart <= distFromEnd) {
        seq = "\x01" + "\x1b[C".repeat(distFromStart); // BeginningOfLine + Right
      } else {
        seq = "\x05" + "\x1b[D".repeat(distFromEnd); // EndOfLine + Left
      }
      invoke("pty_write", { data: seq });
      term.clearSelection();
      e.preventDefault();
      e.stopPropagation();
    };
    containerRef.current.addEventListener("mousedown", onMouseDown, { capture: true });
    containerRef.current.addEventListener("mouseup", onMouseUp, { capture: true });

    // In TUI mode, our keydown handler already wrote the clipboard to PTY manually.
    // The browser's paste event ALSO fires though, and xterm's textarea handler would
    // write a second copy. preventDefault + stopImmediatePropagation in document
    // capture phase blocks xterm before it can run.
    const onPaste = (e: ClipboardEvent) => {
      if (isTuiActive()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener("paste", onPaste, { capture: true });

    // (Paste-replace is handled inside the customKeyEventHandler below — we send the
    //  erase chars synchronously, then return true so xterm's paste flow runs.
    //  Tauri's pty_write IPC queue + the writer mutex preserve order.)

    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    (async () => {
      // Spawn PTY with PowerShell
      await invoke("pty_spawn", {
        shell: "powershell.exe",
        cols: term.cols,
        rows: term.rows,
        cwd: null,
      });

      // Forward terminal input to PTY
      term.onData((data) => {
        invoke("pty_write", { data });
      });

      // Resize PTY when terminal resizes
      term.onResize(({ cols, rows }) => {
        invoke("pty_resize", { cols, rows });
      });

      // Receive PTY output
      unlistenOutput = await listen<string>("pty-output", (event) => {
        const data = event.payload;
        term.write(data);
        // TUI detection: box-drawing chars latch the app into "tuiSticky" mode.
        // A shell prompt at the end of recent output unsticks it.
        if (BOX_CHAR_RE.test(data)) {
          if (!tuiSticky) {
            tuiSticky = true;
            updateMode();
          }
        } else if (tuiSticky && SHELL_PROMPT_RE.test(data)) {
          tuiSticky = false;
          updateMode();
        }
      });

      unlistenExit = await listen<number>("pty-exit", (event) => {
        term.write(`\r\n\x1b[33m[shell exited with code ${event.payload}]\x1b[0m\r\n`);
      });

      // Handle window resize
      const resizeObserver = new ResizeObserver(() => fitAddon.fit());
      resizeObserver.observe(containerRef.current!);
    })().catch((err) => {
      term.write(`\r\n\x1b[31m[failed to spawn shell: ${err}]\x1b[0m\r\n`);
    });

    return () => {
      unlistenOutput?.();
      unlistenExit?.();
      containerRef.current?.removeEventListener("contextmenu", onContextMenu);
      containerRef.current?.removeEventListener("mousedown", onMouseDown, { capture: true } as any);
      containerRef.current?.removeEventListener("mouseup", onMouseUp, { capture: true } as any);
      document.removeEventListener("paste", onPaste, { capture: true } as any);
      term.dispose();
      invoke("pty_kill").catch(() => {});
    };
  }, []);

  return (
    <>
      <div ref={containerRef} className="terminal" />
      {menuPos && (
        <>
          <div className="ctx-menu-overlay" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
          <div
            className="ctx-menu"
            style={{ left: menuPos.x, top: menuPos.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="ctx-item"
              onClick={menuCopy}
              disabled={!xtermRef.current?.hasSelection()}
            >
              <span>Copy</span>
              <span className="ctx-shortcut">Ctrl+C</span>
            </button>
            <button className="ctx-item" onClick={menuPaste}>
              <span>Paste</span>
              <span className="ctx-shortcut">Ctrl+V</span>
            </button>
            <div className="ctx-sep" />
            <button className="ctx-item" onClick={menuSelectInput}>
              <span>Select Input</span>
              <span className="ctx-shortcut">Ctrl+A</span>
            </button>
            <button className="ctx-item" onClick={menuClear}>
              <span>Clear Screen</span>
              <span className="ctx-shortcut">Ctrl+L</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}
