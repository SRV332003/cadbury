// Thin client for the opencode HTTP server + global event stream.
import { spawn } from "bun";

export const OC_PORT = Number(process.env.OPENCODE_PORT ?? 4096);
export const OC_URL = `http://127.0.0.1:${OC_PORT}`;

function qs(params: Record<string, string | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : "";
}

export async function oc<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; directory?: string; query?: Record<string, string> } = {},
): Promise<T> {
  const url = OC_URL + path + qs({ directory: opts.directory, ...(opts.query ?? {}) });
  const res = await fetch(url, {
    method,
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`opencode ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

export async function ocHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${OC_URL}/global/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Start `opencode serve` if nothing is listening on OC_PORT. */
export async function ensureOpencode(cwd: string) {
  if (await ocHealthy()) return;
  console.log(`[mochi] starting opencode serve on :${OC_PORT} (cwd ${cwd})`);
  spawn(["opencode", "serve", "--port", String(OC_PORT), "--hostname", "127.0.0.1"], {
    cwd,
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(250);
    if (await ocHealthy()) return;
  }
  throw new Error("opencode serve did not come up");
}

/** Subscribe to opencode's global SSE stream forever (auto-reconnect). */
export async function streamEvents(onEvent: (directory: string | undefined, ev: any) => void) {
  let warned = false;
  for (;;) {
    try {
      const res = await fetch(`${OC_URL}/global/event`, { headers: { accept: "text/event-stream" } });
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            const raw = JSON.parse(data);
            // /global/event wraps as { directory, payload }; /event is bare.
            const ev = raw?.payload?.type ? raw.payload : raw;
            onEvent(raw?.directory, ev);
          } catch (e) {
            console.warn("[mochi] bad event", e);
          }
        }
      }
    } catch (e) {
      if (!warned) console.warn("[mochi] opencode event stream dropped:", (e as Error).message);
      warned = true;
    }
    await Bun.sleep(1000);
  }
}
