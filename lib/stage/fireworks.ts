// Worm's models, on Fireworks' OpenAI-compatible chat API, streamed. Two of them: a fast one for the instant "one sec"
// and a stronger one for the answer, which may call tools (lib/stage/tools.ts) before it writes.

const BASE_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
/** Kimi K3 on Fireworks' fast router, with thinking off: its first word came in 0.16 s (GLM-5.3 flash: 2.4 s). */
const DEFAULT_FAST_MODEL = "accounts/fireworks/routers/kimi-k3-fast";
const DEFAULT_MODEL = "accounts/fireworks/models/glm-5p3";
const REQUEST_TIMEOUT_MS = 90_000;

export const fireworksKey = () => process.env.FIREWORKS_API_KEY?.trim() || null;
export const fastModel = () => process.env.STAGE_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL;
export const answerModel = () => process.env.STAGE_MODEL?.trim() || DEFAULT_MODEL;
/**
 * GLM-5.3 always thinks before it answers, and at its default effort it can spend a whole reply's tokens doing so:
 * measured on 2026-10-06, nothing was written within 300 tokens. At "low" the first word arrives in 0.4 s (flash)
 * and 0.6 s (full). It cannot be "none" for GLM-5.3.
 */
export const reasoningEffort = () => process.env.STAGE_REASONING_EFFORT?.trim() || "low";
/** The acknowledgement is a few words, so its model is told not to think at all. */
export const fastReasoningEffort = () => process.env.STAGE_FAST_REASONING_EFFORT?.trim() || "none";

export type ToolCall = { id: string; name: string; arguments: string };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

type Delta = { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
type Chunk = { choices?: { delta?: Delta }[] };

/** Adds one streamed delta's tool-call fragments to the calls being assembled. */
function mergeToolCalls(calls: ToolCall[], delta: Delta): void {
  for (const part of delta.tool_calls ?? []) {
    const call = (calls[part.index] ??= { id: "", name: "", arguments: "" });
    if (part.id) call.id = part.id;
    if (part.function?.name) call.name += part.function.name;
    if (part.function?.arguments) call.arguments += part.function.arguments;
  }
}

/** The JSON payloads of a server-sent-events body, as they arrive. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(bytes, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data) as Chunk;
      } catch {
        // A malformed line is skipped; the stream carries on.
      }
    }
  }
}

async function post(payload: Record<string, unknown>, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const key = fireworksKey();
  if (!key) throw new Error("FIREWORKS_API_KEY is not set");
  const response = await fetch(BASE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ ...payload, stream: true }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!response.ok || !response.body) throw new Error(`Fireworks: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.body;
}

/**
 * One streamed completion. `onText` is called with the whole text so far each time more arrives. Resolves with the
 * text and any tool calls the model asked for.
 */
export async function streamChat(
  request: { model: string; messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens: number; temperature?: number; reasoningEffort?: string },
  onText: (textSoFar: string) => void,
  signal: AbortSignal,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const body = await post(
    { model: request.model, messages: request.messages, tools: request.tools, max_tokens: request.maxTokens, temperature: request.temperature ?? 0.4, reasoning_effort: request.reasoningEffort ?? reasoningEffort() },
    signal,
  );
  let text = "";
  const toolCalls: ToolCall[] = [];
  for await (const chunk of events(body)) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    mergeToolCalls(toolCalls, delta);
    if (!delta.content) continue;
    text += delta.content;
    onText(text);
  }
  return { text, toolCalls: toolCalls.filter((call) => call.name) };
}
