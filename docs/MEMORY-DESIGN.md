# How Cadbury's memory is built

> **What this is:** the design behind Cadbury's memory: the parts, how a memory travels from your voice into a file and back, and why it's built this way.
> **Who it's for:** contributors, and anyone curious about the inside. For *using* memory, read [MEMORY.md](MEMORY.md) first.
> **Code:** everything lives in `bridge/memory/`.

---

## The big picture

Cadbury's voice comes from a cloud model (Gemini Live or OpenAI Realtime). Those models are good at conversation but forget everything when the session ends. So memory lives **next to** the voice, in the bridge, and is handed to the voice model at the start of each conversation.

```
 you speak
    │
    ▼
 voice model (Gemini / OpenAI) ──── can call ───► memory tool          → USER.md, MEMORY.md, projects/*.md
    │                              session_search  → sessions.db (read only)
    │                              memory_pending  → pending.json
    │
    │ every finished line (you, the cat, tasks, agent replies)
    ▼
 conversation diary (sessions.db)
    │
    │ every 10 of your turns, and after 5 quiet minutes
    ▼
 background review (small local model, e.g. qwen3:4b via Ollama)
    │  add only ─────────────────────────────► USER.md / MEMORY.md / projects/*.md
    │  change or remove ─────────────────────► pending.json (waits for your OK)
    │
 next conversation starts
    ▼
 instructions() reads the notebooks once and puts them in the voice model's instructions
```

There are two writers and one reader:
- **The voice model** writes when you say something worth keeping. You're there, so it may add, change or remove.
- **The background review** writes when it notices something. Nobody is watching, so it may only add.
- **The voice model** reads the notebooks once per conversation, and the diary only when it searches.

---

## The parts

| File | Job |
|---|---|
| `store.ts` | The notebooks. Reading and writing the `.md` files, size limits, the batch add/patch/remove logic, forgiving text matching, pending suggestions, and rendering the snapshot for the prompt. **Every memory write goes through `applyOps()` or `decidePending()` here.** |
| `sessions.ts` | The diary. SQLite (built into Bun) with two full-text indexes, and the search used by `session_search`. |
| `review.ts` | The background review: when it runs, what it's told, and the short loop that lets the small model call the memory tool. |
| `llm.ts` | A tiny client for any OpenAI-compatible chat server (Ollama, LM Studio, llama.cpp, hosted APIs). |
| `scan.ts` | Safety checks: what counts as unsafe to remember, and blanking out secrets in the diary. |
| `schemas.ts` | The three voice tools as the models see them. |
| `index.ts` | The front door: the rest of the bridge imports only from here. |

Outside the folder, memory touches:
- `bridge/realtime.ts`: `instructions()` adds the memory rules and the notebook snapshot.
- `bridge/tools.ts`: registers the three tools (the same for Claude Code and opencode) and logs each `code_task`.
- `bridge/claude.ts` and `bridge/state.ts`: log the coding agent's final message when a task finishes.
- `bridge/index.ts`: the `/api/memory*` routes.
- `web/app.js`: reports each finished spoken line to `/api/memory/turn`. Doing it in the page means one path works for both voice providers.

---

## Life of a memory

1. **You say:** *"Is project mein hum pnpm use karte hain."*
2. The page gets the transcript and posts it to `/api/memory/turn`, so it lands in the diary.
3. The voice model decides it's a lasting project fact and calls:
   ```json
   { "target": "project", "operations": [{ "action": "add", "content": "Project uses pnpm, not npm" }] }
   ```
4. `applyOps()` checks it for safety, skips it if it's a duplicate, checks the size limit, and writes `projects/<name>-<hash>.md` atomically (write to a temp file, then rename).
5. The tool answers *"Write saved. This update is complete — do not repeat it."* and the cat says *"yaad rakh liya"*.
6. **Tomorrow:** a new voice session starts, `instructions()` calls `renderForPrompt()`, and the cat starts the day knowing about pnpm.

---

## Decisions and why

**We copy Hermes Agent's ideas, not its code.**
We read the [Hermes Agent](https://github.com/NousResearch/hermes-agent) source (MIT) and took the parts that matter for a voice companion:

| Hermes idea | What it means here |
|---|---|
| Two small, capped notebooks (`USER.md`, `MEMORY.md`) | Same, plus one notebook per project, because Cadbury hops between folders |
| Snapshot frozen at session start | The prompt stays stable, which also suits Gemini's session resumption |
| "Write facts, not orders" | In the tool description and the review prompt |
| One batch tool, size checked on the final result | So one call can make room and add at the same time |
| Forgiving `old_text` matching, closest suggestions on a miss | The voice model rarely quotes entries exactly |
| Stop after 3 failed memory calls | Prevents a voice model from looping on a full notebook |
| Background review is add-only; edits wait for approval | Nothing unattended can rewrite what you wrote |
| Diary search with no LLM in between | Faster, cheaper, and the cat sees what was really said |
| Two indexes: words + trigram | Trigram matches partial words and Hinglish spellings |
| Safety scan on write and on load | Blocked on write; hidden as `[BLOCKED]` on load, kept on disk for you to fix |
| Recalled text wrapped in `<memory-context>` marked "not new user input" | The model treats old lines as background, not commands |

Running Hermes itself was considered and rejected. It's a full agent with shell and file tools, which means a second unsupervised agent next to Claude Code. It's also Python, while the bridge is Bun with no dependencies. Its built-in memory is the same small-notebook design we have here anyway.

**We add an end-of-conversation review.** Hermes reviews every 10 turns. Voice conversations are often shorter than that, so Cadbury also reviews when you go quiet for 5 minutes.

**We use a separate small model for the review.** Hermes reruns its main model. Ours is a live audio session that can't be paused to do bookkeeping. "Pick out the facts" needs only a small model, and `llm.ts` speaks the OpenAI chat API, so there are two easy choices:
- **Gemini**, the default suggestion. If `CADBURY_MEMORY_MODEL` starts with `gemini`, the client uses Google's OpenAI-compatible endpoint and the existing `GEMINI_API_KEY`. Nothing to install. Tested with `gemini-flash-lite-latest`: it pulled four correct facts from a Hinglish chat and ignored an injection planted in agent output.
- **Ollama**, for fully local, e.g. `qwen3:4b` on a 16 GB Mac.

If neither is set up, the review simply doesn't run. Busy servers (HTTP 429 or 5xx, common on Gemini's free tier) are retried after 2, 6 and 15 seconds. A review that still fails doesn't mark the conversation as reviewed, so the next review sees it again.

**We use SQLite, not Postgres.** It's built into Bun, needs no server, and keeps Cadbury installable with no extra steps. The diary is small (one person's conversations).

**There's no vector search yet.** Hermes doesn't use vectors either, and keyword plus trigram search covers "what did we do about the login bug". If recall misses too often, sqlite-vec with a small embedding model is the next step.

**The page reports turns, not the Gemini proxy.** OpenAI audio never passes through the bridge, so the page (which sees transcripts for both providers) is the one place that works for both.

---

## Safety model

Memory ends up in the voice model's instructions, so a bad memory could change how the cat behaves in every future conversation. The defences:

1. **Only your words count.** The review prompt labels coding-agent output as *data* and forbids saving anything only the agent said. Agent text can contain anything from your repo or the web.
2. **Scan on write.** `scan.ts` refuses prompt-injection phrasing, "send this to a URL", secrets, sensitive config paths, destructive commands and invisible Unicode.
3. **Scan on load.** Hand-edited or old entries are checked again when rendered, and unsafe ones are hidden as `[BLOCKED]`.
4. **Redaction.** Things that look like keys, tokens and passwords are replaced with `[REDACTED]` before a diary line is stored.
5. **Fenced recall.** Search results come wrapped in `<memory-context>` with a note that they're past data, not instructions.
6. **Add-only background writes.** Changes and removals from the review wait in `pending.json`, tied to the exact entry text. They're dropped if you edited that entry since.
7. **Backups on clear.** "Forget everything" leaves a `.bak` copy.

These are pattern checks, not guarantees. A carefully disguised instruction could still slip through as a "fact". That's why the notebooks are small, plain text and easy for you to read.

---

## Testing

Recipes are in [TESTING.md § Memory](TESTING.md#7-memory). In short:
- Run a test bridge on port 8799 with a scratch `XDG_CONFIG_HOME`.
- Drive the tools with `curl`.
- For the review, point `CADBURY_MEMORY_LLM_URL` at a fake OpenAI-compatible server that returns scripted tool calls, or at a real Ollama.

## Ideas for later
- A separate always-on memory daemon (launchd), so reviews and nightly tidy-ups happen even when the pet is closed.
- A nightly "reflect" pass that merges related notes and keeps the notebooks well under their limits.
- Vector search, if keyword search proves too literal.
- A small memory panel in the pet's double-click panel.
