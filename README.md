# 🐱 Mochi: a voice ginger-cat companion for opencode

A floating ginger cat on your desktop that you **talk to**. It drives **opencode** for the real coding work: editing files, running commands and tests. It shows you what's happening through its moods, asks you out loud when a decision is needed, and tells you what it did.

```
opencode TUI ──attach──┐
                       ▼
Mochi (Electron cat) ─► bridge :8787 ─► opencode serve :4096
      │ WebRTC audio                       (your models, tools, MCP, AGENTS.md)
      ▼
OpenAI Realtime (voice + tool calls)
```

## Setup
```bash
cd ~/Storage/projects/voicecode
cp .env.example .env        # put your OPENAI_API_KEY in it
ln -s "$PWD/bin/mochi" ~/.local/bin/mochi
```

## Use with Claude Code (default)
```bash
cd ~/Storage/projects/erp && mochi          # Claude Code in this terminal + the cat
mochi --opencode                             # opencode instead
```
`mochi` runs the real `claude` CLI (your subscription) inside a private tmux session (`tmux -L mochi`).
Claude Code hooks, passed only to this session via `--settings`, tell the cat what Claude is doing.
When you talk, the cat types your request into Claude Code, answers permission prompts (1 = yes, 2 = always, Esc = no),
and presses Esc to stop. If you're already inside tmux, it uses your current pane.
Detach with `Ctrl-b d`; get back with `tmux -L mochi attach`.

## Use with opencode
```bash
mochi ~/Storage/projects/erp          # starts opencode serve + bridge + the cat
opencode attach http://127.0.0.1:4096 --dir ~/Storage/projects/erp   # optional: the TUI on the same session
```
- **Click the cat** to start talking. Click again to mute or unmute. **Ctrl+Alt+Space** does the same from anywhere.
- **Drag** the cat to move it. **Double-click** opens the activity, transcript and diff panel, where you can also type to it.
- **Right-click** for the menu: open the TUI here, stop the task, new session, switch project, show changes.
- Things to say: *"add a dark mode toggle to the settings page"*, *"what are you doing?"*, *"stop"*, *"show me the changes"*, *"switch to the erp project"*, *"yes, allow it"*.
- It follows whatever session you last prompted, so tasks you **type in the TUI** get narrated by the cat too.

## Moods
`idle` · `listening` (ears up, sound waves) · `talking` (mouth synced to the voice) · `thinking` (…) · `working` (typing on a laptop, the chip shows the current step) · `asking` (? and a waving paw: permission or question) · `happy` (hearts: task done) · `oops` (! with flat ears: error) · `sleeping` (zzz after 5 min idle)

## Phone remote (bonus)
```bash
tailscale serve --bg 8787
```
Open `https://arch.<your-tailnet>.ts.net/remote` on your phone (Tailscale on), tap **Talk**, and add it to your home screen. HTTPS from tailscale serve is what lets the browser use the mic. Only `ALLOWED_TS_USER` gets in.

## Files
- `bridge/opencode.ts`: opencode HTTP client, starts `opencode serve`, global SSE stream
- `bridge/state.ts`: turns opencode events into moods, narration and the completion summary
- `bridge/tools.ts`: voice tools (code_task, task_status, stop_task, answer_permission, answer_question, show_diff, switch_project…)
- `bridge/realtime.ts`: ephemeral Realtime token plus the cat persona and instructions
- `web/`: cat SVG and animations (`index.html`, `style.css`), WebRTC voice (`voice.js`), glue (`app.js`)
- `desktop/`: Electron always-on-top transparent window (runs under XWayland so always-on-top works on GNOME)

## Pet art credit
The cat is **Maodie (耄耋)** by [Octane0411 / maodie-codex-pet contributors](https://github.com/Octane0411/maodie-codex-pet),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — files in `web/pets/maodie/` (see its `LICENSE-ASSETS` and `NOTICE.md`).
It's a Codex v2 pet sprite sheet; `web/sprite.js` plays it. Any other Codex-format pet (8×11 grid of 192×208 frames) can be dropped in the same way.
Preview states with `http://127.0.0.1:8787/?mood=working` or `?antic=zoom`.
