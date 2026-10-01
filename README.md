# Markets and Spotbot dashboard

A fixed 1920x1080 screen for a TV: the Blockchain at Berkeley mark (`public/bab-logo.svg`, also the favicon as `app/icon.svg`) beside a scrolling ticker tape, one featured market with a four-hour candle chart, the song playing in Spotify, and a carousel of recent Spotbot photos from Slack. Run `npm run dev` and open http://127.0.0.1:3000 in Chrome.

## Market data

Prices and candles come from Hyperliquid's public API (`api.hyperliquid.xyz`, REST and WebSocket), called directly from the browser. No API key or account is needed. The list of markets, which is also the tape order and the rotation order of the featured slot, is `ASSETS` in `lib/markets.ts`. Stocks, the S&P 500 and the OpenAI/Anthropic markets are perpetual contracts on Hyperliquid, not exchange quotes.

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
