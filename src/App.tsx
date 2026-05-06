import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Terminal from "./Terminal";

export default function App() {
  const win = getCurrentWindow();
  const [mode, setMode] = useState<string>("shell");

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string") setMode(detail);
    };
    window.addEventListener("ct:mode", handler);
    return () => window.removeEventListener("ct:mode", handler);
  }, []);

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-title">
          claude-terminal
          <span className={`mode-pill ${mode === "tui" ? "mode-pill-tui" : ""}`}>
            {mode}
          </span>
        </span>
        <div className="titlebar-controls">
          <button
            className="titlebar-btn"
            onClick={() => win.minimize()}
            aria-label="Minimize"
            title="Minimize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button
            className="titlebar-btn"
            onClick={() => win.toggleMaximize()}
            aria-label="Maximize"
            title="Maximize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button
            className="titlebar-btn titlebar-btn-close"
            onClick={() => win.close()}
            aria-label="Close"
            title="Close"
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" /><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
        </div>
      </div>
      <Terminal />
    </div>
  );
}
