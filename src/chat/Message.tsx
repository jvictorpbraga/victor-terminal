// One message bubble. Renders user or assistant content with markdown,
// expandable thinking and tool_use blocks, and a copy button.

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolCall } from "./types";

type Props = {
  message: ChatMessage;
};

export default function Message({ message }: Props) {
  const [copied, setCopied] = useState(false);

  const plainText = (): string => {
    return message.blocks
      .map((b) => {
        if (b.kind === "text") return b.text;
        if (b.kind === "thinking") return `[thinking] ${b.text}`;
        if (b.kind === "tool_use") return `[${b.tool.name}] ${JSON.stringify(b.tool.input)}`;
        return "";
      })
      .join("\n\n");
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(plainText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const roleLabel = message.role === "user" ? "You" : message.role === "assistant" ? "Claude" : "System";

  return (
    <div className={`msg msg-${message.role}`}>
      <div className="msg-header">
        <span className="msg-role">{roleLabel}</span>
        {message.role === "assistant" && (
          <button className="msg-copy" onClick={onCopy} title="Copy message">
            {copied ? "✓ Copied" : "Copy"}
          </button>
        )}
      </div>
      <div className="msg-body">
        {/* When the assistant bubble has been opened (message_start arrived)
            but no content has streamed yet, show the thinking dots inline so
            the user sees the chat is still working — covers the slow-API-call
            window where the bubble would otherwise look frozen. */}
        {message.role === "assistant" &&
          message.streaming &&
          isEffectivelyEmpty(message.blocks) && (
            <span className="thinking-dots" aria-label="Claude is working">
              <span></span>
              <span></span>
              <span></span>
            </span>
          )}
        {message.blocks.map((b, i) => {
          if (b.kind === "text") {
            return (
              <div key={i} className="msg-text">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code(props: any) {
                      const { inline, className, children, ...rest } = props;
                      if (inline) {
                        return (
                          <code className="md-inline-code" {...rest}>
                            {children}
                          </code>
                        );
                      }
                      const lang = (className || "").replace("language-", "");
                      return (
                        <CodeBlock lang={lang} className={className}>
                          {children}
                        </CodeBlock>
                      );
                    },
                    pre({ children }: any) {
                      // The `code` renderer above already returns a <pre>, so just
                      // pass through to avoid wrapping <pre><pre>.
                      return <>{children}</>;
                    },
                    a({ children, ...rest }: any) {
                      return (
                        <a {...rest} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {b.text}
                </ReactMarkdown>
              </div>
            );
          }
          if (b.kind === "thinking") {
            return <ThinkingBlock key={i} text={b.text} />;
          }
          if (b.kind === "tool_use") {
            return <ToolBlock key={i} tool={b.tool} />;
          }
          return null;
        })}
        {message.streaming && <span className="msg-cursor">▌</span>}
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments">
            {message.attachments.map((a, i) =>
              a.kind === "image" && a.dataUrl ? (
                <img
                  key={i}
                  className="msg-attachment-image"
                  src={a.dataUrl}
                  alt={a.name}
                  title={a.name}
                />
              ) : (
                <span key={i} className="msg-attachment-chip">
                  📎 {a.name}
                </span>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CodeBlock({
  lang,
  className,
  children,
}: {
  lang: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  const onCopy = async () => {
    const text = codeRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  return (
    <pre className="md-code">
      <button className="md-code-copy" onClick={onCopy} title="Copy code">
        {copied ? "✓" : "Copy"}
      </button>
      {lang && <span className="md-code-lang">{lang}</span>}
      <code ref={codeRef} className={className}>
        {children}
      </code>
    </pre>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className={`thinking-block ${open ? "open" : ""}`}>
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="thinking-icon">💭</span> Thinking
        <span className="thinking-arrow">{open ? "▾" : "▸"}</span>
      </button>
      {open && <pre className="thinking-text">{text}</pre>}
    </div>
  );
}

function ToolBlock({ tool }: { tool: ToolCall }) {
  const inFlight = tool.result === undefined;
  // Auto-expand while in flight, auto-collapse when finished. User can
  // override either way; once they click, their choice sticks for this block.
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? inFlight;
  const inputSummary = summarizeInput(tool.name, tool.input);
  const inputIsEmpty = isEmptyObject(tool.input);
  const resultIsTrivial = isTrivialResult(tool.result);

  // Elapsed timer ticks once a second while the tool is in flight.
  const [, force] = useState(0);
  useEffect(() => {
    if (!inFlight || !tool.startedAt) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [inFlight, tool.startedAt]);

  const elapsed =
    inFlight && tool.startedAt
      ? Math.max(0, Math.floor((Date.now() - tool.startedAt) / 1000))
      : null;

  const live = inFlight ? extractLivePreview(tool) : null;

  return (
    <div className={`tool-block ${open ? "open" : ""} ${inFlight ? "in-flight" : ""}`}>
      <button className="tool-toggle" onClick={() => setUserOverride(!open)}>
        <span className="tool-icon">🔧</span>
        <span className="tool-name">{tool.name}</span>
        {inputSummary && <span className="tool-summary">{inputSummary}</span>}
        {inFlight && elapsed != null && (
          <span className="tool-timer">· {elapsed}s</span>
        )}
        {tool.resultIsError && <span className="tool-status err">✗</span>}
        <span className="tool-arrow">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-detail">
          {live ? (
            <LivePreview live={live} />
          ) : (
            <>
              {!inputIsEmpty && (
                <div className="tool-section">
                  <div className="tool-section-label">input</div>
                  <pre className="tool-section-body">
                    {JSON.stringify(tool.input, null, 2)}
                  </pre>
                </div>
              )}
              {tool.result !== undefined && !resultIsTrivial && (
                <div className="tool-section">
                  <div
                    className={`tool-section-label ${tool.resultIsError ? "err" : ""}`}
                  >
                    {tool.resultIsError ? "error" : "result"}
                  </div>
                  <pre className="tool-section-body">{tool.result}</pre>
                </div>
              )}
              {tool.result !== undefined && resultIsTrivial && !inputIsEmpty && (
                <div className="tool-section">
                  <div className="tool-section-label">result</div>
                  <pre className="tool-section-body tool-section-body-muted">
                    (no output)
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// --- Live tool preview --------------------------------------------------
//
// While a tool is in flight, the SDK streams its JSON input as
// `input_json_delta` events; we accumulate them into `tool.partialInput`.
// Best-effort extraction of human-readable fields out of that partial JSON,
// rendered as a typing animation: code being written, edits being made,
// commands being typed.

type LivePreviewKind =
  | { kind: "write"; filePath: string; content: string }
  | { kind: "edit"; filePath: string; oldStr: string; newStr: string }
  | { kind: "multiedit"; filePath: string; partial: string }
  | { kind: "command"; cmd: string }
  | { kind: "raw"; partial: string };

function extractLivePreview(tool: ToolCall): LivePreviewKind | null {
  const partial = tool.partialInput || "";
  const input = tool.input || {};
  const name = tool.name;
  const peek = (field: string): string => {
    if (input[field] !== undefined && input[field] !== null) {
      return String(input[field]);
    }
    return extractStringField(partial, field);
  };

  if (name === "Write" || name === "NotebookEdit") {
    const filePath = peek("file_path") || peek("path");
    const content = peek("content") || peek("new_source") || peek("source") || "";
    if (!filePath && !content) return null;
    return { kind: "write", filePath, content };
  }
  if (name === "Edit") {
    const filePath = peek("file_path");
    const oldStr = peek("old_string");
    const newStr = peek("new_string");
    if (!filePath && !oldStr && !newStr) return null;
    return { kind: "edit", filePath, oldStr, newStr };
  }
  if (name === "MultiEdit") {
    const filePath = peek("file_path");
    if (!filePath && !partial) return null;
    return { kind: "multiedit", filePath, partial };
  }
  if (name === "Bash" || name === "PowerShell") {
    const cmd = peek("command");
    if (!cmd) return null;
    return { kind: "command", cmd };
  }
  if (partial.length > 0) return { kind: "raw", partial };
  return null;
}

/**
 * Best-effort extractor of a JSON string field's content out of a possibly
 * incomplete JSON document. Returns whatever's been streamed so far.
 */
function extractStringField(json: string, field: string): string {
  const re = new RegExp(`"${field}"\\s*:\\s*"`, "g");
  const m = re.exec(json);
  if (!m) return "";
  let i = m.index + m[0].length;
  let out = "";
  while (i < json.length) {
    const ch = json[i];
    if (ch === "\\" && i + 1 < json.length) {
      const next = json[i + 1];
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else if (next === "u" && i + 5 < json.length) {
        const hex = json.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += next;
      } else out += next;
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i++;
  }
  return out;
}

function LivePreview({ live }: { live: LivePreviewKind }) {
  if (live.kind === "write") {
    return (
      <div className="live-preview">
        {live.filePath && (
          <div className="live-preview-header">
            <span className="live-preview-action">writing</span>
            <span className="live-preview-path">{shortPath(live.filePath)}</span>
          </div>
        )}
        <pre className="live-preview-code">
          {live.content}
          <span className="live-cursor">▌</span>
        </pre>
      </div>
    );
  }
  if (live.kind === "edit") {
    return (
      <div className="live-preview">
        {live.filePath && (
          <div className="live-preview-header">
            <span className="live-preview-action">editing</span>
            <span className="live-preview-path">{shortPath(live.filePath)}</span>
          </div>
        )}
        {live.oldStr && (
          <pre className="live-preview-code live-preview-old">
            {live.oldStr.split("\n").map((line, i, arr) => (
              <span key={i} className="live-preview-line live-preview-line-del">
                <span className="live-preview-marker">-</span> {line}
                {i < arr.length - 1 && "\n"}
              </span>
            ))}
          </pre>
        )}
        {live.newStr && (
          <pre className="live-preview-code live-preview-new">
            {live.newStr.split("\n").map((line, i, arr) => (
              <span key={i} className="live-preview-line live-preview-line-ins">
                <span className="live-preview-marker">+</span> {line}
                {i < arr.length - 1 && "\n"}
              </span>
            ))}
            <span className="live-cursor">▌</span>
          </pre>
        )}
      </div>
    );
  }
  if (live.kind === "multiedit") {
    return (
      <div className="live-preview">
        {live.filePath && (
          <div className="live-preview-header">
            <span className="live-preview-action">multi-editing</span>
            <span className="live-preview-path">{shortPath(live.filePath)}</span>
          </div>
        )}
        <pre className="live-preview-code">
          {live.partial.slice(-1500)}
          <span className="live-cursor">▌</span>
        </pre>
      </div>
    );
  }
  if (live.kind === "command") {
    return (
      <pre className="live-preview-cmd">
        <span className="live-preview-prompt">$</span> {live.cmd}
        <span className="live-cursor">▌</span>
      </pre>
    );
  }
  return (
    <pre className="live-preview-code">
      {live.partial}
      <span className="live-cursor">▌</span>
    </pre>
  );
}

function isEmptyObject(v: any): boolean {
  if (v == null) return true;
  if (typeof v !== "object") return false;
  if (Array.isArray(v)) return v.length === 0;
  return Object.keys(v).length === 0;
}

function isTrivialResult(r: string | undefined): boolean {
  if (r === undefined) return true;
  const t = r.trim();
  if (!t) return true;
  if (t === "()" || t === "{}" || t === "(empty)") return true;
  if (/^\(.*(no output|no content|completed).*\)$/i.test(t)) return true;
  return false;
}

function summarizeInput(name: string, input: any): string {
  if (!input || isEmptyObject(input)) return "";
  if (name === "Bash" || name === "PowerShell") {
    const cmd = input.command || "";
    return cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
  }
  if (name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    return shortPath(input.file_path || input.path || "");
  }
  if (name === "Grep" || name === "Glob") {
    return input.pattern || "";
  }
  if (name === "WebFetch" || name === "WebSearch") {
    return input.url || input.query || "";
  }
  if (name === "Agent" || name === "Task") {
    return input.description || input.prompt?.slice(0, 80) || "";
  }
  if (name === "TodoWrite") {
    const todos = input.todos;
    if (Array.isArray(todos)) return `${todos.length} todo${todos.length === 1 ? "" : "s"}`;
    return "";
  }
  // Fallback for unknown tools — try first useful key, else nothing.
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  const first = keys.find((k) => typeof input[k] === "string") || keys[0];
  const v = input[first];
  if (typeof v === "string") {
    return v.length > 80 ? v.slice(0, 80) + "…" : v;
  }
  return "";
}

function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.split(/[\\/]/);
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-2).join("/");
}

/** True when no block has any visible content yet (empty text, empty
 *  thinking, no tool_use blocks). Used to keep the thinking-dots spinner
 *  visible while a streaming bubble has been opened but is still empty. */
function isEffectivelyEmpty(
  blocks: { kind: string; text?: string }[],
): boolean {
  if (blocks.length === 0) return true;
  return blocks.every(
    (b) =>
      (b.kind === "text" && (!b.text || b.text.length === 0)) ||
      (b.kind === "thinking" && (!b.text || b.text.length === 0)),
  );
}
