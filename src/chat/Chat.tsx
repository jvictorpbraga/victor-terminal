// Main chat surface — owns the message list and the claude-event subscription.
// Spawns a claude-code subprocess on mount, sends user input via stream-json,
// renders streaming responses in real time.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Welcome from "./Welcome";
import Message from "./Message";
import PromptBar from "./PromptBar";
import type { ChatMessage, ContentBlock, ToolCall, Attachment } from "./types";

type ChatProps = {
  resumeId?: string | null;
};

const RESTART_THRESHOLD_PCT = 75;
const RESTART_IDLE_MS = 5000;

type UsageEvent = {
  session_id: string;
  used_pct: number;
  used: number;
  limit: number;
  model: string;
};

export default function Chat({ resumeId }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string>("opus");
  const [error, setError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastUsageRef = useRef<UsageEvent | null>(null);
  const lastEventAtRef = useRef<number>(0);
  const restartedSessionsRef = useRef<Set<string>>(new Set());
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  const setAndRefMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  // Spawn claude on mount. If we have a resumeId, replay the past conversation
  // first and then spawn claude with --resume so subsequent messages continue
  // that thread.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (resumeId) {
        try {
          const jsonl = await invoke<string>("ledger_get_session_jsonl", {
            sessionId: resumeId,
            cwd: null,
          });
          if (cancelled) return;
          const replayed = replayJsonl(jsonl);
          setAndRefMessages(() => replayed);
        } catch (e) {
          if (!cancelled) setError(String(e));
        }
      }
      try {
        await invoke("claude_start", {
          args: {
            model,
            resume: resumeId ?? null,
            cwd: null,
            append_system_prompt: null,
          },
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      invoke("claude_stop").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId]);

  // Restart claude when the model changes (only after a non-initial change).
  const lastModelRef = useRef(model);
  useEffect(() => {
    if (lastModelRef.current === model) return;
    lastModelRef.current = model;
    setAndRefMessages(() => []);
    invoke("claude_stop").catch(() => {});
    invoke("claude_start", {
      args: { model, resume: null, cwd: null, append_system_prompt: null },
    }).catch((e) => setError(String(e)));
  }, [model, setAndRefMessages]);

  // Phase 4: subscribe to usage events; when active session crosses
  // RESTART_THRESHOLD_PCT and has been idle ≥5s, swap claude in the background.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<UsageEvent>("session-usage", (event) => {
      lastUsageRef.current = event.payload;
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      const u = lastUsageRef.current;
      if (!u) return;
      if (u.used_pct < RESTART_THRESHOLD_PCT) return;
      if (restartedSessionsRef.current.has(u.session_id)) return;
      const idleFor = Date.now() - lastEventAtRef.current;
      if (idleFor < RESTART_IDLE_MS) return;
      restartedSessionsRef.current.add(u.session_id);

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
      } catch {
        // Ledger not readable — proceed with empty context
      }
      // Inline only the most recent ~18KB so the new claude has fresh context
      // without blowing past the Windows command-line length limit (~32KB).
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
          args: {
            model: modelRef.current,
            resume: null,
            cwd: null,
            append_system_prompt: note,
          },
        });
        setRefreshNotice("Context refreshed in the background");
        setTimeout(() => setRefreshNotice(null), 3500);
      } catch (e) {
        setError(`auto-refresh failed: ${e}`);
      }
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  // Listen for stream events from claude.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenErr: (() => void) | undefined;
    listen<string>("claude-event", (event) => {
      try {
        const obj = JSON.parse(event.payload);
        applyEvent(obj, setAndRefMessages, () => setBusy(false));
        lastEventAtRef.current = Date.now();
      } catch (e) {
        // ignore parse errors
      }
    }).then((fn) => (unlisten = fn));
    listen<string>("claude-stderr", (event) => {
      const line = event.payload;
      if (line) console.warn("[claude stderr]", line);
    }).then((fn) => (unlistenErr = fn));
    return () => {
      unlisten?.();
      unlistenErr?.();
    };
  }, [setAndRefMessages]);

  // Auto-scroll to bottom on new content unless user has scrolled up.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottomRef.current = atBottom;
  };

  const onSend = (text: string, attachments: Attachment[]) => {
    if (busy) return;
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      blocks: text ? [{ kind: "text", text }] : [],
      timestamp: Date.now(),
      attachments: attachments.length ? attachments : undefined,
    };
    setAndRefMessages((prev) => [...prev, userMsg]);
    stickToBottomRef.current = true;
    setBusy(true);

    // Build the SDK message content. If there are attachments, use the array
    // form with explicit content blocks (text + images). If no attachments,
    // a plain string is fine.
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
            source: {
              type: "base64",
              media_type: a.mediaType,
              data: a.base64,
            },
          });
        } else if (a.kind === "file") {
          // Non-image files: include name + a marker. The next claude can
          // ask to Read the file if a path is available.
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
    invoke("claude_send", { jsonLine: JSON.stringify(payload) }).catch((e) =>
      setError(String(e))
    );
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="chat">
      <div className="chat-scroller" ref={scrollerRef} onScroll={onScroll}>
        {isEmpty && !busy && <Welcome />}
        <div className="chat-list">
          {messages.map((m) => (
            <Message key={m.id} message={m} />
          ))}
          {busy && messages[messages.length - 1]?.role !== "assistant" && (
            <div className="msg msg-assistant">
              <div className="msg-header">
                <span className="msg-role">Claude</span>
              </div>
              <div className="msg-body">
                <span className="thinking-dots">
                  <span></span><span></span><span></span>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      {refreshNotice && (
        <div className="chat-notice">
          <span className="chat-notice-icon">↻</span>
          {refreshNotice}
        </div>
      )}
      {error && (
        <div className="chat-error">
          {error}
          <button onClick={() => setError(null)}>dismiss</button>
        </div>
      )}
      <PromptBar
        disabled={busy}
        model={model}
        onChangeModel={setModel}
        onSend={onSend}
      />
    </div>
  );
}

// --- Event reducer ----------------------------------------------------------
//
// claude --output-format=stream-json --include-partial-messages emits a mix of
// SDK system events ({"type":"system",...}), assistant messages with full or
// partial content, user-role events with tool_result blocks, and a final
// {"type":"result",...} event marking the end of the turn.

function applyEvent(
  obj: any,
  set: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void,
  markIdle: () => void,
) {
  const t = obj?.type;

  if (t === "result") {
    // Turn complete.
    set((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
    );
    markIdle();
    return;
  }

  if (t === "system") {
    // init / setup info — ignore for v1.
    return;
  }

  if (t === "stream_event") {
    // Partial message stream events (when --include-partial-messages is set).
    handleStreamEvent(obj.event || obj, set);
    return;
  }

  if (t === "assistant") {
    // Full assistant message arrived (also delivered after streaming completes).
    handleAssistantMessage(obj.message, set);
    return;
  }

  if (t === "user") {
    // User turn from the SDK perspective — usually a tool_result for the last
    // tool_use we rendered. Match by tool_use_id.
    handleUserToolResult(obj.message, set);
    return;
  }
}

function handleStreamEvent(
  ev: any,
  set: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void,
) {
  const t = ev?.type;
  if (t === "message_start") {
    const id = `a-${ev.message?.id || Date.now()}`;
    const msg: ChatMessage = {
      id,
      role: "assistant",
      blocks: [],
      timestamp: Date.now(),
      streaming: true,
    };
    set((prev) => [...prev, msg]);
    return;
  }
  if (t === "content_block_start") {
    const block = ev.content_block;
    set((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      const newBlock = blockFromContentBlockStart(block);
      if (!newBlock) return prev;
      return replaceLast(prev, { ...last, blocks: [...last.blocks, newBlock] });
    });
    return;
  }
  if (t === "content_block_delta") {
    const delta = ev.delta;
    set((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant" || last.blocks.length === 0) return prev;
      const blocks = [...last.blocks];
      const idx = blocks.length - 1;
      const cur = blocks[idx];
      blocks[idx] = applyDelta(cur, delta);
      return replaceLast(prev, { ...last, blocks });
    });
    return;
  }
  if (t === "content_block_stop") {
    return; // nothing — block already in place
  }
  if (t === "message_stop") {
    set((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
    );
    return;
  }
}

function blockFromContentBlockStart(b: any): ContentBlock | null {
  if (!b) return null;
  if (b.type === "text") return { kind: "text", text: b.text || "" };
  if (b.type === "thinking") return { kind: "thinking", text: b.thinking || "" };
  if (b.type === "tool_use") {
    const tool: ToolCall = {
      id: b.id,
      name: b.name,
      input: b.input ?? {},
    };
    return { kind: "tool_use", tool };
  }
  return null;
}

function applyDelta(block: ContentBlock, delta: any): ContentBlock {
  if (!delta) return block;
  if (block.kind === "text" && delta.type === "text_delta") {
    return { ...block, text: block.text + (delta.text || "") };
  }
  if (block.kind === "thinking" && delta.type === "thinking_delta") {
    return { ...block, text: block.text + (delta.thinking || "") };
  }
  if (block.kind === "tool_use" && delta.type === "input_json_delta") {
    // Accumulate partial JSON text — we won't try to parse incrementally,
    // we wait for the full message to update the input.
    const partial = (block.tool as any).__partialInput || "";
    const next = partial + (delta.partial_json || "");
    return {
      ...block,
      tool: { ...block.tool, ["__partialInput" as any]: next },
    };
  }
  return block;
}

function handleAssistantMessage(
  message: any,
  set: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void,
) {
  if (!message) return;
  const blocks: ContentBlock[] = [];
  for (const c of message.content || []) {
    if (c.type === "text") blocks.push({ kind: "text", text: c.text || "" });
    else if (c.type === "thinking")
      blocks.push({ kind: "thinking", text: c.thinking || "" });
    else if (c.type === "tool_use")
      blocks.push({
        kind: "tool_use",
        tool: { id: c.id, name: c.name, input: c.input ?? {} },
      });
  }
  if (blocks.length === 0) return;

  set((prev) => {
    const last = prev[prev.length - 1];
    if (last && last.role === "assistant" && last.streaming) {
      // Replace the streaming placeholder with the final content.
      return replaceLast(prev, { ...last, blocks, streaming: false });
    }
    const id = `a-${message.id || Date.now()}`;
    return [
      ...prev,
      { id, role: "assistant", blocks, timestamp: Date.now(), streaming: false },
    ];
  });
}

function handleUserToolResult(
  message: any,
  set: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void,
) {
  if (!message) return;
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (c.type !== "tool_result") continue;
    const id = c.tool_use_id;
    const isErr = !!c.is_error;
    const text =
      typeof c.content === "string"
        ? c.content
        : Array.isArray(c.content)
        ? c.content
            .map((x: any) => (typeof x === "string" ? x : x?.text || ""))
            .join("\n")
        : JSON.stringify(c.content);
    set((prev) => attachToolResult(prev, id, text, isErr));
  }
}

function attachToolResult(
  prev: ChatMessage[],
  toolUseId: string,
  result: string,
  isError: boolean,
): ChatMessage[] {
  // Find the most recent assistant message containing this tool_use_id.
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i];
    if (m.role !== "assistant") continue;
    const idx = m.blocks.findIndex(
      (b) => b.kind === "tool_use" && b.tool.id === toolUseId,
    );
    if (idx < 0) continue;
    const blocks = [...m.blocks];
    const target = blocks[idx];
    if (target.kind === "tool_use") {
      blocks[idx] = {
        ...target,
        tool: { ...target.tool, result, resultIsError: isError },
      };
    }
    const next = [...prev];
    next[i] = { ...m, blocks };
    return next;
  }
  return prev;
}

function replaceLast(arr: ChatMessage[], item: ChatMessage): ChatMessage[] {
  const next = arr.slice(0, -1);
  next.push(item);
  return next;
}

// Replay a session's stored JSONL into our message tree. Each line is one of
// the same event shapes we receive live from claude-event, so we can reuse
// the same reducer and end up with the same chat state.
export function replayJsonl(jsonl: string): ChatMessage[] {
  let messages: ChatMessage[] = [];
  const set = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    messages = updater(messages);
  };
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      // Support both the live stream-json shapes and the persistent JSONL shape.
      // The persistent JSONL omits stream_event entries — it stores the FULL
      // assistant message and user-tool_result messages directly.
      if (obj.type === "user" || obj.type === "assistant") {
        // Persistent JSONL also includes a `message` envelope with content[].
        // applyEvent handles this fine for full assistant messages and for
        // user messages with tool_result blocks. For plain user text, we
        // need a small adapter because applyEvent doesn't add a user bubble
        // (it expects user messages to come from THIS app, not the JSONL).
        if (obj.type === "user") {
          const msg = obj.message;
          if (msg?.content && typeof msg.content === "string") {
            // Plain user text — push as a user message.
            const userMsg: ChatMessage = {
              id: `r-u-${messages.length}`,
              role: "user",
              blocks: [{ kind: "text", text: msg.content }],
              timestamp: 0,
            };
            messages = [...messages, userMsg];
            continue;
          }
          if (Array.isArray(msg?.content)) {
            // Could be tool_result OR plain text content. Handle both.
            const textBlock = msg.content.find(
              (c: any) => c.type === "text" && typeof c.text === "string",
            );
            const hasToolResult = msg.content.some(
              (c: any) => c.type === "tool_result",
            );
            if (hasToolResult) {
              applyEvent(obj, set, () => {});
              continue;
            }
            if (textBlock) {
              const userMsg: ChatMessage = {
                id: `r-u-${messages.length}`,
                role: "user",
                blocks: [{ kind: "text", text: textBlock.text }],
                timestamp: 0,
              };
              messages = [...messages, userMsg];
              continue;
            }
          }
          continue;
        }
        // Assistant
        applyEvent(obj, set, () => {});
        continue;
      }
      // Other event types (system, ai-title, summary, etc.) — ignore for replay.
    } catch {
      // skip non-JSON / corrupt lines
    }
  }
  // Mark all as not streaming.
  return messages.map((m) => ({ ...m, streaming: false }));
}
