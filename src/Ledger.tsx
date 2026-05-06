import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SessionMeta = {
  id: string;
  modified_unix: number;
  size: number;
  title: string | null;
  first_user: string | null;
};

type LedgerProps = {
  open: boolean;
  onClose: () => void;
};

export default function Ledger({ open, onClose }: LedgerProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    invoke<SessionMeta[]>("ledger_list_sessions", { cwd: null })
      .then((list) => {
        setSessions(list);
        if (list.length > 0 && !selected) {
          setSelected(list[0].id);
        }
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!selected) {
      setMarkdown("");
      return;
    }
    setLoading(true);
    invoke<string>("ledger_get_session", { sessionId: selected, cwd: null })
      .then((md) => {
        setMarkdown(md);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selected]);

  if (!open) return null;

  return (
    <>
      <div className="ledger-overlay" onClick={onClose} />
      <aside className="ledger-panel">
        <header className="ledger-header">
          <span>Session Ledger</span>
          <button className="ledger-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="ledger-body">
          <nav className="ledger-list">
            {loading && sessions.length === 0 && <div className="ledger-loading">Loading…</div>}
            {error && <div className="ledger-error">{error}</div>}
            {sessions.map((s) => (
              <button
                key={s.id}
                className={`ledger-item ${selected === s.id ? "active" : ""}`}
                onClick={() => setSelected(s.id)}
                title={s.id}
              >
                <div className="ledger-item-title">
                  {s.title || s.first_user || s.id.slice(0, 8)}
                </div>
                <div className="ledger-item-meta">
                  {formatDate(s.modified_unix)} · {formatSize(s.size)}
                </div>
              </button>
            ))}
          </nav>
          <article className="ledger-content">
            {loading && selected && <div className="ledger-loading">Loading ledger…</div>}
            {!loading && markdown && <pre className="ledger-md">{renderMarkdown(markdown)}</pre>}
            {!loading && !markdown && !error && (
              <div className="ledger-empty">Select a session.</div>
            )}
          </article>
        </div>
      </aside>
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
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

// Render markdown as plain styled text. Preserves headers, code blocks, blockquotes.
// Not a full markdown parser — just enough for our ledger output.
function renderMarkdown(md: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const lines = md.split("\n");
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let key = 0;

  const flushCode = () => {
    if (codeLines.length === 0) return;
    parts.push(
      <code key={key++} className="ledger-code">
        {codeLines.join("\n")}
      </code>,
    );
    codeLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    if (line.startsWith("# ")) {
      parts.push(
        <h1 key={key++} className="ledger-h1">
          {line.slice(2)}
        </h1>,
      );
    } else if (line.startsWith("## ")) {
      parts.push(
        <h2 key={key++} className="ledger-h2">
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith("> ")) {
      parts.push(
        <blockquote key={key++} className="ledger-quote">
          {line.slice(2)}
        </blockquote>,
      );
    } else if (line === "---") {
      parts.push(<hr key={key++} className="ledger-hr" />);
    } else {
      parts.push(
        <span key={key++}>
          {renderInline(line)}
          {"\n"}
        </span>,
      );
    }
  }
  return parts;
}

function renderInline(line: string): React.ReactNode {
  // Render inline `code`, **bold**, and emoji prefixes verbatim.
  const out: React.ReactNode[] = [];
  let buffer = "";
  let i = 0;
  let key = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      if (buffer) {
        out.push(<span key={key++}>{buffer}</span>);
        buffer = "";
      }
      const end = line.indexOf("`", i + 1);
      if (end === -1) {
        buffer += line[i];
        i++;
        continue;
      }
      out.push(
        <code key={key++} className="ledger-inline-code">
          {line.slice(i + 1, end)}
        </code>,
      );
      i = end + 1;
    } else if (line.startsWith("**", i)) {
      const end = line.indexOf("**", i + 2);
      if (end === -1) {
        buffer += line[i];
        i++;
        continue;
      }
      if (buffer) {
        out.push(<span key={key++}>{buffer}</span>);
        buffer = "";
      }
      out.push(
        <strong key={key++} className="ledger-bold">
          {line.slice(i + 2, end)}
        </strong>,
      );
      i = end + 2;
    } else {
      buffer += line[i];
      i++;
    }
  }
  if (buffer) out.push(<span key={key++}>{buffer}</span>);
  return out;
}
