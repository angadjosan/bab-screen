/* global AbortSignal, URL, clearTimeout, setTimeout */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./spotify-jam-extension.js", import.meta.url), "utf8");

async function runExtension({ status = 200, missingInvite = false } = {}) {
  const requests = [];
  let shortenedUri;
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const context = {
    AbortSignal,
    setTimeout: (callback, ms) => callback.name === "tick" ? 0 : setTimeout(callback, ms),
    clearTimeout,
    Spicetify: {
      Platform: {
        AuthorizationAPI: { getState: () => ({ token: { accessToken: "spotify-secret" } }) },
        getUrlDispenserServiceClient: () => ({
          getShortUrl: async (uri) => { shortenedUri = uri; return { shareable_url: "https://spotify.link/freshInvite" }; },
        }),
      },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.includes("social-connect")) return {
        ok: status === 200, status,
        json: async () => missingInvite ? { session_id: "internal-id-is-not-an-invite" } : {
          session_id: "internal-id-is-not-an-invite", join_session_uri: "spotify:socialsession:actual-invite",
          join_session_token: "actual-invite", is_session_owner: true,
        },
      };
      if (options.method === "POST") {
        finish(JSON.parse(options.body));
        return { ok: true, json: async () => ({ accepted: true }) };
      }
      return { ok: true, json: async () => ({ id: "request-1" }) };
    },
  };
  vm.runInNewContext(source, context);
  const body = await result;
  return { body, requests, shortenedUri };
}

test("creates/reuses a real session and shortens the join URI rather than internal session ID", async () => {
  const { body, requests, shortenedUri } = await runExtension();
  assert.equal(shortenedUri, "spotify:socialsession:actual-invite");
  assert.equal(body.url, "https://spotify.link/freshInvite");
  assert.equal(body.id, "request-1");
  assert.match(requests.find(x => x.url.includes("social-connect")).url, /activate=true/);
  for (const call of requests.filter(x => x.url.includes("127.0.0.1"))) {
    assert.ok(!JSON.stringify(call).includes("spotify-secret"), "Spotify access token must never reach the dashboard");
  }
});

test("Spotify refusal returns an error without a stale invite", async () => {
  const { body, shortenedUri } = await runExtension({ status: 403 });
  assert.match(body.error, /403/);
  assert.equal(body.url, undefined);
  assert.equal(shortenedUri, undefined);
});

test("missing invitation credentials never substitutes the internal session ID", async () => {
  const { body, shortenedUri } = await runExtension({ missingInvite: true });
  assert.match(body.error, /join invitation/);
  assert.equal(body.url, undefined);
  assert.equal(shortenedUri, undefined);
});
