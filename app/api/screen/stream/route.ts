import { NextRequest } from "next/server";
import { getScreenState, subscribeScreen, type ScreenState } from "../../../../lib/screen-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A comment line now and then, so nothing on the way (or the browser) decides the stream has died. */
const HEARTBEAT_MS = 15_000;

// Server-sent events: the whole screen state once on connect, then again on every change. The page opens one
// of these (app/page.tsx) and reconnects by itself if it drops.
export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let close = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      const sendState = (state: ScreenState) => send(`data: ${JSON.stringify(state)}\n\n`);
      const unsubscribe = subscribeScreen(sendState);
      const heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
      close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the other side.
        }
      };
      request.signal.addEventListener("abort", close, { once: true });
      // How long the browser waits before reconnecting after a drop.
      send("retry: 3000\n\n");
      sendState(await getScreenState());
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform keeps Next's gzip from holding events back to fill a compression block.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
