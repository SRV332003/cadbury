# Gotchas (hard-won lessons)

Each of these cost real debugging time. Check here before "simplifying" something that looks odd.

## Desktop window (Electron on Linux)
- **Wayland ignores always-on-top for native Wayland windows** (GNOME at least), so Cadbury runs Electron under **XWayland**.
- **`--ozone-platform=x11` must be on Electron's command line**, along with `ELECTRON_OZONE_PLATFORM_HINT=x11`. Calling `app.commandLine.appendSwitch` from `main.js` is too late: the browser process comes up on Wayland while the GPU and renderer use X11. The window then exists but is never painted. Symptoms: `XGetWindowAttributes failed for window 1` and `capturePage()` → `UnknownVizError`.
- **Don't call `app.disableHardwareAcceleration()`.** The software output path paints nothing into transparent XWayland windows (an invisible cat). It's opt-in via `CADBURY_SOFTWARE=1`.
- **Linux transparent windows need a short delay** before creation (`setTimeout(createWindow, 400)`) and `show: false` + `ready-to-show`.
- **`globalShortcut` doesn't work on Wayland**, because apps can't grab keys. Use an OS shortcut that runs `bin/cadbury-talk` (→ `/api/hotkey` → SSE `hotkey`).
- **Harmless startup noise** to ignore: `Gtk: gtk_widget_get_scale_factor: assertion …`. The launcher passes `--log-level=3`.
- **The pet size uses `webContents.setZoomFactor`**, so cursor positions (screen px) must be scaled by `zoom` before comparing with page coordinates (`onCursor` in app.js).

## Gemini Live
- **Inactivity hang-up:** with no client input for about 2 minutes (e.g. the cat is muted), Gemini closes with `1008 Session closed due to client inactivity`. Don't treat that as an error. The proxy goes **dormant** and reconnects with the resumption handle on the next audio or text. It buffers about 4 s of mic audio so your first words aren't lost.
- **`goAway` arrives about every 10 min.** Finish the current answer, then hop to a new connection with the handle. Hopping immediately cuts the cat off mid-sentence.
- **"BidiGenerateContent session is already connected to an existing client" (1008):** resuming a handle while the old upstream still holds it. Close the previous owner first and wait for its close (`releaseOwner()`). After 2 failures, start a fresh conversation.
- **Free-tier rate limit:** `1011 Resource has been exhausted` is per minute and transient. Back off (10 s, 20 s, …) and tell the user; don't treat it as fatal. Only key, billing and permission errors are fatal.
- **The resume handle lives at module level** (`lastHandle`, ~2 h TTL), so a page reload or reconnect keeps the conversation memory.
- **Tool schemas:** Gemini wants upper-case OpenAPI types (`OBJECT`, `STRING`) and no empty `parameters` object for no-arg functions. Tool responses must be objects.
- **Use `realtimeInput.text` (not `clientContent`)** for text mid-session. It works on both the 2.5 and 3.x Live models.
- **The Bun WebSocket server defaults to `idleTimeout: 120`**, which silently closes a muted page's socket. The proxy sets `idleTimeout: 960` and `sendPings`, and the page pings every 15 s.

## Barge-in (interrupting the cat)
- **Gemini generates audio much faster than real time.** A whole reply can be queued on the client while Gemini already considers the turn complete, so it never sends `interrupted` and the cat keeps talking over you.
- **The fix is client-side barge-in** in `voice-gemini.js`: about 200 ms of mic RMS above `CADBURY_BARGE_THRESHOLD` (0.06) while playing → stop all sources, and set `skipTurn` if the turn is still generating, so late chunks of the old reply are dropped. Mic audio keeps flowing so Gemini hears you. Browser echo cancellation keeps the cat's own voice out of the mic.
- **`realtimeInputConfig`:** `START_SENSITIVITY_HIGH` (notice interruptions quickly) and `END_SENSITIVITY_LOW` + `silenceDurationMs` 800 (don't jump in during pauses).

## Voice behaviour (persona in realtime.ts)
- **[system] messages are in English, so the model drifted to English** even when the user wanted Hindi or Hinglish. Fix: `narrate()` appends a language reminder to every message, and the language rule comes **first** in the persona. `set_language` persists the choice.
- **"Hinglish" must be described** (a casual mix, technical terms in English), or the model speaks pure Hindi.
- **Clarifying questions:** the model over-asks unless told precisely when to ask (vague goal, or destructive action) and when not to (clear request, sensible default, the agent can investigate).

## Claude Code
- **Hooks come from `--settings <file>`, not the user's settings.json**, so normal `claude` sessions are untouched.
- **`cadbury-hook` must exit 0 fast.** A blocking or failing hook would affect the user's real session.
- **Voice input goes through tmux `send-keys`.** There's no API to inject into an interactive Claude Code session. Use `-l` (literal) and send `Enter` separately; collapse newlines.
- **Permission prompt keys:** `1` = yes, `2` = yes and don't ask again, Esc = no. If Claude Code changes its prompt UI, update `claudeTools.answer_permission`.
- **Subscriptions:** don't try to use a Claude subscription in third-party harnesses (Anthropic's terms forbid OAuth reuse). Driving the official `claude` CLI is the supported path.

## opencode
- **`/event` is per-directory; `/global/event` covers all** and wraps events as `{directory, payload}`.
- **The bridge follows the session the user last typed into** (`message.updated` role=user in a root session) and calls `/tui/select-session` when voice creates one, so the TUI shows it.

## Testing / sandbox
- **No display in the agent sandbox:** Electron can't open windows. Use **headless Chrome** against the bridge (`?mood=` / `?antic=` freeze the cat) for screenshots.
- **`pkill -f "bun bridge/index.ts"` matches your own shell command line** and kills it. Kill by port: `ss -ltnp | grep :8799`.
