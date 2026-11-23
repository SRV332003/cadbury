// Long-term memory: small, capped Markdown files the cat reads at the start of every conversation.
// Design follows Hermes Agent's MEMORY.md / USER.md (MIT, Nous Research): plain entries separated by
// a "§" line, a hard character budget, one atomic batch tool, and add-only background writes.
// ALL memory writes go through applyOps() / decidePending() in this file.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { threat } from "./scan";

export type Target = "user" | "memory" | "project";
export type Op = { action: "add" | "patch" | "remove" | "clear"; content?: string; old_text?: string };
export type Source = "voice" | "review" | "user";

const SEP = "\n§\n";
const LIMITS: Record<Target, number> = {
  user: Number(process.env.CADBURY_MEMORY_USER_CHARS ?? 1375),
  memory: Number(process.env.CADBURY_MEMORY_NOTES_CHARS ?? 2200),
  project: Number(process.env.CADBURY_MEMORY_PROJECT_CHARS ?? 1500),
};
const TITLES: Record<Target, string> = {
  user: "ABOUT THE USER (who they are, what they like)",
  memory: "CADBURY'S NOTES (lessons about working with this user)",
  project: "THIS PROJECT",
};
const HEADERS: Record<Target, string> = {
  user: "<!-- Cadbury remembers this about you. One fact per entry; entries are separated by a line with just §. You can edit or delete anything. -->",
  memory: "<!-- Cadbury's own notes about working with you. One note per entry; entries are separated by a line with just §. You can edit or delete anything. -->",
  project: "<!-- What Cadbury remembers about this project. One fact per entry; entries are separated by a line with just §. You can edit or delete anything. -->",
};

export function memoryDir() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "cadbury", "memory");
}

/** projects/<folder-name>-<short hash of full path>.md, so two "api" folders don't collide. */
export function projectSlug(dir: string) {
  const name = basename(dir).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "project";
  return `${name}-${createHash("sha1").update(dir).digest("hex").slice(0, 6)}`;
}

export function fileFor(target: Target, projectDir?: string) {
  if (target === "user") return join(memoryDir(), "USER.md");
  if (target === "memory") return join(memoryDir(), "MEMORY.md");
  return join(memoryDir(), "projects", `${projectSlug(projectDir ?? process.cwd())}.md`);
}

export function readEntries(target: Target, projectDir?: string): string[] {
  let raw = "";
  try { raw = readFileSync(fileFor(target, projectDir), "utf8"); } catch { return []; }
  const seen = new Set<string>();
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\n\s*§\s*\n/)
    .map((e) => e.trim())
    .filter((e) => e && !seen.has(e) && seen.add(e));
}

function writeEntries(target: Target, entries: string[], projectDir?: string) {
  const file = fileFor(target, projectDir);
  mkdirSync(join(file, ".."), { recursive: true });
  const header = target === "project" && projectDir ? `${HEADERS.project}\n<!-- folder: ${projectDir} -->` : HEADERS[target];
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${header}\n\n${entries.join(SEP)}\n`);
  renameSync(tmp, file); // atomic: a crash never leaves a half-written file
}

const size = (entries: string[]) => entries.join(SEP).length;
export function usage(target: Target, projectDir?: string) {
  const used = size(readEntries(target, projectDir));
  return { used, limit: LIMITS[target], percent: Math.round((100 * used) / LIMITS[target]) };
}

// ---------- matching old_text to an entry (forgiving, like Hermes) ----------
const norm = (s: string) =>
  s.toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—−]/g, "-").replace(/\s+/g, " ").trim();
const words = (s: string) => new Set(norm(s).split(/[^a-z0-9ऀ-ॿ]+/).filter((w) => w.length > 2));

function findEntry(entries: string[], oldText: string): { index: number } | { error: string } {
  const exact = entries.indexOf(oldText.trim());
  if (exact >= 0) return { index: exact };
  for (const test of [(e: string) => e.includes(oldText.trim()), (e: string) => norm(e).includes(norm(oldText))]) {
    const hits = entries.map((e, i) => (test(e) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return { index: hits[0] };
    if (hits.length > 1) return { error: `"${oldText}" matches ${hits.length} entries; quote more of the one you mean: ${hits.map((i) => JSON.stringify(entries[i])).join(", ")}` };
  }
  const want = words(oldText);
  const close = entries
    .map((e) => ({ e, score: [...words(e)].filter((w) => want.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => JSON.stringify(x.e));
  return { error: `No entry matches "${oldText}".${close.length ? ` Closest: ${close.join(", ")}` : " That memory is empty or has nothing similar."}` };
}

// ---------- pending changes (background review may only add; edits wait for the user) ----------
export interface Pending { id: string; target: Target; projectDir?: string; op: Op; entry?: string; at: string }
const pendingFile = () => join(memoryDir(), "pending.json");
export function listPending(): Pending[] {
  try { return JSON.parse(readFileSync(pendingFile(), "utf8")); } catch { return []; }
}
function savePending(list: Pending[]) {
  mkdirSync(memoryDir(), { recursive: true });
  const tmp = `${pendingFile()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, pendingFile());
}

// ---------- the one way to change memory ----------
let failures = 0, lastFailureAt = 0;

export function applyOps(target: Target, ops: Op[], opts: { source: Source; projectDir?: string }) {
  if (!LIMITS[target]) return { ok: false, error: `Unknown target "${target}". Use user, project or memory.` };
  if (!Array.isArray(ops) || !ops.length) return { ok: false, error: "Give at least one operation." };
  if (Date.now() - lastFailureAt > 120_000) failures = 0;
  if (opts.source === "voice" && failures >= 3) {
    failures = 0;
    return { ok: false, error: "Stop retrying memory calls for now. Tell the user it didn't save and continue with your reply." };
  }
  const fail = (error: string) => {
    if (opts.source === "voice") { failures++; lastFailureAt = Date.now(); }
    return { ok: false, error };
  };

  const entries = readEntries(target, opts.projectDir);
  const staged: Pending[] = [];
  let next = [...entries];
  for (const op of ops) {
    const content = op.content?.trim();
    if (content) {
      const bad = threat(content);
      if (bad) return fail(`Refused: this looks like ${bad}. Memory only holds plain facts.`);
    }
    if (op.action === "clear") {
      if (opts.source === "review") return fail("The background review cannot clear memory.");
      next = [];
      continue;
    }
    if (op.action === "add") {
      if (!content) return fail("add needs content.");
      if (!next.includes(content)) next.push(content); // exact duplicate: quietly a no-op
      continue;
    }
    if (op.action !== "patch" && op.action !== "remove") return fail(`Unknown action "${op.action}". Use add, patch, remove or clear.`);
    if (!op.old_text?.trim()) return fail(`${op.action} needs old_text (a quote from the entry).`);
    if (op.action === "patch" && !content) return fail("patch needs content (the new text).");
    const hit = findEntry(next, op.old_text);
    if ("error" in hit) return fail(hit.error);
    if (opts.source === "review") {
      // never change or delete unattended: stage it for the user, tied to the exact entry seen
      staged.push({ id: Math.random().toString(36).slice(2, 8), target, projectDir: target === "project" ? opts.projectDir : undefined, op, entry: next[hit.index], at: new Date().toISOString() });
      continue;
    }
    if (op.action === "remove") next.splice(hit.index, 1);
    else next[hit.index] = content!;
  }

  if (size(next) > LIMITS[target]) {
    return fail(
      `Not saved: ${target} memory would be ${size(next)}/${LIMITS[target]} characters. ` +
        `Retry as ONE batch that first removes or shortens old entries, then adds. Current entries: ${JSON.stringify(entries)}`,
    );
  }
  if (ops.some((o) => o.action === "clear") && entries.length) {
    // keep one backup so "forget everything" can be undone by hand
    try { copyFileSync(fileFor(target, opts.projectDir), `${fileFor(target, opts.projectDir)}.bak`); } catch {}
  }
  if (JSON.stringify(next) !== JSON.stringify(entries)) writeEntries(target, next, opts.projectDir);
  if (staged.length) savePending([...listPending(), ...staged]);
  failures = 0;
  const u = usage(target, opts.projectDir);
  return {
    ok: true,
    saved: staged.length
      ? `Saved additions. ${staged.length} change(s) to existing memories are waiting for the user's approval.`
      : "Write saved. This update is complete — do not repeat it.",
    usage: `${target} ${u.percent}% (${u.used}/${u.limit} chars)`,
  };
}

/** Approve or reject a staged change. Refused if the entry was edited since it was proposed. */
export function decidePending(id: string, approve: boolean) {
  const list = listPending();
  const p = list.find((x) => x.id === id);
  if (!p) return { ok: false, error: `No pending change with id ${id}.` };
  savePending(list.filter((x) => x.id !== id));
  if (!approve) return { ok: true, result: "Rejected; memory unchanged." };
  if (p.entry && !readEntries(p.target, p.projectDir).includes(p.entry)) {
    return { ok: false, error: "That memory was changed since this was proposed, so the proposal was dropped." };
  }
  return applyOps(p.target, [{ ...p.op, old_text: p.entry ?? p.op.old_text }], { source: "user", projectDir: p.projectDir });
}

// ---------- the snapshot that goes into the system prompt ----------
const LINE = "═".repeat(46);

/** Rendered once when a voice session starts (frozen, like Hermes), so the prompt stays stable. */
export function renderForPrompt(projectDir: string): string {
  const blocks: string[] = [];
  for (const target of ["user", "project", "memory"] as Target[]) {
    const entries = readEntries(target, projectDir).map((e) => {
      const bad = threat(e); // a hand-edited or old entry that looks unsafe is hidden from the model, kept on disk
      return bad ? `[BLOCKED: looked like ${bad}. The user can review it in ${basename(fileFor(target, projectDir))}.]` : e;
    });
    if (!entries.length) continue;
    const u = usage(target, projectDir);
    blocks.push(`${LINE}\n${TITLES[target]} [${u.percent}% — ${u.used}/${u.limit} chars]\n${LINE}\n${entries.join(SEP)}`);
  }
  const pending = listPending().length;
  if (pending) blocks.push(`(${pending} memory change(s) are waiting for the user's approval; mention it once at a natural pause and use memory_pending.)`);
  return blocks.join("\n\n");
}

export function hasMemory(projectDir: string) {
  return (["user", "project", "memory"] as Target[]).some((t) => existsSync(fileFor(t, projectDir)) && readEntries(t, projectDir).length);
}
