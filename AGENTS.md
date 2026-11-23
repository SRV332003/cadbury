# AGENTS.md: working on Cadbury

Cadbury is a floating voice pet (an Electron window) that sits on top of a coding agent (**Claude Code** or **opencode**). The user talks to the cat. The cat turns speech into instructions for the agent, watches what the agent does, and speaks back.

Read these before changing things:
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, data flow, and the lifecycle of one spoken request
- [`docs/PROTOCOLS.md`](docs/PROTOCOLS.md): bridge HTTP/SSE/WS API, Claude Code hook mapping, opencode events, voice tools, `[system]` narration
- [`docs/GOTCHAS.md`](docs/GOTCHAS.md): hard-won lessons (Wayland, Gemini quirks, barge-in, tmux…). **Read before touching the desktop window or the voice code.**
- [`docs/TESTING.md`](docs/TESTING.md): how to test everything without a screen, mic or real agent

## Map
```
bin/cadbury         launcher: starts the pet (if not running), registers folder/harness, runs claude-in-tmux or opencode attach
bin/cadbury-hook    Claude Code hook → POST /api/claude-hook (must never block or fail)
bin/cadbury-talk    toggle the mic (for OS keyboard shortcuts on Wayland)
bin/mochi*          legacy names from before the rename; thin wrappers, keep them so old links/shortcuts/sessions work
install.sh          requirement checks, Electron, .env, ~/.local/bin/cadbury
bridge/             Bun server on 127.0.0.1:8787, the brain
  index.ts          routes; starts opencode only when needed
  env.ts            imported first: maps legacy MOCHI_* settings to CADBURY_*
  state.ts          shared state, moods, narration (+ language rule), prefs, opencode event → mood
  claude.ts         Claude Code: hooks → moods/narration; tools via tmux send-keys; git diff
  opencode.ts       opencode HTTP client + /global/event SSE
  tools.ts          voice tool schemas + opencode implementations + runTool() dispatcher
  realtime.ts       persona/instructions (shared) + OpenAI ephemeral token
  gemini.ts         Gemini Live WebSocket proxy (holds key, resumption, goAway, retries, tool execution)
desktop/            Electron shell: transparent always-on-top window, menu, size, cursor stream
web/                the pet page (also served at /remote for phones)
  app.js            glue: SSE → mood/bubble, antics, drag/menu, petting, debug ?mood= / ?antic=
  sprite.js         Codex-v2 sprite sheet player (moods, antics, 16-direction look-at-cursor)
  voice.js          OpenAI Realtime (WebRTC)
  voice-gemini.js   Gemini Live client (16k mic worklet, 24k playback, local barge-in)
  pets/maodie/      CC BY 4.0 artwork (keep attribution)
```

## Rules of thumb
- **Runtimes:** the bridge is **Bun + TypeScript** with no build step and no npm deps. The web page is plain browser JS with no bundler. Electron main is CommonJS.
- **No secrets in git:** never commit `.env`. Keys are read only by the bridge; the page never sees the Gemini key.
- **Hooks are fire-and-forget:** `cadbury-hook` must always exit 0 quickly. A slow or failing hook would slow down or break the user's Claude session.
- **Two harnesses, one interface:** voice tools are defined once (`toolSchemas` in `tools.ts`). `runTool()` picks `claudeTools[name]` (claude.ts) when `state.harness === "claude"`, otherwise `tools[name]`. Add new tools in both places, or make them generic in `tools.ts`.
- **All narration goes through `narrate()`** in state.ts. It appends the language rule. Messages start with `[system]` and are written for the voice model, not the user.
- **Moods are a fixed set:** `idle listening talking thinking working asking happy oops sleeping`. `sprite.js` maps each to an animation; if you add one, update `MOOD_ANIM` and the CSS fx.
- **Keep the persona short:** it's in `instructions()` in `realtime.ts` and shared by both voice providers. Behavioural fixes (language, clarifying questions, interruptions) belong there.
- **User-specific values** belong in `.env` / `.env.example` or `~/.config/cadbury/prefs.json`, never hard-coded.

## Checks before you finish
```bash
bun run check            # bridge compiles + all JS parses
```
For behaviour changes, use the recipes in `docs/TESTING.md`: a test bridge on port 8799, simulated hooks, a fake tmux pane, a Gemini test client, headless Chrome screenshots of `?mood=` / `?antic=`. Don't run tests against the user's live bridge on 8787.
