// One message bubble. Renders user or assistant content with markdown,
// expandable thinking and tool_use blocks, and a copy button.

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "./types";

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

function ToolBlock({ tool }: { tool: import("./types").ToolCall }) {
  const [open, setOpen] = useState(false);
  const inputSummary = summarizeInput(tool.name, tool.input);
  return (
    <div className={`tool-block ${open ? "open" : ""}`}>
      <button className="tool-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="tool-icon">🔧</span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-summary">{inputSummary}</span>
        <span className="tool-arrow">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-detail">
          <div className="tool-section">
            <div className="tool-section-label">input</div>
            <pre className="tool-section-body">{JSON.stringify(tool.input, null, 2)}</pre>
          </div>
          {tool.result !== undefined && (
            <div className="tool-section">
              <div className={`tool-section-label ${tool.resultIsError ? "err" : ""}`}>
                {tool.resultIsError ? "error" : "result"}
              </div>
              <pre className="tool-section-body">{tool.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function summarizeInput(name: string, input: any): string {
  if (!input) return "";
  if (name === "Bash" || name === "PowerShell") {
    const cmd = input.command || "";
    return cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
  }
  if (name === "Read" || name === "Edit" || name === "Write") {
    return input.file_path || "";
  }
  if (name === "Grep" || name === "Glob") {
    return input.pattern || "";
  }
  if (name === "WebFetch" || name === "WebSearch") {
    return input.url || input.query || "";
  }
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}
