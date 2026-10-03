// Offline checks for the games (run from agent/selftest.ts, which sets dry-run and an in-memory database):
// Mafia roles, nights, votes and winners; poker payouts; the fast-path commands; a whole Mafia game driven
// through runTurn with Slack DMs and the TV recorded instead of sent; the screen's `game` op checks.

import assert from "node:assert/strict";

type Test = (name: string, run: () => void | Promise<void>) => Promise<void>;

/** A repeatable random sequence (mulberry32). */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function gameTests(test: Test) {
  const mafia = await import("./mafia");
  const poker = await import("./poker");
  const { parseGameCommand } = await import("./index");
  const { parseRule } = await import("../rules");
  const service = await import("./mafia-service");
  const { runTurn } = await import("../turn");
  const { setChatClient } = await import("../llm");

  const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `U${i + 1}`, name: `P${i + 1}` }));
  /** A game with fixed roles, by name: m = mafia, d = doctor, k = detective, v = villager. */
  const fixed = (roles: string) =>
    mafia.newMafia({
      players: [...roles].map((code, i) => ({ id: `U${i + 1}`, name: `P${i + 1}`, role: ({ m: "mafia", d: "doctor", k: "detective", v: "villager" } as const)[code as "m"], alive: true, died: null })),
      channel: "C1",
      threadTs: "1.1",
      now: 0,
    });

  await test("mafia: role counts scale with players; every role is dealt once", () => {
    assert.deepEqual([4, 5, 6, 8, 9, 10, 12, 14, 16].map(mafia.mafiaCount), [1, 1, 2, 2, 2, 3, 3, 4, 4]);
    for (const n of [4, 5, 7, 10, 16]) {
      const dealt = mafia.assignRoles(people(n), seeded(n));
      const count = (role: string) => dealt.filter((player) => player.role === role).length;
      assert.equal(dealt.length, n);
      assert.equal(count("mafia"), mafia.mafiaCount(n));
      assert.equal(count("doctor"), 1);
      assert.equal(count("detective"), 1);
      assert.equal(count("villager"), n - mafia.mafiaCount(n) - 2);
      assert.ok(dealt.every((player) => player.alive && !player.died));
    }
    assert.throws(() => mafia.assignRoles(people(3)), /at least 4/);
    assert.throws(() => mafia.assignRoles(people(17)), /at most 16/);
    // Duplicates count once.
    assert.throws(() => mafia.assignRoles([...people(3), { id: "U1", name: "P1" }]), /at least 4/);
  });

  await test("mafia: roles are random (seeded deals differ, and each seat gets mafia sometimes)", () => {
    const seats = new Set<number>();
    const deals = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const dealt = mafia.assignRoles(people(6), seeded(seed));
      deals.add(dealt.map((player) => player.role[0]).join(""));
      dealt.forEach((player, i) => player.role === "mafia" && seats.add(i));
    }
    assert.equal(seats.size, 6);
    assert.ok(deals.size > 10, `only ${deals.size} different deals`);
  });

  await test("mafia: night resolution, kill, save, detective check and refusals", () => {
    const game = fixed("mdkvv");
    assert.equal(game.phase, "night");
    assert.equal(game.round, 1);
    assert.equal(mafia.submitNight(game, "U4", "kill", "P5").ok, false); // a villager
    assert.equal(mafia.submitNight(game, "U1", "save", "P5").ok, false); // wrong role
    assert.match(mafia.submitNight(game, "U1", "kill", "P1").message, /mafia too/);
    assert.match(mafia.submitNight(game, "U1", "kill", "Nobody").message, /can't tell/);
    assert.equal(mafia.submitNight(game, "U1", "kill", "@P4").target?.id, "U4");
    assert.equal(mafia.nightComplete(game), false);
    assert.equal(mafia.submitNight(game, "U2", "save", "2").target?.id, "U2"); // by number from the DM list: P2 (self)
    const check = mafia.submitNight(game, "U3", "check", "<@U1>");
    assert.equal(check.checkedTeam, "mafia");
    assert.match(check.message, /MAFIA/);
    assert.equal(mafia.submitNight(game, "U3", "check", "P4").ok, false); // one check a night
    assert.equal(mafia.nightComplete(game), true);
    const night = mafia.resolveNight(game, 1_000);
    assert.equal(night.died?.name, "P4");
    assert.equal(game.phase, "day");
    assert.equal(game.endsAt, 1_000 + game.daySeconds * 1000);
    assert.match(game.headline, /P4 was killed/);

    const saved = fixed("mdkvv");
    mafia.submitNight(saved, "U1", "kill", "P5");
    mafia.submitNight(saved, "U2", "save", "P5");
    const result = mafia.resolveNight(saved, 0);
    assert.equal(result.died, null);
    assert.equal(result.saved, true);
    assert.ok(saved.players.every((player) => player.alive));
    assert.match(saved.headline, /doctor/);
    // Night actions are refused by day.
    assert.match(mafia.submitNight(saved, "U1", "kill", "P5").message, /It's day/);
  });

  await test("mafia: vote tally, majority, ties and skip", () => {
    const game = fixed("mdkvvv");
    mafia.resolveNight(game, 0); // quiet night: six alive, four needed
    assert.equal(game.phase, "day");
    mafia.castVote(game, "U1", "P4");
    mafia.castVote(game, "U2", "P4");
    mafia.castVote(game, "U3", "P1");
    let count = mafia.tally(game);
    assert.deepEqual(count.counts, { U4: 2, U1: 1 });
    assert.equal(count.leader, "U4");
    assert.equal(count.needed, 4);
    assert.equal(count.majority, false);
    mafia.castVote(game, "U5", "P1");
    assert.equal(mafia.tally(game).leader, null); // 2-2 tie
    mafia.castVote(game, "U5", "P4"); // changes vote
    mafia.castVote(game, "U6", "P4");
    count = mafia.tally(game);
    assert.equal(count.counts.U4, 4);
    assert.equal(count.majority, true);
    assert.equal(mafia.castVote(game, "U9", "P1").ok, false);
    const day = mafia.resolveDay(game, 0);
    assert.equal(day.eliminated?.name, "P4");
    assert.equal(game.phase, "night");
    assert.equal(game.round, 2);

    // Time runs out on a tie: nobody goes.
    const tie = fixed("mdkvvv");
    mafia.resolveNight(tie, 0);
    mafia.castVote(tie, "U1", "P4");
    mafia.castVote(tie, "U4", "P1");
    assert.equal(mafia.resolveDay(tie, 0).eliminated, null);
    // Skip ahead of the leader: nobody goes.
    const skip = fixed("mdkvvv");
    mafia.resolveNight(skip, 0);
    mafia.castVote(skip, "U1", "P4");
    mafia.castVote(skip, "U2", "skip");
    mafia.castVote(skip, "U3", "skip");
    assert.equal(mafia.resolveDay(skip, 0).eliminated, null);
    // A plurality over skip goes when time runs out.
    const plurality = fixed("mdkvvv");
    mafia.resolveNight(plurality, 0);
    mafia.castVote(plurality, "U2", "P1");
    mafia.castVote(plurality, "U3", "P1");
    mafia.castVote(plurality, "U4", "skip");
    assert.equal(mafia.resolveDay(plurality, 0).eliminated?.name, "P1");
    // Dead players can't vote, and votes on the dead don't count.
    const dead = fixed("mdkvv");
    mafia.submitNight(dead, "U1", "kill", "P5");
    mafia.resolveNight(dead, 0);
    assert.match(mafia.castVote(dead, "U5", "P1").message, /Ghosts/);
    assert.equal(mafia.castVote(dead, "U4", "P5").ok, false);
  });

  await test("mafia: win detection", () => {
    const town = fixed("mdkv");
    mafia.resolveNight(town, 0);
    mafia.castVote(town, "U2", "P1");
    mafia.castVote(town, "U3", "P1");
    mafia.castVote(town, "U4", "P1");
    mafia.resolveDay(town, 0);
    assert.equal(town.phase, "over");
    assert.equal(town.winner, "town");
    assert.equal(town.endsAt, null);
    assert.match(town.headline, /Town wins/);

    // 1 mafia vs 3 town; a kill leaves 1 vs 2 (game on), a vote-out of town then 1 vs 1: mafia wins.
    const evil = fixed("mdkv");
    mafia.submitNight(evil, "U1", "kill", "P4");
    mafia.resolveNight(evil, 0);
    assert.equal(evil.phase, "day");
    assert.equal(mafia.winnerOf(evil), null);
    mafia.castVote(evil, "U1", "P2");
    mafia.castVote(evil, "U2", "P3");
    mafia.castVote(evil, "U3", "P2");
    mafia.resolveDay(evil, 0);
    assert.equal(evil.winner, "mafia");
    assert.match(evil.detail ?? "", /The mafia: P1/);

    // Two mafia, two town at the start of a day after a kill: mafia win at once.
    const parity = fixed("mmdkv");
    mafia.submitNight(parity, "U1", "kill", "P5");
    mafia.resolveNight(parity, 0);
    assert.equal(parity.winner, "mafia");
  });

  await test("poker: payouts are exact and use few transfers", () => {
    assert.deepEqual(poker.settle([{ name: "A", net: 0 }]), []);
    assert.deepEqual(poker.settle([{ name: "A", net: -2000 }, { name: "B", net: 2000 }]), [{ from: "A", to: "B", amount: 2000 }]);
    // Exact pairs first: A owes B 15 and C owes D 40, rather than chains.
    assert.deepEqual(
      poker.settle([{ name: "A", net: -1500 }, { name: "C", net: -4000 }, { name: "B", net: 1500 }, { name: "D", net: 4000 }]),
      [{ from: "A", to: "B", amount: 1500 }, { from: "C", to: "D", amount: 4000 }],
    );
    const nets = [
      { name: "A", net: -3333 },
      { name: "B", net: -1667 },
      { name: "C", net: -5000 },
      { name: "D", net: 7000 },
      { name: "E", net: 3000 },
    ];
    const transfers = poker.settle(nets);
    assert.ok(transfers.length <= nets.length - 1);
    const balance = new Map(nets.map((row) => [row.name, row.net]));
    for (const transfer of transfers) {
      assert.ok(transfer.amount > 0 && Number.isInteger(transfer.amount));
      balance.set(transfer.from, (balance.get(transfer.from) ?? 0) + transfer.amount);
      balance.set(transfer.to, (balance.get(transfer.to) ?? 0) - transfer.amount);
    }
    assert.ok([...balance.values()].every((value) => value === 0));
    assert.throws(() => poker.settle([{ name: "A", net: -100 }, { name: "B", net: 50 }]), /off by -0.5/);
  });

  await test("poker: buy-ins, rebuys, stacks, cash-outs and settling a game", () => {
    const game = poker.newPoker("Friday");
    poker.buyIn(game, "Alice", 20);
    poker.buyIn(game, "Bob", 20);
    poker.buyIn(game, "Carol", 20);
    poker.buyIn(game, "alice", 10.5); // rebuy, any case
    assert.equal(game.players.length, 3);
    assert.equal(poker.totalIn(game.players[0]), 3050);
    assert.throws(() => poker.settleGame(game), /final stack for Alice, Bob, Carol/);
    poker.cashOut(game, "Bob", 0);
    poker.setStack(game, "Alice", 50.5);
    poker.setStack(game, "Carol", 21);
    assert.throws(() => poker.settleGame(game), /71.50 but buy-ins to 70.50 \(extra 1\)/);
    poker.setStack(game, "Carol", 20);
    assert.throws(() => poker.setStack(game, "Dave", 5), /isn't at the table/);
    assert.throws(() => poker.buyIn(game, "Dave", -5), /positive/);
    const payouts = poker.settleGame(game);
    assert.deepEqual(payouts, [{ from: "Bob", to: "Alice", amount: 2000 }]);
    assert.equal(poker.describePayouts(payouts), "Bob pays Alice 20");
    assert.throws(() => poker.buyIn(game, "Alice", 5), /settled/);
    const screen = poker.pokerScreen(game);
    assert.equal(screen.kind, "poker");
    assert.deepEqual(screen.kind === "poker" && screen.players.map((player) => [player.name, player.net]), [["Alice", 20], ["Carol", 0], ["Bob", -20]]);
  });

  await test("games: fast-path commands", () => {
    assert.deepEqual(parseGameCommand("mafia start @Alice Smith @Bob @Carol @Dan"), { game: "mafia", action: "start", names: ["Alice Smith", "Bob", "Carol", "Dan"] });
    assert.deepEqual(parseGameCommand("start a game of mafia with alice, bob, carol and dan"), { game: "mafia", action: "start", names: ["alice", "bob", "carol", "dan"] });
    assert.deepEqual(parseGameCommand("end mafia"), { game: "mafia", action: "end" });
    assert.deepEqual(parseGameCommand("mafia next"), { game: "mafia", action: "next" });
    assert.deepEqual(parseGameCommand("buy in 20 for @Alice Smith"), { game: "poker", action: "buy_in", amount: 20, player: "Alice Smith" });
    assert.deepEqual(parseGameCommand("rebuy 10"), { game: "poker", action: "buy_in", amount: 10, player: "me" });
    assert.deepEqual(parseGameCommand("@Bob buys in for 25.50"), { game: "poker", action: "buy_in", player: "Bob", amount: 25.5 });
    assert.deepEqual(parseGameCommand("@Bob stack 45"), { game: "poker", action: "stack", player: "Bob", amount: 45 });
    assert.deepEqual(parseGameCommand("my stack is 30"), { game: "poker", action: "stack", player: "me", amount: 30 });
    assert.deepEqual(parseGameCommand("cash out @Carol 60"), { game: "poker", action: "cash_out", player: "Carol", amount: 60 });
    assert.deepEqual(parseGameCommand("cashing out with 12"), { game: "poker", action: "cash_out", amount: 12, player: "me" });
    assert.deepEqual(parseGameCommand("start poker with @A @B, 20 each"), { game: "poker", action: "start", players: ["A", "B"], amount: 20 });
    assert.deepEqual(parseGameCommand("settle up"), { game: "poker", action: "settle" });
    assert.deepEqual(parseGameCommand("who owes who"), { game: "poker", action: "settle" });
    for (const text of ["kill the music", "buy in", "I have 20 dollars", "stack overflow", "mafia movies are great"]) assert.equal(parseGameCommand(text), null, text);
    // Through the rules fast path, wake word and all.
    assert.deepEqual(parseRule("Jarvis, buy in 20 for @Alice"), { kind: "game", command: { game: "poker", action: "buy_in", amount: 20, player: "Alice" } });
    assert.equal(parseRule("pause")?.kind, "playback");
  });

  await test("poker: a game through runTurn (rules only, no model)", async () => {
    setChatClient(null);
    const say = (text: string, userName = "Alice") => runTurn({ text, source: "slack", userId: "UA", userName, channel: "C1", threadTs: "9.9", place: "channel" });
    assert.match((await say("poker status")).reply, /No poker game/);
    assert.match((await say("start poker with @Alice @Bob, 20 each")).reply, /At the table: Alice, Bob, 20 each/);
    assert.match((await say("rebuy 20")).reply, /Alice rebuys for 20 \(40 in total\)/);
    assert.match((await say("@Bob stack 60")).reply, /Bob has 60 \(up 40\)/);
    assert.match((await say("settle poker")).reply, /final stack for Alice/);
    assert.match((await say("cash out @Alice 0")).reply, /down 40/);
    const settled = await say("settle poker");
    assert.equal(settled.path, "rules");
    assert.match(settled.reply, /Alice pays Bob 40/);
    poker.resetPokerCache();
    assert.match((await say("poker status")).reply, /Alice pays Bob 40/); // read back from SQLite
    assert.match((await say("close poker")).reply, /closed/);
  });

  await test("mafia: a whole game by DM and thread votes, with the TV and DMs recorded", async () => {
    setChatClient(null);
    const dms: Array<{ to: string; text: string }> = [];
    const posts: Array<{ channel: string; text: string; threadTs: string | null }> = [];
    const screens: unknown[] = [];
    let now = 1_000_000;
    service.setGameIo({
      dm: async (to, text) => void dms.push({ to, text }),
      post: async (channel, text, threadTs) => (posts.push({ channel, text, threadTs }), { ts: "500.1" }),
      screen: async (op) => (screens.push(op), { ok: true, status: 200 }),
      place: async () => null,
      now: () => now,
    });
    try {
      // Names typed without Slack: dry run gives them stand-in ids (DRY_ALICE ...).
      const start = await runTurn({ text: "mafia start @Alice @Bob @Carol @Dan", source: "slack", userId: "UHOST", userName: "Host", channel: "C1", threadTs: "100.1", place: "channel" });
      assert.equal(start.path, "rules");
      assert.match(start.reply, /Mafia\* with Alice, Bob, Carol, Dan/);
      const game = service.activeMafia();
      assert.ok(game);
      assert.equal(game.threadTs, "100.1");
      // Everyone gets a role DM; mafia, doctor and detective also get the night list.
      for (const player of game.players) assert.ok(dms.some((dm) => dm.to === player.id && dm.text.includes("Mafia is starting")), player.name);
      const by = (role: string) => game.players.find((player) => player.role === role)!;
      const [boss, doc, cop] = [by("mafia"), by("doctor"), by("detective")];
      const villager = by("villager");
      assert.ok(dms.some((dm) => dm.to === boss.id && /Night 1\. Who dies tonight\?/.test(dm.text)));
      assert.ok(!dms.some((dm) => dm.to === villager.id && /Night 1\./.test(dm.text)));
      const tv = screens.at(-1) as { op: string; game: { kind: string; phase: string; players: Array<{ role: unknown }> } };
      assert.equal(tv.op, "game");
      assert.equal(tv.game.phase, "night");
      assert.ok(tv.game.players.every((player) => player.role === null)); // no roles on the TV while alive

      const dm = (player: { id: string; name: string }, text: string) => runTurn({ text, source: "slack", userId: player.id, userName: player.name, channel: `D${player.id}`, place: "dm" });
      // Not game actions: these fall through to the usual turn.
      assert.equal((await dm(villager, "tell me a joke")).path, "no_model");
      assert.match((await dm(boss, "role")).reply, /You are \*Mafia\*/);
      assert.match((await dm(villager, `kill ${doc.name}`)).reply, /Only the mafia/);
      assert.equal((await dm(boss, `kill ${villager.name}`)).reply, `Marked: ${villager.name}.`);
      assert.match((await dm(cop, `check ${boss.name}`)).reply, /MAFIA/);
      // Votes are refused at night.
      assert.match((await dm(cop, `vote ${boss.name}`)).reply, /It's night/);
      assert.match((await dm(doc, `save ${villager.name}`)).reply, /watch over/);
      // All three acted: the night ends on its own just after.
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      assert.equal(game.phase, "day");
      assert.ok(game.players.every((player) => player.alive));
      assert.ok(posts.some((post) => post.threadTs === "100.1" && /\*Day 1\.\*.*doctor got there first/.test(post.text)));

      // Day: votes by DM and in the game thread (a reply in the thread, as the thread handler passes it).
      assert.match((await dm(boss, `vote ${doc.name}`)).reply, /votes for/);
      const thread = (player: { id: string; name: string }, text: string) => runTurn({ text, source: "slack", userId: player.id, userName: player.name, channel: "C1", threadTs: "100.1", place: "channel" });
      assert.match((await thread(doc, `vote @${boss.name}`)).reply, /votes for/);
      assert.match((await thread(cop, `vote ${boss.name}`)).reply, /votes for/);
      // A vote in some other thread is not for the game.
      assert.ok(!(await runTurn({ text: `vote ${boss.name}`, source: "slack", userId: villager.id, userName: villager.name, channel: "C1", threadTs: "200.2", place: "channel" })).reply.includes("votes for"));
      const last = await thread(villager, `vote ${boss.name}`);
      assert.match(last.reply, /majority/);
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      assert.equal(game.phase, "over");
      assert.equal(game.winner, "town");
      const final = screens.at(-1) as { op: string; game: { phase: string; winner: string; players: Array<{ role: unknown }> } };
      assert.equal(final.game.winner, "town");
      assert.ok(final.game.players.every((player) => typeof player.role === "string")); // all roles shown at the end
      assert.ok(posts.some((post) => /Town wins/.test(post.text) && /Roles:/.test(post.text)));
      // Saved: a fresh read of the database sees the finished game as not active.
      service.resetMafia();
      assert.equal(service.activeMafia(), null);

      // Timer path: a new game where nobody acts; the night times out quietly.
      const again = await runTurn({ text: "mafia start @Alice @Bob @Carol @Dan @Eve", source: "slack", userId: "UHOST", userName: "Host", channel: "C1", threadTs: "300.1", place: "channel" });
      assert.match(again.reply, /Mafia\* with/);
      now += 61_000;
      await service.advanceForTest();
      assert.equal(service.activeMafia()?.phase, "day");
      assert.match(service.activeMafia()?.headline ?? "", /quiet night/i);
      assert.match((await runTurn({ text: "mafia status", source: "slack", userName: "Host", channel: "C1", place: "channel" })).reply, /Day 1, \d+s left\. Alive: /);
      assert.match((await runTurn({ text: "end mafia", source: "slack", userName: "Host", channel: "C1", place: "channel" })).reply, /Mafia ended/);
      assert.equal((screens.at(-1) as { op: string }).op, "clear_game");
      // Too few players.
      assert.match((await runTurn({ text: "mafia start @Alice @Bob", source: "slack", userName: "Host", channel: "C1", place: "channel" })).reply, /at least 4/);
    } finally {
      service.setGameIo(null);
      service.resetMafia();
    }
  });

  await test("screen: the game op is checked strictly", async () => {
    const { applyScreenOp } = await import("../../lib/screen-state");
    const now = Date.now();
    const mafiaGame = { kind: "mafia", phase: "day", round: 1, endsAt: now + 60_000, headline: "Day 1.", detail: null, players: [{ name: "A", alive: true, role: null, votes: 1 }], winner: null };
    const ok = await applyScreenOp({ op: "game", game: mafiaGame });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.state.game?.kind, "mafia");
    const bad = async (game: unknown) => {
      const result = await applyScreenOp({ op: "game", game });
      assert.equal(result.ok, false, JSON.stringify(game));
      return result.ok ? "" : result.error;
    };
    assert.match(await bad({ ...mafiaGame, kind: "chess" }), /game.kind/);
    assert.match(await bad({ ...mafiaGame, phase: "dusk" }), /game.phase/);
    assert.match(await bad({ ...mafiaGame, endsAt: now + 2 * 3_600_000 }), /hour/);
    assert.match(await bad({ ...mafiaGame, players: [] }), /not be empty/);
    assert.match(await bad({ ...mafiaGame, players: [{ name: "A", alive: "yes", role: null, votes: 0 }] }), /alive/);
    assert.match(await bad({ ...mafiaGame, players: [{ name: "A", alive: true, role: "werewolf", votes: 0 }] }), /role/);
    const table = { kind: "poker", title: "Friday", status: "live", players: [{ name: "A", buyIn: 20, stack: null, net: null, out: false }], payouts: [], note: null };
    assert.equal((await applyScreenOp({ op: "game", game: table })).ok, true);
    assert.match(await bad({ ...table, players: [{ name: "A", buyIn: -1, stack: null, net: null }] }), /negative/);
    assert.match(await bad({ ...table, payouts: [{ from: "A", to: "B", amount: 0 }] }), /positive/);
    assert.match(await bad({ ...table, status: "won" }), /game.status/);
    const cleared = await applyScreenOp({ op: "clear_game" });
    assert.equal(cleared.ok && cleared.state.game, null);
    const { PRESET_LAYOUTS } = await import("../../app/widgets/registry");
    assert.deepEqual(PRESET_LAYOUTS.default, { tape: "ticker", left: "feed", left_bottom: "coin_flip", center: "featured_market", side_top: "now_playing", side: "carousel", side_bottom: "events" });
    assert.equal(PRESET_LAYOUTS.game_night.center, "game");
  });
}
