// What a link is, for the club spotlight: its title, opening lines, publisher, picture and date. Web pages are read
// from their Open Graph tags; posts on X through FxTwitter's public API (api.fxtwitter.com), since X itself gives
// nothing without an account. Everything returned is plain text, cut to length; the page shows it as text only.

import { clip, decodeEntities, htmlToText, httpsImage, tidy } from "./feed-parse";
import { fetchJson, fetchPage } from "./feed-fetch";

const TITLE_MAX = 220;
const SUMMARY_MAX = 260;
const SOURCE_MAX = 60;
const X_POST = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})/i;

export type LinkPreview = {
  url: string;
  title: string;
  summary: string | null;
  source: string;
  imageUrl: string | null;
  publishedAt: string | null;
};

/** Facts read off an article's HTML: its text (for finding names in), and its preview picture and description. */
export type PageFacts = { text: string; imageUrl: string | null; description: string | null; title: string | null; siteName: string | null; publishedAt: string | null };

const plain = (value: string | null | undefined, max: number) => {
  const text = value ? tidy(value.replace(/https?:\/\/\S+/g, " ")) : "";
  return text ? clip(text, max) : null;
};

/** The content of a <meta> tag by property or name, whichever order its attributes come in. */
function metaTag(html: string, key: string): string | null {
  const escaped = key.replace(/[:.]/g, "\\$&");
  const before = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "i").exec(html);
  const after = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, "i").exec(html);
  const value = before?.[1] ?? after?.[1];
  return value ? decodeEntities(value) : null;
}

const validDate = (value: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);

export function pageFacts(html: string): PageFacts {
  const body = /<body[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  return {
    text: htmlToText(body),
    imageUrl: httpsImage(metaTag(html, "og:image") ?? metaTag(html, "twitter:image")),
    description: plain(metaTag(html, "og:description") ?? metaTag(html, "description"), SUMMARY_MAX),
    title: plain(metaTag(html, "og:title"), TITLE_MAX),
    siteName: plain(metaTag(html, "og:site_name"), SOURCE_MAX),
    publishedAt: validDate(metaTag(html, "article:published_time")),
  };
}

type FxTweet = {
  text?: string;
  created_at?: string;
  author?: { name?: string; screen_name?: string };
  media?: { photos?: { url?: string }[]; videos?: { thumbnail_url?: string }[] };
};

/**
 * A post's text as running sentences: each line ends in a full stop if it had no punctuation, links are dropped,
 * and a line left with nothing but a lead-in to a link ("Order today:") goes with it.
 */
export function postText(raw: string | undefined): string | null {
  const lines = (raw ?? "").split(/\n+/).map((line) => tidy(line.replace(/https?:\/\/\S+/g, " "))).filter((line) => line && !/:$/.test(line));
  const sentences = lines.map((line) => (/[.!?…"”)]$/.test(line) ? line : `${line}.`));
  return sentences.length ? clip(sentences.join(" "), TITLE_MAX) : null;
}

function tweetPicture(tweet: FxTweet): string | null {
  return httpsImage(tweet.media?.photos?.[0]?.url ?? tweet.media?.videos?.[0]?.thumbnail_url);
}

async function previewPost(url: string, handle: string, id: string): Promise<LinkPreview | null> {
  const body = (await fetchJson(`https://api.fxtwitter.com/${handle}/status/${id}`)) as { tweet?: FxTweet } | null;
  const tweet = body?.tweet;
  const title = postText(tweet?.text);
  if (!tweet || !title) return null;
  const author = plain(tweet.author?.name, SOURCE_MAX) ?? `@${handle}`;
  return { url, title, summary: null, source: `${author} on X`, imageUrl: tweetPicture(tweet), publishedAt: validDate(tweet.created_at ?? null) };
}

async function previewPage(url: string): Promise<LinkPreview | null> {
  const html = await fetchPage(url);
  if (!html) return null;
  const facts = pageFacts(html);
  const title = facts.title ?? plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1], TITLE_MAX);
  if (!title) return null;
  const source = facts.siteName ?? new URL(url).hostname.replace(/^www\./, "");
  return { url, title, summary: facts.description, source, imageUrl: facts.imageUrl, publishedAt: facts.publishedAt };
}

/** A preview of an http(s) link, or null when nothing usable could be read from it. Never throws. */
export async function previewLink(url: string): Promise<LinkPreview | null> {
  try {
    const post = X_POST.exec(url);
    return post ? await previewPost(url, post[1], post[2]) : await previewPage(url);
  } catch {
    return null;
  }
}
