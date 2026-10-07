// The stage: what Worm, the screen's voice assistant, is doing right now, held in memory and pushed to every open page
// over /api/stage/stream. A turn starts when someone says "hey worm" (lib/stage/ears.ts) or something is posted to
// /api/stage, and the screen gives most of itself over to it until a while after the answer ends.

/** One piece of the answer, in the order the model wrote it. `body` grows as the answer streams in. */
export type StageBlock = {
  kind: "say" | "diagram" | "chart" | "table" | "html";
  body: string;
  /** True once the block's closing tag has arrived, so its JSON or HTML is whole. */
  done: boolean;
};

export type StagePhase = "idle" | "listening" | "thinking" | "answering" | "done";

export type StageState = {
  /** Changes with every turn, so the page can tell a new question from the same one growing. */
  turn: number;
  phase: StagePhase;
  /** What was asked, as it is being said; final once the speaker has finished. */
  heard: string;
  heardFinal: boolean;
  /** The quick acknowledgement said while the answer is worked on: "Good question, one sec." */
  ack: string | null;
  /** What Worm is looking up right now, if anything: "Searching Slack for task assignments". */
  activity: string | null;
  blocks: StageBlock[];
  error: string | null;
  /** When the stage hands the screen back (ms since epoch), once the answer is over. */
  closesAt: number | null;
  /** Until when (ms since epoch) a follow-up is taken without "hey worm", after Worm has finished answering. */
  listenUntil: number | null;
};

type Listener = (state: StageState) => void;
type Runtime = { state: StageState; listeners: Set<Listener>; closeTimer?: NodeJS.Timeout };

const IDLE: StageState = { turn: 0, phase: "idle", heard: "", heardFinal: false, ack: null, activity: null, blocks: [], error: null, closesAt: null, listenUntil: null };

const shared = globalThis as { __babStage?: Runtime };
const runtime: Runtime = (shared.__babStage ??= { state: IDLE, listeners: new Set() });

export const stageState = () => runtime.state;

/** Replaces the state with what `change` makes of it and tells every page. */
export function updateStage(change: (state: StageState) => StageState): StageState {
  runtime.state = change(runtime.state);
  for (const listener of runtime.listeners) listener(runtime.state);
  return runtime.state;
}

export function listenToStage(listener: Listener): () => void {
  runtime.listeners.add(listener);
  return () => {
    runtime.listeners.delete(listener);
  };
}

/** A fresh turn: the screen goes to the stage and shows what is being said. */
export function beginTurn(heard: string): number {
  clearTimeout(runtime.closeTimer);
  const turn = runtime.state.turn + 1;
  updateStage(() => ({ ...IDLE, turn, phase: "listening", heard }));
  return turn;
}

/** Hands the screen back after `afterMs`, unless another turn has started by then. */
export function closeStageAfter(turn: number, afterMs: number): void {
  clearTimeout(runtime.closeTimer);
  updateStage((state) => (state.turn === turn ? { ...state, closesAt: Date.now() + afterMs } : state));
  runtime.closeTimer = setTimeout(() => {
    if (runtime.state.turn === turn) updateStage((state) => ({ ...IDLE, turn: state.turn }));
  }, afterMs);
}

/** Back to the normal screen now ("thanks worm", or a turn that heard nothing). */
export function closeStage(): void {
  clearTimeout(runtime.closeTimer);
  updateStage((state) => ({ ...IDLE, turn: state.turn }));
}

/** Applies `change` only while `turn` is still the current one, so a slow answer cannot write over a newer question. */
export function updateTurn(turn: number, change: (state: StageState) => StageState): void {
  updateStage((state) => (state.turn === turn ? change(state) : state));
}
