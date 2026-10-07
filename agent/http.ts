// The agent's local endpoint, 127.0.0.1 only:
//   POST /voice {"text": "..."}  runs a turn and speaks the answer; replies {reply, path, toolCalls}
//   GET  /speaking               {"speaking": boolean}: whether a line is still being said in the room
//   GET  /health                 what is configured, connected and spent

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { config, missingConfig } from "./config";
import { spentToday } from "./db";
import { chatClient, overCap } from "./llm";
import { slackStatus } from "./slack";
import { isSpeaking, speak } from "./speech";
import { runTurn } from "./turn";

const MAX_BODY = 16 * 1024;
const startedAt = Date.now();

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
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
  if (request.method === "GET" && url.pathname === "/speaking") return send(response, 200, { speaking: isSpeaking() });

  if (request.method === "POST" && url.pathname === "/voice") {
    let text = "";
    try {
      const body = JSON.parse(await readBody(request)) as { text?: unknown };
      text = typeof body.text === "string" ? body.text.trim() : "";
    } catch {
      return send(response, 400, { error: "body must be JSON {\"text\": \"...\"}" });
    }
    if (!text) return send(response, 400, { error: "text is required" });
    const result = await runTurn({ text, source: "voice", userName: null });
    if (result.reply && !result.alreadySpoken) void speak(result.reply);
    return send(response, 200, { reply: result.reply, path: result.path, toolCalls: result.toolCalls, ...(result.dryRunLog.length ? { dryRunLog: result.dryRunLog } : {}) });
  }

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
