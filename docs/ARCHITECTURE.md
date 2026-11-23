# Architecture

```
                         ┌──────────────────────── Electron (desktop/main.js) ────────────────────────┐
 you ── mic/speaker ───► │  web page (web/*): sprite cat, bubble, panel, voice client                │
                         └──────┬──────────────────────────────┬────────────────────────────┬────────┘
                                │ SSE /api/events (moods,      │ WS /api/gemini-live          │ WebRTC (OpenAI only)
                                │ narration, diffs)            │ (Gemini audio + events)      ▼
                                │ POST /api/tool/* (UI)        │                       api.openai.com
                         ┌──────▼──────────────────────────────▼────────────┐
                         │  bridge (Bun, 127.0.0.1:8787, bridge/*)          │──── wss ───► Gemini Live
                         │  state · narrator · tools · gemini proxy         │
                         └──────┬───────────────────────────────┬───────────┘
            Claude Code mode    │                               │   opencode mode
   hooks: bin/cadbury-hook ──POST─┤                               ├── HTTP + SSE /global/event
   voice: tmux send-keys ───────┘                               └── opencode serve :4096
                ▼                                                        ▲
   claude (TUI) in `tmux -L cadbury` pane  ◄── user types here too    opencode attach (TUI)
```

## Components

**`bin/cadbury` (launcher)**
1. Loads `.env`, picks the harness (`CADBURY_HARNESS`, `--opencode`, `--claude`) and folder.
2. If the bridge isn't answering on `CADBURY_PORT`, it starts Electron in its own process group (under XWayland on Linux). Electron then starts the bridge.
3. Writes `~/.cache/cadbury/claude-hooks.json`, which wires every hook event to `bin/cadbury-hook <Event>`.
4. **Claude:** creates a detached session on a private tmux server, `tmux -L cadbury new-session … claude --settings <hooks>`, and registers the pane with `POST /api/context {directory, harness, tmux, tmuxSocket}`. Then it attaches. Inside an existing tmux it uses `$TMUX_PANE` instead.
5. **opencode:** registers, then runs `opencode attach http://127.0.0.1:4096 --dir …`.
6. When the TUI exits, it kills the pet's process group, but only if this launcher started the pet.

**Electron (`desktop/main.js`)**: a frameless, transparent, always-on-top window, single instance. It:
- loads `http://127.0.0.1:8787/`;
- streams the cursor position (for the cat's gaze);
- owns the right-click menu, the pet size (zoom factor plus window bounds, saved in prefs) and notifications;
- spawns the bridge if needed.

**Bridge (`bridge/`)**: the only process with API keys. It:
- tracks `state` (harness, directory, session, busy, mood, current step, todos, pending permission or question, language);
- turns agent events into **moods** and **narration**, fanned out over SSE;
- executes **voice tools** for both providers;
- proxies Gemini Live.

**Web page (`web/`)**: renders the pet (`sprite.js`), shows the bubble and panel, runs the voice client, and handles interaction. With no `window.cadbury` preload, as in a phone browser at `/remote`, it switches to a full-screen remote layout.

## Lifecycle of one spoken request (Claude Code + Gemini)
1. You speak. `voice-gemini.js` captures 16 kHz PCM (AudioWorklet) and sends `realtimeInput.audio` over WS to the bridge, which forwards it to Gemini.
2. Gemini decides to call `code_task({instruction})`. The bridge runs `runTool()`, which calls `claudeTools.code_task`, which runs `tmux send-keys -l <text>` then `Enter` in Claude's pane.
3. Claude Code fires `UserPromptSubmit` → `cadbury-hook` → `/api/claude-hook`. The bridge sets `busy` and mood `thinking`.
4. `PreToolUse` sets mood `working` with a status like "editing login.tsx", plus a throttled progress narration (at most one every 25 s).
5. `PermissionRequest` / `Notification(permission_prompt)` sets mood `asking` and an **urgent** narration: "[system] Claude Code needs permission… ask the user". The cat asks you; your answer becomes `answer_permission`, which sends `1` (once), `2` (always) or Esc (+ your correction).
6. `Stop`: the bridge reads `last_assistant_message` (falling back to the transcript JSONL) plus `git diff` → mood `happy`, a diff event to the panel, and an urgent narration "[system] Claude Code finished… final message…".
7. The page injects narrations into the voice session as `realtimeInput.text`, only at a quiet moment (not while the cat is talking or you are). The cat speaks a short summary in your language.
8. Along the way, memory records the conversation:
   - Each finished line, yours and the cat's, goes to `/api/memory/turn`.
   - The `code_task` instruction and Claude's final message go into the diary too.
   - Every 10 of your turns, or after 5 quiet minutes, the background review (if configured) looks for facts worth keeping.

opencode mode is the same, except steps 2–6 use opencode's HTTP API (`prompt_async`, `/permission/:id/reply`, `/question/:id/reply`, `/session/:id/abort`, `/session/:id/diff`) and its `/global/event` SSE stream instead of hooks and tmux.

## State the bridge keeps (state.ts)
`harness`, `directory`, `sessionID`, `busy`, `mood` / `status`, `currentTool`, `todos`, `activity[]` (last 30), `lastText`, `pendingPermission`, `pendingQuestion`, `language`, `tmuxTarget` / `tmuxSocket`, `transcriptPath`, `hadError`. It all lives in memory; only `scale` and `language` persist (`~/.config/cadbury/prefs.json`).

## Long-term memory (bridge/memory/)
Separately from `state`, the bridge keeps a long-term memory in `~/.config/cadbury/memory/`:
- three small plain-text notebooks (about the user, about each project, the cat's own notes);
- a SQLite conversation diary.

The notebooks go into `instructions()` once per voice session. The voice model edits them with the `memory` tool and searches the diary with `session_search`. An optional small local model reviews conversations in the background and may only add. Full explanation: [MEMORY.md](MEMORY.md) (for users) and [MEMORY-DESIGN.md](MEMORY-DESIGN.md) (how it's built).

## Voice providers
- **Gemini Live (default):** the page talks WS to the bridge, which talks WS to Gemini. The bridge sends `setup` (model, voice, persona, tools, VAD config, transcription, context compression, session resumption), runs tool calls itself, and handles `goAway`, inactivity, resumption, "already connected" and rate limits (see GOTCHAS).
- **OpenAI Realtime:** the page fetches an ephemeral key from `/api/realtime-token` and connects with WebRTC directly. Tool calls arrive on the data channel and the page POSTs them to `/api/tool/:name`.

Both use the same persona (`instructions()`) and tool schemas (`toolSchemas`).

## Pet rendering
`sprite.js` plays a Codex v2 pet sheet: an 8×11 grid of 192×208 frames.
- **Rows:** idle, run-right, run-left, wave, jump, failed, waiting, working, review, and look directions.
- **Look directions:** rows 9–10 are 16 compass headings (0° = up, clockwise) used to follow the cursor.
- **Moods** map to animations (`MOOD_ANIM`). **Antics** (`ANTIC_ANIM`) are random idle behaviours chosen in `app.js`, combined with whole-sprite CSS transforms (`.antic-*`).
