import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Chat from "./chat/Chat";
import Sidebar from "./chat/Sidebar";
import {
  applySessionEvent,
  deriveSessionTitle,
  replaySession,
} from "./chat/session-reducer";
import {
  emptySession,
  makeSessionKey,
  type Attachment,
  type ChatMessage,
  type SessionData,
} from "./chat/types";

type UsageSnapshot = {
  session_id: string;
  project_dir: string;
  model: string;
  limit: number;
  used: number;
  used_pct: number;
};

const RESTART_THRESHOLD_PCT = 75;
const RESTART_IDLE_MS = 5000;
// Long tools (builds, big fetches, image gen) routinely run >1m with no stream
// events. Keep this generous so the input doesn't unlock under the user.
const WATCHDOG_BUSY_TIMEOUT_MS = 300_000;

export default function App() {
  const win = getCurrentWindow();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionData>>({});
  // Network status. While offline, every claude API call is doomed; rather
  // than firing the watchdog and showing "no response from claude" errors,
  // surface the real cause and pause the watchdog. When the connection
  // returns, briefly toast "Reconnected" so the user knows the chat is live
  // again.
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [reconnectedAt, setReconnectedAt] = useState<number | null>(null);
  const offlineSinceRef = useRef<number | null>(null);
  useEffect(() => {
    offlineSinceRef.current = offlineSince;
  }, [offlineSince]);
  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      setOfflineSince(null);
      setReconnectedAt(Date.now());
    };
    const onOffline = () => {
      setOnline(false);
      setOfflineSince(Date.now());
      setReconnectedAt(null);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    // Sync once on mount in case the page loaded already-offline.
    if (typeof navigator !== "undefined" && !navigator.onLine) onOffline();
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  // Auto-clear the "Reconnected" toast after a few seconds.
  useEffect(() => {
    if (!reconnectedAt) return;
    const id = setTimeout(() => setReconnectedAt(null), 3000);
    return () => clearTimeout(id);
  }, [reconnectedAt]);
  // Multiple chats can be visible side-by-side (up to MAX_VISIBLE_PANES).
  // The first key in visibleKeys is the "primary" — used for the usage pill,
  // titlebar focus, and as the default destination when starting new chats.
  const [visibleKeys, setVisibleKeys] = useState<string[]>([]);

  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const visibleKeysRef = useRef(visibleKeys);
  useEffect(() => {
    visibleKeysRef.current = visibleKeys;
  }, [visibleKeys]);

  // Mutate one session in place, immutably.
  const updateSession = useCallback(
    (key: string, fn: (s: SessionData) => SessionData) => {
      setSessions((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        return { ...prev, [key]: fn(cur) };
      });
    },
    [],
  );

  // ---- Session lifecycle -------------------------------------------------

  /** Create an empty in-app chat with the welcome screen. We DO NOT spawn the
   *  claude subprocess here — that happens lazily on the first user message
   *  via ensureClaudeSpawned. Opening + closing the app should not leave a
   *  stray empty ledger entry on disk. */
  const startNewChat = useCallback(() => {
    const key = makeSessionKey();
    const session = emptySession({ key });
    setSessions((prev) => ({ ...prev, [key]: session }));
    setVisibleKeys([key]);
  }, []);

  /** Ensure claude is running for this key; spawn it on demand the first time. */
  const ensureClaudeSpawned = useCallback(
    async (key: string): Promise<boolean> => {
      const cur = sessionsRef.current[key];
      if (!cur) return false;
      if (cur.claudeSpawned) return true;
      // Mark spawned BEFORE the await so concurrent sends don't double-start.
      updateSession(key, (s) => ({ ...s, claudeSpawned: true }));
      try {
        await invoke("claude_start", {
          key,
          args: {
            model: cur.model,
            resume: cur.resumeId,
            cwd: null,
            append_system_prompt: null,
          },
        });
        return true;
      } catch (e) {
        updateSession(key, (s) => ({
          ...s,
          claudeSpawned: false,
          error: String(e),
        }));
        return false;
      }
    },
    [updateSession],
  );

  /** Add a chat to the visible row (no upper limit) without closing the others. */
  const showAlongside = useCallback((key: string) => {
    setVisibleKeys((prev) => {
      if (prev.includes(key)) return prev;
      return [...prev, key];
    });
  }, []);

  /** Replace the visible row with just this one chat — single-pane swap. */
  const swapToOnly = useCallback((key: string) => {
    setVisibleKeys([key]);
  }, []);

  /** Make this chat the only visible one. */
  const focusOnly = useCallback((key: string) => {
    setVisibleKeys([key]);
  }, []);

  /** Hide this chat from view (it keeps running in the background). */
  const minimizeChat = useCallback((key: string) => {
    setVisibleKeys((prev) => {
      const next = prev.filter((k) => k !== key);
      if (next.length === 0) {
        // Don't leave the user with no panes — fall back to ANY remaining session.
        const remaining = Object.keys(sessionsRef.current).filter((k) => k !== key);
        if (remaining[0]) return [remaining[0]];
      }
      return next;
    });
  }, []);

  const resumeFromPast = useCallback(
    async (resumeId: string) => {
      // If a chat is already open for this resumeId, just bring it into view.
      const existing = Object.values(sessionsRef.current).find(
        (s) => s.resumeId === resumeId || s.resolvedSessionId === resumeId,
      );
      if (existing) {
        showAlongside(existing.key);
        return;
      }

      const key = makeSessionKey();
      const stub = emptySession({ key, resumeId, resolvedSessionId: resumeId });
      setSessions((prev) => ({ ...prev, [key]: stub }));
      setVisibleKeys([key]);

      try {
        const jsonl = await invoke<string>("ledger_get_session_jsonl", {
          sessionId: resumeId,
          cwd: null,
        });
        updateSession(key, (s) => {
          const replayed = replaySession(jsonl, s);
          return { ...replayed, title: deriveSessionTitle(replayed) ?? s.title };
        });
      } catch (e) {
        updateSession(key, (s) => ({ ...s, error: String(e) }));
      }

      try {
        await invoke("claude_start", {
          key,
          args: {
            model: stub.model,
            resume: resumeId,
            cwd: null,
            append_system_prompt: null,
          },
        });
        updateSession(key, (s) => ({ ...s, claudeSpawned: true }));
      } catch (e) {
        updateSession(key, (s) => ({ ...s, error: String(e) }));
      }
    },
    [updateSession],
  );

  const closeSession = useCallback(
    async (key: string) => {
      try {
        await invoke("claude_stop", { key });
      } catch {}
      setSessions((prev) => {
        const { [key]: _, ...rest } = prev;
        return rest;
      });
      setVisibleKeys((prev) => {
        const next = prev.filter((k) => k !== key);
        if (next.length === 0) {
          const remaining = Object.keys(sessionsRef.current).filter((k) => k !== key);
          if (remaining[0]) return [remaining[0]];
        }
        return next;
      });
    },
    [],
  );

  // ---- Outgoing actions --------------------------------------------------

  const sendMessage = useCallback(
    async (key: string, text: string, attachments: Attachment[]) => {
      const session = sessionsRef.current[key];
      if (!session) return;
      if (session.busy) return;

      // Spawn the claude subprocess on the very first message of this chat.
      // This keeps the welcome screen weightless (no ledger entry) until the
      // user actually starts a conversation.
      if (!session.claudeSpawned) {
        const ok = await ensureClaudeSpawned(key);
        if (!ok) return;
      }

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        blocks: text ? [{ kind: "text", text }] : [],
        timestamp: Date.now(),
        attachments: attachments.length ? attachments : undefined,
      };

      updateSession(key, (s) => ({
        ...s,
        messages: [...s.messages, userMsg],
        busy: true,
        currentTurnId: null,
        turnFinalizedCount: 0,
        title: s.title ?? (text ? (text.length > 60 ? text.slice(0, 60) + "…" : text) : null),
        lastEventAt: Date.now(),
      }));

      let content: any;
      if (attachments.length === 0) {
        content = text;
      } else {
        const blocks: any[] = [];
        if (text) blocks.push({ type: "text", text });
        for (const a of attachments) {
          if (a.kind === "image" && a.base64 && a.mediaType) {
            blocks.push({
              type: "image",
              source: { type: "base64", media_type: a.mediaType, data: a.base64 },
            });
          } else if (a.kind === "file") {
            blocks.push({
              type: "text",
              text: `(attached file: ${a.name}${a.path ? ` at ${a.path}` : ""})`,
            });
          }
        }
        content = blocks;
      }

      const payload = {
        type: "user",
        message: { role: "user", content },
      };
      invoke("claude_send", { key, jsonLine: JSON.stringify(payload) }).catch((e) =>
        updateSession(key, (s) => ({ ...s, error: String(e) })),
      );
    },
    [updateSession, ensureClaudeSpawned],
  );

  const interruptSession = useCallback(
    async (key: string) => {
      const session = sessionsRef.current[key];
      if (!session) return;
      try {
        await invoke("claude_stop", { key });
      } catch {}
      updateSession(key, (s) => ({
        ...s,
        busy: false,
        currentTurnId: null,
        turnFinalizedCount: 0,
        claudeSpawned: false,
        messages: s.messages.map((m) =>
          m.streaming ? { ...m, streaming: false } : m,
        ),
      }));
      // Restart fresh (resume resolved session id if we have one so the
      // ledger continues into the same JSONL).
      try {
        await invoke("claude_start", {
          key,
          args: {
            model: session.model,
            resume: session.resolvedSessionId,
            cwd: null,
            append_system_prompt: null,
          },
        });
        updateSession(key, (s) => ({ ...s, claudeSpawned: true }));
      } catch (e) {
        updateSession(key, (s) => ({ ...s, error: String(e) }));
      }
    },
    [updateSession],
  );

  const changeModel = useCallback(
    async (key: string, slug: string) => {
      const session = sessionsRef.current[key];
      if (!session) return;
      if (session.model === slug) return;
      try {
        await invoke("claude_stop", { key });
      } catch {}
      // Model change wipes the chat back to the welcome screen — leave claude
      // unspawned so the user's first message under the new model is what
      // creates the next ledger entry.
      updateSession(key, (s) => ({
        ...s,
        model: slug,
        messages: [],
        currentTurnId: null,
        busy: false,
        resolvedSessionId: null,
        claudeSpawned: false,
      }));
    },
    [updateSession],
  );

  // ---- Event listeners ---------------------------------------------------

  // claude-event: route every line by key into the right session reducer.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("claude-event", (event) => {
      let wrapped: any;
      try {
        wrapped = JSON.parse(event.payload);
      } catch {
        return;
      }
      const key: string | undefined = wrapped.key;
      const lineStr: string | undefined = wrapped.line;
      if (!key || !lineStr) return;
      let obj: any;
      try {
        obj = JSON.parse(lineStr);
      } catch {
        return;
      }
      setSessions((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        return { ...prev, [key]: applySessionEvent(cur, obj) };
      });
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  // session-usage: just remember the latest snapshot for the auto-refresh tick.
  const lastUsageRef = useRef<UsageSnapshot | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<UsageSnapshot>("session-usage", (event) => {
      setUsage(event.payload);
      lastUsageRef.current = event.payload;
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  // Auto-refresh (75% threshold, 5s idle) — runs once globally and matches the
  // hot session by claude session_id against any of our sessions' resolvedSessionId.
  useEffect(() => {
    const interval = setInterval(async () => {
      const u = lastUsageRef.current;
      if (!u) return;
      if (u.used_pct < RESTART_THRESHOLD_PCT) return;
      const all = sessionsRef.current;
      const target = Object.values(all).find(
        (s) => s.resolvedSessionId === u.session_id,
      );
      if (!target) return;
      if (target.refreshedFor.includes(u.session_id)) return;
      const idleFor = Date.now() - target.lastEventAt;
      if (idleFor < RESTART_IDLE_MS) return;

      // Mark refreshed first so we don't double-fire while restarting.
      updateSession(target.key, (s) => ({
        ...s,
        refreshedFor: [...s.refreshedFor, u.session_id],
        refreshNotice: `Refreshing context (was at ${Math.round(u.used_pct)}%)…`,
      }));

      let sessionsDir = "";
      try {
        sessionsDir = await invoke<string>("get_sessions_dir");
      } catch {}
      const ledgerPath = sessionsDir
        ? `${sessionsDir}\\${u.session_id}.md`
        : `${u.session_id}.md`;
      let ledger = "";
      try {
        ledger = await invoke<string>("read_session_ledger", {
          sessionId: u.session_id,
        });
      } catch {}
      const tail = ledger.slice(Math.max(0, ledger.length - 18000));
      const note =
        `The previous internal session reached ${Math.round(u.used_pct)}% of the model context limit ` +
        `and was transparently restarted by Victor Terminal so the conversation can continue without interruption. ` +
        `Below is the recent narrative from that session's ledger. Continue the conversation naturally — to the user, ` +
        `nothing happened. The full ledger is at ${ledgerPath} — read it via the Read tool if you need older context.\n\n` +
        `--- RECENT SESSION LEDGER (tail) ---\n` +
        tail +
        `\n--- END LEDGER ---`;

      try {
        await invoke("claude_start", {
          key: target.key,
          args: {
            model: target.model,
            resume: null,
            cwd: null,
            append_system_prompt: note,
          },
        });
        updateSession(target.key, (s) => ({
          ...s,
          refreshNotice: "Context refreshed in the background",
        }));
        setTimeout(() => {
          updateSession(target.key, (s) => ({ ...s, refreshNotice: null }));
        }, 3500);
      } catch (e) {
        updateSession(target.key, (s) => ({
          ...s,
          error: `auto-refresh failed: ${e}`,
          refreshNotice: null,
        }));
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [updateSession]);

  // Watchdog: if a session has been busy with no event for >5min, force-clear.
  // While offline, skip — the silence is the network's fault, not claude's,
  // and firing this would just produce a misleading error banner.
  useEffect(() => {
    const interval = setInterval(() => {
      if (offlineSinceRef.current !== null) return;
      const now = Date.now();
      const all = sessionsRef.current;
      for (const s of Object.values(all)) {
        if (!s.busy) continue;
        if (s.lastEventAt === 0) continue;
        if (now - s.lastEventAt > WATCHDOG_BUSY_TIMEOUT_MS) {
          updateSession(s.key, (cur) => ({
            ...cur,
            busy: false,
            currentTurnId: null,
            messages: cur.messages.map((m) =>
              m.streaming ? { ...m, streaming: false } : m,
            ),
            error:
              cur.error ??
              "No response from claude in 5 minutes — input unlocked. Try again.",
          }));
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [updateSession]);

  // Stop every session when the window is closing.
  useEffect(() => {
    const handler = () => {
      invoke("claude_stop_all").catch(() => {});
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Spawn an empty chat shell on launch — welcome screen, no claude subprocess
  // yet. The actual claude_start fires lazily on the first user message.
  useEffect(() => {
    if (Object.keys(sessionsRef.current).length === 0) {
      startNewChat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Title-bar usage pill ---------------------------------------------

  const usagePctRounded = usage ? Math.min(100, Math.round(usage.used_pct)) : null;
  const usageColor =
    usagePctRounded == null
      ? ""
      : usagePctRounded >= 90
      ? "usage-danger"
      : usagePctRounded >= 75
      ? "usage-warn"
      : "";

  // ---- Render ------------------------------------------------------------

  const activeSessions = Object.values(sessions);
  const visiblePanes = visibleKeys
    .map((k) => sessions[k])
    .filter((s): s is SessionData => !!s);
  const primaryKey = visibleKeys[0] ?? null;

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-drag" data-tauri-drag-region>
          <span className="titlebar-title">
            <span>Victor Terminal</span>
            {activeSessions.length > 1 && (
              <span className="titlebar-count" title="Active chats">
                {activeSessions.length}
              </span>
            )}
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
      <div className={`chat-row chat-row-${visiblePanes.length}`}>
        {visiblePanes.length === 0 ? (
          <div className="chat" />
        ) : (
          visiblePanes.map((session) => (
            <Chat
              key={session.key}
              session={session}
              showHeader={visiblePanes.length > 1}
              canFocusOnly={visiblePanes.length > 1}
              onSend={(text, attachments) =>
                sendMessage(session.key, text, attachments)
              }
              onChangeModel={(slug) => changeModel(session.key, slug)}
              onInterrupt={() => interruptSession(session.key)}
              onDismissError={() =>
                updateSession(session.key, (s) => ({ ...s, error: null }))
              }
              onMinimize={() => minimizeChat(session.key)}
              onFocusOnly={() => focusOnly(session.key)}
              onIntent={() => {
                // Pre-warm: spawn claude as soon as the user starts typing so
                // the cold-start latency hides under the typing time. Fires
                // at most once per chat (PromptBar guards intentFiredRef).
                ensureClaudeSpawned(session.key).catch(() => {});
              }}
            />
          ))
        )}
      </div>
      {!online && (
        <div className="connection-toast connection-toast-offline" role="status">
          <span className="connection-toast-dot" aria-hidden="true" />
          <span className="connection-toast-label">
            Internet connection dropped — your work resumes when it&apos;s back.
          </span>
        </div>
      )}
      {online && reconnectedAt && (
        <div className="connection-toast connection-toast-online" role="status">
          <span className="connection-toast-dot" aria-hidden="true" />
          <span className="connection-toast-label">Reconnected</span>
        </div>
      )}
      <span className="signature">Victor Braga</span>
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        primaryKey={primaryKey}
        visibleKeys={visibleKeys}
        activeSessions={activeSessions}
        onSwapToOnly={(key) => {
          swapToOnly(key);
          setSidebarOpen(false);
        }}
        onShowAlongside={(key) => {
          showAlongside(key);
        }}
        onMinimizeFromView={(key) => minimizeChat(key)}
        onCloseActiveSession={closeSession}
        onSelectPastSession={resumeFromPast}
        onNewChat={() => {
          startNewChat();
          setSidebarOpen(false);
        }}
      />
    </div>
  );
}

function formatNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
