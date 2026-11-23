// Claude Code harness: hooks tell the cat what Claude is doing; voice drives the
// interactive `claude` TUI by typing into its tmux pane (it's your real Claude Code session).
//
// Several Claude Code sessions can run at once (one per `cadbury` terminal). Each one is a
// ClaudeSession keyed by its tmux pane. One of them is "in focus": the cat's mood follows it and
// voice tools act on it by default. The others are watched in the background: the cat speaks up
// when one finishes or needs a permission/answer, and any tool can target one with `session`.
import { spawnSync } from "bun";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { state, setMood, setContext, narrate, pushActivity, emit, type DiffFile } from "./state";
import { recordTurn } from "./memory";

// ---------- sessions ----------
export interface ClaudeSession {
  n: number; // stable number the user can say ("session 2")
  key: string; // "<socket>|<pane>", or "sid:<session_id>" when the hook didn't come from tmux
  pane?: string;
  socket?: string;
  sessionID?: string;
  directory: string;
  transcriptPath?: string;
  busy: boolean;
  currentTool?: string;
  todos: { content: string; status: string }[];
  lastText: string;
  lastPrompt: string;
  pendingPermission?: { what: string };
  pendingQuestion?: { questions: any[] };
  lastSeen: number;
}

const sessions = new Map<string, ClaudeSession>();
let nextN = 1;
let focusKey: string | undefined;

const label = (s: ClaudeSession) => `#${s.n} ${basename(s.directory)}`;
const focused = () => (focusKey ? sessions.get(focusKey) : undefined);
const isFocused = (s: ClaudeSession) => s.key === focusKey;

function newSession(key: string, init: Partial<ClaudeSession>): ClaudeSession {
  const s: ClaudeSession = {
    n: nextN++, key, directory: state.directory, busy: false, todos: [], lastText: "", lastPrompt: "", lastSeen: Date.now(), ...init,
  };
  sessions.set(key, s);
  return s;
}

/** Copy the focused session into `state`, which the rest of the bridge and the UI read. */
function syncFocus() {
  const s = focused();
  state.tmuxTarget = s?.pane;
  state.tmuxSocket = s?.socket;
  state.busy = s?.busy ?? false;
  state.currentTool = s?.currentTool;
  state.todos = s?.todos ?? [];
  state.lastText = s?.lastText ?? "";
  state.pendingPermission = s?.pendingPermission;
  state.pendingQuestion = s?.pendingQuestion;
  state.transcriptPath = s?.transcriptPath;
}

function emitSessions() {
  emit({ type: "sessions", focus: focused()?.n, sessions: listSessions() } as any);
}

/** Mood that matches the focused session (used after a focus change or an answer). */
function focusMood() {
  const s = focused();
  const waiting = [...sessions.values()].find((x) => x.pendingPermission || x.pendingQuestion);
  if (s?.pendingPermission || s?.pendingQuestion) setMood("asking", s.pendingPermission ? `may I? ${s.pendingPermission.what}`.slice(0, 90) : "a question for you");
  else if (waiting) setMood("asking", `${label(waiting)} is waiting for you`);
  else if (s?.busy) setMood("working", s.currentTool ?? "working…");
  else setMood("idle", s ? `in ${basename(s.directory)}` : "ready when you are");
}

function focus(s: ClaudeSession, announceMood = true) {
  if (focusKey !== s.key) {
    focusKey = s.key;
    setContext(s.directory, s.sessionID, sessions.size > 1 ? label(s) : basename(s.directory));
  }
  syncFocus();
  if (announceMood) focusMood();
  emitSessions();
}

/** `bin/cadbury` registers the pane it started Claude in; the newest launch takes focus. */
export function registerPane(directory: string, pane: string, socket?: string) {
  const key = `${socket ?? ""}|${pane}`;
  let s = sessions.get(key);
  if (!s) s = newSession(key, { pane, socket, directory });
  else { s.directory = directory; s.busy = false; s.lastSeen = Date.now(); }
  focus(s);
  return s;
}

/** Find (or create) the session a hook belongs to. */
function sessionForHook(p: any, from: { pane?: string; socket?: string }): ClaudeSession {
  const sid: string | undefined = p.session_id;
  const cwd: string | undefined = p.cwd;
  let s: ClaudeSession | undefined;
  if (from.pane) {
    const key = `${from.socket ?? ""}|${from.pane}`;
    s = sessions.get(key) ?? newSession(key, { pane: from.pane, socket: from.socket, directory: cwd ?? state.directory });
    // the same Claude session may have been seen before without pane info: fold it in
    for (const [k, o] of sessions) if (k.startsWith("sid:") && sid && o.sessionID === sid) sessions.delete(k);
  } else {
    // Old hook script without pane info: match by session id, else adopt a registered pane that
    // hasn't heard from Claude yet in the same folder, else track it read-only (can't type into it).
    s = [...sessions.values()].find((x) => sid && x.sessionID === sid)
      ?? [...sessions.values()].find((x) => x.pane && !x.sessionID && (!cwd || x.directory === cwd))
      ?? newSession(`sid:${sid ?? "unknown"}`, { directory: cwd ?? state.directory });
  }
  if (sid && s.sessionID !== sid) { s.sessionID = sid; if (isFocused(s)) setContext(s.directory, sid, state.sessionTitle); }
  if (cwd) s.directory = cwd;
  if (p.transcript_path) s.transcriptPath = p.transcript_path;
  s.lastSeen = Date.now();
  return s;
}

// ---------- liveness ----------
const SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "-bash", "-zsh"]);
function alive(s: ClaudeSession): boolean {
  if (!s.pane) return Date.now() - s.lastSeen < 6 * 3600_000; // hook-only session: trust it for a while
  const r = spawnSync(["tmux", ...(s.socket ? ["-S", s.socket] : []), "display", "-p", "-t", s.pane, "#{pane_id}\t#{pane_dead}\t#{pane_current_command}"]);
  if (r.exitCode !== 0) return false;
  const [id, dead, cmd] = r.stdout.toString().trim().split("\t");
  if (id !== s.pane || dead === "1") return false;
  // Claude ran inside the user's own tmux and has exited back to the shell. Allow a short grace
  // period right after registering, when the launcher script is still starting Claude.
  return !(SHELLS.has(cmd) && Date.now() - s.lastSeen > 15_000);
}

/** Drop sessions whose Claude has exited. Returns true if anything changed. */
export function prune(): boolean {
  let changed = false;
  for (const [k, s] of sessions) {
    if (alive(s)) continue;
    sessions.delete(k);
    changed = true;
    pushActivity(`👋 ${label(s)} closed`);
  }
  if (changed) {
    if (focusKey && !sessions.has(focusKey)) {
      focusKey = undefined;
      const next = [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (next) focus(next); else { syncFocus(); focusMood(); }
    }
    emitSessions();
  }
  return changed;
}

/** After a bridge restart, pick up Claude sessions still running in cadbury's private tmux server. */
export function discover() {
  const r = spawnSync(["tmux", "-L", "cadbury", "list-panes", "-a", "-F", "#{socket_path}\t#{pane_id}\t#{pane_current_path}\t#{session_name}"]);
  if (r.exitCode !== 0) return;
  for (const line of r.stdout.toString().split("\n").filter(Boolean)) {
    const [socket, pane, dir, name] = line.split("\t");
    if (!name?.startsWith("cadbury-") || sessions.has(`${socket}|${pane}`)) continue;
    const s = newSession(`${socket}|${pane}`, { pane, socket, directory: dir });
    if (!focusKey) focus(s, false);
  }
  if (sessions.size) { prune(); console.log(`[cadbury] found ${sessions.size} running Claude Code session(s)`); }
}

export function listSessions() {
  return [...sessions.values()].sort((a, b) => a.n - b.n).map((s) => ({
    session: s.n,
    project: basename(s.directory),
    directory: s.directory,
    in_focus: isFocused(s),
    busy: s.busy,
    current_step: s.busy ? s.currentTool ?? "thinking" : null,
    last_request: s.lastPrompt.slice(0, 120) || null,
    waiting_for_user: s.pendingPermission ? `permission: ${s.pendingPermission.what}` : s.pendingQuestion ? "a question" : null,
    can_type: !!s.pane,
  }));
}

/** How many Claude sessions are still running (the launcher asks before shutting the cat down). */
export function aliveCount() {
  prune();
  return [...sessions.values()].filter((s) => s.pane).length;
}

type Pick = { s: ClaudeSession; error?: undefined } | { s?: undefined; error: Record<string, unknown> };
/** Resolve the `session` argument of a voice tool: a number, a project name, words from its last request, or nothing (= focus). */
function pick(ref: unknown, prefer?: (s: ClaudeSession) => boolean): Pick {
  prune();
  const all = [...sessions.values()];
  const none = { ok: false, reason: "No Claude Code session is running. Start one with `cadbury` in a project folder." };
  const raw = String(ref ?? "").trim();
  if (!raw) {
    const f = focused();
    if (prefer && !(f && prefer(f))) {
      const p = all.filter(prefer).sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (p) return { s: p };
    }
    return f ? { s: f } : all.length ? { s: all.sort((a, b) => b.lastSeen - a.lastSeen)[0] } : { error: none };
  }
  if (!all.length) return { error: none };
  const num = raw.match(/^(?:#|session\s*|number\s*)?(\d+)$/i);
  if (num) {
    const s = all.find((x) => x.n === Number(num[1]));
    return s ? { s } : { error: { ok: false, reason: `There is no session ${num[1]}.`, sessions: listSessions() } };
  }
  const norm = (t: string) => t.toLowerCase().replace(/[\s_\-.]/g, "");
  const want = norm(raw);
  const byProject = all.filter((x) => norm(basename(x.directory)) === want);
  const loose = byProject.length ? byProject
    : all.filter((x) => norm(basename(x.directory)).includes(want) || want.includes(norm(basename(x.directory))));
  const hits = loose.length ? loose
    : all.filter((x) => x.sessionID?.startsWith(raw) || (raw.length > 3 && x.lastPrompt.toLowerCase().includes(raw.toLowerCase())));
  if (hits.length === 1) return { s: hits[0] };
  if (hits.length > 1) {
    const p = prefer && hits.filter(prefer);
    if (p?.length === 1) return { s: p[0] };
    return { error: { ok: false, reason: `More than one session matches "${raw}". Ask the user which number.`, sessions: listSessions().filter((x) => hits.some((h) => h.n === x.session)) } };
  }
  return { error: { ok: false, reason: `No session matches "${raw}".`, sessions: listSessions() } };
}

// ---------- tmux ----------
function tmux(s: ClaudeSession, ...args: string[]) {
  const r = spawnSync(["tmux", ...(s.socket ? ["-S", s.socket] : []), ...args]);
  if (r.exitCode !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}
function target(s: ClaudeSession) {
  if (!s.pane) throw new Error(`Claude Code session ${label(s)} isn't running inside a tmux pane I can type into. Start it with \`cadbury\`.`);
  return s.pane;
}
async function typeLine(s: ClaudeSession, text: string) {
  const t = target(s);
  tmux(s, "send-keys", "-t", t, "-l", "--", text.replace(/\s*\n\s*/g, " ").trim());
  await Bun.sleep(120);
  tmux(s, "send-keys", "-t", t, "Enter");
}
const key = (s: ClaudeSession, k: string) => tmux(s, "send-keys", "-t", target(s), k);

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

/** How to name a session in narration, and which `session` value to pass back. */
function who(s: ClaudeSession) {
  if (sessions.size < 2) return { name: "Claude Code", arg: "" };
  return isFocused(s)
    ? { name: `Claude Code (session ${label(s)}, the one in focus)`, arg: ` with session "${s.n}"` }
    : { name: `Claude Code in the background session ${label(s)} (not the one in focus; mention the project name to the user)`, arg: ` with session "${s.n}"` };
}

function askPermission(s: ClaudeSession, what: string) {
  if (s.pendingPermission?.what === what) return;
  s.pendingPermission = { what };
  if (isFocused(s)) syncFocus();
  const w = who(s);
  pushActivity(`❓ ${sessions.size > 1 ? `${label(s)} ` : ""}permission: ${what}`);
  setMood("asking", `${isFocused(s) ? "" : `${label(s)}: `}may I? ${what}`.slice(0, 90));
  emitSessions();
  narrate(
    `[system] ${w.name} needs permission: ${what}. Ask the user whether to allow it once, always, or reject (and what to do instead). ` +
      `Then call answer_permission${w.arg}.`,
    { urgent: true },
  );
}

export function handleHook(event: string, p: any, from: { pane?: string; socket?: string } = {}) {
  if (state.harness !== "claude") return;
  const s = sessionForHook(p, from);
  // The session the user (or the cat) just typed into becomes the one in focus.
  if (!focusKey || (event === "UserPromptSubmit" && !isFocused(s))) focus(s, false);
  const fg = isFocused(s);
  const tag = sessions.size > 1 && !fg ? `[${label(s)}] ` : "";
  const done = () => { if (fg) syncFocus(); emitSessions(); };

  switch (event) {
    case "SessionStart":
      if (fg && !s.busy) setMood("idle", "ready when you are");
      done();
      return;
    case "UserPromptSubmit":
      s.busy = true;
      s.lastText = "";
      s.todos = [];
      s.pendingPermission = undefined;
      s.lastPrompt = String(p.prompt ?? "");
      if (fg) state.hadError = false;
      done();
      pushActivity(`🧑 ${tag}${s.lastPrompt.slice(0, 120)}`);
      if (fg) setMood("thinking", "thinking…");
      return;
    case "PreToolUse": {
      s.busy = true;
      if (p.tool_name === "TodoWrite" && Array.isArray(p.tool_input?.todos)) s.todos = p.tool_input.todos;
      if (p.tool_name === "AskUserQuestion") {
        const qs = p.tool_input?.questions ?? [];
        s.pendingQuestion = { questions: qs };
        done();
        const w = who(s);
        setMood("asking", `${fg ? "" : `${label(s)}: `}${qs[0]?.header ?? "a question for you"}`.slice(0, 80));
        narrate(
          `[system] ${w.name} is asking the user to decide:\n` +
            qs.map((q: any, i: number) => `${i + 1}. ${q.question} Options: ${(q.options ?? []).map((o: any, j: number) => `${j + 1}) ${o.label}`).join(" / ")}`).join("\n") +
            `\nAsk them, then call answer_question${w.arg}.`,
          { urgent: true },
        );
        return;
      }
      const d = describe(p.tool_name, p.tool_input);
      s.currentTool = d;
      done();
      pushActivity(tag + d);
      if (!fg) return; // background sessions: no progress chatter
      if (state.mood !== "asking") setMood("working", d);
      narrate(`[system] progress update (only mention if natural, one short sentence max): Claude Code is ${d}.`, { throttle: true });
      return;
    }
    case "PermissionRequest":
      askPermission(s, describe(p.tool_name ?? "a tool", p.tool_input).replace(/^(\w)/, (c) => c.toLowerCase()));
      return;
    case "Notification": {
      const msg = String(p.message ?? "");
      if (p.notification_type === "permission_prompt" || /permission/i.test(msg)) askPermission(s, msg.replace(/^Claude needs your permission to /i, ""));
      return;
    }
    case "PostToolUse":
    case "PostToolUseFailure":
      if (s.pendingPermission || s.pendingQuestion) {
        s.pendingPermission = undefined;
        s.pendingQuestion = undefined;
        done();
        if (fg) setMood("working", "back to work"); else if (state.mood === "asking") focusMood();
      }
      return;
    case "Stop": {
      if (!s.busy && !s.pendingPermission) return;
      s.busy = false;
      s.currentTool = undefined;
      s.pendingPermission = undefined;
      s.pendingQuestion = undefined;
      const text = String(p.last_assistant_message ?? "") || lastAssistantText(s.transcriptPath);
      s.lastText = text;
      done();
      if (text) recordTurn("agent", text, s.directory);
      const files = gitDiff(p.cwd ?? s.directory);
      const fileLine = files.length
        ? files.slice(0, 12).map((f) => `${f.file} (${f.status}, +${f.additions} -${f.deletions})`).join("; ")
        : "no uncommitted file changes";
      if (fg) {
        if (files.length) emit({ type: "diff", files });
        setMood("happy", "done!", 7000);
        narrate(
          `[system] ${who(s).name} finished. Tell the user out loud, briefly and in plain words, what was done or what it answered. ` +
            `Do not read code or paths character by character.\nUncommitted changes in the repo: ${fileLine}\nClaude's final message:\n${text.slice(0, 3000)}`,
          { urgent: true },
        );
      } else {
        pushActivity(`✅ ${label(s)} finished`);
        if (!state.busy && state.mood !== "asking") setMood("happy", `${label(s)} done!`, 6000);
        narrate(
          `[system] ${who(s).name} finished its task. In one or two short sentences, tell the user which project finished and the gist of it. ` +
            `Do not read code or paths.\nUncommitted changes there: ${fileLine}\nClaude's final message:\n${text.slice(0, 1500)}`,
          { urgent: true },
        );
      }
      return;
    }
    case "SessionEnd":
      s.busy = false;
      done();
      // /clear and /resume end one Claude session and start another in the same pane. For a real
      // exit, liveness decides (SessionEnd doesn't always fire, and the pane may already be gone).
      setTimeout(prune, 1500);
      if (fg) setMood("idle", "bye for now");
      return;
  }
}

// ---------- voice tools for Claude Code ----------
type ToolFn = (args: any) => Promise<unknown>;
const waitingPermission = (s: ClaudeSession) => !!s.pendingPermission;
const waitingQuestion = (s: ClaudeSession) => !!s.pendingQuestion;

function status(s: ClaudeSession) {
  return {
    session: s.n,
    project: basename(s.directory),
    busy: s.busy,
    current_step: s.currentTool ?? null,
    todos: s.todos.map((t) => `[${t.status}] ${t.content}`),
    last_request: s.lastPrompt.slice(0, 300) || null,
    latest_agent_text: s.lastText.slice(-800),
    pending_permission: s.pendingPermission?.what ?? null,
    pending_question: s.pendingQuestion?.questions?.map((q: any) => q.question) ?? null,
  };
}

export const claudeTools: Record<string, ToolFn> = {
  async code_task({ instruction, session }) {
    const r = pick(session);
    if (!r.s) return r.error;
    const s = r.s;
    const wasBusy = s.busy;
    await typeLine(s, String(instruction));
    if (!isFocused(s)) focus(s, false);
    setMood("thinking", "on it…");
    return {
      started: true,
      session: s.n,
      project: basename(s.directory),
      note: wasBusy
        ? "Claude Code is still busy; the message was queued and it will pick it up next. Tell the user briefly."
        : "Working in the background. Tell the user you're on it (one short sentence).",
    };
  },
  async task_status({ session }) {
    const r = pick(session);
    if (!r.s) return r.error;
    const others = listSessions().filter((x) => x.session !== r.s.n);
    return {
      ...status(r.s),
      recent_activity: state.activity.slice(-8),
      ...(others.length ? { other_sessions: others.map((o) => `${o.session} ${o.project}: ${o.waiting_for_user ? `waiting for ${o.waiting_for_user}` : o.busy ? o.current_step : "idle"}`) } : {}),
    };
  },
  async list_running_sessions() {
    prune();
    const list = listSessions();
    return { count: list.length, sessions: list, note: list.length ? "Refer to sessions by number or project name." : "No Claude Code session is running. Start one with `cadbury` in a project folder." };
  },
  async focus_session({ session }) {
    const r = pick(session);
    if (!r.s) return r.error;
    focus(r.s);
    return { ok: true, ...status(r.s) };
  },
  async stop_task({ session }) {
    const r = pick(session, (s) => s.busy);
    if (!r.s) return r.error;
    key(r.s, "Escape");
    return { ok: true, session: r.s.n, project: basename(r.s.directory) };
  },
  async answer_permission({ reply, message, session }) {
    const r = pick(session, waitingPermission);
    if (!r.s) return r.error;
    const s = r.s;
    if (reply === "once") key(s, "1");
    else if (reply === "always") key(s, "2");
    else {
      key(s, "Escape");
      if (message) { await Bun.sleep(400); await typeLine(s, String(message)); }
    }
    s.pendingPermission = undefined;
    if (isFocused(s)) syncFocus();
    emitSessions();
    if (isFocused(s) && ![...sessions.values()].some((x) => x.pendingPermission || x.pendingQuestion))
      setMood(reply === "reject" ? "idle" : "working", reply === "reject" ? "okay, skipping that" : "allowed, back to work");
    else focusMood();
    return { ok: true, session: s.n, project: basename(s.directory) };
  },
  async answer_question({ answers, session }) {
    const r = pick(session, waitingQuestion);
    if (!r.s) return r.error;
    const s = r.s;
    const qs = s.pendingQuestion?.questions ?? [];
    for (let i = 0; i < (answers?.length ?? 0); i++) {
      const want = String(answers[i]?.[0] ?? "").toLowerCase();
      const idx = (qs[i]?.options ?? []).findIndex((o: any) => String(o.label).toLowerCase() === want || want.includes(String(o.label).toLowerCase()));
      if (idx >= 0) key(s, String(idx + 1));
      else await typeLine(s, String(answers[i]?.[0] ?? ""));
      await Bun.sleep(350);
    }
    s.pendingQuestion = undefined;
    if (isFocused(s)) syncFocus();
    emitSessions();
    if (isFocused(s)) setMood("working", "got it"); else focusMood();
    return { ok: true, session: s.n, project: basename(s.directory) };
  },
  async show_diff({ session }) {
    const r = pick(session);
    const dir = r.s?.directory ?? state.directory;
    const files = gitDiff(dir);
    emit({ type: "diff", files });
    return { project: basename(dir), files: files.map((f) => ({ file: f.file, status: f.status, additions: f.additions, deletions: f.deletions })) };
  },
  async new_session({ session }) {
    const r = pick(session);
    if (!r.s) return r.error;
    await typeLine(r.s, "/clear");
    r.s.busy = false;
    if (isFocused(r.s)) syncFocus();
    return { ok: true, session: r.s.n };
  },
  async list_sessions() {
    return { ...(await claudeTools.list_running_sessions({})) as object, note: "These are the Claude Code sessions running right now. For older conversations, say 'resume' and I'll open Claude's session picker." };
  },
  async resume_session({ session }) {
    const r = pick(session);
    if (!r.s) return r.error;
    await typeLine(r.s, "/resume");
    return { ok: true, note: "Opened Claude Code's session picker in the terminal; the user picks one there." };
  },
  async switch_project({ name }) {
    const r = pick(name);
    if (r.s) { focus(r.s); return { ok: true, project: basename(r.s.directory), session: r.s.n, note: "Switched to the Claude Code session already running there." }; }
    return { ok: false, reason: `No Claude Code session is running in "${name}". To work there, run \`cadbury\` in that project's folder.`, sessions: listSessions() };
  },
};

// keep the list honest: notice sessions whose Claude has exited
setInterval(() => { if (state.harness === "claude" && sessions.size) prune(); }, 20_000);
