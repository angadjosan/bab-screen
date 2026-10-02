"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CoinFlipView } from "../lib/coin-flip";
import styles from "./CoinFlip.module.css";

const POLL_MS = 2_000;
const QR_BOX_PX = 259;
const SPIN_MS = 5_000;
const SHOW_MS = 16_000;
/** A game older than this when the page first sees it (a reload, a late poll) is not replayed. */
const FRESH_MS = 30_000;
const DEMO_EVERY_MS = 20_000;
const CONFETTI = 70;

type Ok = Extract<CoinFlipView, { status: "ok" }>;
type Game = NonNullable<Ok["game"]>;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const money = (usd: number) => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function Player({ game, side, landed }: { game: Game; side: "heads" | "tails"; landed: boolean }) {
  const state = !landed ? "" : game.winner === side ? styles.won : styles.lost;
  return (
    <div className={`${styles.player} ${state}`}>
      <p className={styles.side}>{side}</p>
      <p className={styles.address}>{short(game[side])}</p>
      <p className={styles.tag}>{landed && game.winner === side ? "Winner" : ""}</p>
    </div>
  );
}

export function CoinFlip() {
  const [view, setView] = useState<Ok | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [landed, setLanded] = useState(false);
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

  // ?coinflip=demo plays the animation with made-up players.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("coinflip") !== "demo") return;
    let n = 0;
    const play = () => setGame({ id: `demo-${n += 1}`, heads: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", tails: "0x2546BcD3c84621e976D8185a91A922aE77ECEc30", stakeUsd: 5, winner: Math.random() < .5 ? "heads" : "tails", ageMs: 0, payoutHash: null });
    play();
    const timer = window.setInterval(play, DEMO_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  const gameId = game?.id;
  useEffect(() => {
    if (!gameId) return;
    setLanded(false);
    const land = window.setTimeout(() => setLanded(true), SPIN_MS);
    const close = window.setTimeout(() => setGame(null), SHOW_MS);
    return () => { window.clearTimeout(land); window.clearTimeout(close); };
  }, [gameId]);

  const side = view ? Math.max(1, Math.floor(QR_BOX_PX / view.qr.modules)) * view.qr.modules : 0;
  const pot = game ? money(game.stakeUsd * 2) : "";
  const paid = !!game && view?.game?.id === game.id && !!view.game.payoutHash;

  return (
    <>
      {view && (
        <section className={styles.tile} aria-label="Coin flip">
          <div className={styles.qr}>
            <svg viewBox={`0 0 ${view.qr.modules} ${view.qr.modules}`} width={side} height={side} shapeRendering="crispEdges" role="img" aria-label="QR code of the coin flip wallet address">
              <path d={view.qr.path} />
            </svg>
          </div>
          <div className={styles.body}>
            <p className={styles.eyebrow}>Coin flip</p>
            <p className={styles.how}>Send USDC on {view.network}</p>
            {!view.waiting && <p className={styles.rules}>{money(view.minUsd)} to {money(view.maxUsd)}. Winner takes both.</p>}
            {view.waiting ? (
              <div className={styles.status}>
                <p className={styles.stake}>{money(view.waiting.usd)} up</p>
                <p className={styles.rules}>Send {money(view.waiting.usd)} to play</p>
                <p className={styles.fine}>{short(view.waiting.from)} · {clock(view.waiting.remainingMs)}</p>
              </div>
            ) : (
              <p className={`${styles.status} ${styles.fine}`}>{view.problem ? "Not watching for deposits right now" : "Waiting for the first stake"}</p>
            )}
          </div>
        </section>
      )}
      {game && (
        <div key={game.id} className={`${styles.overlay} ${landed ? styles.landed : ""}`} role="status">
          <p className={styles.kicker}>Coin flip · {money(game.stakeUsd)} each</p>
          <div className={styles.table}>
            <Player game={game} side="heads" landed={landed} />
            <div className={styles.toss}>
              <div className={styles.coin} style={{ "--end": `${game.winner === "heads" ? 2160 : 2340}deg` } as CSSProperties}>
                <span className={styles.face}>H</span>
                <span className={`${styles.face} ${styles.back}`}>T</span>
              </div>
            </div>
            <Player game={game} side="tails" landed={landed} />
          </div>
          <p className={styles.result}>{landed ? `${game.winner === "heads" ? "Heads" : "Tails"} wins ${pot}` : "Flipping"}</p>
          <p className={styles.payout}>{!landed ? "" : paid ? `${pot} sent to ${short(game[game.winner])}` : `Sending ${pot} to ${short(game[game.winner])}`}</p>
          {landed && (
            <div className={styles.confetti} aria-hidden="true">
              {Array.from({ length: CONFETTI }, (_, i) => (
                <span key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 12) * .09}s`, animationDuration: `${2.4 + (i % 5) * .35}s` }} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
