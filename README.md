# Markets and Spotbot dashboard

A fixed 1920x1080 screen for a TV: the Blockchain at Berkeley mark (`public/bab-logo.svg`, also the favicon as `app/icon.svg`) beside the time (Berkeley, `h:mm`) and a ring that fills over the 12 seconds until the next Ethereum block (`app/Clock.tsx`; worked out from the beacon chain's slot clock, so no node is asked), then a scrolling ticker tape across the top, and three columns below it. Left (432px): a feed of news and posts from `/api/feed` that drifts slowly upward in a loop (`app/Feed.tsx`; the speed is `FEED_SCROLL_PX_PER_S`), replaced by a short AI-written note while a token that is in the news is featured (see Newsworthy tokens). Middle (816px): one featured market, its price above a chart of the last 24 hours in 30-minute candles, drawn by the page from the same venue as the price (`app/CandleChart.tsx`, `lib/candles.ts`). Right (496px wide, 901px tall): the song playing in Spotify (120px), a carousel that rotates quotes and chumming photos from Slack, and under it the club calendar's week (see "Upcoming events"). A new Spotbot photo takes over the whole screen for a few seconds, and the spots of the last hour are listed under the feed (see "Spot alerts"). The column widths are `grid-template-columns` on `.dashboard` in `app/globals.css`. Run `npm run dev` and open http://127.0.0.1:3000 in Chrome.

## The right column and the events band

The right column is the now-playing tile, a 24px gap, and the carousel in the height that is left (`.side-slot` in `app/globals.css`, `app/page.tsx`). Under the chart and the carousel, across both, is the week's events band (`.events-band`, see "Upcoming events"), 290px tall while the calendar has an event that has not ended. While the calendar is not connected, still loading or empty, the band takes no space and the chart and the carousel have the whole height. The change eases over about half a second (`--bab-slow`); with reduced motion it is immediate.

- **Carousel** (`PhotoCarousel` in `app/page.tsx`): a picture frame with a caption under it. Quotes and chumming photos share it; Spotbot photos are not in it (see "Spot alerts"). Quotes are the backbone, drawn at random from the deck in `app/Quotes.tsx`. A chumming photo (see "Chumming photos") is slipped in after every two or three quotes, two or three chosen at random each time (`chumGap`).
- **Caption height** is the same for every slide, so the frame never changes size between slides: all captions share one grid cell (as tall as the tallest of them), and while quotes are in the rotation the cell is at least 137px, the tallest a quote's caption can be. A chumming caption is never taller than 127px.
- **Jam QR**: for its minute the tile is 300px instead of 120px, and the frame gives up the 180px.

Heights, measured on 2026-10-05 with quotes in the rotation:

| State | Tile | Frame | Caption | Chart slot | Events band |
| --- | --- | --- | --- | --- | --- |
| No events this week | 120 | 595 | 137 | 890 | none |
| Events this week | 120 | 263 | 137 | 558 | 290 |

All ledger rules, and the frame, sit in the middle of 42px of space (`--rule-gap`), so every block has 21px on each side of the rule next to it.

## Market data

The tape and the featured slot show two lists of tokens: ten set tokens that are always on, and the newsworthy tokens described below. The set tokens are `SET_ASSETS` in `lib/markets.ts`, in tape and rotation order: HYPE, SOL, ETH, BTC, XMR, ZEC, NEAR, XRP, RAIN, XLM. There are no stocks, indices or pre-IPO markets.

Prices and 24-hour changes are read in the browser, with no API key or account, from one of two venues:

- **Hyperliquid** (`api.hyperliquid.xyz`): the token's perpetual contract, over one WebSocket, with a REST request every 30 seconds while the socket is down and every 5 minutes otherwise. Nine of the set tokens are read here. The chart is drawn from the same market's candles (Hyperliquid's `candleSnapshot`).
- **Gate** (`api.gateio.ws`): the token's spot market against USDT, for a token Hyperliquid does not list. One REST request per token every 15 seconds (`GATE_POLL_MS`); Gate allows 200 public requests per 10 seconds per address. The chart is drawn from the same pair's candles (Gate's `spot/candlesticks`). RAIN (Rain protocol) is read here: Hyperliquid has no RAIN perpetual, and its RAIN spot listing does not trade (no sell orders and no volume when checked on 2026-10-01, at a price 6% away from the market's). So RAIN's price is a last trade in USDT rather than a mark price in USDC, it moves every 15 seconds rather than live, and the line under its chart says "Price and chart: Gate spot market".

The chart is drawn in SVG by `app/CandleChart.tsx`: 48 half-hour candles with volume, the live price as a gold dotted line, and labels at a size readable across the room. It is always the last 24 hours, whatever its width, so focus mode shows the same window across the full screen. The featured slot shows two set tokens, then one newsworthy token, and so on (`SETS_PER_NEWS` in `app/Markets.tsx`); each list carries on from where it left off, so a token never follows itself, and with no newsworthy tokens the set tokens simply cycle. A set token stays for 10 seconds (`FEATURE_MS`) and a newsworthy one for 20 (`NEWS_FEATURE_MS`), long enough to read its note. The next chart loads behind the current one; a token is passed over while it has no fresh price (older than a minute) or its chart will not load, and a chart that failed is tried again 10 minutes later.

## Now playing

The tile at the top right shows the track playing in the Spotify desktop app on the same Mac as the dev server: cover, title, artist and position. For a minute after someone asks for it in Slack, the tile shows the Jam QR instead (see "Jam QR"). `lib/now-playing.ts` reads it with `osascript` (JXA) through Spotify's AppleScript dictionary; no Spotify account, API key or env var is needed. It only reads: it never starts Spotify or changes playback, and when Spotify is closed or stopped the tile says "Nothing playing". The page asks `/api/now-playing` every 4 seconds and the server runs `osascript` at most once every 1.5 seconds.

The first read makes macOS ask whether the program running the dev server (Terminal, iTerm, your editor) may control Spotify. Choose Allow. If it was denied, turn it on under System Settings > Privacy & Security > Automation; until then the tile shows that instruction.

## Connect Spotbot in Slack

1. Create an **internal Slack app** for your workspace at [api.slack.com/apps](https://api.slack.com/apps). Under **OAuth & Permissions**, add the bot token scopes `channels:history` (public channel), `groups:history` (private channel), `files:read` (uploaded images), and `users:read` (names of the spotter and the people spotted; without it names are left out). You only need the history scope matching your channel type. Reinstall the app after adding a scope.
2. Install the app to the workspace and copy its **Bot User OAuth Token** (`xoxb-...`). Invite the app to the channel where Spotbot posts; the bot token can read history only for conversations it belongs to.
3. Copy the channel ID from Slack’s channel details. Copy `.env.example` to `.env.local`, then set `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`. To limit results to Spotbot, also set `SLACK_SPOTBOT_USER_ID` to the user ID or bot ID on its messages. Restart the dev server after changing env vars.

The dashboard reads the six most recent images in the newest 100 channel messages and shows new ones as described under "Spot alerts". It refreshes Slack data at most once per minute in a running server process; while the Slack agent's listener is up, a new image post makes the next request re-read the channel at once and the routine re-read drops to every 10 minutes (see "Slack events"). Uploaded images pass through a signed local endpoint; the browser never receives the bot token. Image blocks or attachments with public HTTPS image URLs load directly. If no image is among the newest 100 messages, it shows an empty state.

Slack API references: [conversation history and scopes](https://docs.slack.dev/reference/methods/conversations.history/), [private file URLs](https://docs.slack.dev/reference/objects/file-object/), [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).

## Quotes

`GET /api/quotes` returns a random sample (`?count=`, 40 by default, 100 at most) of the quotes posted in the Slack channel `SLACK_QUOTES_CHANNEL_ID` (the club's quotes channel is `C7CJ73H55`). Invite the bot to that channel (`/invite @bot`); the scopes Spotbot already needs are enough, and nothing is ever posted. Until the bot is a member the response is `"status": "error"` with `"error": "not_in_channel"` and no quotes.

`lib/quotes.ts` reads the messages of the last 18 months only (`QUOTES_MAX_AGE_DAYS`, 548 days counted back from now; at most the newest 2,000 of them), once an hour (every 6 hours while the Slack agent's listener is up, which re-reads about 20 seconds after each post, edit or delete instead; see "Slack events"), and keeps at most 400 quotes in memory and in `.data/quotes.json`; a request never waits for Slack. Slack is not asked for anything older, and a quote that passes 18 months is dropped the next time quotes are requested. Because the whole window is read again each hour, a quote edited or deleted in Slack leaves the screen within the hour. A quote is a top-level message posted by a person: bot messages, join and leave notices, thread replies, messages with a link, a code block or `@channel`, messages with a file that is not an image, and anything over 240 characters are left out. So is the channel talking about a quote: text with no image that has no quotation marks, names nobody and is not a conversation (`this a fake quote`). There is no filter on what a quote says.

Each quote has `text` (plain text: mentions as names, Slack markup and emoji codes removed), `who`, `poster`, `postedAt`, and `imageUrl` when the message has an image, served through the same signed endpoint as Spotbot photos; a message that is only an image is a quote with `text: null`. `who` is the person quoted and is set only when the message names them (`"words" - Name`, `words — @mention`, `Name: words`, a `>` quote with a name or mention on the next line); otherwise it is `null`, and the person who posted the message is never shown as the one who said it. Several `Name: words` lines are kept as a conversation, one line per speaker.

`app/Quotes.tsx` has the pieces the carousel shows them with: `useQuoteDeck()` (random order, the whole batch before any repeat), `QuoteFrame` (the picture, or the words set large when there is none) and `QuoteCaption`. A photo fills the frame and a screenshot is shown whole; under either, the caption is the quote itself (one line at 48px, two at 36px or three at 28px, whichever is the largest that fits; longer text is cut with an ellipsis), then who said it and "quoted by" whoever posted it. A quote with no picture is set large in the frame, and its caption is who said it and "Quoted by". While the deck is empty (`not_in_channel`, or no quotes) the carousel shows chumming photos only, and it starts mixing quotes in by itself within a minute of the first successful answer; no restart is needed.

## Chumming photos

`GET /api/chum` returns six photos posted in the last 2 years in the Slack channel `SLACK_CHUM_CHANNEL_ID` (the club's chumming channel is `C032XEA9PTJ`), where members post pictures of themselves hanging out with other members. Invite the bot to the channel (`/invite @bot`); the scopes Spotbot already needs are enough, and nothing is ever posted. With the variable empty the response is `"status": "unconfigured"` and the carousel carries on with quotes; the same goes for any failure in this channel, which never reaches `/api/spot` or `/api/quotes`.

`lib/chum.ts` reads every message of the last 2 years (`CHUM_MAX_AGE_DAYS`, 730 days; at most the newest 2,000 messages) once an hour per server process (and again right after each new post while the Slack agent's listener is up, see "Slack events"), and keeps the last read if a re-read fails. The six are the newest photo plus five drawn at random from the rest, drawn again every 10 minutes; a newly posted photo joins at once. Photos are counted one by one: a message with two pictures gives two of the six, in the order they were attached, each with the same caption. Videos and other files, bot and Slackbot messages, join notices and thread replies are left out. Pictures go through the same signed endpoint as Spotbot photos (`/api/spot/image`) and names through the same lookup. Each photo has `poster`, `chums` (the people the message mentions), and `text` (mentions as `@Name`; emoji codes and links removed). The page asks every 30 seconds and keeps its last list if an answer says Slack could not be read.

The caption follows how the channel is used: a post means "me, with these people" (`chum @A`, `donuts w/ @A @B`, `chumming with @A`), and the poster never mentions themselves. So the headline is the people named, and the line under it reads "Chumming with" the poster, where a quote says "Quoted by". The message is shown between the two, on one line, when it says more than the names and the word chum (`tane w/ @A` is shown; `chum @A` is not). When the post names nobody, the message is the headline (`b@by group hang`) over "Chumming with" the poster; with no message either, the poster is the headline and the line reads "Chumming". The headline keeps to one line at 48px; one that does not fit is set at 36px, on one line over the message or else on two lines without the message, since the names matter more. Names that still do not fit are cut to "A, B, and 2 others", and a message is cut with an ellipsis. `ChumCaption`, the deck (`createChumDeck`) and the poll (`useChumPhotos`) are in `app/Chum.tsx`.

## Song requests

People post Spotify track links in a Slack channel and the server adds them to the Spotify queue. Every 20 seconds it reads new messages in `SLACK_SONGS_CHANNEL_ID` and adds each track link to the play queue of the connected account (or a playlist, or both). A message without a track link is ignored: nothing is looked up and nothing is logged, only counted in `slack.ignoredMessages`.

Accepted links, at most five per message, with any text around them:

- `https://open.spotify.com/track/<id>`, with or without a locale segment (`/intl-de/`) and a query string (`?si=...`)
- `spotify:track:<id>`
- `https://spotify.link/...` short links, followed through Spotify's own redirects only

Album, playlist, artist and episode links are ignored. Only messages posted after the first successful read are handled; the position is saved in `.data/songs.json`, so a restart never replays old messages, and requests older than 30 minutes are dropped rather than played late. Bot messages, join notices and thread replies are ignored.

Setup:

1. Invite the Slack bot to the songs channel (`/invite @bot`) and set `SLACK_SONGS_CHANNEL_ID`. The existing `channels:history` scope is enough.
2. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) with the Web API enabled and the redirect URI `http://127.0.0.1:3000/api/spotify/callback` (Spotify rejects `localhost`). New apps are in Development Mode: the app only works while its owner has Spotify Premium, and any other account that will log in (the one playing on this Mac, if it is not the owner) must be added by name and Spotify email under the app's Users Management tab (five users at most). Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env.local`.
3. Open http://127.0.0.1:3000/api/spotify/login once on this Mac, signed in to Spotify as the account that plays on this Mac, and approve. The refresh token is stored in `.data/spotify.json` (mode 600, gitignored).
4. Start something playing in the Spotify app on this Mac.
5. The server starts a five-second fallback poll automatically, including after an internal Next.js restart. The agent's Slack listener also nudges the server as soon as a message arrives (see "Slack events"). Open http://127.0.0.1:3000/api/songs/sync to run a check immediately. `/api/songs/status` shows the same state without contacting Slack or Spotify.

`SPOTIFY_SONGS_MODE` chooses where songs go:

- `queue` (default): added to the play queue of whichever device is playing. While nothing is playing the request waits, is retried every poll, and is queued as soon as playback starts; after 30 minutes it is dropped. Spotify documents add-to-queue as Premium-only; the app tries anyway, and if Spotify refuses, the request is marked failed and the status JSON reports `spotify.problem: "premium_required"`.
- `playlist`: appended to `SPOTIFY_SONGS_PLAYLIST_ID` (an ID or an `open.spotify.com/playlist/...` link, owned by the connected account). If that is empty, a private playlist called "B@B Song Requests" is created on first use. Works with nothing playing, and a song already in the playlist is not added twice. To hear the requests, play that playlist; Spotify does not document whether a track appended to the playlist that is currently playing is picked up without restarting it.
- `both`: playlist, plus one attempt at the queue. A queue failure does not undo or repeat the playlist add.

If a link does not show up in the queue, read `spotify.problem`, `spotify.help`, `pending` and `recent` in the status JSON: `no_active_device` means nothing is playing, `premium_required` means Spotify refused the account, `insufficient_scope` or `login_expired` means open the login URL again, and `unknown_track` on a request means the link's track ID does not exist.

Spotify has no public API for Jams. A small local Spicetify extension uses Spotify Desktop's internal API to create or reuse the current Jam and sends only its fresh invite to the dashboard (see "Jam QR" below).

Set `SLACK_SONGS_REPLY=1` to have the bot answer in the request's thread ("Queued: ..."); it is off by default. `SONGS_MAX_AGE_MINUTES` and `SONGS_POLL_SECONDS` (0 turns the poll off) are optional.

## Bot commands

Mention the Slack bot in the songs channel with one of these words. The person who said it gets a private answer ("Volume 20 (it was 45).").

| Command | What it does |
| --- | --- |
| `@spotbot-reader focus` | Focus mode: only the B@B mark, the ticker tape, the featured market and, across the whole width under it, the week's events (the chart takes the whole stage when there are none). The music keeps playing. If Spotify is playing, the answer has three buttons: dim it to volume 10, pause it, or keep it as it is. |
| `@spotbot-reader unfocus` (or `focus off`) | Back to the full screen. A dim or pause picked for focus mode is undone. |
| `@spotbot-reader dim` | Spotify to volume 10, the same as the Dim button. |
| `@spotbot-reader pause` (or `stop`) | Pauses Spotify. |
| `@spotbot-reader play` (or `resume`) | Starts Spotify again. |
| `@spotbot-reader volume 20` | Sets Spotify's volume (0 to 100). `louder`, `quieter`, `turn it down`, `decrease volume` and the like move it by 15 (`lib/volume-request.ts`). |
| `@spotbot-reader jam` | Shows the Jam QR for a minute (see "Jam QR"). |
| `@spotbot-reader spotlight <link> <who>` | Puts a story about the club or someone in it in the feed column's spotlight for three days (see "Club in the news"). `<who>` is optional, e.g. `Nicholas Chua`. |
| `@spotbot-reader spotlight off` | Takes every shared story down again. |

Focus mode stays on until turned off, across restarts (`.data/focus.json`). A pause, play or volume said during focus mode wins: unfocus then leaves the music as it is. The focus buttons are answered by the Slack agent (`agent/slack.ts`), so they need it running and Interactivity turned on for the Slack app (api.slack.com/apps > Interactivity & Shortcuts; in Socket Mode there is no request URL to fill in). Without either, `@spotbot-reader dim` and `@spotbot-reader pause` do the same. A message with a Spotify track link is a song request, not a command, even if it says "play". Commands arrive through the Slack listener with a five-second fallback poll, and the page asks `/api/focus` every 4 seconds. See `lib/commands.ts`.

## Jam QR

When someone mentions the Slack bot in the songs channel with the word "jam" (`@bot jam`), the Spicetify extension in Spotify Desktop creates or reuses the current Jam and retrieves a fresh invite. The now-playing tile shows its QR for one minute, then returns to the song. The requester also receives a private ephemeral Slack message with the clickable invite or the reason creation failed.

1. Install Spicetify (`brew install spicetify-cli`) and set `spotify_path` to `/Applications/Spotify.app/Contents/Resources`.
2. Run `node scripts/install-jam-extension.mjs`. This registers `bab-jam.js` and generates a private key in `.data/jam-bridge.json`; neither the key nor Spotify credentials are committed.
3. Run `spicetify -n backup apply` on a fresh installation, or `spicetify -n apply` with an existing backup, then `spicetify spotify-updates block`. Restart Spotify and keep a Premium account logged in.
4. Restart the dev server and send `@bot jam` in the songs channel.

The authenticated bridge at `http://127.0.0.1:3000/api/jam/bridge` carries only a request ID, the invite URL or an error. Spotify's access token stays inside Spotify. `/api/songs/status` reports bridge health and the last Jam error. Manual `@bot jam <link>` remains available, and `SPOTIFY_JAM_URL` is retained as a legacy fallback; a bare command always requests a fresh invite and never reuses the old link.

Accepted links are `https://open.spotify.com/socialsession/...`, `https://spotify.link/...` and `https://spotify.app.link/...`. Nothing else is ever put in the QR. If the bot is asked before any link is known, the tile says how to set one for that minute instead.

The trigger is a message typed by a person in `SLACK_SONGS_CHANNEL_ID` (not a bot message, a join notice or a thread reply) that contains a mention of the bot and "jam" as a whole word, in any case ("jammed" and "jams" do not count, and neither does "jam" inside a link). Socket Mode normally delivers it within a couple of seconds; the fallback poll runs every five seconds. Spotify invite creation and the page's four-second poll add a little more time. The minute starts after the fresh invite arrives. A request posted more than two minutes before the server reads it does not create a Jam or show a QR, though a manually supplied link is still stored.

For that minute the tile grows from 120px to 300px, because at 120px the code is too small to scan from across a room. If the calendar block is showing, it steps aside for the minute; otherwise the carousel below gives up the difference. At 300px each module of a typical invite link is 7 to 9 whole screen pixels (about 5 mm on a 55-inch TV), black on white with a white margin. `/api/songs/status` shows the current link and bridge health under `jam`, and `/api/now-playing` carries `jam` while the QR is up.

## Slack events

With `SLACK_APP_TOKEN` set and the Slack agent running, the agent's Socket Mode listener sees every message in the spots, chumming, quotes and songs channels as it is posted (`agent/feeds.ts`). It does not read or store anything for those tiles itself: it sends the Next app a nudge, `POST /api/slack/nudge` with `{"feed": "spots" | "chum" | "quotes" | "songs", "ts"?: "<message ts>"}`, and the Next app re-reads that channel as it always does. So the Next process stays the only writer of `.data/songs.json` and `.data/quotes.json`, and a song request goes through the same lock and cursor whether the nudge or the poll reads it first: it is queued once. A nudge is sent about 1.5 seconds after a message (a burst is one nudge) and at most every 5 seconds per channel. Thread replies are ignored, as the tiles ignore them; edits and deletes nudge the spots, chumming and quotes tiles.

The agent also sends `{"feed": "listener"}` every minute. For 3 minutes after a nudge or heartbeat the Next app counts the listener as up (`loop.slackListener` in `/api/songs/status`). Songs and commands are still polled every five seconds; the other feeds use slower safety intervals. Without `SLACK_APP_TOKEN`, with the agent stopped, in `JARVIS_DRY_RUN=1`, or without `SCREEN_SECRET`, no nudge arrives and polling continues.

The route takes the same guard as `POST /api/screen`: only from this machine, with `x-screen-secret` equal to `SCREEN_SECRET` (401 wrong secret, 403 not local or no secret set). A mention of the bot in the songs channel with a track link or "jam" is left to the songs poll rather than also run as a request to the agent, so it is not queued twice.

## News and posts feed

`GET /api/feed` returns about twenty news items and posts for the feed column. Candidates are gathered from the sources below, an AI agent picks which ones go up, and the answer is served from memory: a request never waits for a fetch or for the agent. The selection is redone every 15 minutes while a screen is polling (`REFRESH_MINUTES` in `lib/feed-sources.ts`); after 10 minutes without a request the loop stops fetching and stops calling the agent. The last selection is kept in `.data/feed.json`, so a restart shows it at once.

Sources, all in `lib/feed-sources.ts` (edit the lists there):

- **News, no key needed.** RSS/Atom feeds of:
  - crypto desks: CoinDesk, The Block, Decrypt, Cointelegraph, The Defiant, Bitcoin Magazine, Unchained, Protos and Bankless;
  - technology: TechCrunch, Ars Technica, The Verge and MIT Technology Review;
  - AI labs and developer platforms, for model releases and launches in their own words: OpenAI, Google AI, Hugging Face, Cloudflare, GitHub and Simon Willison's weblog (Anthropic publishes no feed);
  - research blogs: the Ethereum Foundation, Vitalik Buterin and a16z crypto;
  - Berkeley: The Daily Californian and The Berkeley Scanner, which report safety incidents on and around campus within the hour, the technology and engineering section of Berkeley News, Berkeley EECS news, and the club's Substack.

  Also the Hacker News front page through the HN Search API (stories with 150 points or more). Items older than 36 hours are ignored (three days for the AI and developer blogs, two for Simon Willison, a week for the research blogs, Berkeley News and EECS). Sponsored posts, press releases, price predictions, daily roundups and newsletter digests ("Morning Minute", "Week in review") are filtered out, and the same story from several outlets is shown once.
- **Posts, no key needed: Bluesky.** The latest posts of the accounts in `BLUESKY.accounts`, read from Bluesky's public API and shown as source "Bluesky". These are technology, AI and security voices plus Vitalik and the campus account; crypto founders mostly do not post there. Set `FEED_BLUESKY=off` to drop the source.

Who picks: once per refresh the candidates (at most 120: source, age and headline or post text, nothing else) go to a model in a single request. `FEED_AGENT` chooses which:

- `codex` (the default): OpenAI's Codex CLI (`codex exec`, model `gpt-6-luna`, about 5 to 15 seconds). It must be installed and logged in on this Mac (`codex login`); runs count against that ChatGPT plan, or are billed to the API key if Codex was logged in with one.
- `claude`: Claude Haiku 4.5, through the Messages API when `ANTHROPIC_API_KEY` is set and otherwise through the `claude` command (Claude Code) on this Mac, which must be logged in (about 10 seconds).
- `off`: nobody; the newest items are shown, taking turns between sources.

If the chosen agent is missing, fails or takes more than 90 seconds, the other one is tried once; if that fails too, the `off` ordering is used for that refresh and the response says `"curation": "fallback"`. The response's `agent` field says who made the selection on screen (`codex`, `claude-cli`, `claude-api`, or `null` for the fallback) and `agentModel` which model. That is at most 96 model calls a day.

What gets picked: the prompt (`SYSTEM_PROMPT` and `GROUPS` in `lib/feed-agent.ts`) tells the model that the members build in crypto, AI and software, and has it sort its picks into topic groups, taken in turn down the column: campus safety alerts, AI and technology (up to 6), protocols, posts, security, policy, markets and campus. Campus news is limited to what a student in a technical club would act on or talk about; research from unrelated fields, gadget reviews and general-interest stories are left out. An AI lab's or platform's own post announcing a model, capability or research result counts as news, not promotion.

**Campus safety alerts.** A threat to people's safety on the UC Berkeley campus or in the neighbourhoods right around it (a shooting or active threat, an armed suspect, a violent crime, police activity with an area to avoid, an evacuation, a fire, a campus closure) goes in the `alerts` group, at most two. The prompt names those neighbourhoods, including Panoramic Hill and Claremont, which have Oakland addresses but sit directly above campus; traffic collisions and crime elsewhere in the Bay Area are not alerts. The server marks such an item `alert: true` in `/api/feed` only while it is under 12 hours old (`ALERT_MAX_AGE_HOURS` in `lib/feed-sources.ts`), and the page pins it above the scrolling list in a block with a red bar (`.feed-alerts` in `app/globals.css`), where it stays put while the news drifts past and while a newsworthy token's note covers the list; the page drops it at 12 hours on its own clock too. These come from news outlets, not from the campus WarnMe system, which has no public feed (its alerts go out by email, text and the UC Berkeley Safety app), so an alert appears only once an outlet has reported the incident and the next selection has run, up to 15 minutes later. Without an agent (`FEED_AGENT=off`, or both agents failing) nothing is pinned.

**Labels and a second advert check (optional).** With Cloudflare's Clef-flash decision model running on this Mac, each item on screen gets a label when the model is sure of one (at least 55%): Breaking, Release, Announcement, Research or Event, shown as a chip beside the source (breaking news in red). The same pass asks whether the item is the publisher advertising itself (tickets, passes, sponsorships, its own event) and takes it off the screen at 85% or more, behind the title filter in `lib/feed-parse.ts`. Clef is not a chat model: it returns a probability for every allowed answer in one forward pass. Running the 4-bit build on an M2 Pro with 16 GB, that took 2.5 to 3.7 seconds per item (measured 2026-10-02; Cloudflare's 39 ms figure is for its own GPUs), so the labels for a fresh selection fill in about a minute after it goes up. Each item is labelled once and cached, so later refreshes only label what is new. `lib/feed-labels.ts` asks `scripts/clef/server.py` after each selection and caches the answer per item; if the server is not running, the feed is shown unlabelled and nothing else changes. Set `FEED_LABELS=off` to skip it, or `CLEF_URL` for a server elsewhere (the request is the Jev / SystemOne shape, so another SystemOne server works too). To run it (Apple Silicon; the 4-bit model is 6.2 GB, downloaded on first start into the Hugging Face cache):

```sh
python3 -m venv .clef-venv
.clef-venv/bin/pip install -r scripts/clef/requirements.txt
.clef-venv/bin/python scripts/clef/server.py   # http://127.0.0.1:7710
```

Headlines are untrusted text, so for the feed the agent can only answer with candidate numbers, checked against a fixed JSON shape; every headline and link in the feed comes from the sources, never from the model. (The one place where model-written text is shown is the note on a newsworthy token, below.) Both CLIs are started without a shell, in an empty temporary directory, with a minimal environment and the prompt on stdin. Claude runs with no tools. Codex (0.159.2) cannot be started with no tools at all, so it runs with the read-only sandbox, web search off, no user config (so no MCP servers or hooks), no project instructions, nothing saved, and its shell, code, browser, app, plugin and sub-agent features disabled; probed that way it could not run a command, read or write a file, or reach the network. Whatever was in the previous selection is left out of the next one, except stories carried by three or more outlets, so the column rotates.

The response's `sources` array shows, for every source, whether the last fetch worked and how many items it gave. `.data/feed.json` also records how the last agent call went (`agent`: who was tried, how long it took, any error).

## Newsworthy tokens

`GET /api/newsworthy` returns at most three tokens with major news right now (often none), each with a one- or two-sentence note and the outlets it is drawn from. The page (`MarketsProvider` in `app/Markets.tsx`) reads it every minute, adds the tokens to the tape and works them into the featured rotation. While one of them is featured, the feed column fades to its note: a one-line heading ("Arbitrum in the news"), the note, and a line naming the outlets it is an AI summary of. The featured header beside it already shows the name and ticker large, so the note does not repeat them. The note is set at the largest of four sizes at which it fits the column, which shrinks while recent spots and the coin flip tile are showing; below the smallest, the note is cut to the lines that fit, and nothing spills into the tiles underneath. When the token leaves, the feed fades back and carries on scrolling from where it stopped. The set tokens never get a note: BTC, ETH and SOL are in the news every day and would crowd the feed out, and their stories are in the feed anyway.

How the list is made (`lib/newsworthy.ts`), in the background as part of the feed's refresh and never inside a request:

- At most every 30 minutes (`NEWSWORTHY_REFRESH_MINUTES`; 0 turns the feature off) one request goes to the same agent the feed uses (`FEED_AGENT`, same fallback, same lockdown). It is skipped when the news has not changed since the last run. That is at most 48 more model calls a day, 144 with the feed's. A call took about 10 seconds with Codex.
- The model is given the last 24 hours of news from the RSS outlets (headline and opening lines, the same story from several outlets once, at most 120) and the list of tokens it may choose from. It is not given social posts or Hacker News, and it is told to pick only tokens with a concrete development, not a price move or an opinion.
- The tokens it may choose from are a fixed list built by `lib/token-universe.ts` every 6 hours and kept in `.data/token-universe.json`: the 500 largest coins on CoinGecko that trade on Hyperliquid's perpetual exchange, or else on Gate's spot market against USDT with $500,000 or more traded in a day, and whose price at that venue is within 10% of CoinGecko's (so the ticker is the same coin and not a namesake). Stablecoins, wrapped and staked copies and tokenised stocks or gold are left out. This was 167 tokens on 2026-10-01. Building it takes two keyless CoinGecko requests (its keyless limit is roughly 5 to 15 a minute per address), one to Hyperliquid and one to Gate. If they cannot be reached the previous list is used.
- The answer is kept in memory and in `.data/newsworthy.json`. If a run fails, the last list stays up until it is 2 hours old. With `FEED_AGENT=off`, or if no agent works, there are no newsworthy tokens: the screen shows the set tokens and the feed.

What the model writes is shown on a public screen, and it writes after reading untrusted headlines, so this is a weaker guarantee than the feed's "numbers only". What is checked before a note is shown:

- The ticker must be in the fixed list (the JSON schema makes it an enum, and it is looked up again). The name, venue and market shown come from that list, not from the model.
- The candidate numbers it cites must exist, and a candidate counts only if its own text names the token. The story must come from at least two outlets (`MIN_OUTLETS`), so one outlet's write-up of a governance proposal or a rate change is never a note. The outlets shown are those candidates' sources.
- The prompt sets a high bar: hacks and outages, court and regulatory decisions, launches and upgrades that change how a network works, major exchange listings, and deals worth hundreds of millions. Routine governance votes, parameter and rate changes, integrations, partnerships and product updates are named as not qualifying.
- The note is reduced to plain text in Latin script. A sentence is removed if it contains a link, a web address, an @handle or a hashtag, if it trips the feed's filters for adverts, price calls, crude language or text addressed to a model, or if it contains a figure that is not in the cited candidates. What is left is capped at 260 characters in whole sentences; under 40 characters the token is dropped.
- The page renders the note as text. It is never a link or markup.

What these checks cannot do: they cannot tell whether a sentence is true. A model can still misread its sources, state something the headlines only imply, or be steered by a misleading or planted article from one of the RSS outlets into writing a false or slanted sentence in plain words. The note is labelled "AI summary" and names its outlets for that reason. `.data/newsworthy.json` records which model wrote the current list and which entries were dropped and why.

## Club in the news

Between token notes, a story about the club or someone in it takes the feed column for 20 seconds every 90 seconds, in turn with any others (`app/ClubNote.tsx`). It is headed by the B@B mark and who it is about ("Ayush Paul in the news", or "B@B in the news"), with the article's picture when the column has room for it, the headline and opening lines, and the publisher. Nothing in it is written by a model.

Stories come in two ways (`lib/club-news.ts`, served by `GET /api/club-news`):

- **Found in the news.** After each feed refresh, every new article from the RSS outlets is read once, page and all, and kept when it names someone in the club's Slack workspace and mentions Berkeley, or names the club. Names often appear only in the body or a photo caption: the Daily Cal's story on the Snackpass leaderboard names Ayush Paul only in a caption. The names come from Slack's `users.list` (`lib/club-roster.ts`, every 12 hours, deactivated accounts included so alumni count; full names of two or more words only). A Google News search for "Blockchain at Berkeley" adds coverage from outlets the feed does not follow. A found story stays up for 7 days from publication.
- **Shared in Slack.** `@spotbot-reader spotlight <link> <who>` in the songs channel, for stories that never name the person, like a co-founder's launch post. Web pages are read from their preview tags; posts on X through FxTwitter's public API (`api.fxtwitter.com`), since X gives nothing without an account. A shared story stays up for 3 days, credited to whoever shared it; `@spotbot-reader spotlight off` takes shared stories down.

Up to 30 new articles are read per refresh, 4 at a time, and what was found is kept in `.data/club-news.json`, so an article is never read twice.

## Upcoming events

`app/Events.tsx` draws the club's Google Calendar along the bottom of the screen as a wall calendar: seven columns from today, each headed by its date, listing that day's events with the time, the place and the title. Today's column is shaded, a day with nothing on it is dimmed, and each event has a rule down its left side, white for the next one and gold for one under way ("Until 9 PM"). All-day and multi-day events are bars across the top of the days they cover. A day with more events than fit shows as many as fit whole and says how many more. In focus mode the band runs the whole width of the screen. `GET /api/events` answers from memory; the calendar is downloaded in the background at most every 10 minutes while a screen is asking, and the page asks every 5 minutes and keeps its own clock, so an event turns to "Now" or drops off on time without a fetch. If a download fails the last good list stays up, for at most 24 hours.

The source is the calendar's iCalendar (.ics) feed, so no API key or Google Cloud project is needed:

- `EVENTS_CALENDAR_ID` (default: the Blockchain at Berkeley calendar) is read from Google's public feed, `https://calendar.google.com/calendar/ical/<id>/public/basic.ics`. That address exists only for a calendar shared as "Make available to public".
- `EVENTS_ICS_URL` is for a calendar that is not public: paste its "Secret address in iCal format" from Google Calendar > the calendar's settings > Integrate calendar. Only people who can manage the calendar see that address, and it works like a password (anyone holding it can read every event, with descriptions and guests), so it belongs in `.env.local` only. It wins over the ID. A Google API key would not help here: a key can only read public calendars.

Until one of the two works there is no calendar block on the screen at all (the carousel keeps the full height) and `/api/events` says why in `message`; the same goes for a connected calendar with nothing coming up. The block appears by itself with the first answer that has an event (the page asks every 5 seconds until the calendar answers, then every 5 minutes) and leaves when the last one ends. Used on its own, without the `quietWhenEmpty` prop the page passes, `<Events />` says "Calendar not connected" or "No upcoming events" instead. Google can take several hours to show a change in either feed.

What is shown: events that have not ended and start within the next 7 days, from the API's list of at most 12 starting within 28 days. Recurring events are expanded (`RRULE`, `EXDATE`, moved or cancelled instances), cancelled events are left out, and so is anything longer than 14 days. Times are always shown in `America/Los_Angeles`, whatever the server's or the browser's timezone. Parsing is done with `ical.js`; turning a time in a named zone into an instant uses the machine's own timezone database (`lib/events.ts`). An event whose timezone name is not an IANA name is left out rather than guessed. Only the title and location reach the page, as plain text; descriptions, guests and links never leave the server.

## Coin flip

Two people send matching amounts of USDC on Base to the wallet in the QR code under the news feed, the screen flips a coin, and the winner is sent both stakes. Amounts within $0.05 count as a match and the full combined pot is paid. It is off until `BAB_PRIVATE_KEY` is set in `.env.local`; with it empty the tile is not shown and the feed has the whole column.

Setup:

1. Put the private key of a wallet made for this, and used for nothing else, in `.env.local` as `BAB_PRIVATE_KEY`. Whoever holds that file holds whatever is in the wallet.
2. Send the wallet about $1 of ETH on Base. Payouts are USDC transfers and their gas is paid in ETH; the stakes themselves are never used for it.
3. Keep the dashboard open. Deposits are read only while a page is asking `/api/coin-flip` (every 2 seconds); ones that arrive while it is closed are handled when it opens again.

Rules (`lib/coin-flip.ts`):

- The first deposit of $1 or more is the open stake, shown on the tile with its amount. There is no upper limit, so the wallet holds whatever is staked until it is matched or refunded. It is refunded if nobody matches it within 10 minutes.
- The next deposit within $0.05 makes a game: the first depositor is heads, the second tails, and the server picks the winner at random (`crypto.randomInt`). The winner is sent the exact combined pot about 17 seconds later, once the coin has landed on screen. Nothing is kept.
- A deposit of any other amount while a stake is open, or under $1, is refunded. Under $0.10 is ignored.
- Money always goes back to the address it came from, so players must send from a wallet they control. A withdrawal sent straight from an exchange would be paid to the exchange's address.

Every transfer is signed and written to `.data/coin-flip.json` before it is broadcast, and only one is in flight at a time, so after a crash or restart the server can only send the same transaction again and it can only land once. If a transfer never lands, the file's `problem` field says which, and the tile says it is not watching for deposits. `COIN_FLIP_CHAIN=base-sepolia` runs it on the test network with Circle's test USDC, and `COIN_FLIP_RPC_URL` replaces the public RPC.

`app/CoinFlip.tsx` has the tile and the full-screen flip. The coin itself is drawn on a canvas by `app/CoinToss.tsx` as flat vector art: over about 13 seconds it trembles and sinks back, is thrown up and hangs in slow motion at the top, comes down standing on its edge and spins there showing neither face, leans towards the losing side, and then falls flat on the winning side (the B@B mark is heads, the dollar sign tails). The timings and the number of turns are the constants at the top of that file. Once the payout has confirmed, a QR code of the transaction on the block explorer is shown bottom right for 20 seconds; if it has not confirmed within a minute the stage closes without one. Add `?coinflip=demo` to the address to play the animation with made-up players, with the wallet's QR standing in for the receipt.

Sound is played on this Mac by the server (`lib/coin-flip-sound.ts`, with `afplay`), not by the browser, so it needs no click on the page first. The page sends three cues to `/api/coin-flip/sound` as the animation reaches them: `start` when the stage comes up, `toss` as the coin leaves for the air (`public/sounds/coin-flip-toss.mp3`), and `land` when it falls flat, which cuts the first sound off and plays `public/sounds/coin-flip-land.mp3`. From `start`, Spotify on this Mac is faded down to a fifth of its volume; it fades back 3.6 seconds after `land`, or after 30 seconds if no landing follows. This is the one place the dashboard changes anything in Spotify, and only its volume; if Spotify is not running nothing is sent to it. The demo plays the sounds too.

## Spot alerts

`app/SpotAlert.tsx` asks `/api/spot` every 30 seconds. A spot that was not in the previous answer takes over the whole screen for 12 seconds (`TAKEOVER_MS`) once its photo has loaded (or after 6 seconds without it): the photo, the people spotted, the message with their @mentions taken out, and who spotted them, with a gold bar along the bottom counting the seconds down. Spots that were already there when the page loaded never take over. The takeover is fixed inside the 1920x1080 stage, like the coin flip.

Afterwards the spot is listed under the news feed with the others from the last hour (`RECENT_SPOT_MS`): up to three, newest first, text only (who was spotted, who spotted them, how long ago). A spot from the last 10 minutes has a pulsing gold marker. With no spot in the last hour the list takes no space and the feed has the column.

## Edge glow

Along the bottom edge of the screen, light rises and falls with whatever this Mac is playing, the way Siri's glow runs around an iPhone's edges (`app/EdgeGlow.tsx`). The bass is in the middle and the treble towards the corners, mirrored, and the light rises a little way up both sides. Its colours are the background ribbons' for the time of day, and they drift slowly along the edge. Each band is scaled against its own recent peak (`app/edge-glow-levels.ts`), so a quiet song moves it as much as a loud one. After 15 seconds of silence it fades out.

Spotify's Web API stopped giving apps audio analysis in November 2024, so the sound is read off the Mac's own output instead. `scripts/audio-levels/AudioLevels.swift` opens a Core Audio process tap: a private, unmuted copy of everything the Mac plays, which changes nothing anyone hears. It prints the overall loudness and 32 bands in dB, 30 times a second. `lib/audio-levels.ts` compiles it into `.data/audio-levels` with `swiftc` the first time a page asks (the Xcode command line tools must be installed), runs it while at least one page is listening, and restarts it if it stops. `GET /api/audio-levels` streams its lines to the page as server-sent events.

It needs macOS 14.2 or later. The first time it runs, macOS asks to allow "System Audio Recording" for the app that started the server (Terminal, or the binary itself under launchd); allow it in System Settings > Privacy & Security > Screen & System Audio Recording. Until it is allowed the tap hears silence and no glow shows. Set `AUDIO_LEVELS=off` to turn it off; on other systems it is off already. With reduced motion nothing is drawn.

## Worm, the voice stage

Say "hey worm" and ask something. The screen gives most of itself over to the answer: the feed, chart, carousel and calendar fade out behind a frosted stage, now-playing stays in its corner, and a one-line calendar runs along the foot ("No current events", or "Calendar: Poker Night"). Your question appears as you say it, and Worm's answer appears under it, centred on the stage: in large type when it is short, with whatever explains it best beside the words when a picture helps (a diagram, a chart, a table, or a freeform page). Worm starts talking the moment you finish ("Pulling up the calendar.") and says the answer a sentence at a time as it is written.

For 12 seconds after Worm finishes (a gold dot beside your question), a follow-up of three words or more is taken without "hey worm", and Worm remembers the last few questions for three minutes: "can you show me that in a graph?" draws what it just described. The answer stays up for 40 seconds after Worm stops talking (a gold bar drains along the foot), or until you say "thanks worm".

- **Ears** (`lib/stage/ears.ts`, `scripts/listen/Listen.swift`): Apple's on-device SpeechAnalyzer (macOS 26) transcribes the room as it is spoken. Nothing leaves the Mac, and nothing is acted on until the wake phrase. The question is asked 0.9 seconds after the speaker stops. The listener runs while a screen is open and is compiled into `.data/listen` on first use; macOS asks once for microphone access.
- **Answers** (`lib/stage/turn.ts`): the moment the question ends, Worm says a short line picked from its words ("Pulling up the calendar.", "Checking the music.", `lib/stage/ack.ts`), then answers with a Fireworks model (`FIREWORKS_API_KEY`, `STAGE_MODEL`, default GLM-5.3 at low reasoning effort, `STAGE_REASONING_EFFORT`). Before writing, it can call tools for up to four rounds (`lib/stage/tools.ts`): the club's Slack, the calendar, live prices, today's news, and the music: what is playing, the Spotify queue, adding a song, play, pause, skip, and the volume. The answer is spoken a sentence at a time as it streams in.
- **What it draws** (`lib/stage/answer-format.ts`, `app/StagePieces.tsx`): the answer streams as tagged blocks. `<say>` is spoken and shown; `<diagram>` gives boxes and arrows, laid out with dagre so they never overlap; `<chart>` and `<table>` take JSON; `<html>` is a freeform page drawn in a sandboxed frame that can never run a script, with the screen's colours and a small set of classes (`app/stage-frame.ts`) that keep it on-brand.
- **Voice** (`lib/stage/voice.ts`, `scripts/tts/speak.py`): Kokoro, an open text-to-speech model, run on this Mac. Set it up once with `sh scripts/tts/setup.sh` (a Python environment and about 350 MB of model files in `.data`); until then, and with `STAGE_TTS=say`, macOS `say` speaks instead. `STAGE_VOICE` picks a Kokoro voice (default `af_heart`; others include `af_bella`, `am_michael`, `bf_emma`, `bm_george`). B@B is said "bahb", B@by "bahby", and web addresses are never read out. Spotify is dimmed to 30%, not paused, from "hey worm" until Worm finishes, then brought back to the volume it had. Worm's speech goes out through the speakers, so the edge glow moves with it too. When the Slack agent says something in the room (its `say` tool), it sends the line to `POST /api/stage/say` (this machine only, with `SCREEN_SECRET`), and Worm says it in the same voice.
- **Hearing the club's words**: the listener is given the club's vocabulary, and its usual mishearings are put right before anything is asked: "gym" becomes "jam", "Bob" B@B, "Bobby" B@by.

Showing the queue and adding songs use Spotify's Web API, so Spotify must be logged in once on this Mac at http://127.0.0.1:3000/api/spotify/login (the same login song requests use). Play, pause, skip and volume work through AppleScript without it.

Slack search uses `assistant.search.context`, which needs the bot's `search:read.public` scope (add it in the Slack app's settings and reinstall). Until then Worm says it cannot search Slack.

To try the stage without a microphone or a model key: `curl -X POST localhost:3000/api/stage -H 'content-type: application/json' -d '{"text":"How does DeepSeek EAGLE differ from MTP?","demo":true}'` streams a canned answer through it. Without `demo`, the same request asks Worm for real. `{"close":true}` hands the screen back. Only requests from this Mac are accepted. Set `STAGE_EARS=off` to turn the listener off and `STAGE_SPEECH=off` to keep Worm quiet.

## Screen API

What the Slack agent puts on the screen is server state (`lib/screen-state.ts`, saved in `.data/screen.json`): a banner or a person card on top, a game (Mafia or poker), a leaderboard, a pinned Slack thread, and the agent's slots and preset. The page follows it on one stream (`app/ScreenPushes.tsx`) and redraws on every change; the tiles still poll their own routes.

- **Overlays** (`app/Overlay.tsx`): a banner along the bottom, signed "Worm", with a gold bar that drains over its time, and a person card in the middle. They sit over everything but the coin flip.
- **Game, leaderboard and pinned thread** (`app/Game.tsx`, `app/Leaderboard.tsx`, `app/PinnedThread.tsx`) take the middle column in place of the featured market while any of them is up, stacked when there are several. The chart comes back once they are gone, and Worm's stage covers them while someone is asking.
- **Slots and presets** (`app/widgets/registry.ts`) are the agent's vocabulary, and every POST is checked against them, but this page keeps its own layout. A game, leaderboard or thread shows wherever the agent put it, `markets` turns on focus mode, `game_night` brings up the game and the leaderboard, and `news` and `party` change nothing here.

`GET /api/screen` returns the state. `GET /api/screen/stream` is server-sent events: the whole state on connect and on every change, a comment every 15 seconds. The page opens one stream, reconnects 3 seconds after it drops, keeps what was up meanwhile, and drops everything the agent put up after a minute without the server.

`POST /api/screen` takes one op as JSON. It needs the header `x-screen-secret` equal to `SCREEN_SECRET` in `.env.local` and is refused from anywhere but this machine; with `SCREEN_SECRET` unset every POST is refused. The answer is `{ok: true, state}`, or `{ok: false, error}` with 400 (bad op or fields), 401 (wrong secret) or 403 (not local, or no secret set).

| Op | Fields |
| --- | --- |
| `set_preset` | `preset` |
| `show_widget` | `slot`, `widget` (must fit the slot) |
| `banner` | `text` (up to 280 characters), `ttlSeconds` (default 20) |
| `person` | `card: {name, headline?, summary?, links?: [{label, url}], imageUrl?}`, `ttlSeconds` (default 30) |
| `clear_overlays` | none |
| `pin_thread` | `thread: {channel, ts, author?, text, replies?: [{author, text}], permalink?}` |
| `unpin_thread` | none |
| `leaderboard` | `title`, `rows: [{name, score}]` (sorted highest first; empty takes it down) |
| `game` | `game`: the Mafia or poker state (`MafiaScreen`, `PokerScreen` in `lib/screen-state.ts`) |
| `clear_game` | none |

```sh
curl -X POST http://127.0.0.1:3000/api/screen -H "x-screen-secret: $SCREEN_SECRET" \
  -H "content-type: application/json" -d '{"op":"banner","text":"Pizza is here"}'
```

A new banner replaces the old one, and so does a new person card; overlays last at most an hour and are taken down on time by the server. Links and image URLs must be http(s). The server listens on 127.0.0.1 only (`package.json`), which is what keeps the endpoint local; the check on the request's address and Host header is a second line, since Next takes `x-forwarded-for` from the request when one is sent.

The agent pins a Slack thread (`pin_slack_thread`, or the busy-thread scheduler) only from `SLACK_CHANNEL_ID` and the channels in the optional comma list `JARVIS_PIN_CHANNELS`, and only when Slack's `conversations.info` (bot scope `channels:read`) says the channel is public: not private, not a DM or group DM, not archived. Anything else is refused before the thread is read, and the refusal does not carry the thread's text.

### Spotify for the agent

The agent's `queue_track` (and "queue X" on the rules fast path) does not call Spotify itself. It asks the Next app, `POST /api/spotify/agent`, so the Next process stays the only one that refreshes and writes `.data/spotify.json`. Same guard as `POST /api/screen` (this machine only, `x-screen-secret` equal to `SCREEN_SECRET`; 401 or 403 otherwise).

| Op | Fields | Answer |
| --- | --- | --- |
| `search` | `query` (artist and title, or a Spotify track link; up to 200 characters) | `{ok: true, link, track: {id, name, artists} \| null}` |
| `queue` | `trackId` (22-character Spotify track ID) | `{ok: true}` |

A Spotify failure answers 200 with `{ok: false, error: "<code>"}` (`not_connected`, `no_active_device`, `premium_required`, `rate_limited`, ...), which the agent turns into a sentence. With `JARVIS_DRY_RUN=1` the agent still searches through the route when `SPOTIFY_CLIENT_ID` is set, but never queues; without it, it searches nothing. Playback (play, pause, skip, volume) stays in the agent, through the Spotify app's AppleScript on this Mac.

## Background waves

The ribbons behind the page (`app/Background.tsx`) change colour with the daylight outside. The palette is read off the sun's position over Berkeley (`lib/sun.ts`, computed from the clock with no network call; change `LATITUDE` and `LONGITUDE` there for another room), so the dawn and dusk colours move with the seasons. `lib/wave-palette.ts` holds ten keyframe palettes, from a dim indigo and plum at night through blue at midday to the indigo, plum and burnt amber of sunset, and blends between them continuously; the colours are refreshed every 10 seconds, in steps too small to see. To hold the palette at one moment instead, set `PINNED_TIME` in `app/Background.tsx` to an instant such as `"2026-10-01T08:00:00-07:00"`; it is `null`, which follows the sun. Every palette stays under the lightness and luminance ceilings in that file, which are what keep the text readable on top of the waves; the reasoning and the contrast figures are in its comments.

To preview a time, add it to the address: `?time=17:30` holds that time today, `?time=2026-12-21T17:30` holds a date and time (to see another season), and `?day=120` runs a whole day every 120 seconds, starting from `?time` if given (from now otherwise). These override `PINNED_TIME` when it is set. Times are in the computer's time zone.

## Running on the Mac mini

On the Mac mini the dashboard (with Worm's ears and voice), the Slack agent and the kiosk browser run as three launchd LaunchAgents in the logged-in user's session (not LaunchDaemons: Spotify AppleScript, `say`, `afplay` and the microphone only work in the GUI session). The templates are in `launchd/`; `scripts/install.sh` fills in the absolute paths and loads them.

- `com.bab.screen`: `npm run start`, the production build on http://127.0.0.1:3000. `scripts/deploy.sh` builds it.
- `com.bab.jarvis`: the agent, `npx --no-install tsx agent/index.ts` (the same as `npm run jarvis`; `npm run jarvis:selftest` checks it without keys).
- `com.bab.kiosk`: `scripts/kiosk.sh` waits until the dashboard answers, then opens it in Google Chrome in kiosk mode, with its own profile (`~/Library/Application Support/bab-kiosk`) so it is a separate instance from any Chrome a person opens. `KIOSK_URL` and `KIOSK_CHROME` override the address and the browser.

Every job starts at login, is restarted when it exits (`KeepAlive`, at most every 10 to 15 seconds) and writes stdout and stderr to `~/Library/Logs/bab/<screen|jarvis|kiosk>.log`. launchd starts jobs with an empty environment, so each plist sets `PATH` to the node directory found at install time (nvm's, which has the version in it: after switching node versions, run the install again), then Homebrew and the system directories. The Next app and the agent read `.env.local` themselves.

First install, from a Terminal on the Mac mini as the user that logs in automatically (not with sudo):

1. Clone the repo, `nvm install 22`, put the secrets in `.env.local` (JARVIS.md, Env).
2. `npm ci && npm run build`.
3. `sh scripts/tts/setup.sh` for Worm's voice (see "Worm, the voice stage"; without it Worm speaks with `say`).
4. `scripts/install.sh`. It renders the plists into `~/Library/LaunchAgents`, unloads any old copy and loads the new one (`launchctl bootstrap gui/$UID`), runs `chmod 600 .env.local`, and prints the manual steps below and the command that installs log rotation.

`--only <service>` (repeatable; `screen`, `jarvis`, `kiosk`) limits it to some services, `--dry-run` renders and lints the plists into a temporary directory and only prints what it would do, and `--uninstall` unloads and removes them (logs are kept).

Manual steps, once per Mac, which the script prints but cannot do:

- `sudo pmset -a sleep 0 displaysleep 0 autorestart 1`, and System Settings > Users & Groups > Automatically log in. The agents only run while that user is logged in.
- Log rotation: run the `sudo install ... /etc/newsyslog.d/com.bab.conf` line it prints. newsyslog rotates each log at 10 MB, keeps five bzip2'd copies, and sends the job SIGTERM (`scripts/run-service.sh` records each job's pid in `~/Library/Logs/bab/.pid/`) so launchd restarts it onto a fresh file; launchd only opens the log when a job starts.
- Privacy permissions, granted by someone at the screen when the prompts come up, then checked in System Settings > Privacy & Security: Automation (node may control Spotify), Microphone (Worm's listener, `.data/listen`, started by the screen's node), and Accessibility if a tool needs it. Without them things fail quietly; `tccutil reset Microphone` (or `AppleEvents`) and a restart of the job brings a missed prompt back.
- Remote access over Tailscale. Tailscale SSH needs the open-source `tailscaled` (`brew install tailscale`, `sudo brew services start tailscale`, `sudo tailscale up --ssh`); with the App Store app, turn on Remote Login under System Settings > General > Sharing and ssh to the Tailscale address instead.

To update: `scripts/deploy.sh` (over SSH is fine). It runs `git pull --ff-only`, `npm ci --include=dev`, `npm run build`, runs `scripts/tts/setup.sh` again if it changed, and `launchctl kickstart -k` each installed service; `scripts/deploy.sh jarvis` restarts only that one. If the pull changed `launchd/`, run `scripts/install.sh` again. To look at a job: `launchctl print gui/$UID/com.bab.jarvis`, `tail -f ~/Library/Logs/bab/*.log`.
