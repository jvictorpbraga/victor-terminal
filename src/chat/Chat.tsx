// Chat surface — presentational. Receives a SessionData from App and renders
// it. All state mutations bubble up via callbacks. Rendered side-by-side
// with other Chats when multiple panes are visible.

import { useEffect, useLayoutEffect, useRef } from "react";
import Welcome from "./Welcome";
import Message from "./Message";
import PromptBar from "./PromptBar";
import SessionActivity from "./SessionActivity";
import type { Attachment, SessionData } from "./types";

type Props = {
  session: SessionData;
  /** When true, render a small header bar with the chat title + pane controls. */
  showHeader?: boolean;
  /** Whether the focus-only (full-screen this pane) action is offered. */
  canFocusOnly?: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  onChangeModel: (slug: string) => void;
  onInterrupt: () => void;
  onDismissError: () => void;
  onMinimize?: () => void;
  onFocusOnly?: () => void;
};

export default function Chat({
  session,
  showHeader,
  canFocusOnly,
  onSend,
  onChangeModel,
  onInterrupt,
  onDismissError,
  onMinimize,
  onFocusOnly,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Auto-scroll on every layout change while pinned to bottom. Two channels:
  //   1. ResizeObserver — handles slow growth (markdown re-renders, images).
  //   2. useLayoutEffect on message content — fires synchronously on every
  //      stream delta so the scrollbar never lags behind streamed text.
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
    if (stickToBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
    return () => ro.disconnect();
  }, [session.key]);

  // Cheap signature that changes on every streamed delta — drives the
  // synchronous pin-to-bottom below.
  const lastMsg = session.messages[session.messages.length - 1];
  const lastBlockSig = lastMsg?.blocks
    .map((b) => {
      if (b.kind === "text") return `t${b.text.length}`;
      if (b.kind === "thinking") return `k${b.text.length}`;
      return `u${b.tool.id}${b.tool.result ? "r" : ""}`;
    })
    .join(",");
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (stickToBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [session.messages.length, lastBlockSig, session.busy]);

  const handleSend = (text: string, attachments: Attachment[]) => {
    stickToBottomRef.current = true;
    onSend(text, attachments);
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottomRef.current = atBottom;
  };

  const isEmpty = session.messages.length === 0;
  const lastIsAssistant =
    session.messages[session.messages.length - 1]?.role === "assistant";

  return (
    <div className="chat">
      {showHeader && (
        <div className="chat-pane-header">
          <span className={`chat-pane-dot ${session.busy ? "busy" : "idle"}`} />
          <span className="chat-pane-title">
            {session.title || "(empty chat)"}
          </span>
          {canFocusOnly && (
            <button
              className="chat-pane-btn"
              onClick={onFocusOnly}
              title="Focus on this chat (close other panes from view)"
              aria-label="Focus only this chat"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M2 6 V2 H6 M14 6 V2 H10 M2 10 V14 H6 M14 10 V14 H10"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
          <button
            className="chat-pane-btn"
            onClick={onMinimize}
            title="Minimize this chat (keeps running in background)"
            aria-label="Minimize this chat"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 11 H13"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}
      <div className="chat-scroller" ref={scrollerRef} onScroll={onScroll}>
        {isEmpty && !session.busy && <Welcome />}
        <div className="chat-list" ref={chatListRef}>
          {session.messages.map((m) => (
            <Message key={m.id} message={m} />
          ))}
          {session.busy && !lastIsAssistant && (
            <div className="msg msg-assistant">
              <div className="msg-header">
                <span className="msg-role">Claude</span>
              </div>
              <div className="msg-body">
                <span className="thinking-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      {session.refreshNotice && (
        <div className="chat-notice">
          <span className="chat-notice-icon">↻</span>
          {session.refreshNotice}
        </div>
      )}
      {session.error && (
        <div className="chat-error">
          {session.error}
          <button onClick={onDismissError}>dismiss</button>
        </div>
      )}
      <SessionActivity session={session} />
      <PromptBar
        busy={session.busy}
        model={session.model}
        onChangeModel={onChangeModel}
        onSend={handleSend}
        onInterrupt={onInterrupt}
      />
    </div>
  );
}
