/* global AbortSignal, clearTimeout, fetch, setTimeout */
/* eslint-disable complexity -- Spotify's unsupported response shapes and availability fallbacks are kept in one isolated adapter. */
// Runs inside Spotify through Spicetify. The installer substitutes the local bridge token.
// Internal Spotify APIs based on David-Novo-Scripts/spotify-jam-lobby (MIT).
/*
MIT License
Copyright (c) 2026 David Novo, DN Automation (https://dnautomation.tech)
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
(() => {
  if (globalThis.__babJamExtension) return;
  globalThis.__babJamExtension = true;
  const ENDPOINT = "http://127.0.0.1:3000/api/jam/bridge";
  const TOKEN = "__BAB_JAM_BRIDGE_TOKEN__";
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const field = (value, key) => value?.[key] ?? value?.session?.[key] ?? value?.social_session?.[key];
  async function bounded(operation, ms, message) {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
    finally { clearTimeout(timer); }
  }

  async function freshInvitation() {
    let platform, native;
    for (let i = 0; i < 60; i++) {
      platform = globalThis.Spicetify?.Platform;
      native = globalThis.Spicetify?._platform;
      if (platform?.AuthorizationAPI?.getState && (native?.getUrlDispenserServiceClient || platform?.getUrlDispenserServiceClient)) break;
      await delay(250);
    }
    const auth = await bounded(Promise.resolve(platform?.AuthorizationAPI?.getState?.()), 3000, "Spotify login lookup timed out.");
    const token = auth?.token?.accessToken;
    if (!token) throw new Error("Spotify client login is unavailable.");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    if (platform.version) headers["Spotify-App-Version"] = platform.version;
    if (platform.PlatformData?.app_platform) headers["App-Platform"] = platform.PlatformData.app_platform;
    const response = await fetch("https://spclient.wg.spotify.com/social-connect/v2/sessions/current_or_new?activate=true&alt=json", {
      headers, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Spotify Jam request failed (${response.status}). Hosting requires Premium.`);
    const jam = await response.json();
    const uri = field(jam, "join_session_uri");
    const inviteToken = field(jam, "join_session_token");
    if (!uri || !inviteToken) throw new Error("Spotify did not return a Jam join invitation.");
    if (field(jam, "is_session_owner") === false) throw new Error("This Spotify account is a guest in another Jam. Leave it before hosting.");
    const dispenser = native?.getUrlDispenserServiceClient?.() ?? platform?.getUrlDispenserServiceClient?.();
    if (!dispenser?.getShortUrl) throw new Error("Spotify invite service is unavailable; the extension may need an update.");
    const generated = await bounded(dispenser.getShortUrl(uri, {
      customData: [{ key: "ssp", value: "1" }, { key: "app_destination", value: "socialsession" }],
      utmParameters: { utm_campaign: null, utm_term: null, utm_medium: "share-link", utm_content: null, utm_source: "share-options-sheet" },
      linkPreview: { title: "Join the B@B Spotify Jam", image_url: `https://shareables.scdn.co/publish/socialsession/${inviteToken}` },
    }), 8000, "Spotify invite generation timed out.");
    const url = generated?.shareable_url ?? generated?.url;
    if (typeof url !== "string") throw new Error("Spotify did not return a shareable invite.");
    return url;
  }

  async function bridge(body) {
    const response = await fetch(ENDPOINT, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Jam bridge HTTP ${response.status}`);
    return response.json();
  }
  async function tick() {
    let interval = 1500;
    try {
      const request = await bridge();
      if (request.id) {
        try { await bridge({ id: request.id, url: await bounded(freshInvitation(), 20_000, "Spotify Jam creation timed out.") }); }
        catch (error) { await bridge({ id: request.id, error: error instanceof Error ? error.message : "Spotify Jam failed" }); }
      }
    } catch { interval = 5000; }
    setTimeout(tick, interval);
  }
  void tick();
})();
