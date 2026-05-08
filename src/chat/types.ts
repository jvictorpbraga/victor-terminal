// Chat data model. Mirrors what claude --output-format=stream-json emits.

export type ToolCall = {
  id: string;
  name: string;
  input: any;
  /** ms epoch when this tool block was first seen — for elapsed timer */
  startedAt?: number;
  /** Partial JSON accumulator while streaming, before canonical input arrives */
  partialInput?: string;
  result?: string;
  resultIsError?: boolean;
  expanded?: boolean;
};

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; expanded?: boolean }
  | { kind: "tool_use"; tool: ToolCall };

export type Attachment = {
  name: string;
  kind: "image" | "file";
  /** For images: a data URL like "data:image/png;base64,iVBOR..." */
  dataUrl?: string;
  /** Image MIME type, e.g. "image/png" */
  mediaType?: string;
  /** Raw base64 data without the data: prefix */
  base64?: string;
  /** Optional file path (for non-image files) */
  path?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  blocks: ContentBlock[];
  timestamp: number;
  streaming?: boolean;
  attachments?: Attachment[];
};

/** Per-chat backing state — multiple instances live simultaneously in App. */
export type SessionData = {
  /** Unique app-side key, used to route to the right backend subprocess */
  key: string;
  /** Display title for the sidebar (auto-derived from first user message) */
  title: string | null;
  /** If this chat resumed a past claude session, that session id; else null */
  resumeId: string | null;
  /** The most recent claude session_id seen on the wire (changes after auto-restart) */
  resolvedSessionId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  model: string;
  /** Bubble id we're currently appending to within the active turn */
  currentTurnId: string | null;
  /** Number of blocks in the current turn bubble that have been finalized
   *  by canonical assistant messages. Mid-stream blocks past this index get
   *  REPLACED when the next canonical assistant message arrives — that's
   *  what prevents duplicate text/tool-call rendering in multi-round-trip turns. */
  turnFinalizedCount: number;
  /** ms epoch of the last claude-event */
  lastEventAt: number;
  /** ms epoch when the chat was created */
  startedAt: number;
  /** Whether claude_start has been invoked for this session yet. We delay
   *  spawning the subprocess until the user actually sends their first message
   *  so opening the app and closing it doesn't create an empty ledger entry. */
  claudeSpawned: boolean;
  /** Set of claude session_ids we've already auto-refreshed (avoid re-fire) */
  refreshedFor: string[];
  /** Refresh banner state, when set: { shown: ms, message } */
  refreshNotice: string | null;
  /** Last error to surface in the chat */
  error: string | null;
};

export const MODELS = [
  { slug: "opus", label: "Opus 4.7", description: "most capable" },
  { slug: "sonnet", label: "Sonnet 4.6", description: "balanced" },
  { slug: "haiku", label: "Haiku 4.5", description: "fastest" },
];

export function makeSessionKey(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function emptySession(opts?: Partial<SessionData>): SessionData {
  return {
    key: opts?.key ?? makeSessionKey(),
    title: opts?.title ?? null,
    resumeId: opts?.resumeId ?? null,
    resolvedSessionId: opts?.resolvedSessionId ?? null,
    messages: opts?.messages ?? [],
    busy: false,
    model: opts?.model ?? "opus",
    currentTurnId: null,
    turnFinalizedCount: 0,
    lastEventAt: 0,
    startedAt: Date.now(),
    claudeSpawned: false,
    refreshedFor: [],
    refreshNotice: null,
    error: null,
  };
}
