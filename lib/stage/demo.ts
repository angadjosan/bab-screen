// A canned answer streamed through the real stage, for trying the screen without a model key: POST
// {"text": "...", "demo": true} to /api/stage. It says "one sec", pretends to look something up, then streams an answer
// with a diagram at about the speed a model writes.

const DEMO_ANSWER = `<say>The main difference is when the drafter is trained. Multi-token prediction is trained with the big model, so the model learns to guess several tokens at once. EAGLE is bolted on afterwards: a small head trained on the frozen model's features.</say>
<say>Here's how they fit together:</say>
<diagram>{"direction":"LR","nodes":[{"id":"x","label":"Prompt"},{"id":"mtp","label":"MTP heads","note":"trained with the model","tone":"accent"},{"id":"base","label":"Big model"},{"id":"eagle","label":"EAGLE head","note":"trained after, frozen base"},{"id":"verify","label":"Verify drafts","tone":"muted"}],"edges":[{"from":"x","to":"base"},{"from":"base","to":"mtp","label":"features"},{"from":"base","to":"eagle","label":"features"},{"from":"mtp","to":"verify","label":"drafts"},{"from":"eagle","to":"verify","label":"drafts"}],"groups":[{"id":"pre","label":"Pre-training","nodes":["mtp"]},{"id":"post","label":"After training","nodes":["eagle"]}]}</diagram>
<say>Both draft tokens that the big model then checks in one pass, so you get several tokens per step for the price of one.</say>`;

const CHUNK_CHARS = 9;
const CHUNK_MS = 35;

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
  });

/** Streams the canned answer to `onText` as a model would, after a short pretend lookup shown through `onActivity`. */
export async function streamDemoAnswer(onText: (soFar: string) => void, onActivity: (activity: string) => void, signal: AbortSignal): Promise<string> {
  onActivity("Reading up on speculative decoding");
  await pause(1_800, signal);
  for (let at = CHUNK_CHARS; at < DEMO_ANSWER.length + CHUNK_CHARS; at += CHUNK_CHARS) {
    onText(DEMO_ANSWER.slice(0, at));
    await pause(CHUNK_MS, signal);
  }
  return DEMO_ANSWER;
}
