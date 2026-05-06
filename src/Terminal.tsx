import { useEffect, useRef } from "react";
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

  useEffect(() => {
    if (!containerRef.current) return;

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
        term.write(event.payload);
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
      term.dispose();
      invoke("pty_kill").catch(() => {});
    };
  }, []);

  return <div ref={containerRef} className="terminal" />;
}
