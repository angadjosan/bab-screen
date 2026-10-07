// Worm's ears: scripts/listen/Listen.swift transcribes the room on this Mac, and this reads its lines. "Hey worm"
// opens a turn and puts the words that follow on the screen as they are said; once the speaker pauses, what they said
// is the question (lib/stage/turn.ts). "Thanks worm" or "never mind" hands the screen back. Nothing is acted on while
// Worm itself is talking. Runs while at least one screen is open, like the audio levels.

import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { buildSwiftHelper, swiftHelper } from "../swift-helper";
import { beginTurn, closeStage, stageState, updateTurn } from "./state";
import { askWorm, cancelTurn } from "./turn";
import { isSpeaking } from "./voice";

const HELPER = swiftHelper("listen", "Listen.swift");
/** Recognisers hear "hey worm" as one word, or as "a worm" when it is said quickly. */
const WAKE = /\b(?:hey|hi|okay|ok|yo|a)[,\s]*worm\b|\bheyworm\b/i;
const DISMISS = /\b(thanks|thank you|cheers|never ?mind|stop|that's all)[,\s]+worm\b|\bworm[,\s]+(stop|never ?mind|that's all|thanks)\b/i;
/** After a final result, the question is asked only if nothing more is said within this long. */
const PAUSE_MS = 900;
/** A wake word with no question after it is dropped after this long. */
const NO_QUESTION_MS = 8_000;
const IDLE_STOP_MS = 30_000;
const RESTART_MS = 10_000;

type Capture = { turn: number; settled: string; live: string; askTimer?: NodeJS.Timeout; giveUpTimer?: NodeJS.Timeout };
type Ears = { helper: ChildProcess | null; starting: boolean; listeners: number; idleTimer?: NodeJS.Timeout; capture: Capture | null };
const shared = globalThis as { __babStageEars?: Ears };
const ears = (shared.__babStageEars ??= { helper: null, starting: false, listeners: 0, capture: null });

export const earsEnabled = () => process.platform === "darwin" && process.env.STAGE_EARS !== "off";

type Heard = { text?: string; final?: boolean; status?: string; error?: string };

/** The words after the wake phrase, tidied: "Heyworm, how does EAGLE work" → "How does EAGLE work". */
function afterWake(text: string): string {
  const match = WAKE.exec(text);
  const rest = match ? text.slice(match.index + match[0].length) : text;
  const trimmed = rest.replace(/^[\s,.!?:-]+/, "");
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : "";
}

const questionSoFar = (capture: Capture) => [capture.settled, capture.live].filter(Boolean).join(" ").trim();

function ask(capture: Capture): void {
  clearTimeout(capture.giveUpTimer);
  ears.capture = null;
  const question = questionSoFar(capture);
  if (question) void askWorm(question, capture.turn);
  else if (stageState().turn === capture.turn) closeStage();
}

function wake(text: string): void {
  cancelTurn();
  const turn = beginTurn("");
  const capture: Capture = { turn, settled: "", live: afterWake(text) };
  capture.giveUpTimer = setTimeout(() => { if (ears.capture === capture && !questionSoFar(capture)) ask(capture); }, NO_QUESTION_MS);
  ears.capture = capture;
  updateTurn(turn, (state) => ({ ...state, heard: capture.live }));
}

function hearMore(capture: Capture, heard: Required<Pick<Heard, "text" | "final">>): void {
  clearTimeout(capture.askTimer);
  const words = capture.settled ? heard.text : afterWake(heard.text);
  if (heard.final) {
    capture.settled = [capture.settled, words].filter(Boolean).join(" ");
    capture.live = "";
    // "Hey worm" is often settled as a phrase of its own before the question starts: only a question with words in
    // it is asked. One that never comes is given up on by the timer set in wake().
    if (capture.settled) capture.askTimer = setTimeout(() => ask(capture), PAUSE_MS);
  } else {
    capture.live = words;
  }
  updateTurn(capture.turn, (state) => ({ ...state, heard: questionSoFar(capture) }));
}

/** Acts on one line from the listener. Exported so the wake and pause logic can be checked without a microphone. */
export function hearLine(line: string): void {
  let heard: Heard;
  try {
    heard = JSON.parse(line) as Heard;
  } catch {
    return;
  }
  if (heard.error) console.warn(`[stage] listener: ${heard.error}`);
  if (typeof heard.text !== "string" || isSpeaking()) return;
  if (DISMISS.test(heard.text) && stageState().phase !== "idle") {
    cancelTurn();
    closeStage();
    return;
  }
  if (WAKE.test(heard.text) && !ears.capture) return wake(heard.text);
  if (ears.capture) hearMore(ears.capture, { text: heard.text, final: heard.final === true });
}

async function start(): Promise<void> {
  if (ears.helper || ears.starting || !earsEnabled()) return;
  ears.starting = true;
  const problem = await buildSwiftHelper(HELPER);
  ears.starting = false;
  if (problem) return void console.warn(`[stage] listener unavailable: ${problem}`);
  if (!ears.listeners) return;
  const helper = spawn(HELPER.binary, [], { stdio: ["pipe", "pipe", "inherit"] });
  ears.helper = helper;
  readline.createInterface({ input: helper.stdout! }).on("line", hearLine);
  helper.on("exit", () => {
    if (ears.helper !== helper) return;
    ears.helper = null;
    if (ears.listeners) setTimeout(() => void start(), RESTART_MS);
  });
}

function stop(): void {
  ears.helper?.kill("SIGTERM");
  ears.helper = null;
}

/** Keeps the listener running while a screen is open; the returned function says that screen has gone. */
export function keepListening(): () => void {
  ears.listeners += 1;
  clearTimeout(ears.idleTimer);
  void start();
  return () => {
    ears.listeners -= 1;
    if (ears.listeners > 0) return;
    ears.idleTimer = setTimeout(stop, IDLE_STOP_MS);
  };
}
