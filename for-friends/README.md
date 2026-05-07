# Victor Terminal

> A native Windows chat app for Claude Code. Looks like Claude.ai, runs locally,
> with endless context and a real-time action ledger.

![Victor Terminal](icon-preview.png)

---

## What it gives you

- Chat with Claude (Opus / Sonnet / Haiku) in a clean modern UI — no terminal,
  no scroll noise, just messages with markdown, code blocks, expandable
  thinking and tool-use blocks, copy buttons everywhere
- **Endless context.** When the model hits 75% of its context limit, the app
  silently spawns a new claude session in the background, hands it a summary
  of your conversation, and your chat keeps going as if nothing happened
- **Conversation sidebar.** Click the left rail to slide it in. Search by
  title or content across every chat you've had
- **Voice input** with on-the-fly language switching (10 languages)
- **Image paste** (Ctrl+V) and a `+` button for files. Images render as
  thumbnails in the chat
- Live ledger MD file written for every chat — you can open it in any editor
  to see exactly what Claude has done so far
- Custom dark metallic UI with the Vt mark — built specifically for daily
  long-form work

---

## Prerequisites (one-time, per machine)

You need three things before installing Victor Terminal:

### 1. Node.js (for claude-code)

Install Node 20+ from https://nodejs.org if you don't have it already.

### 2. Claude Code CLI

In PowerShell:

```powershell
npm install -g @anthropic-ai/claude-code
```

Verify:

```powershell
claude --version
```

### 3. Authenticate Claude

```powershell
claude auth
```

Follow the prompts to log in with your Anthropic account (Pro / Team / API).
Authentication is stored per-user in `~/.claude/` — Victor Terminal does NOT
bundle anyone else's account.

---

## Install Victor Terminal

1. Run `Victor Terminal_0.1.0_x64-setup.exe` (double-click).
2. The installer is silent / per-user — no admin needed. App lands at
   `%LOCALAPPDATA%\Victor Terminal\victor-terminal.exe`.
3. A desktop shortcut is created automatically.

To uninstall later: open Add or Remove Programs, find "Victor Terminal", click
Uninstall. Or run `%LOCALAPPDATA%\Victor Terminal\uninstall.exe`.

---

## First launch

1. Double-click the desktop shortcut.
2. The window opens to a "How can I help you today?" hero.
3. Type a message (or click the mic to dictate) and hit Enter.
4. Claude responds with streaming text, expandable thinking blocks, and
   collapsible tool calls when it works on files.

---

## Daily use

| Action | How |
|---|---|
| Open conversations sidebar | Click the thin vertical rail on the left edge |
| Search past chats | Type in the search box at the top of the sidebar |
| Resume a past chat | Click any item in the sidebar |
| Start a new chat | "+ New chat" button at the top of the sidebar |
| Switch model | Click `Opus 4.7 ▾` in the prompt bar |
| Attach a file or image | `+` button left of the model picker |
| Paste a screenshot | Ctrl+V into the message box |
| Voice dictation | Click the mic button (right of the textarea) |
| Change voice language | Hover the mic, then click `EN ▾` in the popover |
| Copy a message | "Copy" button top-right of any assistant bubble |
| Copy just a code block | Hover any code block, "Copy" button appears top-right |

---

## Where things live on your disk

| Path | What |
|---|---|
| `%LOCALAPPDATA%\Victor Terminal\` | Installed app |
| `~\.claude\` | Claude auth + per-cwd session JSONLs (managed by claude CLI) |
| `~\Desktop\claude-terminal\sessions\<session-id>.md` | Live ledger of each chat — the human-readable narrative the app writes as Claude works |

---

## Permissions and safety

Victor Terminal launches Claude with `--dangerously-skip-permissions`. This
means Claude can run any tool (Bash, Edit, Write, WebFetch, Task, etc.)
without confirmation prompts. It runs as your user — same privileges you have.

This is intentional for a daily-driver assistant. If you want stricter behavior,
run claude-code directly from a regular terminal instead, where each tool use
prompts.

---

## Endless context: the 75% restart

When a chat reaches 75% of the model's context window AND has been idle for at
least 5 seconds, the app:

1. Reads the running ledger MD for that session
2. Spawns a new claude with the last ~18KB of ledger as a system prompt and a
   pointer to the full ledger file
3. Kills the old subprocess
4. Shows a brief **"↻ Context refreshed in the background"** banner

Your chat view doesn't change. The next message you send goes to the fresh
claude, which has the conversation summary baked in.

If Claude needs older context than the inlined tail, it can `Read` the ledger
file at the path mentioned in its system prompt.

---

## Troubleshooting

**"claude not found" / app stuck on welcome**
Make sure `claude --version` works in PowerShell. Re-run `npm install -g @anthropic-ai/claude-code` if needed.

**Window won't drag, buttons don't click**
That was a bug in older builds — fixed in 0.1.0. If you see it: check
`%LOCALAPPDATA%\Victor Terminal\victor-terminal.exe` is the v0.1.0 binary.

**Voice button errors**
The Web Speech API uses Microsoft Speech under the hood on Windows. Open
Windows Settings → Time & language → Speech and make sure the language pack
for whichever code you've selected (EN, PT, etc.) is installed.

**Cursor inside the prompt area is a square block**
Old issue with claude's TUI rendering in xterm. Fixed by Victor Terminal v0.1.0
(we don't use xterm anymore).

**Sidebar shows the same chat multiple times**
Known limitation. Each 75%-restart creates a new internal session. Click the
most-recent entry to resume from where you left off.

---

## Credits

Built with Tauri 2 + React 19 + xterm.js (legacy mode, removed in 0.1.0) +
react-markdown.

Branding: **Victor Braga**.
