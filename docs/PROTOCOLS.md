# Protocols & interfaces

## Bridge HTTP API (`127.0.0.1:${CADBURY_PORT:-8787}`)
| Route | Method | Purpose |
|---|---|---|
| `/` , `/remote` | GET | the pet page (`/remote` = phone layout) |
| `/voice-config.js` | GET | `window.CADBURY_VOICE = {provider, halfDuplex, bargeThreshold}` |
| `/api/health` | GET | liveness (`bin/cadbury` polls this) |
| `/api/state` | GET | mood, status, directory, harness, session, busy, recent activity |
| `/api/context` | POST | `{directory, harness: "claude"\|"opencode", tmux?: paneId, tmuxSocket?: path}`: called by `bin/cadbury` on every launch |
| `/api/claude-hook?event=<HookEvent>` | POST | raw Claude Code hook JSON (from `bin/cadbury-hook`) |
| `/api/tool/:name` | POST | run a voice tool with a JSON args body (OpenAI path and UI buttons) |
| `/api/realtime-token` | POST | OpenAI ephemeral client secret `{value, model}` |
| `/api/hotkey` | POST | toggle the mic (`bin/cadbury-talk`) |
| `/api/events` | GET (SSE) | UI event stream (below) |
| `/api/gemini-live` | WS | Gemini Live proxy (below) |
| `/api/memory/turn` | POST | `{role: "user"\|"cat", text}`: the page reports each finished spoken line to the conversation diary ([MEMORY-DESIGN.md](MEMORY-DESIGN.md)) |
| `/api/memory` | GET | everything memory holds right now: the three notebooks with usage, pending suggestions, recent sessions, review model |
| `/api/memory/pending` | POST | `{id, approve: true\|false}`: accept or reject a change suggested by the background review |

If a request carries a `Tailscale-User-Login` header (i.e. it came through `tailscale serve`) and `ALLOWED_TS_USER` is set, that login must match.

## UI events (SSE `/api/events`, `data: <json>`)
```ts
{ type: "mood", mood, status }                 // mood ∈ idle listening talking thinking working asking happy oops sleeping
{ type: "activity", text }                     // feed line, e.g. "editing login.tsx"
{ type: "narrate", text, speak, urgent? }      // [system] message for the voice model; the page injects it at a quiet moment
{ type: "diff", files: [{file, additions, deletions, status, patch?}] }
{ type: "context", directory, sessionID?, title? }
{ type: "hotkey" }
```
`listening` and `talking` are also set locally by the voice client (overlay moods).

## Claude Code hooks → cat
`bin/cadbury` passes `--settings ~/.cache/cadbury/claude-hooks.json`, which wires each event to `bin/cadbury-hook <Event>` (timeout 5 s, always exit 0).

| Hook | Fields used | Effect |
|---|---|---|
| `SessionStart` | `session_id`, `cwd` | follow this session; mood idle |
| `UserPromptSubmit` | `prompt` | busy; mood thinking; activity line |
| `PreToolUse` | `tool_name`, `tool_input` | mood working + status (`describe()`); `TodoWrite` → todos; `AskUserQuestion` → asking + question narration |
| `PermissionRequest` | `tool_name`, `tool_input` | mood asking + urgent "needs permission" narration |
| `Notification` | `notification_type`, `message` | `permission_prompt` → same as above |
| `PostToolUse` | n/a | clears a pending permission or question; back to working |
| `Stop` | `last_assistant_message`, `cwd` | not busy; `git diff HEAD` + untracked → diff event; mood happy; urgent "finished" narration |
| `SessionEnd` | n/a | idle |

Payloads carry `session_id`, `transcript_path`, `cwd` and `hook_event_name` (verified against Claude Code 2.1.x). If `last_assistant_message` is missing, the bridge reads the transcript JSONL backwards to the last user prompt.

**Driving Claude (claude.ts):** `tmux -S <socket> send-keys -t <pane> -l -- "<text>"`, then `Enter`. Newlines are collapsed to spaces.

| Voice tool | Keys sent to Claude's pane |
|---|---|
| permission: once / always | `1` / `2` |
| permission: reject | `Escape`, then the user's correction typed as a message |
| stop | `Escape` |
| new session | `/clear` |
| resume | `/resume` |
| question | option number, or free text |

## opencode (opencode.ts / state.ts / tools.ts)
- **REST:**
  - `POST /session`
  - `POST /session/:id/prompt_async {parts:[{type:"text",text}]}`
  - `POST /session/:id/abort`
  - `GET /session/:id/diff`
  - `GET /session/:id/message`
  - `POST /permission/:id/reply {reply: once|always|reject, message?}`
  - `POST /question/:id/reply {answers: string[][]}`
  - `POST /tui/select-session` (so the attached TUI shows voice-created sessions)
  - Most routes take `?directory=`.
- **Events:** `GET /global/event` (SSE, `{directory, payload:{type, properties}}`). The ones used are `session.status` (busy/idle/retry), `session.idle`, `message.part.updated` (tool/text parts), `todo.updated`, `permission.asked` / `.replied`, `question.asked` / `.replied`, `session.error`, `message.updated` (follow the session the user typed into), and `session.created` / `.updated` (parent tracking).
- The full OpenAPI spec is at `http://127.0.0.1:4096/doc`.

## Voice tools (`toolSchemas` in tools.ts)
`code_task(instruction)`, `task_status()`, `stop_task()`, `answer_permission(reply, message?)`, `answer_question(answers)`, `show_diff()`, `set_language(language)`, `list_projects()`, `switch_project(name)`, `new_session()`, `list_sessions()`, `resume_session(id)`.

`runTool(name, args)` uses `claudeTools[name]` in Claude mode when it exists, otherwise the opencode / generic `tools[name]`. Results must be JSON objects (the Gemini proxy wraps arrays and primitives in `{result}`).

### Memory tools (same for both harnesses, `bridge/memory/schemas.ts`)
| Tool | Arguments | What it does |
|---|---|---|
| `memory` | `target: "user"\|"project"\|"memory"`, `operations: [{action: "add"\|"patch"\|"remove"\|"clear", content?, old_text?}]` | Changes a notebook. The batch is all-or-nothing, and the size limit is checked on the final result. `old_text` is a short quote; matching is forgiving, and a miss returns the closest entries. After 3 failed calls in a row the tool says to stop retrying. |
| `session_search` | `mode: "search"\|"recent"\|"session"`, `query?`, `session_id?`, `limit?` | Searches the conversation diary. The result comes as text inside `<memory-context>…</memory-context>`, marked as past data, not instructions. |
| `memory_pending` | `action: "list"\|"approve"\|"reject"`, `id?` | Changes the background review suggested, waiting for the user's OK. |

The background review calls `memory` too, but only to add. Its patch and remove operations are staged in `pending.json`. Every `code_task` instruction and the coding agent's final message are also logged to the diary, as `task` and `agent` lines.

## Narration convention
Messages to the voice model start with `[system]` and say what to do, for example "Ask the user whether to allow it once, always, or reject. Then call answer_permission." `narrate()` appends `(Reply in <language>, even though this message is in English.)`. Throttled progress narrations say "only mention if natural". Urgent ones (permission, question, finished, error) are spoken at the next quiet moment.

## Gemini Live proxy (gemini.ts)
- **Page → bridge:** Gemini client messages as-is (`realtimeInput.audio`, `realtimeInput.text`), plus `{"cadbury":"ping"}` every 15 s.
- **Bridge → page:**
  - Gemini server messages as-is (`serverContent`, `toolCall`), plus control messages:
    - `{cadbury:"ready", model, resumed}`
    - `{cadbury:"reconnecting", attempt}`
    - `{cadbury:"rate-limited", wait}`
    - `{cadbury:"error", message}`
    - `{cadbury:"pong"}`
  - `setupComplete`, `sessionResumptionUpdate`, `goAway` and `toolCall` execution are handled in the bridge. `toolCall` is also forwarded so the UI can show it.
- **Upstream:** `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` with header `x-goog-api-key`. The setup includes:
  - `responseModalities:["AUDIO"]`, `speechConfig.voiceConfig`, `systemInstruction`;
  - `tools.functionDeclarations` (upper-case OpenAPI types, no empty `parameters`);
  - `input/outputAudioTranscription`, `contextWindowCompression.slidingWindow`, `sessionResumption{handle?}`;
  - `realtimeInputConfig.automaticActivityDetection` (high start sensitivity, low end sensitivity, `silenceDurationMs`).
- **Audio formats:** mic is 16 kHz s16le mono (`audio/pcm;rate=16000`); output is 24 kHz s16le.
