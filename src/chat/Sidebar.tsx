// Slide-in left sidebar — conversation list with title/content search.
// Click a row to resume that conversation. "+ New chat" starts fresh.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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
  activeId: string | null;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
};

export default function Sidebar({
  open,
  onClose,
  activeId,
  onSelectSession,
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

  // Debounced search whenever the query changes.
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

  // Lightweight client-side filtering of the loaded sessions list — runs
  // immediately so the visible list updates on every keystroke without
  // waiting for the backend search. Backend hits then merge in.
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

  // Merge backend hits with local filter so content matches surface alongside
  // title/first_user matches. Dedup by id, sorted by mtime desc.
  const merged: (SessionMeta & {
    matched?: "title" | "first_user" | "content" | null;
    snippet?: string | null;
  })[] = useMemo(() => {
    if (!query.trim()) return sessions;
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
          // local hit found by title/first_user — keep that snippet but enrich
          // with backend matched type if backend found content
          map.set(h.id, { ...prev, matched: h.matched, snippet: h.snippet });
        } else {
          map.set(h.id, h);
        }
      }
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => b.modified_unix - a.modified_unix);
    return arr;
  }, [sessions, hits, localFiltered, query]);

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
              onClose();
            }}
          >
            <span className="sidebar-new-plus">+</span>
            <span>New chat</span>
          </button>
        </header>
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
            placeholder="Search title or content…"
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
              className={`sidebar-item ${activeId === s.id ? "active" : ""}`}
              onClick={() => {
                onSelectSession(s.id);
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
