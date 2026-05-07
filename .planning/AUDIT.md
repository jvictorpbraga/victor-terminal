# Victor Terminal — Audit (2026-05-07)

Honest audit against the four user requirements before shipping the v0.1.0 distribution.

---

## ✅ 1. Full permissions to make changes / install things

**Status: YES — full host access.**

How:
- `claude_session.rs` spawns claude with `--dangerously-skip-permissions`, which bypasses every tool-permission confirmation prompt. Claude can `Bash`, `Edit`, `Write`, `WebFetch`, etc. without asking.
- The cwd is `%USERPROFILE%` (the user's home directory) by default. From there claude can `cd` anywhere and use Bash to install software, modify files, run admin tools — the OS's normal user-level permissions apply, no app-level restriction.
- This is intentional — the whole point is for claude to be able to do real work without click-through. Friends installing this should understand that claude inside Victor Terminal has the same privileges as themselves.

**Mitigation worth knowing:** If a friend wants more restraint, they can edit `src-tauri/src/claude_session.rs` and remove `--dangerously-skip-permissions`. Then claude will prompt before each tool use (and the prompts will need a UI; not yet wired).

---

## ✅ 2. Background MD ledger of every action

**Status: YES — every chat is mirrored to a markdown ledger continuously.**

How:
- `src-tauri/src/ledger_watcher.rs` spawns a thread on app startup that polls every 3 seconds.
- Each tick: finds the most-recently-modified JSONL in `~/.claude/projects/*/`, then appends only NEW lines (tracked by byte offset per session) to `Desktop/claude-terminal/sessions/<session-id>.md`.
- Per JSONL entry the watcher writes:
  - `[HH:MM:SS]` **user** — message text
  - `[HH:MM:SS]` 🔧 `ToolName` — input summary
  -   ↳ ✓/✗ tool result snippet (~90 chars)
  - `[HH:MM:SS]` **claude** — response text
  - `[HH:MM:SS]` 💭 *(thinking)*
- System reminders, IDE-selection tags, and prompt-injection-shaped strings are filtered out so the narrative stays human-readable.
- File grows continuously while a chat is active. Open it any time to see the running play-by-play.

The MD captures *what happened*. It is not a verbatim transcript — it's a structured action log designed so a fresh claude can read it via the Read tool and reconstruct context.

---

## ✅ 3. Auto-rereads ledger + restarts at 75% in background, no UI interruption

**Status: YES — implemented and live.**

How:
- `src-tauri/src/monitor.rs` polls active session usage every 3s, emits a `session-usage` Tauri event with `used_pct`.
- `src/chat/Chat.tsx` keeps a `setInterval` (1.5s tick) that checks: `usage ≥ 75% AND idle ≥ 5s AND this session_id hasn't been refreshed yet`.
- When the trigger fires:
  1. `read_session_ledger(session_id)` reads `Desktop/claude-terminal/sessions/<id>.md`
  2. Tail (last ~18KB) is inlined into a system-prompt note explaining the restart and pointing at the full ledger path
  3. `claude_start({ append_system_prompt: note })` is called — the existing claude-code subprocess is killed and a fresh one is spawned with the ledger context preloaded
  4. A small **"↻ Context refreshed in the background"** banner shows for 3.5s then fades
- The chat React state is **not** reset. All previously-rendered user/assistant bubbles stay visible. The user keeps typing; the next message goes to the new claude.

**What "no impact on workflow" means in practice:**
- ✅ Chat scroll position not lost
- ✅ Visible message history not lost
- ✅ User can keep typing while restart happens (will be sent to the new claude)
- ✅ Streaming response that's mid-flight is allowed to finish before restart fires (idle detection waits 5s)
- ✅ Banner is non-blocking, fades out

**What new claude knows:**
- Last ~18KB of ledger inline in its system prompt → recent actions, recent files touched, last few messages
- Pointer to `sessions/<id>.md` — can `Read` the full file for older context

**What new claude does NOT have:**
- Full message history in working memory (would defeat the compaction)
- Original tool-state in claude-code's internal buffer

This means: a restart is functionally similar to running `/compact` — recent context is preserved, deep history requires explicit Read.

---

## ⚠ 4. Endless chats / single conversation

**Status: PARTIAL — chat view is endless, sidebar is not yet merged.**

What works:
- ✅ The visible chat surface in the app **never resets**. Messages from before and after a 75% restart appear continuously in the same scroll list.
- ✅ User can keep typing forever — each restart-cycle gives a fresh context window with the ledger summary attached.

What's missing:
- ❌ **Sidebar duplication.** Each internal restart creates a new claude-code session with a new session ID, so the sidebar's "past conversations" list grows with one new entry per restart, even though the visible chat is the same logical thread.
- This is documented as a Phase 4.1 follow-up — would need a "logical conversation" manifest that maps one user-facing conversation to multiple internal session IDs.

**Practical impact for friends:** if a chat refreshes 5 times during one long session, the sidebar will show 5 entries for it. Clicking any of them resumes from that internal session's saved state (so the latest is the most useful one). Older internal sessions can be deleted manually from `~/.claude/projects/<dir>/` if the list gets noisy.

---

## Distribution checklist

To ship to friends:
- ✅ Hardcoded user path removed from Chat.tsx — replaced with `get_sessions_dir()` Tauri command that resolves at runtime per user
- ✅ All other paths use `%USERPROFILE%` env or relative resolution
- ✅ Branding ("Victor Terminal", "Victor Braga", metallic Vt icon) is intentional product identity, not personal credentials
- ✅ Auth: claude-code CLI handles auth per-user via `~/.claude/`. Friends run `claude auth` once on their machine before launching. No Anthropic account info is bundled in the installer.
- ✅ Window controls, drag, sidebar, search, voice, attachments, auto-refresh — all working
- ⚠ Friend prerequisites: must install claude-code CLI separately (`npm install -g @anthropic-ai/claude-code` or equivalent) and authenticate. Documented in dist/README.md.
