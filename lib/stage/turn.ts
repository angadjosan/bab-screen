// One question to Worm, start to finish. A quick acknowledgement is said the moment the question ends
// (lib/stage/ack.ts) while the answer is written. The answer may call tools for a few
// rounds; its blocks go on the screen as they stream in, and each spoken block is said as soon as it closes.

import { parseAnswer, speechSoFar } from "./answer-format";
import { streamDemoAnswer } from "./demo";
import { quickAck } from "./ack";
import { answerModel, fireworksKey, streamChat, type ChatMessage } from "./fireworks";
import { answerPrompt } from "./prompt";
import { beginTurn, closeStageAfter, updateTurn, type StageState } from "./state";
import { runTool, toolActivity, toolSpecs } from "./tools";
import { hush, releaseMusic, speak } from "./voice";

const MAX_TOOL_ROUNDS = 4;
const ANSWER_MAX_TOKENS = 2_000;
/** The answer stays on screen this long after Worm has finished speaking it. */
const LINGER_MS = 40_000;
const ERROR_LINGER_MS = 12_000;

type Current = { turn: number; controller: AbortController };
const shared = globalThis as { __babStageTurn?: Current | null };

/** Cancels whatever turn is running, so a new question or "thanks worm" stops it mid-sentence. */
export function cancelTurn(): void {
  shared.__babStageTurn?.controller.abort();
  shared.__babStageTurn = null;
  hush();
}

/** Says each spoken block once, in order, after the acknowledgement. */
function makeSpeaker(afterAck: Promise<unknown>) {
  let said = 0;
  let last: Promise<unknown> = afterAck;
  return {
    sayNew(lines: string[]) {
      for (const line of lines.slice(said)) last = last.then(() => speak(line));
      said = Math.max(said, lines.length);
    },
    done: () => last,
  };
}

function showAnswer(turn: number, text: string, finished: boolean): ReturnType<typeof parseAnswer> {
  const blocks = parseAnswer(text, finished);
  updateTurn(turn, (state) => ({ ...state, phase: finished ? "done" : "answering", activity: null, blocks }));
  return blocks;
}

async function answer(turn: number, question: string, speaker: ReturnType<typeof makeSpeaker>, signal: AbortSignal): Promise<void> {
  const messages: ChatMessage[] = [{ role: "system", content: answerPrompt(new Date()) }, { role: "user", content: question }];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const tools = round < MAX_TOOL_ROUNDS ? toolSpecs() : undefined;
    const reply = await streamChat({ model: answerModel(), messages, tools, maxTokens: ANSWER_MAX_TOKENS }, (soFar) => speaker.sayNew(speechSoFar(showAnswer(turn, soFar, false))), signal);
    if (!reply.toolCalls.length) {
      speaker.sayNew(speechSoFar(showAnswer(turn, reply.text, true)));
      return;
    }
    messages.push({ role: "assistant", content: reply.text || null, tool_calls: reply.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) });
    for (const call of reply.toolCalls) {
      updateTurn(turn, (state) => ({ ...state, phase: "thinking", activity: toolActivity(call.name, call.arguments) }));
      messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(call.name, call.arguments) });
    }
  }
}

function fail(turn: number, message: string): void {
  updateTurn(turn, (state): StageState => ({ ...state, phase: "done", activity: null, error: message }));
  closeStageAfter(turn, ERROR_LINGER_MS);
  releaseMusic();
}

async function demoAnswer(turn: number, speaker: ReturnType<typeof makeSpeaker>, signal: AbortSignal): Promise<void> {
  const onActivity = (activity: string) => updateTurn(turn, (state) => ({ ...state, phase: "thinking", activity }));
  const text = await streamDemoAnswer((soFar) => speaker.sayNew(speechSoFar(showAnswer(turn, soFar, false))), onActivity, signal);
  speaker.sayNew(speechSoFar(showAnswer(turn, text, true)));
}

/**
 * Answers `question` on the stage. `turn` is the turn the listener opened when it heard the wake word; without one
 * (a question typed to /api/stage) a turn is opened here. Never throws.
 */
export async function askWorm(question: string, openTurn?: number, options: { demo?: boolean } = {}): Promise<void> {
  cancelTurn();
  const turn = openTurn ?? beginTurn(question);
  const controller = new AbortController();
  shared.__babStageTurn = { turn, controller };
  updateTurn(turn, (state) => ({ ...state, heard: question, heardFinal: true, phase: "thinking" }));
  const demo = options.demo === true;
  if (!demo && !fireworksKey()) return fail(turn, "Worm needs a FIREWORKS_API_KEY in .env.local to answer.");

  const line = quickAck(question);
  updateTurn(turn, (state) => ({ ...state, ack: line }));
  const ack = speak(line);
  const speaker = makeSpeaker(ack);
  try {
    await (demo ? demoAnswer(turn, speaker, controller.signal) : answer(turn, question, speaker, controller.signal));
    await speaker.done();
    releaseMusic();
    closeStageAfter(turn, LINGER_MS);
  } catch (error) {
    if (controller.signal.aborted) return;
    console.warn("[stage] answer failed:", error instanceof Error ? error.message : error);
    fail(turn, "I couldn't get an answer just now.");
    // Speaking dims the music again and cancels the release fail() scheduled; it is released once the line is said.
    void speak("Sorry, I couldn't get an answer just now.").then(() => releaseMusic());
  }
}
