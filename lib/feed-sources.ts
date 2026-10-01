// Where the news-and-posts feed comes from, and how often. Edit the lists here; nothing else needs
// to change. Every URL below was fetched and checked for recent items on 2026-10-01.

/** A selection is made this often while a screen is polling /api/feed. One model call each. */
export const REFRESH_MINUTES = 15;
/** The refresh loop pauses when nobody has asked for the feed for this long (the page polls every minute). */
export const IDLE_PAUSE_MINUTES = 10;
/** Items older than this are ignored unless the source sets its own maxAgeHours. */
export const MAX_AGE_HOURS = 36;
/** At most this many candidates are shown to the agent. */
export const MAX_CANDIDATES = 120;
/** At most this many of one source's newest items become candidates. */
export const PER_SOURCE_CANDIDATES = 10;
/** At most this many of one account's newest posts become candidates. */
export const PER_ACCOUNT_CANDIDATES = 2;
/** How many items the agent is asked for, and the most that are ever served. */
export const TARGET_ITEMS = 20;
export const MAX_ITEMS = 25;
/** Fewer valid picks than this from the agent and the deterministic ordering is used instead. */
export const MIN_AGENT_PICKS = 10;
/** Ids from this many previous selections are marked "shown" so the next one rotates. */
export const HISTORY_SELECTIONS = 2;

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2_000_000;
export const FETCH_CONCURRENCY = 6;
export const USER_AGENT = "bab-screen/0.1 (Blockchain at Berkeley wall display; RSS reader)";

export type RssSource = {
  /** Shown on screen as the item's source. */
  name: string;
  url: string;
  /** Overrides MAX_AGE_HOURS; blogs that post rarely get a longer window. */
  maxAgeHours?: number;
  /** Fetch at most this often (default: every refresh). */
  everyMinutes?: number;
};

// RSS and Atom feeds. All keyless. Order matters only as a tie-break.
export const NEWS_FEEDS: RssSource[] = [
  // Crypto news desks
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "The Defiant", url: "https://thedefiant.io/api/feed" },
  { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/feed" },
  { name: "Unchained", url: "https://unchainedcrypto.com/feed/" },
  { name: "Protos", url: "https://protos.com/feed/" },
  { name: "Bankless", url: "https://www.bankless.com/rss/feed", everyMinutes: 30 },
  // Technology and AI
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", everyMinutes: 30 },
  // Research and protocol blogs: a post a week at most, so a longer window and an hourly fetch
  { name: "Ethereum Foundation", url: "https://blog.ethereum.org/feed.xml", maxAgeHours: 7 * 24, everyMinutes: 60 },
  { name: "Vitalik Buterin", url: "https://vitalik.eth.limo/feed.xml", maxAgeHours: 7 * 24, everyMinutes: 60 },
  { name: "a16z crypto", url: "https://a16zcrypto.com/feed/", maxAgeHours: 7 * 24, everyMinutes: 60 },
  // Berkeley
  { name: "Berkeley News", url: "https://news.berkeley.edu/feed/", maxAgeHours: 72, everyMinutes: 60 },
  // The club's own Substack. Last post April 2024; listed so a new post shows up by itself.
  { name: "Blockchain at Berkeley", url: "https://blockchainatberkeley.substack.com/feed", maxAgeHours: 14 * 24, everyMinutes: 60 },
];

// Hacker News front page through the HN Search API (run by Algolia for Y Combinator): one keyless
// request instead of 31 against the Firebase API. Only stories with at least minPoints are used.
export const HACKER_NEWS = {
  name: "Hacker News",
  url: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30",
  minPoints: 150,
};

// Bluesky's public AppView (public.api.bsky.app) needs no key. These accounts were posting in the
// week before 2026-10-01. Shown as kind "tweet" with source "Bluesky", never as X.
// Honest note: crypto founders are mostly absent from Bluesky; this list is technology, AI and
// security voices plus Vitalik and the campus account. Set FEED_BLUESKY=off to drop the source.
export const BLUESKY = {
  name: "Bluesky",
  api: "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed",
  maxAgeHours: 48,
  postsPerAccount: 15,
  accounts: [
    "vitalik.ca",
    "emollick.bsky.social",
    "simonwillison.net",
    "gergely.pragmaticengineer.com",
    "caseynewton.bsky.social",
    "antirez.bsky.social",
    "filippo.abyssdomain.expert",
    "web3isgoinggreat.com",
    "eff.org",
    "ucberkeleyofficial.bsky.social",
  ],
};

// X (Twitter). Off until X_BEARER_TOKEN is set: X has no free read tier (pay-per-use, $0.005 per
// post read, checked 2026-10-01). With a token, posts come from X_LIST_ID if set (one request per
// refresh, the cheapest route) or else from the accounts below (one request per account).
export const X = {
  name: "X",
  api: "https://api.x.com/2",
  maxAgeHours: 48,
  /** X is asked at most this often, whatever REFRESH_MINUTES is. */
  everyMinutes: 30,
  /** Posts requested per account per poll (the API minimum is 5). */
  postsPerAccount: 5,
  /** Posts requested per poll in list mode. */
  postsPerList: 50,
  /** Hard stop on post reads per UTC day; X_MAX_READS_PER_DAY overrides it. 300 reads is $1.50. */
  maxReadsPerDay: 300,
  /** A numeric List ID, or "" to use the accounts. The X_LIST_ID env var overrides it. */
  listId: "",
  // SUGGESTED STARTER LIST - edit freely. Handles were not checked against the X API (no token on
  // this machine); a handle X does not recognise is skipped and named in the source's error.
  accounts: [
    // Founders and researchers
    "VitalikButerin",
    "cdixon",
    "balajis",
    "brian_armstrong",
    "jessepollak",
    "haydenzadams",
    "StaniKulechov",
    "aeyakovenko",
    "chameleon_jeff",
    "drakefjustin",
    "dankrad",
    "TimBeiko",
    "gakonst",
    "danrobinson",
    "tarunchitra",
    "hasufl",
    "zachxbt",
    "tayvano_",
    "sassal0x",
    // Protocols and firms
    "ethereum",
    "solana",
    "base",
    "Uniswap",
    "HyperliquidX",
    "Polymarket",
    "coinbase",
    "a16zcrypto",
    "paradigm",
    // Markets
    "matt_levine",
    "WuBlockchain",
    // AI labs and people
    "AnthropicAI",
    "OpenAI",
    "GoogleDeepMind",
    "sama",
    "karpathy",
    // Berkeley
    "CalBlockchain",
    "BerkeleyRDI",
    "dawnsongtweets",
    "UCBerkeley",
  ],
};
