# Markets and Spotbot dashboard

A fixed 1920x1080 screen for a TV: a scrolling ticker tape, one featured market with a four-hour candle chart, and a carousel of recent Spotbot photos from Slack. Run `npm run dev` and open http://127.0.0.1:3000 in Chrome.

## Market data

Prices and candles come from Hyperliquid's public API (`api.hyperliquid.xyz`, REST and WebSocket), called directly from the browser. No API key or account is needed. The list of markets, which is also the tape order and the rotation order of the featured slot, is `ASSETS` in `lib/markets.ts`. Stocks, the S&P 500 and the OpenAI/Anthropic markets are perpetual contracts on Hyperliquid, not exchange quotes.

## Connect Spotbot in Slack

1. Create an **internal Slack app** for your workspace at [api.slack.com/apps](https://api.slack.com/apps). Under **OAuth & Permissions**, add the bot token scopes `channels:history` (public channel), `groups:history` (private channel), `files:read` (uploaded images), and `users:read` (names of the spotter and the people spotted; without it names are left out). You only need the history scope matching your channel type. Reinstall the app after adding a scope.
2. Install the app to the workspace and copy its **Bot User OAuth Token** (`xoxb-...`). Invite the app to the channel where Spotbot posts; the bot token can read history only for conversations it belongs to.
3. Copy the channel ID from Slack’s channel details. Copy `.env.example` to `.env.local`, then set `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`. To limit results to Spotbot, also set `SLACK_SPOTBOT_USER_ID` to the user ID or bot ID on its messages. Restart the dev server after changing env vars.

The dashboard shows the six most recent images in the newest 100 channel messages, one at a time. It refreshes Slack data at most once per minute in a running server process. Uploaded images pass through a signed local endpoint; the browser never receives the bot token. Image blocks or attachments with public HTTPS image URLs load directly. If no image is among the newest 100 messages, it shows an empty state.

Slack API references: [conversation history and scopes](https://docs.slack.dev/reference/methods/conversations.history/), [private file URLs](https://docs.slack.dev/reference/objects/file-object/), [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).
