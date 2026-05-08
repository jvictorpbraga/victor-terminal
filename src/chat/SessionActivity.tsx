// Persistent activity strip that sits between the message list and the prompt
// bar. Its ONLY job is to reassure the user the chat hasn't glitched when
// claude has gone silent but background work is still happening. So the strip
// stays hidden whenever claude is actively streaming — chips only appear when
// the chat would otherwise look frozen.
//
// What it can surface (only when claude is silent for >SILENCE_MS):
//   1. "Still working" pulse while the session is busy.
//   2. ScheduleWakeup countdown.
//   3. Background bash/PowerShell tasks (run_in_background: true) within the
//      first 10 minutes of launch.
//
// At most MAX_CHIPS are shown to avoid spam. The newest activities win.

import { useEffect, useState } from "react";
import type { SessionData, ToolCall } from "./types";

type Indicator =
  | { id: string; kind: "working"; elapsed: number; sortAt: number }
  | { id: string; kind: "wake"; remainingMs: number; sortAt: number }
  | {
      id: string;
      kind: "bg-task";
      toolName: string;
      elapsedMs: number;
      reason?: string;
      sortAt: number;
    };

const BG_TASK_MAX_MS = 10 * 60 * 1000; // hide bg-task chips after 10 min
const SILENCE_MS = 2000;               // claude must be quiet this long
const MAX_CHIPS = 3;                   // cap to avoid screen spam

export default function SessionActivity({ session }: { session: SessionData }) {
  const [now, setNow] = useState(Date.now());

  // Only tick the clock when claude has actually gone silent — this keeps the
  // activity strip dormant during normal streaming and avoids re-rendering
  // every 500ms when there's nothing to show.
  const idleMs =
    session.lastEventAt > 0 ? Date.now() - session.lastEventAt : 0;
  const silentEnough = session.busy && idleMs > SILENCE_MS;
  useEffect(() => {
    if (!silentEnough) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [silentEnough]);

  // Bail before we walk messages — when claude is mid-stream the strip stays
  // hidden entirely, regardless of pending bg-tasks/wakeups.
  if (!silentEnough) return null;

  const indicators: Indicator[] = [];

  // 1. Idle-while-busy pulse
  indicators.push({
    id: "working",
    kind: "working",
    elapsed: Math.floor((now - session.lastEventAt) / 1000),
    sortAt: session.lastEventAt,
  });

  // 2 + 3. Walk message history for outstanding wake/bg-task tools
  for (const m of session.messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.blocks) {
      if (b.kind !== "tool_use") continue;
      const tool = b.tool;

      if (tool.name === "ScheduleWakeup" && tool.startedAt) {
        const delaySeconds = readNumber(tool.input?.delaySeconds);
        if (delaySeconds && delaySeconds > 0) {
          const eta = tool.startedAt + delaySeconds * 1000;
          const remainingMs = eta - now;
          if (remainingMs > 0) {
            indicators.push({
              id: tool.id,
              kind: "wake",
              remainingMs,
              sortAt: tool.startedAt,
            });
          }
        }
      }

      if (
        (tool.name === "Bash" || tool.name === "PowerShell") &&
        tool.input?.run_in_background === true &&
        tool.result !== undefined &&
        tool.startedAt
      ) {
        const elapsedMs = now - tool.startedAt;
        if (elapsedMs < BG_TASK_MAX_MS) {
          indicators.push({
            id: tool.id,
            kind: "bg-task",
            toolName: tool.name,
            elapsedMs,
            reason: bgTaskShortName(tool),
            sortAt: tool.startedAt,
          });
        }
      }
    }
  }

  // Newest first, then cap.
  indicators.sort((a, b) => b.sortAt - a.sortAt);
  const visible = indicators.slice(0, MAX_CHIPS);

  if (visible.length === 0) return null;

  return (
    <div className="session-activity">
      {visible.map((ind) => (
        <span
          key={ind.id}
          className={`session-activity-item session-activity-${ind.kind}`}
        >
          {ind.kind === "working" && <WorkingPill elapsed={ind.elapsed} />}
          {ind.kind === "wake" && <WakePill remainingMs={ind.remainingMs} />}
          {ind.kind === "bg-task" && (
            <BgTaskPill
              toolName={ind.toolName}
              elapsedMs={ind.elapsedMs}
              reason={ind.reason}
            />
          )}
        </span>
      ))}
    </div>
  );
}

function WorkingPill({ elapsed }: { elapsed: number }) {
  return (
    <>
      <span className="activity-dots" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </span>
      <span className="activity-label">working</span>
      <span className="activity-meta">{formatSecs(elapsed)}</span>
    </>
  );
}

function WakePill({ remainingMs }: { remainingMs: number }) {
  return (
    <>
      <span className="activity-icon">⏰</span>
      <span className="activity-label">wakeup in</span>
      <span className="activity-meta activity-countdown">
        {formatRemaining(remainingMs)}
      </span>
    </>
  );
}

function BgTaskPill({
  toolName,
  elapsedMs,
  reason,
}: {
  toolName: string;
  elapsedMs: number;
  reason?: string;
}) {
  const elapsed = Math.floor(elapsedMs / 1000);
  return (
    <>
      <span className="activity-icon">⏵</span>
      <span className="activity-label">
        {toolName.toLowerCase()}
        {reason ? ` · ${reason}` : ""}
      </span>
      <span className="activity-meta">{formatSecs(elapsed)}</span>
    </>
  );
}

function readNumber(v: any): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function formatSecs(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const r = total % 60;
  return `${m}m ${r.toString().padStart(2, "0")}s`;
}

function bgTaskShortName(tool: ToolCall): string | undefined {
  // For Bash, try to surface a short hint about what's running.
  const cmd: string | undefined = tool.input?.command;
  if (!cmd) return undefined;
  const first = cmd.trim().split(/\s+/)[0];
  if (!first) return undefined;
  const trimmed = first.split(/[\\/]/).pop() || first;
  return trimmed.length > 24 ? trimmed.slice(0, 24) + "…" : trimmed;
}

// Re-export for tests if needed
export type { Indicator };
