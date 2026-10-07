import { keepListening } from "../../../../lib/stage/ears";
import { listenToStage, stageState } from "../../../../lib/stage/state";
import { warmVoice } from "../../../../lib/stage/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 15_000;

// The stage as server-sent events: the whole state on connect and on every change (lib/stage/state.ts). While a
// screen is connected, Worm's listener runs (lib/stage/ears.ts) and its voice is kept loaded (lib/stage/voice.ts).
export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let release = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          release();
        }
      };
      send(`data: ${JSON.stringify(stageState())}\n\n`);
      const unlisten = listenToStage((state) => send(`data: ${JSON.stringify(state)}\n\n`));
      const stopListening = keepListening();
      warmVoice();
      const keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      release = () => {
        clearInterval(keepalive);
        unlisten();
        stopListening();
        release = () => {};
      };
      request.signal.addEventListener("abort", () => release());
    },
    cancel() {
      release();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
}
