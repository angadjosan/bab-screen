// The agent's local endpoint, 127.0.0.1 only:
//   GET  /health                 what is configured, connected and spent
// Voice in the room is Worm's, in the Next app (lib/stage/ears.ts); the agent takes no spoken requests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { config, missingConfig } from "./config";
import { spentToday } from "./db";
import { chatClient, overCap } from "./llm";
import { slackStatus } from "./slack";
import { isSpeaking } from "./speech";

const startedAt = Date.now();

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export function health() {
  return {
    ok: true,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    dryRun: config.dryRun(),
    speaking: isSpeaking(),
    llm: { configured: Boolean(chatClient()), model: config.model(), heavyModel: config.heavyModel(), overCap: overCap() },
    spend: { todayUsd: Number(spentToday().toFixed(4)), capUsd: config.dailyCap() },
    slack: { ...slackStatus(), botToken: Boolean(config.slackBotToken()), appToken: Boolean(config.slackAppToken()) },
    exa: Boolean(config.exaKey()),
    screenSecret: Boolean(config.screenSecret()),
    missing: missingConfig(),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  // Bound to loopback, but a browser page could still try a request: refuse anything with an Origin.
  if (request.headers.origin) return send(response, 403, { error: "forbidden" });

  if (request.method === "GET" && url.pathname === "/health") return send(response, 200, health());

  send(response, 404, { error: "not found" });
}

export function startHttp(port = config.port()): Promise<Server> {
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error("[jarvis] HTTP handler failed:", error);
      if (!response.headersSent) send(response, 500, { error: "internal" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
