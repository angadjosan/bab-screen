"use client";

import type { Leaderboard as LeaderboardData } from "../lib/screen-state";
import styles from "./Leaderboard.module.css";

const score = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * Any game's scores, set by the agent (POST /api/screen, op "leaderboard"), highest first. Ties share a rank.
 * It fills whatever box it is given and shows as many rows as fit; the rest are cut at a fade.
 */
export function Leaderboard({ board }: { board: LeaderboardData }) {
  let rank = 0;
  return (
    <section className={styles.board} aria-label={board.title}>
      <p className={styles.title}>{board.title}</p>
      <ol className={styles.list}>
        {board.rows.map((row, i) => {
          if (i === 0 || row.score !== board.rows[i - 1].score) rank = i + 1;
          return (
            <li key={`${i}:${row.name}`} className={`${styles.row} ${rank === 1 ? styles.isFirst : ""}`}>
              <span className={styles.rank}>{rank}</span>
              <span className={styles.name}>{row.name}</span>
              <span className={styles.score}>{score.format(row.score)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
