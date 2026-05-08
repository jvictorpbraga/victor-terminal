// Pure event reducer for per-session state. Takes a SessionData and a parsed
// claude-event object, returns the updated SessionData. App.tsx wraps this in
// setState so multiple chats can stream independently.

import type {
  ChatMessage,
  ContentBlock,
  SessionData,
  ToolCall,
} from "./types";

/** Apply a single parsed event line to a session. */
export function applySessionEvent(s: SessionData, obj: any): SessionData {
  const t = obj?.type;

  // Track the active claude session_id whenever the SDK reveals it. This lets
  // us look up the matching ledger MD on auto-refresh.
  const claudeSid: string | undefined =
    obj?.session_id || obj?.message?.session_id;
  let resolvedSessionId = s.resolvedSessionId;
  if (claudeSid && claudeSid !== resolvedSessionId) {
    resolvedSessionId = claudeSid;
  }

  if (t === "result") {
    return {
      ...s,
      busy: false,
      currentTurnId: null,
      turnFinalizedCount: 0,
      resolvedSessionId,
      lastEventAt: Date.now(),
      messages: s.messages.map((m) =>
        m.streaming ? { ...m, streaming: false } : m,
      ),
    };
  }

  if (t === "system") {
    return { ...s, resolvedSessionId, lastEventAt: Date.now() };
  }

  if (t === "stream_event") {
    return {
      ...handleStreamEvent(s, obj.event || obj),
      resolvedSessionId,
      lastEventAt: Date.now(),
    };
  }

  if (t === "assistant") {
    return {
      ...handleAssistantMessage(s, obj.message),
      resolvedSessionId,
      lastEventAt: Date.now(),
    };
  }

  if (t === "user") {
    return {
      ...handleUserToolResult(s, obj.message),
      resolvedSessionId,
      lastEventAt: Date.now(),
    };
  }

  return { ...s, resolvedSessionId, lastEventAt: Date.now() };
}

function ensureTurnBubble(s: SessionData): {
  state: SessionData;
  bubbleId: string;
} {
  if (s.currentTurnId) {
    return { state: s, bubbleId: s.currentTurnId };
  }
  const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const msg: ChatMessage = {
    id,
    role: "assistant",
    blocks: [],
    timestamp: Date.now(),
    streaming: true,
  };
  return {
    state: {
      ...s,
      currentTurnId: id,
      messages: [...s.messages, msg],
    },
    bubbleId: id,
  };
}

function updateBubble(
  s: SessionData,
  bubbleId: string,
  fn: (m: ChatMessage) => ChatMessage,
): SessionData {
  const idx = s.messages.findIndex((m) => m.id === bubbleId);
  if (idx < 0) return s;
  const next = s.messages.slice();
  next[idx] = fn(s.messages[idx]);
  return { ...s, messages: next };
}

function handleStreamEvent(s: SessionData, ev: any): SessionData {
  const t = ev?.type;
  if (t === "message_start") {
    // First message of a turn opens the bubble; subsequent message_starts
    // (multi-tool round-trips inside one user turn) are ignored.
    return ensureTurnBubble(s).state;
  }
  if (t === "content_block_start") {
    const block = ev.content_block;
    const newBlock = blockFromContentBlockStart(block);
    if (!newBlock) return s;
    const { state, bubbleId } = ensureTurnBubble(s);
    return updateBubble(state, bubbleId, (m) => ({
      ...m,
      blocks: [...m.blocks, newBlock],
    }));
  }
  if (t === "content_block_delta") {
    const delta = ev.delta;
    if (!s.currentTurnId) return s;
    return updateBubble(s, s.currentTurnId, (m) => {
      if (m.blocks.length === 0) return m;
      const blocks = m.blocks.slice();
      const idx = blocks.length - 1;
      blocks[idx] = applyDelta(blocks[idx], delta);
      return { ...m, blocks };
    });
  }
  return s;
}

function blockFromContentBlockStart(b: any): ContentBlock | null {
  if (!b) return null;
  if (b.type === "text") return { kind: "text", text: b.text || "" };
  if (b.type === "thinking")
    return { kind: "thinking", text: b.thinking || "" };
  if (b.type === "tool_use") {
    const tool: ToolCall = {
      id: b.id,
      name: b.name,
      input: b.input ?? {},
      startedAt: Date.now(),
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
    const partial = block.tool.partialInput || "";
    return {
      ...block,
      tool: {
        ...block.tool,
        partialInput: partial + (delta.partial_json || ""),
      },
    };
  }
  return block;
}

function handleAssistantMessage(s: SessionData, message: any): SessionData {
  if (!message) return s;
  const blocks: ContentBlock[] = [];
  for (const c of message.content || []) {
    if (c.type === "text") blocks.push({ kind: "text", text: c.text || "" });
    else if (c.type === "thinking")
      blocks.push({ kind: "thinking", text: c.thinking || "" });
    else if (c.type === "tool_use")
      blocks.push({
        kind: "tool_use",
        tool: {
          id: c.id,
          name: c.name,
          input: c.input ?? {},
          startedAt: Date.now(),
        },
      });
  }
  if (blocks.length === 0) return s;

  if (!s.currentTurnId) {
    const id = `a-${message.id || Date.now()}`;
    return {
      ...s,
      currentTurnId: id,
      turnFinalizedCount: blocks.length,
      messages: [
        ...s.messages,
        { id, role: "assistant", blocks, timestamp: Date.now(), streaming: true },
      ],
    };
  }

  const idx = s.messages.findIndex((m) => m.id === s.currentTurnId);
  if (idx < 0) {
    return {
      ...s,
      turnFinalizedCount: blocks.length,
      messages: [
        ...s.messages,
        {
          id: s.currentTurnId,
          role: "assistant",
          blocks,
          timestamp: Date.now(),
          streaming: true,
        },
      ],
    };
  }

  // Replace any "live" stream-built blocks past the previously-finalized
  // count with the canonical blocks from this message. Earlier blocks
  // (already finalized by prior canonical messages from earlier round-trips)
  // stay untouched.
  const cur = s.messages[idx];
  const finalized = s.turnFinalizedCount;
  const baseBlocks = cur.blocks.slice(0, finalized);
  const liveBlocks = cur.blocks.slice(finalized);

  // Preserve tool_use startedAt from any live block whose id matches an
  // incoming canonical block (so the elapsed timer doesn't reset).
  const newBlocks = blocks.map((b) => {
    if (b.kind !== "tool_use") return b;
    const live = liveBlocks.find(
      (lb) => lb.kind === "tool_use" && lb.tool.id === b.tool.id,
    );
    if (live && live.kind === "tool_use") {
      return {
        ...b,
        tool: {
          ...b.tool,
          startedAt: live.tool.startedAt ?? b.tool.startedAt,
        },
      };
    }
    return b;
  });

  const merged = [...baseBlocks, ...newBlocks];
  const nextMessages = s.messages.slice();
  nextMessages[idx] = { ...cur, blocks: merged, streaming: true };
  return {
    ...s,
    messages: nextMessages,
    turnFinalizedCount: merged.length,
  };
}

function handleUserToolResult(s: SessionData, message: any): SessionData {
  if (!message) return s;
  const content = message.content;
  if (!Array.isArray(content)) return s;
  let next = s;
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
    next = attachToolResult(next, id, text, isErr);
  }
  return next;
}

function attachToolResult(
  s: SessionData,
  toolUseId: string,
  result: string,
  isError: boolean,
): SessionData {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role !== "assistant") continue;
    const idx = m.blocks.findIndex(
      (b) => b.kind === "tool_use" && b.tool.id === toolUseId,
    );
    if (idx < 0) continue;
    const blocks = m.blocks.slice();
    const target = blocks[idx];
    if (target.kind === "tool_use") {
      blocks[idx] = {
        ...target,
        tool: { ...target.tool, result, resultIsError: isError },
      };
    }
    const next = s.messages.slice();
    next[i] = { ...m, blocks };
    return { ...s, messages: next };
  }
  return s;
}

/** Replay a session JSONL file into a SessionData (used on resume). */
export function replaySession(jsonl: string, s: SessionData): SessionData {
  let cur: SessionData = { ...s, messages: [], currentTurnId: null };
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
        cur = handleUserToolResult(cur, msg);
        continue;
      }
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
          id: `r-u-${cur.messages.length}`,
          role: "user",
          blocks: [{ kind: "text", text }],
          timestamp: 0,
        };
        cur = { ...cur, messages: [...cur.messages, userMsg] };
      }
      cur = { ...cur, currentTurnId: null };
      continue;
    }
    if (obj.type === "assistant") {
      cur = handleAssistantMessage(cur, obj.message);
    }
  }
  // Mark all bubbles as complete AND wipe startedAt on every tool_use. Live
  // event handlers stamp Date.now() on each tool when it appears, which is
  // correct for active sessions but wrong here — without this, every tool
  // from the historical JSONL would look like it just started, polluting the
  // activity strip with phantom bg-task chips on app launch.
  return {
    ...cur,
    currentTurnId: null,
    messages: cur.messages.map((m) => ({
      ...m,
      streaming: false,
      blocks: m.blocks.map((b) =>
        b.kind === "tool_use"
          ? { ...b, tool: { ...b.tool, startedAt: undefined } }
          : b,
      ),
    })),
  };
}

/** Auto-derive a sidebar title from the first user message in a session. */
export function deriveSessionTitle(s: SessionData): string | null {
  const firstUser = s.messages.find((m) => m.role === "user");
  if (!firstUser) return null;
  const tb = firstUser.blocks.find((b) => b.kind === "text");
  if (!tb || tb.kind !== "text") return null;
  const t = tb.text.trim();
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}
