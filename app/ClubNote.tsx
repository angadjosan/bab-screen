"use client";

import { useEffect, useState } from "react";
import type { ClubNewsResponse, ClubStory } from "@/lib/feed-types";
import styles from "./ClubNote.module.css";
import { age } from "./time-ago";

const POLL_MS = 60_000;
/** A club story holds the feed column this long, then the news scrolls for CLUB_GAP_MS before the next one. */
const CLUB_SHOW_MS = 20_000;
const CLUB_GAP_MS = 70_000;

const nameList = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });
const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

function cleanPeople(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((person) => text(person, 60)).filter((person): person is string => person !== null).slice(0, 4);
}

function cleanImage(raw: unknown): string | null {
  const image = text(raw, 2000);
  return image?.startsWith("https://") ? image : null;
}

function cleanStory(raw: unknown): ClubStory | null {
  if (!raw || typeof raw !== "object") return null;
  const story = raw as Partial<Record<keyof ClubStory, unknown>>;
  const id = text(story.id, 64);
  const title = text(story.title, 300);
  if (!id || !title) return null;
  return {
    id,
    title,
    summary: text(story.summary, 400),
    source: text(story.source, 80) ?? "",
    url: text(story.url, 2000) ?? "",
    imageUrl: cleanImage(story.imageUrl),
    publishedAt: text(story.publishedAt, 40) ?? "",
    people: cleanPeople(story.people),
    via: story.via === "slack" ? "slack" : "news",
    sharedBy: text(story.sharedBy, 80),
  };
}

/** Stories about the club and its people (lib/club-news.ts), polled every minute. */
export function useClubStories(): ClubStory[] {
  const [stories, setStories] = useState<ClubStory[]>([]);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const response = await fetch("/api/club-news", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as Partial<ClubNewsResponse>;
        const next = (Array.isArray(body.stories) ? body.stories : []).map(cleanStory).filter((story): story is ClubStory => story !== null);
        if (alive) setStories((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      } catch {
        // Keep the last list; the next poll tries again.
      }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return stories;
}

/**
 * Which club story holds the feed column now, or null while the news scrolls. Each takes CLUB_SHOW_MS in turn
 * with CLUB_GAP_MS of news between them, and none goes up while a token's note is showing (`waiting`).
 */
export function useClubTurn(stories: ClubStory[], waiting: boolean): ClubStory | null {
  const [turn, setTurn] = useState<{ index: number; on: boolean }>({ index: 0, on: true });
  const count = stories.length;
  useEffect(() => {
    if (!count || waiting) return;
    const timer = window.setTimeout(
      () => setTurn((current) => (current.on ? { index: current.index, on: false } : { index: (current.index + 1) % count, on: true })),
      turn.on ? CLUB_SHOW_MS : CLUB_GAP_MS,
    );
    return () => window.clearTimeout(timer);
  }, [count, waiting, turn]);
  if (!count || waiting || !turn.on) return null;
  return stories[turn.index % count];
}

function heading(story: ClubStory) {
  return story.people.length ? `${nameList.format(story.people)} in the news` : "B@B in the news";
}

function sourceLine(story: ClubStory, now: number) {
  const when = age(story.publishedAt, now);
  const from = when ? `${story.source}, ${when}` : story.source;
  return story.sharedBy ? `${from}. Shared by ${story.sharedBy}.` : from;
}

/**
 * A story about the club or one of its people, over the feed column. All of it is the publisher's or the poster's
 * own words. Headed by the club's mark, the screen's one image of the club, so it reads as ours at a glance.
 */
export function ClubNote({ story, on, now }: { story: ClubStory; on: boolean; now: number }) {
  return (
    <article className={on ? `${styles.note} ${styles.on}` : styles.note} aria-label={heading(story)} aria-hidden={!on}>
      <h2 className={styles.heading} dir="auto">
        <img className={styles.mark} src="/bab-logo.svg" alt="" width={344} height={311} />
        {heading(story)}
      </h2>
      {story.imageUrl && <img className={styles.image} src={story.imageUrl} alt="" />}
      <p className={styles.title} dir="auto">{story.title}</p>
      {story.summary && <p className={styles.summary} dir="auto">{story.summary}</p>}
      <p className={styles.source} dir="auto">{sourceLine(story, now)}</p>
    </article>
  );
}
