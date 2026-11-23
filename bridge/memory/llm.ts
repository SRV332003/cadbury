// Minimal client for any OpenAI-compatible chat endpoint (Ollama, LM Studio, llama.cpp, vLLM, or a
// hosted API). Used only by the background memory review, never by the live voice.

export const LLM_URL = (process.env.CADBURY_MEMORY_LLM_URL ?? "").replace(/\/+$/, "");
export const LLM_MODEL = process.env.CADBURY_MEMORY_MODEL ?? "";
const LLM_KEY = process.env.CADBURY_MEMORY_LLM_KEY ?? "";

export const llmConfigured = () => !!(LLM_URL && LLM_MODEL);

export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: any[]; tool_call_id?: string }

export async function chat(messages: ChatMessage[], tools: any[], signal: AbortSignal): Promise<ChatMessage> {
  const res = await fetch(`${LLM_URL}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(LLM_KEY ? { authorization: `Bearer ${LLM_KEY}` } : {}) },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: tools.map(({ type, ...fn }) => ({ type: "function", function: fn })), // our schemas are Realtime-style (flat)
      tool_choice: "auto",
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`memory model: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message ?? { role: "assistant", content: "" };
}
