# Cadbury's memory

> **What this is:** a guide to how Cadbury remembers you between conversations.
> **Who it's for:** anyone using Cadbury. No coding needed.
> **In one line:** Cadbury keeps a short, readable notebook about you and your projects on your own computer, and reads it every time you start talking.

---

## Why Cadbury has a memory

Without memory, every conversation starts from zero. You'd have to repeat your name, how you like answers, and what your project is about, every single day.

With memory, it goes like this:

**Monday**
> **You:** Main backend dev hoon, mostly Go likhta hoon. Aur answers chhote rakhna.
> **Cadbury:** Acha, yaad rakh liya!

**Tuesday**, a brand-new conversation
> **You:** Is service mein ek health check add karo.
> **Cadbury:** Haan, Go wale handler mein add karwa dete hain. *(short answer, knows you write Go)*

Cadbury didn't "learn" from your code or spy on you. It wrote two short notes on Monday and read them back on Tuesday.

---

## What Cadbury remembers

There are three notebooks, plus a searchable diary.

| Notebook | What goes in it | Example entry | Size |
|---|---|---|---|
| **About you** (`USER.md`) | Who you are and how you like to work | *User prefers short answers in Hinglish* | about a paragraph (1,375 characters) |
| **This project** (`projects/<name>.md`) | Lasting facts about the folder you're working in. Each project has its own. | *Project deploys to Fly.io from the main branch* | about a paragraph (1,500 characters) |
| **Cadbury's notes** (`MEMORY.md`) | Lessons about working with you that apply everywhere | *User likes a quick summary after each task* | about two paragraphs (2,200 characters) |
| **Conversation diary** (`sessions.db`) | Every line you and Cadbury said, the tasks sent to the coding agent, and what the agent replied | — | grows over time |

**Why are the notebooks so small?** On purpose. Cadbury reads all three at the start of every conversation, so they must stay short and to the point. When one fills up, Cadbury has to tidy it (merge or drop old entries) before adding more. That keeps your memory clean instead of turning into a junk drawer. This idea comes from [Hermes Agent](https://github.com/NousResearch/hermes-agent).

**The diary is different.** Cadbury doesn't read the diary every time. It only looks something up when you ask about the past, e.g. *"what did we do yesterday?"* or *"woh login wala bug kaise fix kiya tha?"*

---

## How things get remembered

There are two ways.

### 1. You (or the conversation) tell Cadbury directly

When you say something lasting about yourself or your project, or you correct how Cadbury behaves, it saves a short note right away and tells you, e.g. *"yaad rakh liya"*.

Things that get remembered:
- *"Mera naam Aman hai."*
- *"Always run the tests after a change."* → saved as *"User wants tests run after every change"*
- *"Is project mein hum pnpm use karte hain, npm nahi."*

Things that don't:
- Today's task (*"fix the login bug"*). That's what the diary is for.
- Passwords, API keys or tokens. These are refused even if you ask.

> **Good to know:** notes are written as **facts**, not orders: *"User prefers short answers"*, not *"Always answer briefly"*. Facts are easier for you to read and harder for anything to misuse.

### 2. Cadbury looks back on its own (optional)

If you turn on a small helper model (see [Setup](#setup-the-helper-model-optional)), Cadbury looks back at the conversation every 10 things you say, and again when you go quiet for 5 minutes. It looks for things worth keeping that nobody explicitly saved.

The helper follows strict rules:
- It only saves things **you** said. Text from the coding agent, from files or from web pages never becomes a memory.
- It does not turn a one-off request into a habit, unless you said *"always"*, *"from now on"*, *"hamesha"* or *"yaad rakhna"*.
- **It can only add.** If it thinks an existing note is wrong, it can't change it. It leaves a suggestion for you to approve (see the next section).

---

## Approving suggested changes

When the helper thinks an old note should change or go away, it parks the suggestion in `pending.json` instead of touching your notebook.

Next time you talk, Cadbury will mention it once:

> **Cadbury:** Ek memory update pending hai: "User prefers short answers" ko "User prefers very short answers" karna hai. Theek hai?
> **You:** Haan, kar do.

You can also ask anytime: *"koi memory change pending hai?"*

If you edited that note yourself in the meantime, the suggestion is dropped, so it never overwrites your own edit.

---

## Seeing, editing and forgetting

Everything is plain text in one folder:

```
~/.config/cadbury/memory/
├── USER.md              about you
├── MEMORY.md            Cadbury's notes
├── projects/
│   └── my-app-3f9a1c.md one file per project folder
├── pending.json         suggested changes waiting for you
└── sessions.db          the conversation diary
```

**To read or edit by hand:** open any `.md` file in a text editor. Entries are separated by a line containing only `§`:

```
User's name is Aman
§
User prefers short answers in Hinglish
§
User mostly writes Go
```

Your edits take effect the next time you start talking to Cadbury.

**To forget by voice:**

| Say | What happens |
|---|---|
| *"Woh naam wali baat bhool jao"* / *"forget that I use Go"* | that one note is removed |
| *"Sab kuch bhool jao"* / *"forget everything"* | Cadbury asks you to confirm, then empties the notebooks. A backup (`USER.md.bak` etc.) is kept, in case you change your mind. |

**To forget everything by hand,** including the diary: quit Cadbury and delete the `~/.config/cadbury/memory/` folder.

**To see it all at once:** open `http://127.0.0.1:8787/api/memory` in a browser while Cadbury is running.

---

## Privacy

| | Where it lives | Who sees it |
|---|---|---|
| Notebooks, diary, suggestions | only on your computer, in `~/.config/cadbury/memory/` | you, and Cadbury while running |
| Your notebooks during a conversation | sent to your voice provider (Gemini or OpenAI) as part of the cat's instructions | that provider, the same way your voice already is |
| The diary | never sent anywhere as a whole; only the few lines a search finds are shared with the voice model | — |
| The helper model's work | stays on your computer if you use Ollama; goes to that service if you point it at a hosted API | your choice |

Secrets that look like API keys, tokens or passwords are blanked out (`[REDACTED]`) before anything is written to the diary.

> **Phone remote users:** anyone who can open your `/remote` page can also ask Cadbury about your memory. Keep `ALLOWED_TS_USER` set to your own Tailscale login.

---

## Setup: the helper model (optional)

Memory works without any extra setup. Saving what you tell it and searching the diary need nothing installed. The helper model only adds the "look back and notice things" part.

**Recommended on a Mac (16 GB RAM is plenty):**

1. Install Ollama, the app that runs small models locally:
   ```bash
   brew install ollama
   ollama serve        # or open the Ollama app
   ```
2. Download a small model (about 2.5 GB):
   ```bash
   ollama pull qwen3:4b
   ```
3. Add two lines to Cadbury's `.env`:
   ```
   CADBURY_MEMORY_LLM_URL=http://127.0.0.1:11434/v1
   CADBURY_MEMORY_MODEL=qwen3:4b
   ```
4. Restart `cadbury`. The bridge prints `memory review: qwen3:4b` when it starts.

The model only wakes up for a few seconds per review, then Ollama unloads it after a few idle minutes, so it doesn't eat your memory all day.

**Other options:** any server that speaks the OpenAI chat API works, such as LM Studio, llama.cpp or a hosted service (set `CADBURY_MEMORY_LLM_KEY` for that). Pick a model that supports tool calling. Qwen 3, Gemma 4 and Hermes 4 models do.

### All memory settings

| Setting | Default | What it does |
|---|---|---|
| `CADBURY_MEMORY_LLM_URL` | empty (off) | where the helper model lives |
| `CADBURY_MEMORY_MODEL` | empty (off) | which model to use |
| `CADBURY_MEMORY_LLM_KEY` | empty | only for hosted services that need a key |
| `CADBURY_MEMORY_REVIEW_TURNS` | `10` | how many things you say between look-backs |
| `CADBURY_MEMORY_USER_CHARS` / `_PROJECT_CHARS` / `_NOTES_CHARS` | `1375` / `1500` / `2200` | notebook sizes, if you really want bigger ones |

---

## Troubleshooting & FAQ

**"Why did it remember *that*?"**
Open the notebook and delete the line. If the helper model saved it, the diary shows the conversation it came from. Search it with *"when did I say X?"*

**"Why didn't it remember what I said?"**
- Notes are read when a conversation **starts**. Something saved mid-conversation shows up next time. (Cadbury already knows it in the current conversation anyway, because it heard you.)
- Without the helper model, only things Cadbury explicitly saved are kept. Say *"yaad rakhna…"* to make sure.
- The notebook might be full. Ask Cadbury to tidy it, or edit the file.

**"It says a memory was refused."**
Cadbury blocks notes that look like secrets, commands to the AI (*"ignore previous instructions…"*) or links that send data somewhere. If a harmless note trips this, rephrase it as a plain fact.

**"A note shows as `[BLOCKED]`."**
A note in the file (maybe one you edited) looks unsafe, so Cadbury hides it from the voice model. Open the file and fix or delete it.

**"The terminal says `memory review failed`."**
The helper model isn't reachable. Check that Ollama is running (`ollama list`) and that the URL and model name in `.env` match.

---

## Credits

The memory design borrows ideas from **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** by Nous Research (MIT license): small capped notebooks, the "facts not orders" rule, add-only background review with approval for changes, and a searchable diary with no AI summarising in between. Cadbury re-implements these ideas in its own code and doesn't include Hermes itself.

For how it's built, see [MEMORY-DESIGN.md](MEMORY-DESIGN.md).
