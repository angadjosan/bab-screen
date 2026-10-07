"use client";

import { useEffect, useState } from "react";
import type { GameScreen, MafiaScreen, PokerScreen } from "../lib/screen-state";
import styles from "./Game.module.css";

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 20, or 20.50: never 20.5. */
const amount = { format: (value: number) => (Number.isInteger(value) ? whole : cents).format(value) };
const signed = (value: number) => (value > 0 ? `+${amount.format(value)}` : value < 0 ? `−${amount.format(-value)}` : "0");
const ROLE: Record<string, string> = { mafia: "Mafia", doctor: "Doctor", detective: "Detective", villager: "Villager" };

/** Seconds left until `endsAt`, ticking while there is a clock. */
function useSecondsLeft(endsAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [endsAt]);
  return endsAt === null ? null : Math.max(0, Math.ceil((endsAt - now) / 1000));
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function Mafia({ game }: { game: MafiaScreen }) {
  const left = useSecondsLeft(game.endsAt);
  const phase = game.phase === "over" ? "Game over" : `${game.phase === "night" ? "Night" : "Day"} ${game.round}`;
  const alive = game.players.filter((player) => player.alive).length;
  return (
    <section className={styles.game} aria-label={`Mafia, ${phase}`}>
      <p className={styles.header}>
        <span>Mafia · {phase}</span>
        <span className={styles.count}>{alive} of {game.players.length} alive</span>
      </p>
      {/* Keyed by the phase, so each new one fades in. */}
      <div key={`${game.phase}:${game.round}`} className={styles.body}>
        <div className={styles.lead}>
          <p className={`${styles.headline} ${game.winner ? styles.isWinner : ""}`}>{game.headline}</p>
          {left !== null && <p className={`${styles.clock} ${left <= 10 ? styles.isLate : ""}`}>{clock(left)}</p>}
        </div>
        {game.detail && <p className={styles.detail}>{game.detail}</p>}
        <ol className={styles.players}>
          {game.players.map((player, i) => (
            <li key={`${i}:${player.name}`} className={`${styles.player} ${player.alive ? "" : styles.isDead}`}>
              <span className={styles.playerName}>{player.name}</span>
              {player.role ? (
                <span className={`${styles.role} ${player.role === "mafia" ? styles.isMafia : ""}`}>{ROLE[player.role]}</span>
              ) : player.votes > 0 ? (
                <span className={styles.votes}>{player.votes === 1 ? "1 vote" : `${player.votes} votes`}</span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Poker({ game }: { game: PokerScreen }) {
  return (
    <section className={styles.game} aria-label={game.title}>
      <p className={styles.header}>
        <span>Poker</span>
        <span className={styles.count}>{game.status === "settled" ? "Settled" : "Live"}</span>
      </p>
      <div className={styles.body}>
        <p className={styles.title}>{game.title}</p>
        {game.players.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">In</th>
                <th scope="col">Stack</th>
                <th scope="col">+/−</th>
              </tr>
            </thead>
            <tbody>
              {game.players.map((player, i) => (
                <tr key={`${i}:${player.name}`} className={player.out ? styles.isOut : ""}>
                  <td className={styles.playerName}>{player.name}</td>
                  <td>{amount.format(player.buyIn)}</td>
                  <td>{player.stack === null ? "–" : amount.format(player.stack)}</td>
                  <td className={player.net !== null && player.net > 0 && i === 0 ? styles.isUp : ""}>{player.net === null ? "–" : signed(player.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {game.payouts.length > 0 && (
          <>
            <p className={styles.subhead}>Who pays whom</p>
            <ol className={styles.payouts}>
              {game.payouts.map((payout, i) => (
                <li key={i} className={styles.payout}>
                  <span className={styles.playerName}>
                    {payout.from} <span className={styles.arrow}>→</span> {payout.to}
                  </span>
                  <span className={styles.amount}>{amount.format(payout.amount)}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        {game.note && <p className={styles.detail}>{game.note}</p>}
      </div>
    </section>
  );
}

/** The game running now, set by the agent (POST /api/screen, op "game"): Mafia's phase and clock, or the poker table. */
export function Game({ game }: { game: GameScreen }) {
  return game.kind === "mafia" ? <Mafia game={game} /> : <Poker game={game} />;
}
