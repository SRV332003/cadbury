// Tools the realtime voice model can call. Each maps onto opencode's API.
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { oc } from "./opencode";
import { state, setContext, setMood, emit, savePref, type DiffFile } from "./state";

const ROOTS = (process.env.PROJECT_ROOTS ?? `${homedir()}/Storage/projects,${homedir()}/Storage/Projects,${homedir()}/Storage`)
  .split(",").map((s) => s.trim()).filter(Boolean);

function listProjectDirs(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const root of ROOTS) {
    let entries: string[] = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const e of entries) {
      if (e.startsWith(".") || e.startsWith("_")) continue;
      const p = join(root, e);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ name: e, path: p });
    }
  }
  return out;
}

/** Make the attached opencode TUI show this session too. */
export async function showInTui(sessionID: string) {
  try { await oc("POST", "/tui/select-session", { directory: state.directory, body: { sessionID } }); } catch {}
}

async function ensureSession(): Promise<string> {
  if (state.sessionID) return state.sessionID;
  const s = await oc<any>("POST", "/session", { directory: state.directory, body: { title: "Mochi voice session" } });
  setContext(state.directory, s.id, s.title);
  showInTui(s.id);
  return s.id;
}

export const toolSchemas = [
  {
    type: "function",
    name: "set_language",
    description:
      "Call this whenever the user asks you to speak in a particular language (e.g. 'talk to me in Hindi', 'English please', 'Hinglish mein bolo'). " +
      "It is remembered for every future reply, including your summaries of what the coding agent did. Use 'auto' to go back to matching the user.",
    parameters: {
      type: "object",
      properties: { language: { type: "string", description: "e.g. Hindi, English, Hinglish (Hindi-English mix), Tamil, or auto" } },
      required: ["language"],
    },
  },
  {
    type: "function",
    name: "code_task",
    description:
      "Send a coding instruction to the coding agent (Claude Code or opencode) working in the current project (it can read, write and edit files, run shell commands, tests, git, etc.). " +
      "Returns immediately; you will get a [system] message when it finishes. Rewrite the user's spoken request into a clear, complete instruction. " +
      "Also use this for questions about the codebase that require reading files.",
    parameters: {
      type: "object",
      properties: { instruction: { type: "string", description: "Clear, self-contained instruction for the coding agent" } },
      required: ["instruction"],
    },
  },
  { type: "function", name: "task_status", description: "What the coding agent is doing right now: current step, todo list, recent activity, any pending permission/question.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "stop_task", description: "Stop / abort the running coding task.", parameters: { type: "object", properties: {} } },
  {
    type: "function",
    name: "answer_permission",
    description: "Reply to the coding agent's pending permission request after asking the user.",
    parameters: {
      type: "object",
      properties: {
        reply: { type: "string", enum: ["once", "always", "reject"] },
        message: { type: "string", description: "Optional note to the agent, e.g. what to do instead when rejecting" },
      },
      required: ["reply"],
    },
  },
  {
    type: "function",
    name: "answer_question",
    description: "Answer the coding agent's pending multiple-choice question(s). One answer array per question, using option labels (or the user's own words).",
    parameters: {
      type: "object",
      properties: { answers: { type: "array", items: { type: "array", items: { type: "string" } } } },
      required: ["answers"],
    },
  },
  { type: "function", name: "show_diff", description: "Get the list of files changed in this session (and show the diff on screen).", parameters: { type: "object", properties: {} } },
  { type: "function", name: "list_projects", description: "List project folders the user can switch to.", parameters: { type: "object", properties: {} } },
  {
    type: "function",
    name: "switch_project",
    description: "Switch the working project (folder). Resumes its most recent session.",
    parameters: { type: "object", properties: { name: { type: "string", description: "Project folder name (fuzzy)" } }, required: ["name"] },
  },
  { type: "function", name: "new_session", description: "Start a fresh coding-agent session in the current project.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "list_sessions", description: "List recent sessions in the current project.", parameters: { type: "object", properties: {} } },
  {
    type: "function",
    name: "resume_session",
    description: "Resume a session from list_sessions by id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

type ToolFn = (args: any) => Promise<unknown>;

export const tools: Record<string, ToolFn> = {
  async set_language({ language }) {
    const l = String(language ?? "").trim();
    state.language = !l || /^auto$/i.test(l) ? undefined : l;
    savePref("language", state.language ?? null);
    return { ok: true, language: state.language ?? "auto (match the user)", note: "From now on, always reply in this language." };
  },

  async code_task({ instruction }) {
    const id = await ensureSession();
    await oc("POST", `/session/${id}/prompt_async`, {
      directory: state.directory,
      body: { parts: [{ type: "text", text: String(instruction) }] },
    });
    setMood("thinking", "on it…");
    return { started: true, project: basename(state.directory), note: "Working in the background. Tell the user you're on it (one short sentence)." };
  },

  async task_status() {
    return {
      project: basename(state.directory),
      session: state.sessionTitle ?? state.sessionID ?? null,
      busy: state.busy,
      current_step: state.currentTool ?? null,
      todos: state.todos.map((t) => `[${t.status}] ${t.content}`),
      recent_activity: state.activity.slice(-8),
      latest_agent_text: state.lastText.slice(-800),
      pending_permission: state.pendingPermission ? `${state.pendingPermission.permission}: ${(state.pendingPermission.patterns ?? []).join(", ")}` : null,
      pending_question: state.pendingQuestion?.questions?.map((q: any) => q.question) ?? null,
    };
  },

  async stop_task() {
    if (!state.sessionID) return { ok: false, reason: "no session" };
    await oc("POST", `/session/${state.sessionID}/abort`, { directory: state.directory });
    return { ok: true };
  },

  async answer_permission({ reply, message }) {
    const p = state.pendingPermission;
    if (!p) return { ok: false, reason: "no pending permission" };
    await oc("POST", `/permission/${p.id}/reply`, { directory: p.directory ?? state.directory, body: { reply, ...(message ? { message } : {}) } });
    state.pendingPermission = undefined;
    setMood(state.busy ? "working" : "idle", reply === "reject" ? "okay, skipping that" : "allowed, back to work");
    return { ok: true };
  },

  async answer_question({ answers }) {
    const q = state.pendingQuestion;
    if (!q) return { ok: false, reason: "no pending question" };
    await oc("POST", `/question/${q.id}/reply`, { directory: q.directory ?? state.directory, body: { answers } });
    state.pendingQuestion = undefined;
    setMood(state.busy ? "working" : "idle", "got it");
    return { ok: true };
  },

  async show_diff() {
    if (!state.sessionID) return { files: [] };
    const files = await oc<DiffFile[]>("GET", `/session/${state.sessionID}/diff`, { directory: state.directory });
    emit({ type: "diff", files });
    return { files: files.map((f) => ({ file: f.file, status: f.status, additions: f.additions, deletions: f.deletions })) };
  },

  async list_projects() {
    return { current: basename(state.directory), projects: listProjectDirs().map((p) => p.name) };
  },

  async switch_project({ name }) {
    const all = listProjectDirs();
    const n = String(name).toLowerCase().replace(/[\s_-]/g, "");
    const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
    const hit = all.find((p) => norm(p.name) === n) ?? all.find((p) => norm(p.name).includes(n)) ?? all.find((p) => n.includes(norm(p.name)));
    if (!hit) return { ok: false, reason: `no project matching "${name}"`, projects: all.map((p) => p.name) };
    let latest: any;
    try {
      const sessions = await oc<any[]>("GET", "/session", { directory: hit.path });
      latest = sessions.filter((s) => !s.parentID && s.directory === hit.path).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
    } catch {}
    setContext(hit.path, latest?.id, latest?.title);
    if (latest?.id) showInTui(latest.id);
    state.busy = false;
    setMood("idle", `in ${hit.name}`);
    return { ok: true, project: hit.name, path: hit.path, resumed_session: latest?.title ?? null };
  },

  async new_session() {
    const s = await oc<any>("POST", "/session", { directory: state.directory, body: { title: "Mochi voice session" } });
    setContext(state.directory, s.id, s.title);
    state.busy = false;
    showInTui(s.id);
    return { ok: true, id: s.id };
  },

  async list_sessions() {
    const sessions = await oc<any[]>("GET", "/session", { directory: state.directory });
    return sessions
      .filter((s) => !s.parentID && s.directory === state.directory)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, 8)
      .map((s) => ({ id: s.id, title: s.title, updated: new Date(s.time?.updated ?? 0).toLocaleString() }));
  },

  async resume_session({ id }) {
    const s = await oc<any>("GET", `/session/${id}`, { directory: state.directory });
    setContext(s.directory ?? state.directory, s.id, s.title);
    showInTui(s.id);
    return { ok: true, title: s.title };
  },
};

/** Run a voice tool against whichever harness the cat is following. */
export async function runTool(name: string, args: any): Promise<unknown> {
  const { claudeTools } = await import("./claude");
  const fn = (state.harness === "claude" ? claudeTools[name] : undefined) ?? tools[name];
  if (!fn) return { error: `unknown tool ${name}` };
  return fn(args ?? {});
}
