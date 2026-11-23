// Public face of the memory engine. The rest of the bridge only imports from here.
import { applyOps, decidePending, listPending, renderForPrompt, readEntries, usage, fileFor, memoryDir, type Target } from "./store";
import { logTurn, search, recentSessions, type Role } from "./sessions";
import { noteTurn, review } from "./review";
import { llmConfigured, LLM_MODEL, LLM_URL } from "./llm";

export { memoryToolSchemas } from "./schemas";
export { renderForPrompt };

/** Record one line of conversation (or task/agent output) and let the review scheduler know. */
export function recordTurn(role: Role, text: string, project: string) {
  try {
    const r = logTurn(role, text, project);
    if (r) noteTurn(r.sessionId, role);
  } catch (e) {
    console.warn("[cadbury] memory: could not log turn", (e as Error).message);
  }
}

/** Voice tools. `project()` returns the folder the cat is following right now. */
export function memoryTools(project: () => string): Record<string, (args: any) => Promise<unknown>> {
  return {
    async memory({ target, operations }) {
      return applyOps(target as Target, Array.isArray(operations) ? operations : [], { source: "voice", projectDir: project() });
    },
    async session_search(args) {
      return search(args ?? {});
    },
    async memory_pending({ action, id }) {
      if (action === "list") {
        const list = listPending();
        if (!list.length) return { result: "Nothing is waiting for approval." };
        return {
          result: list.map((p) => ({
            id: p.id,
            change: p.op.action === "remove" ? `forget "${p.entry}"` : `change "${p.entry}" to "${p.op.content}"`,
            in: p.target,
          })),
        };
      }
      if (!id) return { ok: false, error: "approve/reject needs the id from list." };
      return decidePending(String(id), action === "approve");
    },
  };
}

/** Everything a human (or the phone remote) might want to see: GET /api/memory */
export function overview(projectDir: string) {
  const t = (target: Target) => ({ file: fileFor(target, projectDir), entries: readEntries(target, projectDir), ...usage(target, projectDir) });
  return {
    folder: memoryDir(),
    user: t("user"),
    project: t("project"),
    notes: t("memory"),
    pending: listPending(),
    recent_sessions: recentSessions(5),
    review_model: llmConfigured() ? `${LLM_MODEL} at ${LLM_URL}` : "off (set CADBURY_MEMORY_LLM_URL and CADBURY_MEMORY_MODEL)",
  };
}

export { review, decidePending };
