// Coin flip: two people send the same amount of USDC on Base to the wallet behind BAB_PRIVATE_KEY and the winner
// is sent the pot. Nothing else may send from that key: transfers are matched to their nonces.

import { randomInt } from "node:crypto";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, getAbiItem, http, keccak256, parseUnits, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { buildQr, type JamQr } from "./jam";
import { readJson, writeJson } from "./songs-store";

const NETWORKS: Record<"base" | "base-sepolia", { chain: Chain; label: string; usdc: Address }> = {
  base: { chain: base, label: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "base-sepolia": { chain: baseSepolia, label: "Base Sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
};
const FILE = "coin-flip.json";
const TRANSFER = getAbiItem({ abi: erc20Abi, name: "Transfer" });
const usdc = (dollars: number) => parseUnits(String(dollars), 6);
const dollars = (amount: string) => Number(formatUnits(BigInt(amount), 6));
const MIN_USD = 1;
const DUST = usdc(0.1);
const TICK_MS = 3_000;
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
  const transport = http(process.env.COIN_FLIP_RPC_URL?.trim() || undefined);
  return { name, label, token, account, explorer: chain.blockExplorers?.default.url ?? "https://basescan.org", reader: createPublicClient({ chain, transport }), wallet: createWalletClient({ account, chain, transport }) };
}

async function load(cfg: Config): Promise<State> {
  const saved = await readJson<State>(FILE);
  if (saved?.address === cfg.account.address && saved.network === cfg.name) return saved;
  return { network: cfg.name, address: cfg.account.address, cursor: null, nonce: 0, waiting: null, game: null, transfers: [], problem: null };
}

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

// One transfer at a time. It is signed and saved before it is broadcast, so a retry can only resend the same bytes.
async function settle(cfg: Config, state: State, now: number) {
  const transfer = state.transfers.find((t) => !t.done && t.raw) ?? state.transfers.find((t) => !t.done && now >= t.notBefore);
  if (!transfer) return;
  const mined = await cfg.reader.getTransactionCount({ address: cfg.account.address });
  if (!transfer.raw) {
    const nonce = Math.max(mined, state.nonce);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [transfer.to, BigInt(transfer.amount)] });
    const raw = await cfg.wallet.signTransaction(await cfg.wallet.prepareTransactionRequest({ to: cfg.token, data, nonce }));
    Object.assign(transfer, { nonce, raw, hash: keccak256(raw), signedAt: now });
    state.nonce = nonce + 1;
  } else {
    const receipt = await cfg.reader.getTransactionReceipt({ hash: transfer.hash! }).catch(() => null);
    if (receipt || (mined > transfer.nonce! && now - transfer.signedAt! > LOST_MS)) {
      transfer.done = true;
      if (receipt?.status !== "success") state.problem = `${transfer.id} did not go through; check it by hand`;
      return writeJson(FILE, state);
    }
    if (now - (transfer.sentAt ?? 0) < RESEND_MS) return;
  }
  transfer.sentAt = now;
  await writeJson(FILE, state);
  await cfg.reader.sendRawTransaction({ serializedTransaction: transfer.raw! }).catch((error) => {
    if (!/already known|nonce too low/i.test(String(error))) throw error;
  });
}

async function tick(cfg: Config) {
  const state = await load(cfg);
  const now = Date.now();
  const head = (await cfg.reader.getBlockNumber()) - CONFIRMATIONS;
  const from = state.cursor ? BigInt(state.cursor) + 1n : head;
  if (from <= head) {
    const to = from + MAX_BLOCK_RANGE < head ? from + MAX_BLOCK_RANGE : head;
    const logs = await cfg.reader.getLogs({ address: cfg.token, event: TRANSFER, args: { to: cfg.account.address }, fromBlock: from, toBlock: to });
    scan(cfg, state, logs.flatMap((log) => (log.args.from && log.args.value !== undefined ? [{ id: `${log.transactionHash}:${log.logIndex}`, from: log.args.from, amount: String(log.args.value), at: now }] : [])), now);
    state.cursor = String(to);
  } else scan(cfg, state, [], now);
  const open = state.transfers.filter((t) => !t.done);
  state.transfers = state.transfers.filter((t) => t.done).slice(-20).concat(open);
  await writeJson(FILE, state);
  await settle(cfg, state, now);
}

const shared = globalThis as { coinFlipTick?: Promise<void>; coinFlipAt?: number; coinFlipError?: string | null };

export async function getCoinFlipView(): Promise<CoinFlipView> {
  let cfg: Config | null;
  try {
    cfg = config();
  } catch {
    return { status: "error", message: "BAB_PRIVATE_KEY is not a valid private key" };
  }
  if (!cfg) return { status: "unconfigured" };
  if (!shared.coinFlipTick && Date.now() - (shared.coinFlipAt ?? 0) >= TICK_MS) {
    shared.coinFlipTick = tick(cfg)
      .then(() => { shared.coinFlipError = null; }, (error) => {
        const message = (error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error)).split("\n")[0];
        if (message !== shared.coinFlipError) console.error("Coin flip:", message);
        shared.coinFlipError = message;
      })
      .finally(() => { shared.coinFlipAt = Date.now(); shared.coinFlipTick = undefined; });
  }
  const state = await load(cfg);
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
    problem: state.problem ?? shared.coinFlipError ?? null,
  };
}
