# Testing without a screen, mic or real agent

Use a **separate test bridge on port 8799**, never the user's live one on 8787. Point `XDG_CONFIG_HOME` at a scratch folder so the test doesn't overwrite real prefs.

```bash
S=$(mktemp -d)                       # scratch
mkdir -p $S/proj $S/cfg
XDG_CONFIG_HOME=$S/cfg CADBURY_PORT=8799 CADBURY_HARNESS=claude DEFAULT_PROJECT=$S/proj \
  bun bridge/index.ts > $S/bridge.log 2>&1 &
until curl -s localhost:8799/api/health >/dev/null; do sleep 0.3; done
# …tests…
kill $(ss -ltnp | grep ':8799' | grep -o 'pid=[0-9]*' | cut -d= -f2)   # don't pkill -f (it can match your own shell)
```

## 0. Static checks
```bash
bun run check
```

## 1. UI events
```bash
timeout 20 curl -sN localhost:8799/api/events     # watch mood / narrate / diff events while running the tests below
```

## 2. Claude Code mode with simulated hooks and a fake Claude pane
```bash
PANE=$(tmux -L cadburytest new-session -d -s t -x 120 -y 30 -P -F '#{pane_id}' "cat > $S/typed.txt")
SOCK=$(tmux -L cadburytest display -p '#{socket_path}')
curl -s -XPOST localhost:8799/api/context -H 'content-type: application/json' \
  -d "{\"directory\":\"$S/proj\",\"harness\":\"claude\",\"tmux\":\"$PANE\",\"tmuxSocket\":\"$SOCK\"}"
H() { echo "$2" | CADBURY_PORT=8799 bin/cadbury-hook $1; }
B="\"session_id\":\"s1\",\"cwd\":\"$S/proj\""
H UserPromptSubmit "{$B,\"prompt\":\"add hello\"}"
H PreToolUse        "{$B,\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$S/proj/hello.sh\"}}"
H PermissionRequest "{$B,\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"chmod +x hello.sh\"}}"
curl -s -XPOST localhost:8799/api/tool/answer_permission -d '{"reply":"once"}'
H Stop              "{$B,\"last_assistant_message\":\"Created hello.sh.\"}"
curl -s -XPOST localhost:8799/api/tool/code_task -d '{"instruction":"now print the date"}'
cat -A $S/typed.txt        # expect: 1now print the date$
tmux -L cadburytest kill-server
```
To check real hook payloads: run `claude -p "…" --settings hooks.json` with hooks that append stdin to a file (cheap prompt, uses the user's plan).

## 3. Gemini Live end to end (real API, needs GEMINI_API_KEY)
A Bun client acting as the page:
```ts
const ws = new WebSocket("ws://127.0.0.1:8799/api/gemini-live");
let said = "";
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.cadbury === "ready") ws.send(JSON.stringify({ realtimeInput: { text: "What is the agent doing? Use your tool." } }));
  if (m.toolCall) console.log("tool", m.toolCall.functionCalls.map((f) => f.name));
  if (m.serverContent?.outputTranscription?.text) said += m.serverContent.outputTranscription.text;
  if (m.serverContent?.turnComplete && said) { console.log(said); process.exit(0); }
};
```

Things worth re-testing after voice changes:
- **Resume after reconnect:** tell it a secret word, close, reconnect → `resumed: true`, and it remembers.
- **Inactivity:** stay silent until the log shows `idle, will resume on next activity` (about 120 s), then ask → it wakes and remembers.
- **Language:** "talk to me in Hindi" → `set_language`. Then simulate `Stop` hooks while forwarding SSE `narrate` events into the WS as `realtimeInput.text` → the summary should be in Devanagari.
- **Clarifying questions:** a clear request → `code_task` with no question; "make it faster" → one question; "delete X and force push" → confirmation and no tool call.
- **The free tier rate-limits back-to-back sessions.** Wait about a minute between test batches, using a background command (foreground `sleep` may be blocked in agent sandboxes).

## 4. Client logic in Node (barge-in etc.)
Load `web/voice-gemini.js` in a `vm` context with stubbed `window`, `CustomEvent`, `WebSocket`, `atob`/`btoa` and a fake `outCtx` (`createBuffer`, `createBufferSource`).
1. Feed `onServer({serverContent:{modelTurn:{parts:[{inlineData:{…}}]}}})` to start "talking".
2. Call `onMic({pcm, rms})` with rms 0.02 (no barge-in) and with rms 0.12 ×5 (barge-in).
3. Assert: sources stopped, `skipTurn`, late chunks not played, next turn plays.

## 5. The pet visually (headless Chrome)
With the test bridge running, `?mood=<mood>` and `?antic=<antic>` freeze the cat:
```bash
google-chrome-stable --headless=new --no-sandbox --user-data-dir=$S/chrome --window-size=420,560 \
  --timeout=3000 --screenshot=$S/shot.png "http://127.0.0.1:8799/?antic=zoom"
```
For a grid, make an HTML page of iframes, one per state. Without the Electron preload the page uses the remote (phone) layout, which is fine for checking frames.

## 6. Real desktop run (needs a display)
```bash
CADBURY_DEBUG=1 bin/cadbury        # ~/.cache/cadbury/pet.log + cat-shot.png (what the window actually rendered)
```
