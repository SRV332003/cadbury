// Gemini Live voice: the browser/Electron page talks to this WebSocket proxy, which holds the
// API key, keeps the upstream Live session alive (resumption on goAway), and runs tool calls here.
import type { ServerWebSocket } from "bun";
import { toolSchemas, runTool } from "./tools";
import { instructions } from "./realtime";

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-live";
const GEMINI_VOICE = process.env.GEMINI_VOICE ?? "Leda";
const URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Gemini wants OpenAPI-style upper-case types and no empty parameter objects.
const upperTypes = (s: any): any =>
  Array.isArray(s) ? s.map(upperTypes)
  : s && typeof s === "object"
    ? Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === "type" && typeof v === "string" ? v.toUpperCase() : upperTypes(v)]))
    : s;
const functionDeclarations = toolSchemas.map((t: any) => ({
  name: t.name,
  description: t.description,
  ...(Object.keys(t.parameters?.properties ?? {}).length ? { parameters: upperTypes(t.parameters) } : {}),
}));

function setupMessage(handle?: string) {
  return {
    setup: {
      model: `models/${GEMINI_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } } },
      },
      systemInstruction: { parts: [{ text: instructions() }] },
      tools: [{ functionDeclarations }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH", // notice you quickly when you cut in
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",      // don't jump in during short pauses
          prefixPaddingMs: 40,
          silenceDurationMs: Number(process.env.MOCHI_SILENCE_MS ?? 800),
        },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      sessionResumption: handle ? { handle } : {},
    },
  };
}

export interface LiveClient {
  up?: WebSocket;
  ready: boolean;
  handle?: string;
  queue: string[];
  closed: boolean;
  retries: number;
  generating: boolean;   // model is mid-answer
  hopAt?: number;        // goAway: reconnect once the answer finishes (or by this deadline)
  hopTimer?: Timer;
  since: number;
  dormant: boolean;      // Gemini hung up for inactivity; wake on next activity
  alreadyTries?: number;
  limitTries?: number;
  audioBuf: string[];    // mic audio held while (re)connecting, so first words aren't lost
}

const toText = (d: unknown) => (typeof d === "string" ? d : new TextDecoder().decode(d as ArrayBuffer));
const MAX_RETRIES = 8;
const HANDLE_TTL = 2 * 60 * 60 * 1000; // Gemini keeps resumable sessions ~2h

// Survives page reloads / reconnects, so the cat remembers the conversation.
let lastHandle: { value: string; at: number } | undefined;
let handleOwner: WebSocket | undefined; // upstream socket currently holding that conversation

/** Close whoever holds the conversation and wait (briefly) until Gemini lets go of it. */
async function releaseOwner() {
  const o = handleOwner;
  if (!o || o.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((res) => {
    const t = setTimeout(res, 2500);
    o.addEventListener("close", () => { clearTimeout(t); setTimeout(res, 300); }, { once: true });
    try { o.close(); } catch { res(); }
  });
}

function parseSeconds(t: any): number {
  if (typeof t === "string") return parseFloat(t) || 30;
  if (t && typeof t === "object") return Number(t.seconds ?? 30);
  return 30;
}

function hop(ws: ServerWebSocket<LiveClient>, why: string) {
  const c = ws.data;
  clearTimeout(c.hopTimer);
  c.hopAt = undefined;
  if (c.closed) return;
  console.log(`[mochi] gemini: reconnecting (${why}), resuming conversation`);
  const old = c.up;
  c.up = undefined;
  try { old?.close(); } catch {}
  connectUpstream(ws);
}

function connectUpstream(ws: ServerWebSocket<LiveClient>) {
  const c = ws.data;
  c.ready = false;
  c.generating = false;
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    ws.send(JSON.stringify({ mochi: "error", message: "GEMINI_API_KEY is not set in voicecode/.env" }));
    ws.close();
    return;
  }
  const up = new WebSocket(URL, { headers: { "x-goog-api-key": key } } as any);
  c.up = up;
  const usedHandle = c.handle;

  up.onopen = () => up.send(JSON.stringify(setupMessage(usedHandle)));

  up.onmessage = async (e) => {
    if (up !== c.up) return; // a stale socket after reconnect
    const raw = toText(e.data);
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.setupComplete) {
      const resumed = !!usedHandle;
      if (c.retries > 0) console.log(`[mochi] gemini: back online${resumed ? " (conversation resumed)" : ""}`);
      c.ready = true;
      c.retries = 0;
      c.alreadyTries = 0;
      c.limitTries = 0;
      for (const q of c.queue.splice(0)) up.send(q);
      for (const a of c.audioBuf.splice(0)) up.send(a);
      ws.send(JSON.stringify({ mochi: "ready", model: GEMINI_MODEL, resumed }));
      return;
    }
    if (m.sessionResumptionUpdate) {
      if (m.sessionResumptionUpdate.resumable && m.sessionResumptionUpdate.newHandle) {
        c.handle = m.sessionResumptionUpdate.newHandle;
        lastHandle = { value: c.handle!, at: Date.now() };
        handleOwner = up;
      }
      return;
    }
    if (m.goAway) {
      // Server will drop this connection soon. Finish the current answer, then hop.
      const left = parseSeconds(m.goAway.timeLeft);
      console.log(`[mochi] gemini goAway (${left}s left)`);
      if (!c.generating) return hop(ws, "goAway");
      c.hopAt = Date.now() + Math.max(0, left - 3) * 1000;
      c.hopTimer = setTimeout(() => hop(ws, "goAway deadline"), Math.max(0, left - 3) * 1000);
      return;
    }
    if (m.toolCall?.functionCalls?.length) {
      c.generating = true;
      ws.send(raw); // UI shows what's happening
      const functionResponses = await Promise.all(
        m.toolCall.functionCalls.map(async (f: any) => {
          let response: any;
          try {
            response = (await runTool(f.name, f.args ?? {})) ?? { ok: true };
          } catch (err) {
            response = { error: (err as Error).message };
          }
          console.log(`[mochi] gemini tool ${f.name}`, JSON.stringify(f.args ?? {}).slice(0, 200));
          // Gemini wants an object; wrap arrays/primitives.
          if (typeof response !== "object" || Array.isArray(response)) response = { result: response };
          return { id: f.id, name: f.name, response };
        }),
      );
      if (up.readyState === WebSocket.OPEN) up.send(JSON.stringify({ toolResponse: { functionResponses } }));
      return;
    }
    const sc = m.serverContent;
    if (sc?.modelTurn) c.generating = true;
    if (sc?.turnComplete || sc?.interrupted) {
      c.generating = false;
      if (c.hopAt) setTimeout(() => hop(ws, "goAway, answer finished"), 200);
    }
    ws.send(raw); // audio, transcripts, turnComplete, interrupted …
  };

  up.onclose = (e) => {
    if (up !== c.up || c.closed) return;
    console.warn(`[mochi] gemini upstream closed: ${e.code} ${e.reason || "(no reason)"}`);
    c.ready = false;
    const reason = e.reason ?? "";
    // Free-tier rate limit (per minute): wait it out instead of giving up.
    if (/exhausted|rate|too many|429/i.test(reason) && !/billing|api key/i.test(reason)) {
      c.limitTries = (c.limitTries ?? 0) + 1;
      if (c.limitTries <= 5) {
        const wait = Math.min(60, 10 * c.limitTries);
        console.log(`[mochi] gemini: rate limited, retrying in ${wait}s`);
        ws.send(JSON.stringify({ mochi: "rate-limited", wait }));
        setTimeout(() => !c.closed && connectUpstream(ws), wait * 1000);
        return;
      }
    }
    if (/quota|exhausted|api key|permission denied|billing/i.test(reason)) {
      ws.send(JSON.stringify({ mochi: "error", message: reason }));
      ws.close();
      return;
    }
    // Quiet for a while (e.g. muted): don't churn reconnects; resume on the next thing said or sent.
    if (/inactiv|idle/i.test(reason)) {
      c.dormant = true;
      console.log("[mochi] gemini: idle, will resume on next activity");
      return;
    }
    // The previous connection (page reload, or another device) still holds this conversation:
    // wait a moment for it to let go, then fall back to a fresh conversation.
    if (/already connected/i.test(reason)) {
      c.alreadyTries = (c.alreadyTries ?? 0) + 1;
      if (c.alreadyTries > 2) { c.handle = undefined; console.log("[mochi] gemini: conversation busy elsewhere, starting a fresh one"); }
      setTimeout(() => !c.closed && connectUpstream(ws), 1200);
      return;
    }
    // A stale/invalid resume handle: start a fresh conversation instead of failing.
    if (usedHandle && /(invalid|expired|unknown|not found).{0,40}(handle|resum)|(handle|resum).{0,40}(invalid|expired|unknown|not found)/i.test(reason)) {
      c.handle = undefined;
      lastHandle = undefined;
    }
    if (c.retries < MAX_RETRIES) {
      c.retries++;
      ws.send(JSON.stringify({ mochi: "reconnecting", attempt: c.retries }));
      setTimeout(() => !c.closed && connectUpstream(ws), Math.min(8000, 400 * 2 ** (c.retries - 1)));
      return;
    }
    ws.send(JSON.stringify({ mochi: "error", message: reason || `Gemini connection closed (${e.code})` }));
    ws.close();
  };
}

export const geminiSocket = {
  // page <-> bridge socket: never drop it for being quiet (e.g. while muted)
  idleTimeout: 960,
  sendPings: true,
  async open(ws: ServerWebSocket<LiveClient>) {
    if (ws.data.handle) await releaseOwner(); // e.g. page reload: free the old connection first
    if (!ws.data.closed) connectUpstream(ws);
  },
  message(ws: ServerWebSocket<LiveClient>, msg: string | Buffer) {
    const c = ws.data;
    const text = typeof msg === "string" ? msg : msg.toString();
    if (text === '{"mochi":"ping"}') { ws.send('{"mochi":"pong"}'); return; }
    const isAudio = text.includes('"audio"');
    if (c.dormant) {
      // wake only for real speech/text, not silence frames
      c.dormant = false;
      console.log("[mochi] gemini: waking up");
      connectUpstream(ws);
    }
    if (c.ready && c.up?.readyState === WebSocket.OPEN) c.up.send(text);
    else if (isAudio) { c.audioBuf.push(text); if (c.audioBuf.length > 100) c.audioBuf.shift(); } // keep last ~4s
    else c.queue.push(text);
  },
  close(ws: ServerWebSocket<LiveClient>, code: number, reason: string) {
    const c = ws.data;
    console.log(`[mochi] voice page disconnected: ${code} ${reason || ""} after ${Math.round((Date.now() - c.since) / 1000)}s`);
    c.closed = true;
    clearTimeout(c.hopTimer);
    try { c.up?.close(); } catch {}
  },
};

export const newLiveClient = (): LiveClient => ({
  ready: false, queue: [], closed: false, retries: 0, generating: false, since: Date.now(),
  dormant: false, audioBuf: [],
  // resume the previous conversation if the page reconnects within the handle's lifetime
  handle: lastHandle && Date.now() - lastHandle.at < HANDLE_TTL ? lastHandle.value : undefined,
});
