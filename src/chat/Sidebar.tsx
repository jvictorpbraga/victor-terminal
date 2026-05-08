// Slide-in left sidebar.
//
// Top section: ACTIVE CHATS — all currently-running sessions in App's session
// map. Click to switch focus, click ⏹ to terminate that one. Sessions running
// in the background show a green dot; the active one is highlighted.
//
// Bottom section: PAST CONVERSATIONS — every past JSONL session on disk, with
// title/content search. Click to resume in a new active chat.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionData } from "./types";

type SessionMeta = {
  id: string;
  modified_unix: number;
  size: number;
  title: string | null;
  first_user: string | null;
};

type SearchHit = SessionMeta & {
  matched: "title" | "first_user" | "content";
  snippet: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  primaryKey: string | null;
  visibleKeys: string[];
  activeSessions: SessionData[];
  /** Replace the visible row with just this chat (single-pane swap). */
  onSwapToOnly: (key: string) => void;
  /** Add this chat to the visible row alongside the others. */
  onShowAlongside: (key: string) => void;
  /** Remove this chat from the visible row (it keeps running in the background). */
  onMinimizeFromView: (key: string) => void;
  onCloseActiveSession: (key: string) => void;
  onSelectPastSession: (id: string) => void;
  onNewChat: () => void;
};

export default function Sidebar({
  open,
  onClose,
  primaryKey,
  visibleKeys,
  activeSessions,
  onSwapToOnly,
  onShowAlongside,
  onMinimizeFromView,
  onCloseActiveSession,
  onSelectPastSession,
  onNewChat,
}: Props) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load full session list whenever the sidebar opens.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    invoke<SessionMeta[]>("ledger_list_sessions", { cwd: null })
      .then((list) => {
        setSessions(list);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!q) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      invoke<SearchHit[]>("ledger_search", { query: q, cwd: null })
        .then((list) => {
          setHits(list);
          setError(null);
        })
        .catch((e) => setError(String(e)))
        .finally(() => setSearching(false));
    }, 220);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query]);

  const localFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return sessions.filter((s) => {
      return (
        (s.title && s.title.toLowerCase().includes(q)) ||
        (s.first_user && s.first_user.toLowerCase().includes(q)) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [sessions, query]);

  // Hide past sessions whose JSONL id matches one of the currently-open active
  // chats — they're already represented in the top section.
  const pastSessionsExcludingActive = useMemo(() => {
    const activeIds = new Set(
      activeSessions
        .map((s) => s.resolvedSessionId)
        .filter((id): id is string => !!id),
    );
    return sessions.filter((s) => !activeIds.has(s.id));
  }, [sessions, activeSessions]);

  const merged: (SessionMeta & {
    matched?: "title" | "first_user" | "content" | null;
    snippet?: string | null;
  })[] = useMemo(() => {
    if (!query.trim()) return pastSessionsExcludingActive;
    const map = new Map<string, any>();
    if (localFiltered) {
      for (const s of localFiltered) {
        map.set(s.id, { ...s, matched: null, snippet: null });
      }
    }
    if (hits) {
      for (const h of hits) {
        const prev = map.get(h.id);
        if (prev) {
          map.set(h.id, { ...prev, matched: h.matched, snippet: h.snippet });
        } else {
          map.set(h.id, h);
        }
      }
    }
    const activeIds = new Set(
      activeSessions
        .map((s) => s.resolvedSessionId)
        .filter((id): id is string => !!id),
    );
    const arr = Array.from(map.values()).filter((s) => !activeIds.has(s.id));
    arr.sort((a, b) => b.modified_unix - a.modified_unix);
    return arr;
  }, [pastSessionsExcludingActive, hits, localFiltered, query, activeSessions]);

  const onClearSearch = () => {
    setQuery("");
    setHits(null);
  };

  return (
    <>
      <div
        className={`sidebar-overlay ${open ? "open" : ""}`}
        onClick={onClose}
      />
      <aside className={`sidebar ${open ? "open" : ""}`} aria-hidden={!open}>
        <header className="sidebar-header">
          <button
            className="sidebar-new"
            onClick={() => {
              onNewChat();
            }}
          >
            <span className="sidebar-new-plus">+</span>
            <span>New chat</span>
          </button>
        </header>

        {/* Only show chats whose claude subprocess has actually spawned. The
            empty welcome-screen shell is held back from the active list until
            the user sends their first message. */}
        {(() => {
          const liveSessions = activeSessions.filter(
            (s) => s.claudeSpawned || s.messages.length > 0,
          );
          if (liveSessions.length === 0) return null;
          return (
          <div className="sidebar-section">
            <div className="sidebar-section-title">
              Active
              <span className="sidebar-section-count">{liveSessions.length}</span>
            </div>
            <div className="sidebar-active-list">
              {liveSessions.map((s) => {
                const isVisible = visibleKeys.includes(s.key);
                const isPrimary = primaryKey === s.key;
                const visibleCount = visibleKeys.length;
                return (
                  <div
                    key={s.key}
                    className={`sidebar-active-item ${
                      isPrimary ? "active" : ""
                    } ${isVisible ? "visible" : ""}`}
                  >
                    <button
                      className="sidebar-active-main"
                      onClick={() => {
                        // Default click = SWAP. Single-pane focus on this chat.
                        // (Use the split icon to show alongside others.)
                        if (isVisible && visibleCount === 1) {
                          // Already the only visible chat — nothing to do.
                          onClose();
                          return;
                        }
                        onSwapToOnly(s.key);
                      }}
                      title={
                        isVisible && visibleCount === 1
                          ? "Already focused"
                          : "Switch to this chat (closes other panes from view)"
                      }
                    >
                      <span
                        className={`sidebar-active-dot ${s.busy ? "busy" : "idle"}`}
                        aria-hidden="true"
                      />
                      <span className="sidebar-active-title">
                        {s.title || "(empty chat)"}
                      </span>
                      <span className="sidebar-active-meta">
                        {isVisible
                          ? s.busy
                            ? "shown · working"
                            : "shown"
                          : s.busy
                          ? "working in bg"
                          : "minimized"}
                      </span>
                    </button>
                    <button
                      className={`sidebar-active-split ${isVisible ? "showing" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isVisible) {
                          onMinimizeFromView(s.key);
                        } else {
                          onShowAlongside(s.key);
                        }
                      }}
                      title={
                        isVisible
                          ? "Minimize from view (keeps running)"
                          : "Run alongside the current chat"
                      }
                      aria-label={
                        isVisible
                          ? "Minimize from view"
                          : "Run alongside"
                      }
                    >
                      {isVisible ? (
                        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3 11 H13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                        </svg>
                      ) : (
                        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                          <rect x="2" y="3" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="1.4" fill="none" />
                          <rect x="9" y="3" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="1.4" fill="none" />
                        </svg>
                      )}
                    </button>
                    <button
                      className="sidebar-active-stop"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseActiveSession(s.key);
                      }}
                      title="Stop and close this chat"
                      aria-label="Stop this chat"
                    >
                      <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                        <rect
                          x="1"
                          y="1"
                          width="7"
                          height="7"
                          rx="1"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          );
        })()}

        <div className="sidebar-search">
          <span className="sidebar-search-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="M16 16 L21 21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </span>
          <input
            type="text"
            className="sidebar-search-input"
            placeholder="Search past chats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && (
            <button
              className="sidebar-search-clear"
              onClick={onClearSearch}
              title="Clear search"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <div className="sidebar-section-title sidebar-section-title-divider">
          Past conversations
        </div>
        <div className="sidebar-list">
          {loading && sessions.length === 0 && (
            <div className="sidebar-empty">Loading…</div>
          )}
          {error && <div className="sidebar-error">{error}</div>}
          {!loading && merged.length === 0 && (
            <div className="sidebar-empty">
              {query ? (searching ? "Searching…" : "No matches.") : "No past conversations yet."}
            </div>
          )}
          {merged.map((s: any) => (
            <button
              key={s.id}
              className="sidebar-item"
              onClick={() => {
                onSelectPastSession(s.id);
                onClose();
              }}
              title={s.id}
            >
              <div className="sidebar-item-title">
                {highlight(
                  s.title ||
                    (s.first_user ? trimText(s.first_user, 60) : s.id.slice(0, 8)),
                  query,
                )}
              </div>
              <div className="sidebar-item-meta">
                {formatDate(s.modified_unix)}
                {s.matched === "content" && (
                  <span className="sidebar-item-tag">in messages</span>
                )}
              </div>
              {s.matched === "content" && s.snippet && (
                <div className="sidebar-item-snippet">{highlight(s.snippet, query)}</div>
              )}
            </button>
          ))}
          {searching && merged.length > 0 && (
            <div className="sidebar-search-status">Searching deeper…</div>
          )}
        </div>
      </aside>
    </>
  );
}

function highlight(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const i = lower.indexOf(lq);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="sidebar-mark">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function formatDate(unix: number): string {
  if (!unix) return "?";
  const d = new Date(unix * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const diffDays = (now.getTime() - d.getTime()) / 86400_000;
  if (diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function trimText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}
