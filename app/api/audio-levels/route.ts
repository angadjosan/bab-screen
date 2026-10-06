import { audioLevelsEnabled, listenToAudioLevels } from "../../../lib/audio-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A comment line now and then, so nothing between here and the page closes a quiet stream. */
const KEEPALIVE_MS = 15_000;

// What this Mac is playing, as a server-sent event per frame (lib/audio-levels.ts): "data: <rms> <band dB>...".
export async function GET(request: Request) {
  if (!audioLevelsEnabled()) return new Response(null, { status: 204 });
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
      const unlisten = listenToAudioLevels((line) => send(`data: ${line}\n\n`));
      const keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      release = () => {
        clearInterval(keepalive);
        unlisten();
      };
      request.signal.addEventListener("abort", () => release());
    },
    cancel() {
      release();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
  });
}
