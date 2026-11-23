# 🐱 Cadbury

**A floating voice pet for your coding agent.** Run `cadbury` in a project: your coding agent ([Claude Code](https://claude.com/claude-code) or [opencode](https://opencode.ai)) opens in the terminal, and a little cat pops up on your desktop. Talk to the cat and it drives the agent. The cat shows what the agent is doing, asks you out loud when the agent needs a decision, and tells you what changed when it's done.

```
┌──────────── terminal ────────────┐        ┌───── desktop ─────┐
│ $ cadbury                          │        │   "Done! I added  │
│ ╭─ Claude Code ───────────────╮  │  ◄──►  │    the login page │
│ │ > add a login page          │  │  voice │    and 2 tests."  │
│ │ ● Editing src/login.tsx …   │  │        │        🐱         │
│ ╰─────────────────────────────╯  │        └───────────────────┘
└──────────────────────────────────┘
```

- 🎙 **Hands-free voice.** You can interrupt it mid-sentence. It answers in your language and keeps it (say "talk to me in Hindi" and it sticks).
- 🛠 **Real harness power.** Everything goes through your actual Claude Code or opencode session: same tools, MCP servers, permissions and `CLAUDE.md`/`AGENTS.md`. Typing in the terminal works as usual, and the cat narrates that too.
- 🐾 **A pet with moods.** Idle, listening, talking, thinking, working, asking, happy, oops, sleeping, plus random antics (zoomies, flops, begging…). Its head follows your mouse, and hovering over it counts as petting.
- 🔐 **Uses your Claude subscription legitimately.** Cadbury drives the official `claude` CLI; it never touches your credentials.
- 💸 **Free voice option.** Gemini Live has a free tier. OpenAI Realtime is also supported.
- 📱 **Optional phone remote** over Tailscale.

## Requirements

| | |
|---|---|
| [Bun](https://bun.sh) ≥ 1.1 | runs the bridge |
| [Claude Code](https://claude.com/claude-code) **+ tmux**, or [opencode](https://opencode.ai) | the coding agent |
| A voice key | free [Gemini API key](https://aistudio.google.com/apikey) (recommended) or an OpenAI key with Realtime access |
| Linux (X11 or Wayland) or macOS | developed and tested on Linux (GNOME/Wayland); macOS should work but is less tested; Windows is not supported yet |

Electron is installed automatically, or uses a system `electron` if you have one.

## Install

```bash
git clone https://github.com/thekamalkashyap/cadbury.git cadbury
cd cadbury
./install.sh            # checks requirements, installs Electron, creates .env, links ~/.local/bin/cadbury
$EDITOR .env            # set GEMINI_API_KEY (or VOICE_PROVIDER=openai + OPENAI_API_KEY)
```

## Use

```bash
cd ~/code/my-app
cadbury                   # Claude Code + the cat
cadbury --opencode        # opencode + the cat
cadbury path/to/project   # start in another folder; extra args go to claude, e.g. `cadbury --continue`
```

| Do this | What happens |
|---|---|
| **Click** the cat | start talking (then click again to mute or unmute) |
| **Drag** it | move it anywhere |
| **Double-click** it | activity, transcript and diff panel; you can type to the cat there too |
| **Right-click** it | menu: stop task, new session, show changes, size, project (opencode), quit |
| **Hover** over it | pet the cat 🐾 |

Things to say: *"add a dark-mode toggle to settings"*, *"why is the login test failing?"*, *"what are you doing?"*, *"stop"*, *"show me the changes"*, *"yes, allow it"* / *"always allow"* / *"no, use pnpm instead"*, *"talk to me in Hindi"*.

The cat asks a clarifying question only when it really matters: a vague goal ("make it faster") or something destructive (deleting data, force-pushing). Clear requests and "why…" questions go straight to the agent.

### How it works with Claude Code
`cadbury` starts the real `claude` CLI inside a private tmux session (`tmux -L cadbury`, status bar hidden, so it looks like a normal terminal). [Hooks](https://docs.claude.com/en/docs/claude-code/hooks), passed only to this session with `--settings`, tell the cat what Claude is doing. When you speak, the cat types into Claude. Permission answers are `1`, `2` or Esc, and "stop" is Esc. Your other `claude` sessions are untouched. If you're already inside tmux, Cadbury uses your current pane.
Detach with `Ctrl-b d`; reattach with `tmux -L cadbury attach`.

### Upgrading from Mochi
Cadbury used to be called Mochi. Old setups keep working: `mochi`, `bin/mochi-talk` and `bin/mochi-hook` still exist and run the Cadbury versions, `MOCHI_*` settings in `.env` are used when the matching `CADBURY_*` one isn't set, and `~/.config/mochi/prefs.json` is read until Cadbury saves its own `~/.config/cadbury/prefs.json`. Claude sessions you left running before the upgrade are on the old tmux server: `tmux -L mochi attach`.

### Global "talk" hotkey
- **X11 and macOS:** `Ctrl+Alt+Space` works out of the box. Change it with `CADBURY_HOTKEY`.
- **Wayland** (apps can't grab global keys): bind a system shortcut to `<cadbury folder>/bin/cadbury-talk`. On GNOME that's Settings → Keyboard → Custom Shortcuts.

### Phone remote (optional)
```bash
tailscale serve --bg 8787
```
Open `https://<your-machine>.<your-tailnet>.ts.net/remote` on your phone and tap **Talk**. You can add it to your home screen. Set `ALLOWED_TS_USER` to restrict access to your own tailnet login.

## Configuration

All settings live in `.env`; see [`.env.example`](.env.example) for the full list with comments. The most useful ones:

| Setting | Default | |
|---|---|---|
| `VOICE_PROVIDER` | `gemini` | `gemini` or `openai` |
| `GEMINI_VOICE` / `REALTIME_VOICE` | `Leda` / `marin` | voice of the cat |
| `CADBURY_HARNESS` | `claude` | default agent |
| `CADBURY_LANGUAGE` | `Hinglish` (empty = match you) | e.g. `Hinglish`, `Hindi`, `English`, `Spanish` |
| `CADBURY_SCALE` | `1` | pet size (also right-click → Size) |
| `CADBURY_BARGE_THRESHOLD` | `0.06` | lower = easier to interrupt the cat |
| `CADBURY_SILENCE_MS` | `800` | pause length before the cat answers |
| `CADBURY_HALF_DUPLEX` | off | set `1` if the cat hears its own voice |

Your choices for size and language are remembered in `~/.config/cadbury/prefs.json`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Cat doesn't appear | `CADBURY_DEBUG=1 cadbury`, then check `~/.cache/cadbury/pet.log` and `~/.cache/cadbury/cat-shot.png`. Try `CADBURY_OPAQUE=1` if your compositor lacks transparency. |
| Not always on top (Wayland) | Cadbury already runs under XWayland for this. Make sure XWayland is installed. |
| "GEMINI_API_KEY is not set" | add it to `.env` and restart `cadbury` |
| "Gemini free limit hit" | the free tier is rate-limited per minute; it retries by itself |
| Cat talks over you, or cuts itself off | tune `CADBURY_BARGE_THRESHOLD` (lower or higher), use a headset, or set `CADBURY_HALF_DUPLEX=1` |
| Cat jumps in while you pause | raise `CADBURY_SILENCE_MS` (e.g. `1200`) |
| Voice doesn't reach Claude | Claude Code mode needs tmux; run `cadbury`, not plain `claude` |

## Privacy
- **API keys** stay in `.env` on your machine. The page only gets short-lived tokens (OpenAI), or talks to a local proxy that holds the key (Gemini).
- **Your voice** goes to the voice provider you chose. On Google's free tier, it may be used to improve their models.
- **Code** is only touched by your coding agent, the same as without Cadbury.

## Contributing / hacking
Read [`AGENTS.md`](AGENTS.md) and [`docs/`](docs/), written for humans and AI coding agents alike: architecture, protocols, gotchas, and how to test without a screen.

## Credits & license
- Code: [MIT](LICENSE).
- Cat artwork: **Maodie (耄耋)** by [Octane0411 / maodie-codex-pet contributors](https://github.com/Octane0411/maodie-codex-pet), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See `web/pets/maodie/`. Any Codex v2 pet sprite sheet (8×11 grid of 192×208 frames) can be swapped in.
