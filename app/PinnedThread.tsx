"use client";

import type { PinnedThread as Thread } from "../lib/screen-state";
import styles from "./PinnedThread.module.css";

/**
 * Slack writes links and mentions as <url|label>, <url>, <@U123> and escapes &, < and >. The agent should send
 * plain text, but anything left over is turned into words here rather than shown raw.
 */
function plain(text: string): string {
  return text
    .replace(/<([^<>|]+)\|([^<>]+)>/g, "$2")
    .replace(/<[@#!][^<>]*>/g, "")
    .replace(/<(https?:[^<>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** A Slack thread the agent pinned to the screen (op "pin_thread"): the first message large, the replies under it. */
export function PinnedThread({ thread }: { thread: Thread }) {
  const count = thread.replies.length;
  return (
    <section className={styles.thread} aria-label="Pinned Slack thread">
      <p className={styles.header}>
        <span>Pinned from Slack</span>
        {count > 0 && <span className={styles.count}>{count === 1 ? "1 reply" : `${count} replies`}</span>}
      </p>
      {/* Keyed by the thread, so a new one fades in. */}
      <div key={`${thread.channel}:${thread.ts}`} className={styles.body}>
        {thread.author && <p className={styles.author}>{thread.author}</p>}
        <p className={styles.text}>{plain(thread.text)}</p>
        {count > 0 && (
          <ol className={styles.replies}>
            {thread.replies.map((reply, i) => (
              <li key={i} className={styles.reply}>
                <p className={styles.replyAuthor}>{reply.author}</p>
                <p className={styles.replyText}>{plain(reply.text)}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
