// Tracks what opencode is doing and turns it into cat moods + narration.
import { oc } from "./opencode";
import { recordTurn } from "./memory";

export type Mood =
  | "sleeping" | "idle" | "listening" | "talking" | "thinking"
  | "working" | "asking" | "happy" | "oops";

export type UiEvent =
  | { type: "mood"; mood: Mood; status: string }
  | { type: "activity"; text: string }
  | { type: "narrate"; text: string; speak: boolean; urgent?: boolean }
  | { type: "diff"; files: DiffFile[] }
  | { type: "context"; directory: string; sessionID?: string; title?: string }
  | { type: "sessions"; focus?: number; sessions: { session: number; project: string; in_focus: boolean; busy: boolean; waiting_for_user: string | null }[] };

export interface DiffFile { file?: string; additions: number; deletions: number; status?: string; patch?: string }

type Listener = (e: UiEvent) => void;
const listeners = new Set<Listener>();
export function subscribe(l: Listener) { listeners.add(l); return () => listeners.delete(l); }
export function emit(e: UiEvent) { for (const l of listeners) l(e); }

export const state = {
  directory: process.env.DEFAULT_PROJECT || process.cwd(),
  sessionID: undefined as string | undefined,
  sessionTitle: undefined as string | undefined,
  busy: false,
  mood: "idle" as Mood,
  status: "napping, ready when you are",
  currentTool: undefined as string | undefined,
  todos: [] as { content: string; status: string }[],
  activity: [] as string[],
  lastText: "",
  pendingPermission: undefined as any,
  pendingQuestion: undefined as any,
  lastActivityAt: Date.now(),
  lastNarrateAt: 0,
  hadError: false,
  harness: (process.env.CADBURY_HARNESS === "opencode" ? "opencode" : "claude") as "opencode" | "claude",
  tmuxTarget: undefined as string | undefined,
  tmuxSocket: undefined as string | undefined,
  language: undefined as string | undefined,
  transcriptPath: undefined as string | undefined,
};

const parents = new Map<string, string | undefined>(); // sessionID -> parentID
const seenCalls = new Map<string, string>(); // callID -> last status
let moodTimer: Timer | undefined;

export function setMood(mood: Mood, status?: string, revertMs?: number) {
  state.mood = mood;
  if (status !== undefined) state.status = status;
  state.lastActivityAt = Date.now();
  emit({ type: "mood", mood, status: state.status });
  clearTimeout(moodTimer);
  if (revertMs) moodTimer = setTimeout(() => setMood(state.busy ? "working" : "idle", state.busy ? state.status : "ready for the next thing"), revertMs);
}

export function pushActivity(text: string) {
  state.activity.push(text);
  if (state.activity.length > 30) state.activity.shift();
  emit({ type: "activity", text });
}

// ---- preferences (same file the desktop app uses for pet size) ----
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const CONFIG = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const PREFS = join(CONFIG, "cadbury", "prefs.json");
const LEGACY_PREFS = join(CONFIG, "mochi", "prefs.json"); // before the rename; read until the first save writes PREFS
export function loadPrefs(): any {
  for (const f of [PREFS, LEGACY_PREFS]) { try { return JSON.parse(readFileSync(f, "utf8")); } catch {} }
  return {};
}
export function savePref(key: string, value: unknown) {
  try { mkdirSync(dirname(PREFS), { recursive: true }); writeFileSync(PREFS, JSON.stringify({ ...loadPrefs(), [key]: value }, null, 2)); } catch {}
}

export function describeLanguage(l: string) {
  return /^hinglish$/i.test(l)
    ? "Hinglish (casual, conversational Hindi-English mix the way Indian developer friends talk on a call, e.g. 'maine login page add kar diya, ab tests run karte hain'; use everyday words like acha, haan, chalo, bas, arre; keep technical terms in English; never switch to pure or formal Hindi)"
    : l;
}

/** Language the cat should always answer in (set by voice: "talk to me in Hindi"). */
export function languageRule() {
  return state.language
    ? `Reply in ${describeLanguage(state.language)}, even though this message is in English.`
    : `Reply in the same language the user has been speaking with you, even though this message is in English.`;
}

export function narrate(text: string, opts: { urgent?: boolean; throttle?: boolean } = {}) {
  const now = Date.now();
  if (opts.throttle && now - state.lastNarrateAt < 25_000) return;
  state.lastNarrateAt = now;
  emit({ type: "narrate", text: `${text}\n(${languageRule()})`, speak: true, urgent: opts.urgent });
}

export function setContext(directory: string, sessionID?: string, title?: string) {
  state.directory = directory;
  state.sessionID = sessionID;
  state.sessionTitle = title;
  emit({ type: "context", directory, sessionID, title });
}

function isRoot(sessionID: string) {
  return !parents.get(sessionID);
}

function belongsToUs(sessionID: string | undefined, directory: string | undefined) {
  if (!sessionID) return false;
  if (sessionID === state.sessionID) return true;
  // a child (subagent) of our session
  if (parents.get(sessionID) === state.sessionID) return true;
  return false;
}

function describeTool(part: any): string {
  const s = part.state ?? {};
  const inp = s.input ?? {};
  const file = (inp.filePath || inp.path || "").split("/").pop();
  switch (part.tool) {
    case "edit": case "write": case "patch": case "apply_patch": return `editing ${file || "files"}`;
    case "read": return `reading ${file || "a file"}`;
    case "bash": return `running \`${String(inp.command ?? "").slice(0, 60)}\``;
    case "grep": case "glob": case "list": return `searching ${inp.pattern ? `for ${String(inp.pattern).slice(0, 40)}` : "the code"}`;
    case "webfetch": return "reading a web page";
    case "todowrite": return "planning the steps";
    case "task": return `sending a helper: ${String(inp.description ?? "").slice(0, 50)}`;
    default: return s.title || `using ${part.tool}`;
  }
}

async function finishTask(sessionID: string, directory: string) {
  state.busy = false;
  state.currentTool = undefined;
  if (state.hadError) { state.hadError = false; return; } // error was already narrated
  let finalText = state.lastText;
  let files: DiffFile[] = [];
  try {
    const msgs = await oc<any[]>("GET", `/session/${sessionID}/message`, { directory });
    const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant");
    if (lastAssistant) {
      const t = lastAssistant.parts.filter((p: any) => p.type === "text" && !p.synthetic).map((p: any) => p.text).join("\n");
      if (t.trim()) finalText = t;
      if (lastAssistant.info?.error) {
        const err = lastAssistant.info.error;
        if (err.name === "MessageAbortedError") {
          setMood("idle", "stopped");
          narrate("[system] The coding task was stopped.", { urgent: true });
          return;
        }
      }
    }
  } catch (e) { console.warn("[cadbury] fetch messages failed", e); }
  try {
    files = await oc<DiffFile[]>("GET", `/session/${sessionID}/diff`, { directory });
  } catch {}
  if (files.length) emit({ type: "diff", files });
  const fileLine = files.length
    ? files.slice(0, 12).map((f) => `${f.file} (${f.status ?? "modified"}, +${f.additions} -${f.deletions})`).join("; ")
    : "no files changed";
  if (finalText) recordTurn("agent", finalText, directory);
  setMood("happy", "done!", 7000);
  narrate(
    `[system] opencode finished the task. Tell the user out loud, briefly and in plain words, what was done. ` +
      `Do not read code or paths character by character.\nFiles changed: ${fileLine}\nAgent's final message:\n${finalText.slice(0, 3000)}`,
    { urgent: true },
  );
}

export function handleEvent(directory: string | undefined, ev: any) {
  if (state.harness !== "opencode") return;
  const p = ev?.properties ?? {};
  const sid: string | undefined = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
  switch (ev?.type) {
    case "session.created":
    case "session.updated": {
      const info = p.info;
      if (info?.id) parents.set(info.id, info.parentID);
      if (info?.id === state.sessionID && info.title) state.sessionTitle = info.title;
      return;
    }
    case "message.updated": {
      // A user prompt in any root session (e.g. typed in the TUI) makes it the session we follow.
      const info = p.info;
      if (info?.role === "user" && sid && isRoot(sid) && sid !== state.sessionID) {
        setContext(directory ?? info.path?.cwd ?? state.directory, sid);
      }
      return;
    }
    case "session.status": {
      if (!belongsToUs(sid, directory) || !isRoot(sid!)) return;
      const t = p.status?.type;
      if (t === "busy" && !state.busy) {
        state.busy = true;
        state.lastText = "";
        state.todos = [];
        state.hadError = false;
        seenCalls.clear();
        setMood("thinking", "thinking…");
      } else if (t === "idle" && state.busy) {
        finishTask(sid!, directory ?? state.directory);
      } else if (t === "retry") {
        setMood("oops", `retrying: ${p.status.message ?? ""}`.slice(0, 80));
      }
      return;
    }
    case "session.idle": {
      if (sid === state.sessionID && state.busy) finishTask(sid, directory ?? state.directory);
      return;
    }
    case "message.part.updated": {
      if (!belongsToUs(sid, directory)) return;
      const part = p.part;
      if (part?.type === "tool") {
        const st = part.state?.status;
        if (seenCalls.get(part.callID) === st) return;
        seenCalls.set(part.callID, st);
        if (st === "running") {
          const d = describeTool(part);
          state.currentTool = d;
          pushActivity(d);
          if (state.mood !== "asking") setMood("working", d);
          narrate(`[system] progress update (only mention if natural, one short sentence max): opencode is ${d}.`, { throttle: true });
        } else if (st === "error") {
          pushActivity(`⚠ ${part.tool} failed`);
        }
      } else if (part?.type === "text" && !part.synthetic) {
        // assistant text (user text parts come through too, but those precede busy)
        if (state.busy) {
          state.lastText = part.text ?? state.lastText;
          if (state.mood !== "asking" && state.mood !== "working") setMood("thinking", "thinking…");
        }
      }
      return;
    }
    case "todo.updated": {
      if (!belongsToUs(sid, directory)) return;
      state.todos = p.todos ?? [];
      return;
    }
    case "permission.asked": {
      if (!belongsToUs(sid, directory)) return;
      state.pendingPermission = { ...p, directory };
      const what = `${p.permission}${p.patterns?.length ? `: ${p.patterns.join(", ")}` : ""}`;
      pushActivity(`❓ permission: ${what}`);
      setMood("asking", `may I? ${what}`.slice(0, 90));
      narrate(
        `[system] opencode needs permission for "${what}". Ask the user whether to allow it once, always, or reject. ` +
          `Then call answer_permission.`,
        { urgent: true },
      );
      return;
    }
    case "permission.replied": {
      if (state.pendingPermission?.id === (p.requestID ?? p.permissionID ?? p.id)) state.pendingPermission = undefined;
      if (state.mood === "asking") setMood(state.busy ? "working" : "idle", state.busy ? "back to work" : "ready");
      return;
    }
    case "question.asked": {
      if (!belongsToUs(sid, directory)) return;
      state.pendingQuestion = { ...p, directory };
      const qs = (p.questions ?? [])
        .map((q: any, i: number) => `${i + 1}. ${q.question} Options: ${(q.options ?? []).map((o: any) => o.label).join(" / ")}`)
        .join("\n");
      setMood("asking", (p.questions?.[0]?.header ?? "a question for you").slice(0, 80));
      narrate(`[system] opencode is asking the user to decide:\n${qs}\nAsk them, then call answer_question.`, { urgent: true });
      return;
    }
    case "question.replied":
    case "question.rejected": {
      state.pendingQuestion = undefined;
      if (state.mood === "asking") setMood(state.busy ? "working" : "idle");
      return;
    }
    case "session.error": {
      if (!belongsToUs(sid, directory)) return;
      const err = p.error;
      if (err?.name === "MessageAbortedError") return;
      const msg = err?.data?.message ?? err?.name ?? "unknown error";
      state.hadError = true;
      setMood("oops", `uh oh: ${msg}`.slice(0, 90), 8000);
      narrate(`[system] opencode hit an error: ${msg}. Tell the user briefly.`, { urgent: true });
      return;
    }
  }
}

// Fall asleep after 5 min of nothing.
setInterval(() => {
  if (!state.busy && state.mood === "idle" && Date.now() - state.lastActivityAt > 5 * 60_000) setMood("sleeping", "zzz…");
}, 15_000);

// Default: CADBURY_LANGUAGE, else Hinglish (CADBURY_LANGUAGE= empty → match the user). A saved voice choice wins ("auto" is saved as null).
{
  const prefs = loadPrefs();
  state.language = "language" in prefs ? prefs.language || undefined : (process.env.CADBURY_LANGUAGE ?? "Hinglish") || undefined;
}
