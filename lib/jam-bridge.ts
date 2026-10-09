import { randomUUID, timingSafeEqual } from "node:crypto";
import { readJson } from "./songs-store";

type Pending = { id: string; dispatched: boolean; finish: (value: { url?: string; error?: string }) => void };
const shared = globalThis as typeof globalThis & { __babJamBridge?: { pending?: Pending; lastSeen: number; lastError: string | null; running?: Promise<string> } };
const state = (shared.__babJamBridge ??= { lastSeen: 0, lastError: null });

export async function bridgeAuthorized(value: string | null): Promise<boolean> {
  const config = await readJson<{ token?: string }>("jam-bridge.json");
  const expected = config?.token;
  if (!expected || !value?.startsWith("Bearer ")) return false;
  const actual = value.slice(7);
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function bridgeStatus() {
  return { online: Date.now() - state.lastSeen < 15_000, lastSeen: state.lastSeen ? new Date(state.lastSeen).toISOString() : null, error: state.lastError };
}

export function nextJamRequest() {
  state.lastSeen = Date.now();
  const pending = state.pending;
  if (!pending || pending.dispatched) return { id: null };
  pending.dispatched = true;
  return { id: pending.id };
}

export function finishJamRequest(id: string, value: { url?: string; error?: string }): boolean {
  if (state.pending?.id !== id) return false;
  state.pending.finish(value);
  return true;
}

/** One request at a time across route bundles and dev reloads. */
export function requestFreshJam(): Promise<string> {
  if (state.running) return state.running;
  state.running = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pending = undefined;
      state.lastError = "Spotify Jam extension did not respond. Keep Spotify open and reapply the extension after Spotify updates.";
      reject(new Error(state.lastError));
    }, 25_000);
    state.pending = {
      id: randomUUID(), dispatched: false,
      finish(value) {
        clearTimeout(timeout);
        state.pending = undefined;
        if (value.url) { state.lastError = null; resolve(value.url); }
        else { state.lastError = value.error || "Spotify did not provide a Jam invitation."; reject(new Error(state.lastError)); }
      },
    };
  }).finally(() => { state.running = undefined; });
  return state.running;
}
