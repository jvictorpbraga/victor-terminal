import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Terminal from "./Terminal";
import Ledger from "./Ledger";

type UsageSnapshot = {
  session_id: string;
  project_dir: string;
  model: string;
  limit: number;
  used: number;
  used_pct: number;
};

export default function App() {
  const win = getCurrentWindow();
  const [mode, setMode] = useState<string>("shell");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [warned, setWarned] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string") setMode(detail);
    };
    window.addEventListener("ct:mode", handler);
    return () => window.removeEventListener("ct:mode", handler);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<UsageSnapshot>("session-usage", (event) => {
      setUsage(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Auto-export ledger when context crosses 85%, only once per session.
  useEffect(() => {
    if (!usage) return;
    if (usage.used_pct < 85) {
      // Reset the warning when usage drops back down (e.g. after /compact)
      if (warned && usage.used_pct < 50) setWarned(false);
      return;
    }
    if (warned) return;
    setWarned(true);
    const out = `${navigator.userAgent.includes("Win") ? "C:\\Users\\Victor\\Desktop\\claude-terminal\\sessions\\" : ""}${usage.session_id}.md`;
    invoke<string>("ledger_export_session", {
      sessionId: usage.session_id,
      cwd: null,
      outPath: out,
    }).catch(() => {});
  }, [usage, warned]);

  const usagePctRounded = usage ? Math.min(100, Math.round(usage.used_pct)) : null;
  const usageColor =
    usagePctRounded == null
      ? ""
      : usagePctRounded >= 90
      ? "usage-danger"
      : usagePctRounded >= 75
      ? "usage-warn"
      : "";

  return (
    <div className="app">
      <div className="titlebar">
        {/* Dedicated drag handle — fills the leftover space between content and buttons */}
        <div className="titlebar-drag" data-tauri-drag-region>
          <span className="titlebar-title">
            <span>claude-terminal</span>
            <span className={`mode-pill ${mode === "tui" ? "mode-pill-tui" : ""}`}>
              {mode}
            </span>
            {usagePctRounded != null && (
              <span
                className={`usage-pill ${usageColor}`}
                title={`${formatNum(usage!.used)} / ${formatNum(usage!.limit)} tokens (${usage!.model})`}
              >
                {usagePctRounded}%
              </span>
            )}
          </span>
        </div>
        <button
          className="titlebar-link"
          onClick={() => setLedgerOpen((v) => !v)}
          title="Open session ledger"
        >
          Ledger
        </button>
        <div className="traffic-lights">
          <button
            className="tl-btn tl-min"
            onClick={() => win.minimize()}
            aria-label="Minimize"
            title="Minimize"
          />
          <button
            className="tl-btn tl-max"
            onClick={() => win.toggleMaximize()}
            aria-label="Maximize"
            title="Maximize"
          />
          <button
            className="tl-btn tl-close"
            onClick={() => win.close()}
            aria-label="Close"
            title="Close"
          />
        </div>
      </div>
      {usage && usage.used_pct >= 85 && (
        <div className={`usage-banner ${usage.used_pct >= 95 ? "danger" : ""}`}>
          <span>
            Context at <strong>{Math.round(usage.used_pct)}%</strong> · ledger saved
            to <code>sessions/{usage.session_id}.md</code> · run{" "}
            <code>/compact</code> in claude to summarize and continue.
          </span>
        </div>
      )}
      <Terminal />
      <Ledger open={ledgerOpen} onClose={() => setLedgerOpen(false)} />
    </div>
  );
}

function formatNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
