"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { Overlay } from "../lib/screen-state";
import { PersonCard } from "./PersonCard";
import styles from "./Overlay.module.css";

/**
 * What the agent puts on top of the stage (POST /api/screen): a banner along the bottom and a person card in the
 * middle. The server prunes each one when it expires and pushes the change; the page also drops one whose time
 * is up on its own clock, so an overlay never outstays its time while the stream is down.
 */
export function Overlays({ overlays }: { overlays: Overlay[] }) {
  const [now, setNow] = useState(() => Date.now());
  const next = overlays.reduce((soonest, overlay) => (overlay.expiresAt > now ? Math.min(soonest, overlay.expiresAt) : soonest), Infinity);

  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [next]);

  // A new overlay set comes with a new now, so its remaining time is measured from when it arrived.
  useEffect(() => setNow(Date.now()), [overlays]);

  const live = overlays.filter((overlay) => overlay.expiresAt > now);
  const banner = live.find((overlay) => overlay.kind === "banner");
  const person = live.find((overlay) => overlay.kind === "person");

  return (
    <>
      {person && (
        <div key={person.id} className={styles.scrim} role="status" aria-live="polite">
          <PersonCard card={person.card} />
        </div>
      )}
      {banner && (
        <div key={banner.id} className={styles.banner} role="status" aria-live="polite">
          <p className={styles.bannerKicker}>Worm</p>
          <p className={styles.bannerText}>{banner.text}</p>
          <div className={styles.drain} aria-hidden="true">
            {/* Empties over the time left, from the share of it still to go. */}
            <span
              style={{
                "--from": Math.min(1, Math.max(0, (banner.expiresAt - now) / Math.max(1, banner.expiresAt - banner.createdAt))).toFixed(4),
                animationDuration: `${Math.max(0, banner.expiresAt - now)}ms`,
              } as CSSProperties}
            />
          </div>
        </div>
      )}
    </>
  );
}
