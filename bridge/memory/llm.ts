// Minimal client for any OpenAI-compatible chat endpoint (Ollama, LM Studio, llama.cpp, vLLM, Gemini,
// or another hosted API). Used only by the background memory review, never by the live voice.
//
// Shortcut: set only CADBURY_MEMORY_MODEL=gemini-… and the review uses Google's OpenAI-compatible
// endpoint with the GEMINI_API_KEY you already have for the voice.

const GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export const LLM_MODEL = process.env.CADBURY_MEMORY_MODEL ?? "";
export const LLM_URL = (process.env.CADBURY_MEMORY_LLM_URL || (/^gemini/i.test(LLM_MODEL) ? GEMINI_OPENAI_URL : "")).replace(/\/+$/, "");
const LLM_KEY = process.env.CADBURY_MEMORY_LLM_KEY || (LLM_URL.startsWith(GEMINI_OPENAI_URL) ? process.env.GEMINI_API_KEY ?? "" : "");

export const llmConfigured = () => !!(LLM_URL && LLM_MODEL);
export const llmIsLocal = () => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(LLM_URL);

export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: any[]; tool_call_id?: string }

const RETRY_WAITS_MS = [2000, 6000, 15000]; // busy/overloaded servers (429, 5xx) usually recover within seconds

export async function chat(messages: ChatMessage[], tools: any[], signal: AbortSignal): Promise<ChatMessage> {
  const body = JSON.stringify({
    model: LLM_MODEL,
    messages,
    tools: tools.map(({ type, ...fn }) => ({ type: "function", function: fn })), // our schemas are Realtime-style (flat)
    tool_choice: "auto",
    temperature: 0.2,
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...(LLM_KEY ? { authorization: `Bearer ${LLM_KEY}` } : {}) },
      body,
    });
    if (res.ok) {
      const data: any = await res.json();
      return data.choices?.[0]?.message ?? { role: "assistant", content: "" };
    }
    const text = (await res.text()).slice(0, 200);
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= RETRY_WAITS_MS.length) throw new Error(`memory model: HTTP ${res.status} ${text}`);
    console.log(`[cadbury] memory model busy (HTTP ${res.status}), retrying in ${RETRY_WAITS_MS[attempt] / 1000}s`);
    await Bun.sleep(RETRY_WAITS_MS[attempt]);
    if (signal.aborted) throw new Error("memory model: timed out");
  }
}
