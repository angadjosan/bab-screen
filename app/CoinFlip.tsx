"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CoinFlipView } from "../lib/coin-flip";
import type { JamQr } from "../lib/jam";
import { CoinToss } from "./CoinToss";
import styles from "./CoinFlip.module.css";

const POLL_MS = 2_000;
const QR_BOX_PX = 259;
const RECEIPT_BOX_PX = 250;
/** How long the receipt QR stays up once the payout has landed, and the longest the stage is held waiting for it. */
const RECEIPT_MS = 20_000;
const MAX_SHOW_MS = 60_000;
const LEAVE_MS = 600;
/** A game older than this when the page first sees it (a reload, a late poll) is not replayed. */
const FRESH_MS = 30_000;
const DEMO_EVERY_MS = 42_000;

type Ok = Extract<CoinFlipView, { status: "ok" }>;
type Game = NonNullable<Ok["game"]>;
type Phase = "flip" | "landed" | "leaving";

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const money = (usd: number) => `$${usd.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(usd) ? 0 : 2, maximumFractionDigits: 2 })}`;
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function Qr({ qr, box, label }: { qr: JamQr; box: number; label: string }) {
  const side = Math.max(1, Math.floor(box / qr.modules)) * qr.modules;
  return (
    <svg viewBox={`0 0 ${qr.modules} ${qr.modules}`} width={side} height={side} shapeRendering="crispEdges" role="img" aria-label={label}>
      <path d={qr.path} />
    </svg>
  );
}

function Player({ game, side, landed }: { game: Game; side: "heads" | "tails"; landed: boolean }) {
  const state = !landed ? "" : game.winner === side ? styles.won : styles.lost;
  return (
    <div className={`${styles.player} ${state}`}>
      <p className={styles.side}><span className={side === "heads" ? styles.mark : styles.dollar}>{side === "heads" ? "" : "$"}</span>{side}</p>
      <p className={styles.address}>{short(game[side])}</p>
      <p className={styles.tag}>{landed && game.winner === side ? "Winner" : ""}</p>
    </div>
  );
}

export function CoinFlip() {
  const [view, setView] = useState<Ok | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [phase, setPhase] = useState<Phase>("flip");
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const next = (await (await fetch("/api/coin-flip", { cache: "no-store" })).json()) as CoinFlipView;
        if (!alive) return;
        setView(next.status === "ok" ? next : null);
        if (next.status === "ok" && next.game && next.game.ageMs < FRESH_MS && next.game.id !== lastId.current) {
          lastId.current = next.game.id;
          setGame(next.game);
        }
      } catch {
        // The next poll tries again.
      }
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  // ?coinflip=demo plays the animation with made-up players; the wallet's QR stands in for the receipt.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("coinflip") !== "demo") return;
    let n = 0;
    const play = () => setGame({ id: `demo-${n += 1}`, heads: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", tails: "0x2546BcD3c84621e976D8185a91A922aE77ECEc30", stakeUsd: 5, winner: Math.random() < .5 ? "heads" : "tails", ageMs: 0, payout: null });
    play();
    const timer = window.setInterval(play, DEMO_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  const gameId = game?.id;
  const landed = phase !== "flip";
  const receipt = !game || !landed ? null : game.id.startsWith("demo") ? view?.qr ?? null : view?.game?.id === game.id ? view.game.payout?.qr ?? null : null;
  const paid = !!receipt;

  useEffect(() => {
    if (!gameId) return;
    setPhase("flip");
    const leave = window.setTimeout(() => setPhase("leaving"), MAX_SHOW_MS);
    return () => window.clearTimeout(leave);
  }, [gameId]);
  const land = useCallback(() => setPhase((now) => (now === "flip" ? "landed" : now)), []);

  useEffect(() => {
    if (!paid) return;
    const leave = window.setTimeout(() => setPhase("leaving"), RECEIPT_MS);
    return () => window.clearTimeout(leave);
  }, [paid, gameId]);

  useEffect(() => {
    if (phase !== "leaving") return;
    const done = window.setTimeout(() => setGame(null), LEAVE_MS);
    return () => window.clearTimeout(done);
  }, [phase]);

  const pot = game ? money(game.stakeUsd * 2) : "";

  return (
    <>
      {view && (
        <section className={styles.tile} aria-label="Coin flip">
          <div className={styles.qr}><Qr qr={view.qr} box={QR_BOX_PX} label="QR code of the coin flip wallet address" /></div>
          <div className={styles.body}>
            <p className={styles.title}>Want to gamble?</p>
            <p className={styles.rules}>Gamble on a coin flip</p>
            {!view.waiting && <p className={styles.fine}>Send USDC on {view.network}, {money(view.minUsd)} or more</p>}
            {view.waiting ? (
              <div className={styles.status}>
                <p className={styles.stake}>{money(view.waiting.usd)}</p>
                <p className={styles.rules}>Match to play</p>
                <p className={styles.fine}>{short(view.waiting.from)} · {clock(view.waiting.remainingMs)}</p>
              </div>
            ) : (
              <p className={`${styles.status} ${styles.fine}`}>{view.problem ? "Not watching for deposits right now" : "Waiting for the first stake"}</p>
            )}
          </div>
        </section>
      )}
      {game && (
        <div key={game.id} className={`${styles.overlay} ${landed ? styles.landed : ""} ${phase === "leaving" ? styles.leaving : ""}`} role="status">
          <p className={styles.kicker}>Coin flip · {money(game.stakeUsd)} each</p>
          <div className={styles.table}>
            <Player game={game} side="heads" landed={landed} />
            <div className={styles.toss}><CoinToss winner={game.winner} onLand={land} /></div>
            <Player game={game} side="tails" landed={landed} />
          </div>
          <p className={styles.result}>{landed ? `${game.winner === "heads" ? "Heads" : "Tails"} wins ${pot}` : ""}</p>
          <p className={styles.payout}>{!landed ? "" : paid ? `${pot} sent to ${short(game[game.winner])}` : `Sending ${pot} to ${short(game[game.winner])}`}</p>
          {receipt && (
            <div className={styles.receipt}>
              <p>Scan for the transaction</p>
              <div className={styles.receiptQr}><Qr qr={receipt} box={RECEIPT_BOX_PX} label="QR code of the payout transaction on the block explorer" /></div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
