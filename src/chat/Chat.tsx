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
  const chatListRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastUsageRef = useRef<UsageEvent | null>(null);
  const lastEventAtRef = useRef<number>(0);
  const restartedSessionsRef = useRef<Set<string>>(new Set());
  const modelRef = useRef(model);
  // Tracks the bubble we're appending to for the current user turn. Reset on
  // user send and on `result`. While set, all assistant content (text, tool
  // calls, thinking, mid-turn round-trips) lands in ONE visible bubble.
  const currentTurnIdRef = useRef<string | null>(null);
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
        applyEvent(obj, currentTurnIdRef, setAndRefMessages, () => {
          setBusy(false);
          currentTurnIdRef.current = null;
        });
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

  // Auto-scroll to bottom on every content size change. Using a ResizeObserver
  // on the inner chat-list catches every streaming delta — useEffect on the
  // messages array fires before layout completes, so scrollHeight reads stale.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const list = chatListRef.current;
    if (!scroller || !list) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    ro.observe(list);
    // Also scroll immediately on initial mount in case content already overflows.
    if (stickToBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
    return () => ro.disconnect();
  }, []);

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
    currentTurnIdRef.current = null;

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
        <div className="chat-list" ref={chatListRef}>
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
// SDK system events, assistant messages (full or partial), user-role events
// with tool_result blocks, and a final result event marking the turn end.
//
// We collapse ALL assistant content of a single turn — text + tool_use +
// thinking, including tool-call round-trips — into one visible bubble. The
// `turnRef` holds the id of that bubble. It's null between turns; the first
// assistant content after a user message creates the bubble, and `result`
// (or the parent calling onSend) clears it.

type SetMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
type TurnRef = React.MutableRefObject<string | null>;

function applyEvent(
  obj: any,
  turnRef: TurnRef,
  set: SetMessages,
  markIdle: () => void,
) {
  const t = obj?.type;

  if (t === "result") {
    set((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
    );
    turnRef.current = null;
    markIdle();
    return;
  }

  if (t === "system") return;

  if (t === "stream_event") {
    handleStreamEvent(obj.event || obj, turnRef, set);
    return;
  }

  if (t === "assistant") {
    handleAssistantMessage(obj.message, turnRef, set);
    return;
  }

  if (t === "user") {
    handleUserToolResult(obj.message, set);
    return;
  }
}

/** Ensure a turn bubble exists, return its id. */
function ensureTurnBubble(
  turnRef: TurnRef,
  set: SetMessages,
): string {
  if (turnRef.current) return turnRef.current;
  const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  turnRef.current = id;
  const msg: ChatMessage = {
    id,
    role: "assistant",
    blocks: [],
    timestamp: Date.now(),
    streaming: true,
  };
  set((prev) => [...prev, msg]);
  return id;
}

/** Apply an updater function to the current turn bubble in messages. */
function updateTurnBubble(
  turnRef: TurnRef,
  set: SetMessages,
  fn: (m: ChatMessage) => ChatMessage,
) {
  const id = turnRef.current;
  if (!id) return;
  set((prev) => {
    const idx = prev.findIndex((m) => m.id === id);
    if (idx < 0) return prev;
    const next = prev.slice();
    next[idx] = fn(prev[idx]);
    return next;
  });
}

function handleStreamEvent(
  ev: any,
  turnRef: TurnRef,
  set: SetMessages,
) {
  const t = ev?.type;
  if (t === "message_start") {
    // First message of a turn creates the bubble; subsequent message_starts
    // (when claude does multi-turn tool round-trips inside one user turn) are
    // ignored — we keep appending to the same bubble.
    ensureTurnBubble(turnRef, set);
    return;
  }
  if (t === "content_block_start") {
    const block = ev.content_block;
    const newBlock = blockFromContentBlockStart(block);
    if (!newBlock) return;
    ensureTurnBubble(turnRef, set);
    updateTurnBubble(turnRef, set, (m) => ({
      ...m,
      blocks: [...m.blocks, newBlock],
    }));
    return;
  }
  if (t === "content_block_delta") {
    const delta = ev.delta;
    updateTurnBubble(turnRef, set, (m) => {
      if (m.blocks.length === 0) return m;
      const blocks = m.blocks.slice();
      const idx = blocks.length - 1;
      blocks[idx] = applyDelta(blocks[idx], delta);
      return { ...m, blocks };
    });
    return;
  }
  if (t === "content_block_stop") return;
  if (t === "message_stop") {
    // A single round-trip ended; the TURN may continue with another assistant
    // message_start if claude is calling more tools. Don't clear the bubble
    // or streaming flag here — that happens on `result`.
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
  turnRef: TurnRef,
  set: SetMessages,
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

  // Full assistant message arrival. If there's already a streaming bubble for
  // this turn (built up from content_block_delta events), replace its blocks
  // with the canonical full version. If there's no bubble yet, create it.
  // If the bubble exists and already has tool_use blocks from an earlier
  // round-trip, APPEND these new blocks instead of replacing — this is the
  // multi-tool round-trip case where claude sends a new full message after
  // each tool result.
  if (!turnRef.current) {
    const id = `a-${message.id || Date.now()}`;
    turnRef.current = id;
    set((prev) => [
      ...prev,
      { id, role: "assistant", blocks, timestamp: Date.now(), streaming: true },
    ]);
    return;
  }
  set((prev) => {
    const idx = prev.findIndex((m) => m.id === turnRef.current);
    if (idx < 0) {
      // Bubble vanished somehow — recreate.
      return [
        ...prev,
        { id: turnRef.current!, role: "assistant", blocks, timestamp: Date.now(), streaming: true },
      ];
    }
    const cur = prev[idx];
    // If existing bubble has only streaming-built deltas matching this content
    // (same number of blocks and same kinds), the full message is just the
    // canonical version of the same content — REPLACE.
    // Otherwise APPEND (multi-round-trip case).
    const isSameAsCanonical =
      cur.blocks.length > 0 &&
      cur.blocks.length === blocks.length &&
      cur.blocks.every((b, i) => b.kind === blocks[i].kind);
    const merged = isSameAsCanonical ? blocks : [...cur.blocks, ...blocks];
    const next = prev.slice();
    next[idx] = { ...cur, blocks: merged, streaming: true };
    return next;
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


// Replay a session's stored JSONL into our message tree. Same merge rule as
// the live path: every assistant content between two user messages collapses
// into ONE bubble (so multi-tool round-trips don't show up as N bubbles).
export function replayJsonl(jsonl: string): ChatMessage[] {
  let messages: ChatMessage[] = [];
  const set: SetMessages = (updater) => {
    messages = updater(messages);
  };
  const turnRef = { current: null as string | null } as TurnRef;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type === "user") {
      const msg = obj.message;
      const isToolResult =
        Array.isArray(msg?.content) &&
        msg.content.some((c: any) => c.type === "tool_result");
      if (isToolResult) {
        // Mid-turn — don't reset the bubble; just attach the tool result.
        handleUserToolResult(msg, set);
        continue;
      }
      // Plain user text — push a user bubble and reset the turn so the next
      // assistant content opens a fresh bubble.
      let text: string | null = null;
      if (typeof msg?.content === "string") text = msg.content;
      else if (Array.isArray(msg?.content)) {
        const tb = msg.content.find(
          (c: any) => c.type === "text" && typeof c.text === "string",
        );
        if (tb) text = tb.text;
      }
      if (text) {
        const userMsg: ChatMessage = {
          id: `r-u-${messages.length}`,
          role: "user",
          blocks: [{ kind: "text", text }],
          timestamp: 0,
        };
        messages = [...messages, userMsg];
      }
      turnRef.current = null;
      continue;
    }
    if (obj.type === "assistant") {
      handleAssistantMessage(obj.message, turnRef, set);
    }
    // Ignore system / ai-title / summary / etc.
  }
  return messages.map((m) => ({ ...m, streaming: false }));
}
