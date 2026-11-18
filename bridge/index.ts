// Mochi bridge: serves the cat UI, relays opencode activity, runs voice tools.
import { join, normalize } from "node:path";
import { ensureOpencode, streamEvents, OC_URL } from "./opencode";
import { handleEvent, state, subscribe, setContext, emit, type UiEvent } from "./state";
import { runTool } from "./tools";
import { mintToken } from "./realtime";
import { geminiSocket, newLiveClient, GEMINI_MODEL } from "./gemini";
import { handleHook } from "./claude";

const VOICE_PROVIDER = (process.env.VOICE_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : "openai")).toLowerCase();

const PORT = Number(process.env.MOCHI_PORT ?? 8787);
const WEB = join(import.meta.dir, "..", "web");
const ALLOWED = process.env.ALLOWED_TS_USER?.trim();

// opencode server is only needed when following opencode
let ocStarted = false;
async function startOpencode() {
  if (ocStarted) return;
  ocStarted = true;
  await ensureOpencode(state.directory);
  streamEvents(handleEvent);
}
if (state.harness === "opencode") await startOpencode();
setContext(state.directory);

function authorized(req: Request) {
  // Requests proxied by `tailscale serve` carry the tailnet identity.
  const tsUser = req.headers.get("tailscale-user-login");
  if (tsUser && ALLOWED && tsUser !== ALLOWED) return false;
  return true;
}

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  websocket: geminiSocket,
  async fetch(req, server) {
    if (!authorized(req)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    const path = url.pathname;

    // Gemini Live voice proxy (key stays here)
    if (path === "/api/gemini-live") {
      if (server.upgrade(req, { data: newLiveClient() })) return undefined as any;
      return new Response("expected websocket", { status: 400 });
    }

    // which voice the page should use
    if (path === "/voice-config.js") {
      const cfg = {
        provider: VOICE_PROVIDER,
        halfDuplex: !!process.env.MOCHI_HALF_DUPLEX,
        bargeThreshold: process.env.MOCHI_BARGE_THRESHOLD ? Number(process.env.MOCHI_BARGE_THRESHOLD) : undefined,
      };
      return new Response(`window.MOCHI_VOICE = ${JSON.stringify(cfg)};`, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
    }

    if (path === "/api/health") return json({ ok: true, opencode: OC_URL });

    if (path === "/api/state") {
      return json({
        mood: state.mood, status: state.status, directory: state.directory, harness: state.harness,
        sessionID: state.sessionID, title: state.sessionTitle, busy: state.busy, activity: state.activity.slice(-10),
      });
    }

    // `mochi` launcher: set the working folder for a new terminal session
    if (path === "/api/context" && req.method === "POST") {
      const { directory, harness, tmux, tmuxSocket } = await req.json().catch(() => ({}));
      if (harness === "claude" || harness === "opencode") state.harness = harness;
      state.tmuxTarget = tmux || undefined;
      state.tmuxSocket = tmuxSocket || undefined;
      if (directory) { setContext(directory); state.busy = false; }
      if (state.harness === "opencode") await startOpencode();
      console.log(`[mochi] following ${state.harness} in ${state.directory}${state.tmuxTarget ? ` (tmux ${state.tmuxTarget})` : ""}`);
      return json({ ok: true, directory: state.directory, harness: state.harness });
    }

    // Claude Code hooks (bin/mochi-hook <Event> posts the hook JSON here)
    if (path === "/api/claude-hook" && req.method === "POST") {
      const event = url.searchParams.get("event") ?? "";
      const payload = await req.json().catch(() => ({}));
      try { handleHook(event, payload); } catch (e) { console.warn("[mochi] hook error", e); }
      return json({});
    }

    // Global hotkey (GNOME custom shortcut → bin/mochi-talk → here → cat toggles mic)
    if (path === "/api/hotkey" && req.method === "POST") {
      emit({ type: "hotkey" } as any);
      return json({ ok: true });
    }

    if (path === "/api/realtime-token" && req.method === "POST") {
      const t = await mintToken();
      return json(t, "error" in t ? 500 : 200);
    }

    if (path.startsWith("/api/tool/") && req.method === "POST") {
      const name = path.slice("/api/tool/".length);
      const args = await req.json().catch(() => ({}));
      try {
        const result = await runTool(name, args);
        console.log(`[mochi] tool ${name}`, JSON.stringify(args).slice(0, 200));
        return json(result ?? { ok: true });
      } catch (e) {
        console.warn(`[mochi] tool ${name} failed`, e);
        return json({ error: (e as Error).message });
      }
    }

    if (path === "/api/events") {
      let unsub: () => void = () => {};
      let ping: Timer;
      const stream = new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder();
          const send = (e: UiEvent) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          send({ type: "context", directory: state.directory, sessionID: state.sessionID, title: state.sessionTitle });
          send({ type: "mood", mood: state.mood, status: state.status });
          unsub = subscribe(send);
          ping = setInterval(() => ctrl.enqueue(enc.encode(": ping\n\n")), 15000);
        },
        cancel() { unsub(); clearInterval(ping); },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    // static files: / → index.html, /remote → index.html (phone layout chosen client-side)
    let rel = path === "/" || path === "/remote" ? "/index.html" : path;
    const file = normalize(join(WEB, rel));
    if (!file.startsWith(WEB)) return new Response("nope", { status: 400 });
    const f = Bun.file(file);
    if (await f.exists()) return new Response(f);
    return new Response("not found", { status: 404 });
  },
});

console.log(`[mochi] voice: ${VOICE_PROVIDER === "gemini" ? `Gemini Live (${GEMINI_MODEL})` : "OpenAI Realtime"}`);
console.log(`[mochi] bridge on http://127.0.0.1:${PORT}  (opencode at ${OC_URL})`);
console.log(`[mochi] attach the TUI with:  opencode attach ${OC_URL} --dir <project>`);
