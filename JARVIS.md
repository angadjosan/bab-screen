# B@B Jarvis plan

One agent on the Mac mini that controls the TV. Talk to it by Slack or by voice.

## 1. Widgets (do first)
- Turn every tile (markets, feed, now playing, quotes, chum, events, coin flip, jam QR) into a widget in one registry.
- Screen layout is server state: which widgets are in which slots. The page renders whatever the state says.
- Presets: default, markets, news, party, game night.

## 2. Jarvis core
- One long-running agent with tools: `show_widget`, `set_preset`, `pin_slack_thread`, `queue_music`, `set_leaderboard`, `say`, `remember`.
- Input: Slack DMs and @mentions. Output: the TV plus a Slack reply.
- Replaces the separate Slack checks (songs, quotes, chum) with one listener.

## 3. Smart screen
- Slack: pin threads that are busy or funny, drop them when they go quiet.
- News and tokens: pull up a story or chart when something moves.
- Interests: anyone DMs a list of interests, the feed leans toward them.
- Who's in office: check in by Slack or voice ("I'm here"), feed and jokes lean toward whoever is in.

## 4. Memory and humor
- Per-member memory: name, interests, running jokes.
- Funny persona: prompt plus a few hand-picked examples from our own Slack.

## 5. Music
- "Queue something chill" picks and queues tracks on Spotify. Works for XYZ vibe.
- Playlist of every song B@B has ever requested, kept up to date.

## 6. Voice
- Mic on the Mac mini, wake word "Jarvis", it talks back. Music turns down while it speaks.

## 7. Games
- Generic leaderboard widget: any title, names, scores.
- Poker: buy-ins, stacks, payouts.
- Mafia: roles DM'd in Slack, the TV runs day and night. This is a game that runs in a short period of time.

## Cut
- Camera, face recognition, polaroid.
- GEPA tuning.
