// Reads Worm's answer as it streams in. The model writes tagged blocks, in the order they should appear:
//
//   <say>Spoken and shown in large type.</say>
//   <diagram>{ ...JSON }</diagram>   <chart>{ ...JSON }</chart>   <table>{ ...JSON }</table>
//   <html>freeform markup in the screen's styles</html>
//
// Text outside any tag is treated as said. A block is put on the screen as soon as its opening tag arrives, and grows
// with the stream; JSON pieces are drawn once their closing tag has come.

import type { StageBlock } from "./state";

const KINDS = ["say", "diagram", "chart", "table", "html"] as const;
type Kind = StageBlock["kind"];
const OPEN = new RegExp(`<(${KINDS.join("|")})>`, "g");

/** Where the next tag starts, or where a partial tag might be starting at the end of the text. */
function holdBack(text: string): number {
  const lastOpen = text.lastIndexOf("<");
  return lastOpen >= 0 && !text.slice(lastOpen).includes(">") ? lastOpen : text.length;
}

function closingIndex(text: string, kind: Kind, from: number): number {
  return text.indexOf(`</${kind}>`, from);
}

/** Loose text between blocks, kept only when it has words in it. */
function looseSay(text: string): StageBlock[] {
  const body = text.trim();
  return body ? [{ kind: "say", body, done: true }] : [];
}

/** One block starting at `start` (just after its opening tag): its body so far and whether it has closed. */
function readBlock(text: string, kind: Kind, start: number): { block: StageBlock; end: number } {
  const close = closingIndex(text, kind, start);
  if (close < 0) {
    const body = text.slice(start, holdBack(text)).trimStart();
    return { block: { kind, body, done: false }, end: text.length };
  }
  return { block: { kind, body: text.slice(start, close).trim(), done: true }, end: close + kind.length + 3 };
}

/**
 * GLM-5.3 writes its own tool calls with <arg_key> and <arg_value> tags, and now and then one leaks into an answer:
 * "<diagram<arg_key>direction":…" where "<diagram>{"direction":…" was meant. Those are repaired, and any other stray
 * tool-call tags dropped, before the answer is read.
 */
function repairLeaks(text: string): string {
  return text
    .replace(new RegExp(`<(${KINDS.join("|")})<arg_key>`, "g"), '<$1>{"')
    .replace(/<\/?(arg_key|arg_value|tool_call)>/g, "");
}

/** Text that looks like JSON or markup is never said out loud, whatever block it ended up in. */
export function isSpeakable(text: string): boolean {
  return !/^[\s{[<]/.test(text) && !/"\s*:\s*["{[\d]/.test(text);
}

/**
 * The blocks in everything streamed so far. Pure: called again with the longer text each time a chunk arrives.
 * `finished` marks the stream as over, which closes a block whose closing tag never came.
 */
export function parseAnswer(raw: string, finished = false): StageBlock[] {
  const text = repairLeaks(raw);
  const blocks: StageBlock[] = [];
  let at = 0;
  OPEN.lastIndex = 0;
  for (let match = OPEN.exec(text); match; match = OPEN.exec(text)) {
    if (match.index < at) continue;
    blocks.push(...looseSay(text.slice(at, match.index)));
    const { block, end } = readBlock(text, match[1] as Kind, match.index + match[0].length);
    blocks.push(finished ? { ...block, done: true } : block);
    at = end;
    OPEN.lastIndex = end;
  }
  const tail = text.slice(at, finished ? text.length : holdBack(text));
  if (tail.trim()) blocks.push({ kind: "say", body: tail.trim(), done: finished });
  return blocks;
}

/** A sentence has ended when its full stop is followed by a space and the start of another sentence. */
const SENTENCE_END = /(?<=[.!?…]["”’)]?)\s+(?=["“‘(]?[\p{Lu}\p{N}])/u;

/** The sentences of one spoken block that are complete: all of them once it has closed, else all but the last. */
function completeSentences(block: StageBlock): string[] {
  const sentences = plainSpeech(block.body).split(SENTENCE_END).filter(Boolean);
  return block.done ? sentences : sentences.slice(0, -1);
}

/**
 * What can be said so far, a sentence at a time and in order, so Worm starts talking as soon as the first sentence is
 * written rather than when its whole block is. The list only ever grows as the answer streams in.
 */
export function speechSoFar(blocks: StageBlock[]): string[] {
  const said: string[] = [];
  for (const block of blocks) {
    if (block.kind !== "say") continue;
    said.push(...completeSentences(block).filter(isSpeakable));
    if (!block.done) break;
  }
  return said;
}

/** Markdown a model may slip in, taken out before the text is spoken or shown. */
export function plainSpeech(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
}
