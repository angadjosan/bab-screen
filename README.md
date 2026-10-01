# Markets and Spotbot dashboard

A fixed 1920x1080 screen for a TV: the Blockchain at Berkeley mark (`public/bab-logo.svg`, also the favicon as `app/icon.svg`) beside a scrolling ticker tape across the top, and three columns below it. Left (432px): a feed of news and posts from `/api/feed` that drifts slowly upward in a loop (`app/Feed.tsx`; the speed is `FEED_SCROLL_PX_PER_S`). Middle (816px): one featured market, its price above a TradingView chart of the last 24 hours in 30-minute candles. Right (496px): the song playing in Spotify and a carousel of recent Spotbot photos from Slack. The column widths are `grid-template-columns` on `.dashboard` in `app/globals.css`; the chart's 24-hour window depends on the middle column's width, so if that changes, re-tune `zoom` on `.chartFrame` in `app/Markets.module.css` together with `CHART_INTERVAL` in `lib/markets.ts`. Run `npm run dev` and open http://127.0.0.1:3000 in Chrome.

## Market data

Prices and 24-hour changes on the tape and in the featured header come from Hyperliquid's public API (`api.hyperliquid.xyz`, REST and WebSocket), called directly from the browser. No API key or account is needed. The chart is TradingView's Advanced Chart embed showing the same Hyperliquid market (`HYPERLIQUID:` and `HIP3XYZ:` symbols); the featured market switches every 10 seconds (`FEATURE_MS` in `app/Markets.tsx`). The list of markets, which is also the tape order and the rotation order of the featured slot, is `ASSETS` in `lib/markets.ts`. Stocks, the S&P 500 and the OpenAI/Anthropic markets are perpetual contracts on Hyperliquid, not exchange quotes. TradingView has no chart for the OpenAI/Anthropic markets, so they appear on the tape only. Stock charts show a TradingView "High-risk market notice" until someone clicks Accept once in that browser.

## Now playing

The tile at the top right shows the track playing in the Spotify desktop app on the same Mac as the dev server: cover, title, artist and position. `lib/now-playing.ts` reads it with `osascript` (JXA) through Spotify's AppleScript dictionary; no Spotify account, API key or env var is needed. It only reads: it never starts Spotify or changes playback, and when Spotify is closed or stopped the tile says "Nothing playing". The page asks `/api/now-playing` every 4 seconds and the server runs `osascript` at most once every 1.5 seconds.

The first read makes macOS ask whether the program running the dev server (Terminal, iTerm, your editor) may control Spotify. Choose Allow. If it was denied, turn it on under System Settings > Privacy & Security > Automation; until then the tile shows that instruction.

## Connect Spotbot in Slack

1. Create an **internal Slack app** for your workspace at [api.slack.com/apps](https://api.slack.com/apps). Under **OAuth & Permissions**, add the bot token scopes `channels:history` (public channel), `groups:history` (private channel), `files:read` (uploaded images), and `users:read` (names of the spotter and the people spotted; without it names are left out). You only need the history scope matching your channel type. Reinstall the app after adding a scope.
2. Install the app to the workspace and copy its **Bot User OAuth Token** (`xoxb-...`). Invite the app to the channel where Spotbot posts; the bot token can read history only for conversations it belongs to.
3. Copy the channel ID from Slack’s channel details. Copy `.env.example` to `.env.local`, then set `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`. To limit results to Spotbot, also set `SLACK_SPOTBOT_USER_ID` to the user ID or bot ID on its messages. Restart the dev server after changing env vars.

The dashboard shows the six most recent images in the newest 100 channel messages, one at a time. It refreshes Slack data at most once per minute in a running server process. Uploaded images pass through a signed local endpoint; the browser never receives the bot token. Image blocks or attachments with public HTTPS image URLs load directly. If no image is among the newest 100 messages, it shows an empty state.

Slack API references: [conversation history and scopes](https://docs.slack.dev/reference/methods/conversations.history/), [private file URLs](https://docs.slack.dev/reference/objects/file-object/), [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).

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
5. Open http://127.0.0.1:3000/api/songs/sync once after each server start; that starts the 20-second poll. The same URL returns a JSON status: what is missing, who posted which link, and what happened to it. `/api/songs/status` shows the same without contacting Slack or Spotify.

`SPOTIFY_SONGS_MODE` chooses where songs go:

- `queue` (default): added to the play queue of whichever device is playing. While nothing is playing the request waits, is retried every poll, and is queued as soon as playback starts; after 30 minutes it is dropped. Spotify documents add-to-queue as Premium-only; the app tries anyway, and if Spotify refuses, the request is marked failed and the status JSON reports `spotify.problem: "premium_required"`.
- `playlist`: appended to `SPOTIFY_SONGS_PLAYLIST_ID` (an ID or an `open.spotify.com/playlist/...` link, owned by the connected account). If that is empty, a private playlist called "B@B Song Requests" is created on first use. Works with nothing playing, and a song already in the playlist is not added twice. To hear the requests, play that playlist; Spotify does not document whether a track appended to the playlist that is currently playing is picked up without restarting it.
- `both`: playlist, plus one attempt at the queue. A queue failure does not undo or repeat the playlist add.

If a link does not show up in the queue, read `spotify.problem`, `spotify.help`, `pending` and `recent` in the status JSON: `no_active_device` means nothing is playing, `premium_required` means Spotify refused the account, `insufficient_scope` or `login_expired` means open the login URL again, and `unknown_track` on a request means the link's track ID does not exist.

Spotify has no API for Jams, so the server cannot start one or keep one alive. A Jam started by hand in the Spotify app shares that account's queue, so `queue` or `both` mode feeds it.

Set `SLACK_SONGS_REPLY=1` to have the bot answer in the request's thread ("Queued: ..."); it is off by default. `SONGS_MAX_AGE_MINUTES` and `SONGS_POLL_SECONDS` (0 turns the poll off) are optional.

## News and tweets feed

`GET /api/feed` returns about twenty news items and posts for the feed column. Candidates are gathered from the sources below, an AI agent picks which ones go up, and the answer is served from memory: a request never waits for a fetch or for the agent. The selection is redone every 15 minutes while a screen is polling (`REFRESH_MINUTES` in `lib/feed-sources.ts`); after 10 minutes without a request the loop stops fetching and stops calling the agent. The last selection is kept in `.data/feed.json`, so a restart shows it at once.

Sources, all in `lib/feed-sources.ts` (edit the lists there):

- **News, no key needed.** RSS/Atom feeds of CoinDesk, The Block, Decrypt, Cointelegraph, The Defiant, Bitcoin Magazine, Unchained, Protos, Bankless, TechCrunch, Ars Technica, The Verge, MIT Technology Review, the Ethereum Foundation blog, Vitalik Buterin's blog, a16z crypto, Berkeley News and the club's Substack, plus the Hacker News front page through the HN Search API (stories with 150 points or more). Items older than 36 hours are ignored (a week for the three research blogs, three days for Berkeley News). Sponsored posts, press releases, price predictions and daily roundups are filtered out, and the same story from several outlets is shown once.
- **Posts, no key needed: Bluesky.** The latest posts of the accounts in `BLUESKY.accounts`, read from Bluesky's public API and shown as source "Bluesky". These are technology, AI and security voices plus Vitalik and the campus account; crypto founders mostly do not post there. Set `FEED_BLUESKY=off` to drop the source.
- **Tweets: X, only with a paid token.** X has no free read access: reading costs $0.005 per post on its pay-per-use plan (checked 2026-10-01). Without `X_BEARER_TOKEN` the feed has no tweets and `sources` in the response lists X as "not configured". To turn it on, create an app at [console.x.com](https://console.x.com), buy credits, and put the app's Bearer Token in `.env.local` as `X_BEARER_TOKEN`. Posts then come from the accounts in `X.accounts` (a suggested starter list, edit it), or from one X List if `X_LIST_ID` is set, which needs one request per poll instead of one per account. X is polled every 30 minutes, each post is read once, and `X_MAX_READS_PER_DAY` (default 300, i.e. at most $1.50 a day) is a hard stop.

Who picks: once per refresh the candidates (at most 120: source, age and headline or post text, nothing else) go to a model in a single request. `FEED_AGENT` chooses which:

- `codex` (the default): OpenAI's Codex CLI (`codex exec`, model `gpt-6-luna`, about 5 to 15 seconds). It must be installed and logged in on this Mac (`codex login`); runs count against that ChatGPT plan, or are billed to the API key if Codex was logged in with one.
- `claude`: Claude Haiku 4.5, through the Messages API when `ANTHROPIC_API_KEY` is set and otherwise through the `claude` command (Claude Code) on this Mac, which must be logged in (about 10 seconds).
- `off`: nobody; the newest items are shown, taking turns between sources.

If the chosen agent is missing, fails or takes more than 90 seconds, the other one is tried once; if that fails too, the `off` ordering is used for that refresh and the response says `"curation": "fallback"`. The response's `agent` field says who made the selection on screen (`codex`, `claude-cli`, `claude-api`, or `null` for the fallback) and `agentModel` which model. That is at most 96 model calls a day.

Headlines are untrusted text, so the agent can only answer with candidate numbers, checked against a fixed JSON shape; every headline and link on screen comes from the feeds, never from the model. Both CLIs are started without a shell, in an empty temporary directory, with a minimal environment and the prompt on stdin. Claude runs with no tools. Codex (0.159.2) cannot be started with no tools at all, so it runs with the read-only sandbox, web search off, no user config (so no MCP servers or hooks), no project instructions, nothing saved, and its shell, code, browser, app, plugin and sub-agent features disabled; probed that way it could not run a command, read or write a file, or reach the network. Whatever was in the previous selection is left out of the next one, except stories carried by three or more outlets, so the column rotates.

The response's `sources` array shows, for every source, whether the last fetch worked and how many items it gave. `.data/feed.json` also records how the last agent call went (`agent`: who was tried, how long it took, any error).
