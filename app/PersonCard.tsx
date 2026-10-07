"use client";

import { useState } from "react";
import type { PersonCard as Card } from "../lib/screen-state";
import styles from "./Overlay.module.css";

/** A link as it reads from across the room: the host and path, without the scheme, "www." or a trailing slash. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

/** Who someone is, put up by the agent (op "person") when a visitor is introduced. */
export function PersonCard({ card }: { card: Card }) {
  const [badImage, setBadImage] = useState<string | null>(null);
  const image = card.imageUrl && card.imageUrl !== badImage ? card.imageUrl : null;
  return (
    <div className={styles.person}>
      {image && (
        <div className={styles.photo}>
          <img src={image} alt={card.name} referrerPolicy="no-referrer" onError={() => setBadImage(image)} />
        </div>
      )}
      <div className={styles.personBody}>
        <p className={styles.kicker}>Say hi to</p>
        <p className={styles.name}>{card.name}</p>
        {card.headline && <p className={styles.headline}>{card.headline}</p>}
        {card.summary && <p className={styles.summary}>{card.summary}</p>}
        {card.links.length > 0 && (
          <ul className={styles.links}>
            {card.links.map((link) => (
              <li key={link.url} className={styles.link}>
                <span className={styles.linkLabel}>{link.label}</span>
                <span className={styles.linkUrl}>{shortUrl(link.url)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
