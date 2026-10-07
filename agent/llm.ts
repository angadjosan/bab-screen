// Our own tool loop on Fireworks (OpenAI-compatible API, the `openai` package with baseURL set):
// send messages + tool schemas, run the tool calls, feed results back, stop after N steps.
//
// The flash model handles every turn. It can call `escalate` to hand the rest of the turn to the
// heavy model (multi-step requests); lookup_person calls the heavy model itself through complete().
// Every call's tokens are priced into the spend table, and no call is made over the daily cap.

import OpenAI from "openai";
import { addSpend, logEvent, spentToday } from "./db";
import { config, FIREWORKS_BASE_URL } from "./config";
import type { AnyTool, TurnContext } from "./tools/types";
import { ArgError } from "./tools/types";

type Chat = OpenAI.Chat.Completions.ChatCompletion;
type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** The one method the loop needs, so tests can pass a fake. */
export type ChatClient = { chat: { completions: { create(body: Params): PromiseLike<Chat> } } };

/** USD per million tokens. An unknown model is priced as the heavy one. */
const PRICES: Record<string, { input: number; output: number }> = {
  "accounts/fireworks/models/glm-5p3-flash": { input: 0.15, output: 0.5 },
  "accounts/fireworks/models/glm-5p3": { input: 1.4, output: 4.4 },
};
const TOOL_TIMEOUT_MS = 45_000;
const RESULT_MAX_CHARS = 6_000;
/** Tool calls run per model step; any beyond this are answered "not run" so one step can't fan out. */
const MAX_CALLS_PER_STEP = 6;

export class SpendCapError extends Error {
  constructor() {
    super("daily spend cap reached");
  }
}

let override: ChatClient | null = null;
let cached: { key: string; client: ChatClient } | null = null;

/** For tests: a fake client, or null to go back to Fireworks. */
export function setChatClient(client: ChatClient | null) {
  override = client;
}

export function chatClient(): ChatClient | null {
  if (override) return override;
  const key = config.fireworksKey();
  if (!key) return null;
  if (cached?.key !== key) cached = { key, client: new OpenAI({ apiKey: key, baseURL: FIREWORKS_BASE_URL, timeout: 45_000, maxRetries: 1 }) };
  return cached.client;
}

export const overCap = () => spentToday() >= config.dailyCap();

export function priceOf(model: string, tokensIn: number, tokensOut: number): number {
  const price = PRICES[model] ?? PRICES[config.heavyModel()] ?? { input: 1.4, output: 4.4 };
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}

/** One model call, priced into the spend table. Throws SpendCapError over the cap. */
export async function complete(params: Params): Promise<Chat> {
  const client = chatClient();
  if (!client) throw new Error("FIREWORKS_API_KEY is not set");
  if (overCap()) throw new SpendCapError();
  const response = await client.chat.completions.create(params);
  const tokensIn = response.usage?.prompt_tokens ?? 0;
  const tokensOut = response.usage?.completion_tokens ?? 0;
  addSpend("fireworks", params.model, priceOf(params.model, tokensIn, tokensOut), tokensIn, tokensOut);
  return response;
}

/** Visible text of an answer: reasoning blocks some open models inline are removed. */
export function answerText(content: string | null | undefined): string {
  return (content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
}

const ESCALATE = {
  type: "function" as const,
  function: {
    name: "escalate",
    description: "Hand this request to a stronger model. Only for requests that need several steps of planning or careful judgement. Never for simple commands.",
    parameters: { type: "object", properties: { reason: { type: "string", description: "One short line" } }, required: ["reason"], additionalProperties: false },
  },
};

export type LoopResult = { text: string; steps: number; model: string; escalated: boolean; toolCalls: string[]; stoppedBy: "answer" | "max_steps" | "spend_cap" | "error" };

async function runTool(tool: AnyTool, rawArgs: string, ctx: TurnContext): Promise<{ ok: boolean; payload: unknown }> {
  let raw: Record<string, unknown>;
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { ok: false, payload: "arguments were not valid JSON" };
  }
  let args: unknown;
  try {
    args = tool.parse(raw);
  } catch (error) {
    return { ok: false, payload: error instanceof ArgError ? error.message : "bad arguments" };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("tool timed out")), TOOL_TIMEOUT_MS);
    });
    const result = await Promise.race([tool.run(args, ctx), timeout]);
    const failed = result && typeof result === "object" && "ok" in result && (result as { ok: unknown }).ok === false;
    return { ok: !failed, payload: result };
  } catch (error) {
    return { ok: false, payload: error instanceof Error ? error.message : "tool failed" };
  } finally {
    clearTimeout(timer);
  }
}

type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;

type LoopState = { model: string; escalated: boolean; heavy: string; toolCalls: string[]; byName: Map<string, AnyTool>; ctx: TurnContext };

function escalateTo(call: ToolCall, state: LoopState): string {
  state.toolCalls.push(call.function.name);
  state.escalated = true;
  state.model = state.heavy;
  logEvent(state.ctx.who, "tool", "escalate", call.function.arguments, true, { model: state.model });
  return JSON.stringify({ ok: true, result: "You are now the stronger model. Continue the request." });
}

async function callTool(call: ToolCall, state: LoopState): Promise<string> {
  const name = call.function.name;
  state.toolCalls.push(name);
  const tool = state.byName.get(name);
  const outcome = tool ? await runTool(tool, call.function.arguments ?? "", state.ctx) : { ok: false, payload: `no tool called ${name}` };
  logEvent(state.ctx.who, "tool", name, call.function.arguments, outcome.ok, outcome.payload);
  return JSON.stringify(outcome.ok ? { ok: true, result: outcome.payload } : { ok: false, error: outcome.payload });
}

async function answerCall(call: ToolCall, index: number, state: LoopState): Promise<string> {
  if (index >= MAX_CALLS_PER_STEP) return JSON.stringify({ ok: false, error: `not run: at most ${MAX_CALLS_PER_STEP} tool calls per step` });
  if (call.function.name === "escalate" && !state.escalated) return escalateTo(call, state);
  return callTool(call, state);
}

const clipResult = (content: string) => (content.length > RESULT_MAX_CHARS ? `${content.slice(0, RESULT_MAX_CHARS)}…(cut)` : content);

const functionCalls = (message: Chat["choices"][number]["message"] | undefined) => (message?.tool_calls ?? []).filter((call): call is ToolCall => call.type === "function");

function modelFailure(error: unknown): LoopResult["stoppedBy"] {
  if (error instanceof SpendCapError) return "spend_cap";
  console.error("[jarvis] model call failed:", error instanceof Error ? error.message : error);
  return "error";
}

export async function runToolLoop(options: { messages: Message[]; tools: AnyTool[]; ctx: TurnContext; model?: string; maxSteps?: number }): Promise<LoopResult> {
  const { tools, ctx } = options;
  const messages = [...options.messages];
  const heavy = config.heavyModel();
  const model = options.model ?? config.model();
  const state: LoopState = { model, escalated: model === heavy, heavy, toolCalls: [], byName: new Map(tools.map((tool) => [tool.name, tool])), ctx };
  const maxSteps = options.maxSteps ?? config.maxSteps();
  const finish = (text: string, steps: number, stoppedBy: LoopResult["stoppedBy"]): LoopResult => ({ text, steps, model: state.model, escalated: state.escalated, toolCalls: state.toolCalls, stoppedBy });
  const schemas = () => [
    ...tools.map((tool) => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
    ...(state.escalated ? [] : [ESCALATE]),
  ];

  for (let step = 0; step < maxSteps; step += 1) {
    const last = step === maxSteps - 1;
    let response: Chat;
    try {
      response = await complete({ model: state.model, messages, tools: schemas(), tool_choice: last ? "none" : "auto", temperature: 0.6, max_tokens: 700 });
    } catch (error) {
      return finish("", step, modelFailure(error));
    }
    const message = response.choices[0]?.message;
    const calls = functionCalls(message);
    // The last step is asked for text (tool_choice none); a model that calls tools anyway is not obeyed.
    if (!message || !calls.length || last) {
      return finish(answerText(message?.content), step + 1, calls.length ? "max_steps" : "answer");
    }

    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
    for (const [index, call] of calls.entries()) {
      messages.push({ role: "tool", tool_call_id: call.id, content: clipResult(await answerCall(call, index, state)) });
    }
  }
  return finish("", maxSteps, "max_steps");
}
