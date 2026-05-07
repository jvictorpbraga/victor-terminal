import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Chat from "./chat/Chat";
import Sidebar from "./chat/Sidebar";

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const usageRef = useRef<UsageSnapshot | null>(null);
  // resumeId drives Chat — change it (via key) to load a different session.
  const [resumeId, setResumeId] = useState<string | null>(null);
  // Bumping chatKey forces a fresh Chat mount even when resumeId is unchanged
  // (e.g. user clicks "+ New chat" with no current resumeId).
  const [chatKey, setChatKey] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<UsageSnapshot>("session-usage", (event) => {
      setUsage(event.payload);
      usageRef.current = event.payload;
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const usagePctRounded = usage ? Math.min(100, Math.round(usage.used_pct)) : null;
  const usageColor =
    usagePctRounded == null
      ? ""
      : usagePctRounded >= 90
      ? "usage-danger"
      : usagePctRounded >= 75
      ? "usage-warn"
      : "";

  const onSelectSession = (id: string) => {
    setResumeId(id);
    setChatKey((k) => k + 1);
  };

  const onNewChat = () => {
    setResumeId(null);
    setChatKey((k) => k + 1);
  };

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-drag" data-tauri-drag-region>
          <span className="titlebar-title">
            <span>Victor Terminal</span>
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
      <button
        className={`sidebar-rail ${sidebarOpen ? "open" : ""}`}
        onClick={() => setSidebarOpen((v) => !v)}
        aria-label={sidebarOpen ? "Close conversations" : "Open conversations"}
        title={sidebarOpen ? "Close conversations" : "Conversations"}
      >
        <svg
          className="sidebar-rail-chevron"
          width="10"
          height="14"
          viewBox="0 0 10 14"
          fill="none"
        >
          <path
            d="M2 2 L7 7 L2 12"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <Chat key={chatKey} resumeId={resumeId} />
      <span className="signature">Victor Braga</span>
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeId={resumeId}
        onSelectSession={onSelectSession}
        onNewChat={onNewChat}
      />
    </div>
  );
}

function formatNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
