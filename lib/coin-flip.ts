// Coin flip: two people send the same amount of USDC on Base to the wallet behind BAB_PRIVATE_KEY and the winner
// is sent the pot. Nothing else may send from that key: transfers are matched to their nonces.
//
// Real money moves here, so the rules for state (lib/store.ts) are strict:
//   - One round at a time across every server instance: a round is the "coin-flip" job (lib/jobs.ts) and runs
//     under its lease. Every write of a round goes through writeWithLease, which lands only while that lease is
//     still held, so a round that stalls past its lease can never overwrite the next round's state.
//   - Each deposit (transaction hash and log index) is written to a write-once ledger in the same atomic write
//     that records what was done with it, and a deposit already in the ledger is never looked at again, even if
//     the main state were lost or reset. A deposit leads to at most one transfer: a refund, the open stake, or
//     the payout of the game it completes.
//   - Each transfer is signed once. The signed bytes go into a write-once transfer record together with the
//     state before anything is broadcast, so the only transaction that can ever be sent for a transfer is that
//     one (resending it is harmless: it has one nonce and can land once). A round that finds a record but no
//     signature in the state takes the record's.
//   - The nonce is the chain's pending count, never lower than one past the last nonce this wallet signed.
//   - On Vercel without Redis there is no shared store, and the coin flip refuses to run (the tile is hidden),
//     rather than keep money state in a per-instance /tmp.

import { randomInt } from "node:crypto";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, getAbiItem, http, keccak256, parseUnits, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { buildQr, type JamQr } from "./jam";
import { inBackground, runJob, type JobSpec } from "./jobs";
import { readManyStrict, readJsonStrict, safeName, storeIsShared, writeWithLease, type Lease, type LeasedWrite } from "./store";

const NETWORKS: Record<"base" | "base-sepolia", { chain: Chain; label: string; usdc: Address }> = {
  base: { chain: base, label: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "base-sepolia": { chain: baseSepolia, label: "Base Sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
};
const FILE = "coin-flip.json";
const JOB = "coin-flip";
const depositName = (id: string) => `coin-flip/deposits/${safeName(id)}.json`;
const transferName = (id: string) => `coin-flip/transfers/${safeName(id)}.json`;
const TRANSFER = getAbiItem({ abi: erc20Abi, name: "Transfer" });
const usdc = (dollars: number) => parseUnits(String(dollars), 6);
const dollars = (amount: string) => Number(formatUnits(BigInt(amount), 6));
const MIN_USD = 1;
const DUST = usdc(0.1);
/** Time between rounds while a stake is open or a transfer is under way, and otherwise. */
const TICK_MS = 3_000;
const IDLE_TICK_MS = 5_000;
/** A round normally takes a few seconds; RPC calls give up after RPC_TIMEOUT_MS (and one retry). */
const LEASE_MS = 120_000;
/** Nothing is written, so nothing is signed for sending, with less than this left on the lease. */
const LEASE_MARGIN_MS = 30_000;
const RPC_TIMEOUT_MS = 8_000;
const WAIT_MS = 10 * 60_000;
/** The payout is held this long so the chain does not show the winner before the coin lands. */
const REVEAL_MS = 17_000;
const GAME_SHOW_MS = 120_000;
const RESEND_MS = 20_000;
const LOST_MS = 2 * 60_000;
const CONFIRMATIONS = 2n;
const MAX_BLOCK_RANGE = 1_000n;

type Side = "heads" | "tails";
type Deposit = { id: string; from: Address; amount: string; at: number };
type Transfer = { id: string; to: Address; amount: string; notBefore: number; nonce?: number; raw?: Hex; hash?: Hex; signedAt?: number; sentAt?: number; done?: boolean };
type Signed = { id: string; to: Address; amount: string; nonce: number; raw: Hex; hash: Hex; signedAt: number };
type Game = { id: string; heads: Address; tails: Address; stake: string; winner: Side; at: number };
type State = { network: string; address: Address; cursor: string | null; nonce: number; waiting: Deposit | null; game: Game | null; transfers: Transfer[]; problem: string | null };
type Config = NonNullable<ReturnType<typeof config>>;

export type CoinFlipView =
  | { status: "unconfigured" }
  | { status: "error"; message: string }
  | {
      status: "ok";
      address: Address;
      qr: JamQr;
      network: string;
      minUsd: number;
      waiting: { from: Address; usd: number; remainingMs: number } | null;
      game: { id: string; heads: Address; tails: Address; stakeUsd: number; winner: Side; ageMs: number; payout: { url: string; qr: JamQr } | null } | null;
      problem: string | null;
    };

function config() {
  const key = process.env.BAB_PRIVATE_KEY?.trim();
  if (!key) return null;
  const name = process.env.COIN_FLIP_CHAIN?.trim() === "base-sepolia" ? "base-sepolia" : "base";
  const { chain, label, usdc: token } = NETWORKS[name];
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  const transport = http(process.env.COIN_FLIP_RPC_URL?.trim() || undefined, { timeout: RPC_TIMEOUT_MS, retryCount: 1 });
  return { name, label, token, account, explorer: chain.blockExplorers?.default.url ?? "https://basescan.org", reader: createPublicClient({ chain, transport }), wallet: createWalletClient({ account, chain, transport }) };
}

function fromSaved(cfg: Config, saved: State | null): State {
  if (saved?.address === cfg.account.address && saved.network === cfg.name) return saved;
  return { network: cfg.name, address: cfg.account.address, cursor: null, nonce: 0, waiting: null, game: null, transfers: [], problem: null };
}

async function load(cfg: Config): Promise<State> {
  // Strict: a store that cannot be read stops the round rather than look like a fresh start.
  return fromSaved(cfg, await readJsonStrict<State>(FILE));
}

/** Writes under the round's lease, or throws: lease (nearly) gone, or a write-once record already there. */
function committer(lease: Lease) {
  return async (writes: LeasedWrite[]) => {
    if (lease.remainingMs() < LEASE_MARGIN_MS) throw new Error("round ran too long; stopped before writing");
    const result = await writeWithLease(lease, writes);
    if (result.ok) return;
    if (result.reason === "lease_lost") throw new Error("lost the lease to another round; stopped before writing");
    throw new Error(`already recorded: ${Object.keys(result.existing).join(", ")}`);
  };
}
type Commit = ReturnType<typeof committer>;

function scan(cfg: Config, state: State, deposits: Deposit[], now: number) {
  const refund = (d: Deposit) => state.transfers.push({ id: `refund:${d.id}`, to: d.from, amount: d.amount, notBefore: now });
  for (const deposit of deposits) {
    const amount = BigInt(deposit.amount);
    if (amount < DUST) continue;
    if (amount < usdc(MIN_USD)) refund(deposit);
    else if (!state.waiting) state.waiting = deposit;
    else if (state.waiting.amount !== deposit.amount) refund(deposit);
    else {
      const winner: Side = randomInt(2) ? "heads" : "tails";
      state.game = { id: deposit.id, heads: state.waiting.from, tails: deposit.from, stake: deposit.amount, winner, at: now };
      state.transfers.push({ id: `payout:${deposit.id}`, to: state.game[winner], amount: String(amount * 2n), notBefore: now + REVEAL_MS });
      state.waiting = null;
    }
  }
  if (state.waiting && now - state.waiting.at > WAIT_MS) {
    refund(state.waiting);
    state.waiting = null;
  }
}

// One transfer at a time. It is signed and saved (write-once) before it is broadcast, so a retry can only resend
// the same bytes, and no second signature for the same transfer can ever be saved.
async function settle(cfg: Config, state: State, now: number, commit: Commit) {
  const transfer = state.transfers.find((t) => !t.done && t.raw) ?? state.transfers.find((t) => !t.done && now >= t.notBefore);
  if (!transfer) return;
  if (!transfer.raw) {
    // Signed by an earlier round whose state did not survive: that signature is the transfer.
    const recorded = await readJsonStrict<Signed>(transferName(transfer.id));
    if (recorded) {
      Object.assign(transfer, { nonce: recorded.nonce, raw: recorded.raw, hash: recorded.hash, signedAt: recorded.signedAt, sentAt: undefined });
      state.nonce = Math.max(state.nonce, recorded.nonce + 1);
      return commit([{ name: FILE, value: state }]);
    }
    const pending = await cfg.reader.getTransactionCount({ address: cfg.account.address, blockTag: "pending" });
    // A lagging RPC node may not know the last transaction yet; never reuse a nonce this wallet has signed.
    const nonce = Math.max(pending, state.nonce);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [transfer.to, BigInt(transfer.amount)] });
    const raw = await cfg.wallet.signTransaction(await cfg.wallet.prepareTransactionRequest({ to: cfg.token, data, nonce }));
    const signed: Signed = { id: transfer.id, to: transfer.to, amount: transfer.amount, nonce, raw, hash: keccak256(raw), signedAt: now };
    Object.assign(transfer, { nonce, raw, hash: signed.hash, signedAt: now, sentAt: now });
    state.nonce = nonce + 1;
    await commit([{ name: transferName(transfer.id), value: signed, once: true }, { name: FILE, value: state }]);
  } else {
    const mined = await cfg.reader.getTransactionCount({ address: cfg.account.address });
    const receipt = await cfg.reader.getTransactionReceipt({ hash: transfer.hash! }).catch(() => null);
    if (receipt || (mined > transfer.nonce! && now - transfer.signedAt! > LOST_MS)) {
      transfer.done = true;
      if (receipt?.status !== "success") state.problem = `${transfer.id} did not go through; check it by hand`;
      return commit([{ name: FILE, value: state }]);
    }
    if (now - (transfer.sentAt ?? 0) < RESEND_MS) return;
    transfer.sentAt = now;
    await commit([{ name: FILE, value: state }]);
  }
  await cfg.reader.sendRawTransaction({ serializedTransaction: transfer.raw! }).catch((error) => {
    if (!/already known|nonce too low/i.test(String(error))) throw error;
  });
}

/** One round: read new deposits, act on them, move the open transfer along. Returns the time until the next round. */
async function tick(cfg: Config, lease: Lease): Promise<number> {
  const commit = committer(lease);
  const state = await load(cfg);
  const now = Date.now();
  const head = (await cfg.reader.getBlockNumber()) - CONFIRMATIONS;
  const from = state.cursor ? BigInt(state.cursor) + 1n : head;
  const ledger: LeasedWrite[] = [];
  if (from <= head) {
    const to = from + MAX_BLOCK_RANGE < head ? from + MAX_BLOCK_RANGE : head;
    const logs = await cfg.reader.getLogs({ address: cfg.token, event: TRANSFER, args: { to: cfg.account.address }, fromBlock: from, toBlock: to });
    const found = new Map<string, Deposit>();
    for (const log of logs) {
      if (log.args.from && log.args.value !== undefined) found.set(`${log.transactionHash}:${log.logIndex}`, { id: `${log.transactionHash}:${log.logIndex}`, from: log.args.from, amount: String(log.args.value), at: now });
    }
    const deposits = [...found.values()];
    // Deposits already in the ledger were handled by an earlier round and are never handled again.
    const seen = await readManyStrict<unknown>(deposits.map((deposit) => depositName(deposit.id)));
    const fresh = deposits.filter((_, index) => seen[index] === null);
    scan(cfg, state, fresh, now);
    for (const deposit of fresh) ledger.push({ name: depositName(deposit.id), value: { ...deposit, cursor: String(to) }, once: true });
    state.cursor = String(to);
  } else scan(cfg, state, [], now);
  const open = state.transfers.filter((t) => !t.done);
  state.transfers = state.transfers.filter((t) => t.done).slice(-20).concat(open);
  // The state and the ledger entries of the deposits it now accounts for, in one write.
  await commit([{ name: FILE, value: state }, ...ledger]);
  await settle(cfg, state, now, commit);
  return state.waiting || state.transfers.some((t) => !t.done) ? TICK_MS : IDLE_TICK_MS;
}

function safeConfig(): Config | null {
  try {
    return config();
  } catch {
    return null;
  }
}

const shared = globalThis as { coinFlipError?: string | null };
const errorMessage = (error: unknown) => (error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error)).split("\n")[0];

export const coinFlipJob: JobSpec = {
  name: JOB,
  leaseMs: LEASE_MS,
  everyMs: () => TICK_MS,
  retryMs: 10_000,
  // Never on a store that other instances cannot see (Vercel without Redis).
  enabled: () => Boolean(process.env.BAB_PRIVATE_KEY?.trim()) && storeIsShared(),
  run: async (lease) => {
    const cfg = safeConfig();
    if (!cfg) return;
    try {
      const next = await tick(cfg, lease);
      shared.coinFlipError = null;
      return next;
    } catch (error) {
      const message = errorMessage(error);
      if (message !== shared.coinFlipError) console.error("Coin flip:", message);
      shared.coinFlipError = message;
      throw error;
    }
  },
};

export async function getCoinFlipView(): Promise<CoinFlipView> {
  let cfg: Config | null;
  try {
    cfg = config();
  } catch {
    return { status: "error", message: "BAB_PRIVATE_KEY is not a valid private key" };
  }
  if (!cfg) return { status: "unconfigured" };
  if (!storeIsShared()) return { status: "error", message: "The coin flip needs a shared store on Vercel: connect Upstash Redis to the project" };
  // A round, if one is due and no other instance is running one; the reply does not wait for it.
  inBackground(runJob(coinFlipJob));
  let state: State;
  let job: { ok?: boolean; error?: string | null } | null;
  try {
    const [saved, round] = await readManyStrict<unknown>([FILE, `jobs/${JOB}.json`]);
    state = fromSaved(cfg, saved as State | null);
    job = round as typeof job;
  } catch {
    // Without the state there is nothing safe to show: no QR, so nobody sends money now.
    return { status: "error", message: "The coin flip's state cannot be read right now" };
  }
  const now = Date.now();
  const { waiting, game } = state;
  const paid = game && state.transfers.find((t) => t.id === `payout:${game.id}` && t.done && t.hash);
  const receipt = paid ? `${cfg.explorer}/tx/${paid.hash}` : null;
  return {
    status: "ok",
    address: cfg.account.address,
    qr: buildQr(cfg.account.address),
    network: cfg.label,
    minUsd: MIN_USD,
    waiting: waiting && { from: waiting.from, usd: dollars(waiting.amount), remainingMs: Math.max(0, waiting.at + WAIT_MS - now) },
    game: game && now - game.at < GAME_SHOW_MS
      ? { id: game.id, heads: game.heads, tails: game.tails, stakeUsd: dollars(game.stake), winner: game.winner, ageMs: now - game.at, payout: receipt ? { url: receipt, qr: buildQr(receipt) } : null }
      : null,
    problem: state.problem ?? (job && job.ok === false ? job.error ?? "the last round failed" : null) ?? shared.coinFlipError ?? null,
  };
}
