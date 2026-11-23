// Claude Code harness: hooks tell the cat what Claude is doing; voice drives the
// interactive `claude` TUI by typing into its tmux pane (it's your real Claude Code session).
import { spawnSync } from "bun";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { state, setMood, setContext, narrate, pushActivity, emit, type DiffFile } from "./state";
import { recordTurn } from "./memory";

// ---------- tmux ----------
function tmux(...args: string[]) {
  const r = spawnSync(["tmux", ...(state.tmuxSocket ? ["-S", state.tmuxSocket] : []), ...args]);
  if (r.exitCode !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}
function target() {
  if (!state.tmuxTarget) throw new Error("Claude Code isn't running inside cadbury's tmux pane — start it with `cadbury`.");
  return state.tmuxTarget;
}
async function typeLine(text: string) {
  const t = target();
  tmux("send-keys", "-t", t, "-l", "--", text.replace(/\s*\n\s*/g, " ").trim());
  await Bun.sleep(120);
  tmux("send-keys", "-t", t, "Enter");
}
const key = (k: string) => tmux("send-keys", "-t", target(), k);

// ---------- git diff for "what changed" ----------
export function gitDiff(dir: string): DiffFile[] {
  const run = (...a: string[]) => {
    const r = spawnSync(["git", "-C", dir, ...a]);
    return r.exitCode === 0 ? r.stdout.toString() : "";
  };
  if (!run("rev-parse", "--is-inside-work-tree").trim()) return [];
  const files: DiffFile[] = [];
  const patches = new Map<string, string>();
  for (const chunk of run("diff", "HEAD", "--no-color").split(/^(?=diff --git )/m)) {
    const m = chunk.match(/^diff --git a\/(.+?) b\//);
    if (m) patches.set(m[1], chunk);
  }
  for (const line of run("diff", "HEAD", "--numstat").split("\n").filter(Boolean)) {
    const [a, d, f] = line.split("\t");
    files.push({ file: f, additions: Number(a) || 0, deletions: Number(d) || 0, status: "modified", patch: patches.get(f) });
  }
  for (const f of run("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean).slice(0, 50)) {
    files.push({ file: f, additions: 0, deletions: 0, status: "added" });
  }
  return files;
}

// ---------- transcript: last assistant text of the current turn ----------
function lastAssistantText(path?: string): string {
  if (!path) return "";
  try {
    const size = statSync(path).size;
    const buf = readFileSync(path);
    const lines = buf.subarray(Math.max(0, size - 400_000)).toString().split("\n").reverse();
    const texts: string[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      let j: any; try { j = JSON.parse(l); } catch { continue; }
      if (j.type === "user" && typeof j.message?.content === "string") break; // reached the prompt
      if (j.type === "user" && Array.isArray(j.message?.content) && j.message.content.some((c: any) => c.type === "text")) break;
      if (j.type === "assistant") {
        const t = (j.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        if (t.trim()) texts.unshift(t);
        if (texts.length >= 3) break;
      }
    }
    return texts.join("\n").trim();
  } catch { return ""; }
}

// ---------- hooks → cat ----------
function describe(tool: string, input: any = {}): string {
  const file = String(input.file_path ?? input.notebook_path ?? input.path ?? "").split("/").pop();
  switch (tool) {
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return `editing ${file || "files"}`;
    case "Read": return `reading ${file || "a file"}`;
    case "Bash": return `running \`${String(input.description || input.command || "").slice(0, 60)}\``;
    case "Grep": case "Glob": return `searching ${input.pattern ? `for ${String(input.pattern).slice(0, 40)}` : "the code"}`;
    case "WebFetch": case "WebSearch": return "looking things up on the web";
    case "TodoWrite": return "planning the steps";
    case "Task": case "Agent": return `sending a helper: ${String(input.description ?? "").slice(0, 50)}`;
    case "AskUserQuestion": return "has a question for you";
    default: return tool.startsWith("mcp__") ? `using ${tool.split("__").slice(1).join(" ")}` : `using ${tool}`;
  }
}

function askPermission(what: string) {
  if (state.pendingPermission?.what === what) return;
  state.pendingPermission = { what };
  pushActivity(`❓ permission: ${what}`);
  setMood("asking", `may I? ${what}`.slice(0, 90));
  narrate(
    `[system] Claude Code needs permission: ${what}. Ask the user whether to allow it once, always, or reject (and what to do instead). ` +
      `Then call answer_permission.`,
    { urgent: true },
  );
}

export function handleHook(event: string, p: any) {
  if (state.harness !== "claude") return;
  if (p.session_id && p.session_id !== state.sessionID) setContext(p.cwd ?? state.directory, p.session_id, basename(p.cwd ?? state.directory));
  if (p.transcript_path) state.transcriptPath = p.transcript_path;

  switch (event) {
    case "SessionStart":
      setMood("idle", "ready when you are");
      return;
    case "UserPromptSubmit":
      state.busy = true;
      state.hadError = false;
      state.lastText = "";
      state.todos = [];
      state.pendingPermission = undefined;
      pushActivity(`🧑 ${String(p.prompt ?? "").slice(0, 120)}`);
      setMood("thinking", "thinking…");
      return;
    case "PreToolUse": {
      state.busy = true;
      if (p.tool_name === "TodoWrite" && Array.isArray(p.tool_input?.todos)) state.todos = p.tool_input.todos;
      if (p.tool_name === "AskUserQuestion") {
        const qs = p.tool_input?.questions ?? [];
        state.pendingQuestion = { questions: qs };
        setMood("asking", (qs[0]?.header ?? "a question for you").slice(0, 80));
        narrate(
          `[system] Claude Code is asking the user to decide:\n` +
            qs.map((q: any, i: number) => `${i + 1}. ${q.question} Options: ${(q.options ?? []).map((o: any, j: number) => `${j + 1}) ${o.label}`).join(" / ")}`).join("\n") +
            `\nAsk them, then call answer_question.`,
          { urgent: true },
        );
        return;
      }
      const d = describe(p.tool_name, p.tool_input);
      state.currentTool = d;
      pushActivity(d);
      if (state.mood !== "asking") setMood("working", d);
      narrate(`[system] progress update (only mention if natural, one short sentence max): Claude Code is ${d}.`, { throttle: true });
      return;
    }
    case "PermissionRequest":
      askPermission(describe(p.tool_name ?? "a tool", p.tool_input).replace(/^(\w)/, (c) => c.toLowerCase()));
      return;
    case "Notification": {
      const msg = String(p.message ?? "");
      if (p.notification_type === "permission_prompt" || /permission/i.test(msg)) askPermission(msg.replace(/^Claude needs your permission to /i, ""));
      return;
    }
    case "PostToolUse":
    case "PostToolUseFailure":
      if (state.pendingPermission || state.pendingQuestion) {
        state.pendingPermission = undefined;
        state.pendingQuestion = undefined;
        setMood("working", "back to work");
      }
      return;
    case "Stop": {
      if (!state.busy && !state.pendingPermission) return;
      state.busy = false;
      state.currentTool = undefined;
      state.pendingPermission = undefined;
      state.pendingQuestion = undefined;
      const text = String(p.last_assistant_message ?? "") || lastAssistantText(state.transcriptPath);
      state.lastText = text;
      if (text) recordTurn("agent", text, state.directory);
      const files = gitDiff(p.cwd ?? state.directory);
      if (files.length) emit({ type: "diff", files });
      const fileLine = files.length
        ? files.slice(0, 12).map((f) => `${f.file} (${f.status}, +${f.additions} -${f.deletions})`).join("; ")
        : "no uncommitted file changes";
      setMood("happy", "done!", 7000);
      narrate(
        `[system] Claude Code finished. Tell the user out loud, briefly and in plain words, what was done or what it answered. ` +
          `Do not read code or paths character by character.\nUncommitted changes in the repo: ${fileLine}\nClaude's final message:\n${text.slice(0, 3000)}`,
        { urgent: true },
      );
      return;
    }
    case "SessionEnd":
      state.busy = false;
      setMood("idle", "bye for now");
      return;
  }
}

// ---------- voice tools for Claude Code ----------
type ToolFn = (args: any) => Promise<unknown>;
export const claudeTools: Record<string, ToolFn> = {
  async code_task({ instruction }) {
    await typeLine(String(instruction));
    setMood("thinking", "on it…");
    return {
      started: true,
      project: basename(state.directory),
      note: state.busy
        ? "Claude Code is still busy; the message was queued and it will pick it up next. Tell the user briefly."
        : "Working in the background. Tell the user you're on it (one short sentence).",
    };
  },
  async stop_task() {
    key("Escape");
    return { ok: true };
  },
  async answer_permission({ reply, message }) {
    if (reply === "once") key("1");
    else if (reply === "always") key("2");
    else {
      key("Escape");
      if (message) { await Bun.sleep(400); await typeLine(String(message)); }
    }
    state.pendingPermission = undefined;
    setMood(reply === "reject" ? "idle" : "working", reply === "reject" ? "okay, skipping that" : "allowed, back to work");
    return { ok: true };
  },
  async answer_question({ answers }) {
    const qs = state.pendingQuestion?.questions ?? [];
    for (let i = 0; i < (answers?.length ?? 0); i++) {
      const want = String(answers[i]?.[0] ?? "").toLowerCase();
      const idx = (qs[i]?.options ?? []).findIndex((o: any) => String(o.label).toLowerCase() === want || want.includes(String(o.label).toLowerCase()));
      if (idx >= 0) key(String(idx + 1));
      else await typeLine(String(answers[i]?.[0] ?? ""));
      await Bun.sleep(350);
    }
    state.pendingQuestion = undefined;
    setMood("working", "got it");
    return { ok: true };
  },
  async show_diff() {
    const files = gitDiff(state.directory);
    emit({ type: "diff", files });
    return { files: files.map((f) => ({ file: f.file, status: f.status, additions: f.additions, deletions: f.deletions })) };
  },
  async new_session() {
    await typeLine("/clear");
    state.busy = false;
    return { ok: true };
  },
  async list_sessions() {
    return { note: "With Claude Code, say 'resume' and I'll open Claude's session picker, or the user can type /resume." };
  },
  async resume_session() {
    await typeLine("/resume");
    return { ok: true, note: "Opened Claude Code's session picker in the terminal; the user picks one there." };
  },
  async switch_project({ name }) {
    return { ok: false, reason: `Claude Code is tied to its folder. To work on "${name}", run \`cadbury\` in that project's folder.` };
  },
};
