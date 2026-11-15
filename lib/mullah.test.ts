import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMullahMix, MULLAH_TRACKS } from "./mullah";
import { SpotifyError } from "./spotify";

test("mix skips missing tracks, deduplicates IDs and starts the resolved selection", async () => {
  let calls = 0;
  const played: string[][] = [];
  const result = await buildMullahMix({
    search: async () => {
      calls++;
      return calls === 1 ? [] : [{ id: String(calls % 3).padStart(22, "0"), name: "Track", artists: ["Artist"] }];
    },
    play: async (ids) => { played.push(ids); },
    random: () => 0,
  });
  assert.equal(calls, MULLAH_TRACKS.length);
  assert.equal(result.count, 3);
  assert.equal(played.length, 1);
  assert.deepEqual(new Set(played[0]), new Set([0, 1, 2].map((id) => String(id).padStart(22, "0"))));
});

test("empty catalog never changes playback", async () => {
  await assert.rejects(buildMullahMix({ search: async () => [], play: async () => assert.fail("must not play"), random: Math.random }),
    (error: unknown) => error instanceof SpotifyError && error.code === "mix_empty");
});

test("API failures never start a partial mix", async () => {
  await assert.rejects(buildMullahMix({ search: async () => { throw new SpotifyError("rate_limited"); },
    play: async () => assert.fail("must not play"), random: Math.random }),
    (error: unknown) => error instanceof SpotifyError && error.code === "rate_limited");
});

test("playback failures reach the caller", async () => {
  await assert.rejects(buildMullahMix({ search: async () => [{ id: "0".repeat(22), name: "Track", artists: [] }],
    play: async () => { throw new SpotifyError("no_active_device"); }, random: Math.random }),
    (error: unknown) => error instanceof SpotifyError && error.code === "no_active_device");
});
