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
 * The blocks in everything streamed so far. Pure: called again with the longer text each time a chunk arrives.
 * `finished` marks the stream as over, which closes a block whose closing tag never came.
 */
export function parseAnswer(text: string, finished = false): StageBlock[] {
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

/** The spoken text of blocks that have finished, in order, for the voice to read out. */
export function finishedSpeech(blocks: StageBlock[]): string[] {
  return blocks.filter((block) => block.kind === "say" && block.done).map((block) => plainSpeech(block.body));
}

/** Markdown a model may slip in, taken out before the text is spoken or shown. */
export function plainSpeech(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
}
