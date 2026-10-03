# B@B Jarvis plan

Spotify full control - play, pause, etc, play new jam

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
- Mafia: roles DM'd in Slack, the TV runs day and night. This is a game that runs in a short period of time

## Cut
- Camera, face recognition, polaroid.
- GEPA tuning.

# B@B Jarvis design

How Jarvis runs on the Mac mini. Goals live in `JARVIS.md`; this is the build plan.

## Shape

```
Slack (Socket Mode) ─┐                              ┌─> Slack reply
Voice daemon ────────┤                              ├─> say / TTS (Spotify ducks)
Scheduler ───────────┼─> agent/ (Node, launchd) ────┼─> POST /api/screen ─> SSE ─> TV
Calendar ────────────┘   rules fast path            ├─> Spotify (lib/spotify.ts)
                         Fireworks tool loop        ├─> Exa search
                                                    └─> SQLite (.data/jarvis.db)
```

Four processes, each a launchd LaunchAgent in the logged-in user's session:
- `com.bab.screen`: Next app, `next build && next start` (not `dev`).
- `com.bab.jarvis`: the agent, `agent/index.ts`.
- `com.bab.voice`: wake word + speech-to-text daemon.
- `com.bab.kiosk`: Chrome in kiosk mode on the dashboard.

LaunchAgents, not LaunchDaemons: Spotify AppleScript, `say`, `afplay` and the mic only work in the user's GUI session.

## Mac mini setup
- Auto-login on, `pmset -a sleep 0 displaysleep 0 autorestart 1`.
- Plists use `RunAtLoad`, `KeepAlive`, `ThrottleInterval`. Logs in `~/Library/Logs/bab/`, rotated by newsyslog.
- `scripts/install.sh` renders plists in `launchd/` with absolute paths and runs `launchctl bootstrap gui/$UID`.
- `scripts/deploy.sh`: git pull, `npm ci`, build, `launchctl kickstart -k` each service.
- Tailscale + Tailscale SSH for remote access.
- Grant TCC permissions once, by hand, in the GUI: Automation (Spotify), Microphone, Accessibility.
- The agent starts the songs loop on boot. Today it only starts after someone hits `/api/songs/sync` (`lib/songs.ts`, README "Song requests").

## LLM
- Fireworks, OpenAI-compatible API, using the `openai` package with `baseURL` set to Fireworks.
- Default model: GLM 5.3 Flash, `accounts/fireworks/models/glm-5p3-flash` ($0.15/M in, $0.50/M out, function calling supported). Handles every Slack/voice turn.
- Heavy model: GLM-5.3, `accounts/fireworks/models/glm-5p3` ($1.40/M in, $4.40/M out, function calling supported). Used only for visitor identification (`lookup_person`) and multi-step requests the flash model hands up.
- Both ids live in env (`FIREWORKS_MODEL`, `FIREWORKS_MODEL_HEAVY`).
- Our own tool loop in `agent/llm.ts`, ~150 lines: send messages + tool schemas, run tool calls, feed results back, stop at N steps.
- Rules fast path before the LLM: "queue X", "skip", "pause", "volume up", "preset party" run directly, no model call.
- Daily spend cap tracked in SQLite. Over the cap, rules only.

## Agent
- `agent/index.ts`: starts Slack listener, local HTTP endpoint (voice + dashboard events), scheduler.
- `agent/tools/*.ts`: one file per tool, typed args.
- `agent/persona.md`: persona prompt + a few hand-picked Slack examples. Checked in.
- Imports existing code directly: `lib/spotify.ts`, `lib/slack-users.ts`, `lib/now-playing.ts`.
- Kept out of the Next process. Next restarts and route-bundle `globalThis` loops are a bad home for a listener.

### Tools
| Tool | Does |
|---|---|
| `queue_track` | Search Spotify, add to queue (`lib/spotify.ts`) |
| `playback` | Play, pause, next, volume via AppleScript (`lib/now-playing.ts`) |
| `say` | Speak out loud, ducking Spotify |
| `overlay_message` | Banner/text on the TV |
| `show_widget` | Put a widget in a slot |
| `set_preset` | Switch layout preset |
| `lookup_person` | Identify a visitor and pull public info |
| `show_person` | Put a person card on the TV |
| `remember` / `recall` | Read/write member and visitor memory |
| `pin_slack_thread` | Pin a thread to the screen |
| `reply` | Reply in Slack |
| `set_leaderboard` | Update the generic leaderboard widget |

### Hard rules
- No shell, filesystem, browser or arbitrary fetch tools. Only the typed tools above.
- `BAB_PRIVATE_KEY` (coin-flip wallet) is never in the agent's env.
- Slack text, feed text and search results are data, not instructions.
- Daily spend cap on Fireworks and Exa.

## Screen push
- `lib/screen-state.ts`: layout, widget slots, overlays. Stored in `.data/screen.json`.
- `app/api/screen/route.ts`: POST, 127.0.0.1 only plus a shared-secret header.
- `app/api/screen/stream/route.ts`: SSE.
- `app/page.tsx` opens one `EventSource` and renders from the registry (`app/widgets/registry.ts`).
- Tiles keep polling their own data routes. Only layout and overlays move to push.

## Slack
New Slack app, Socket Mode (no public URL).
- Tokens: app-level token (`xapp-`, scope `connections:write`) + bot token (`xoxb-`).
- Bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `channels:history`, `channels:read`, `groups:history`, `users:read`, `reactions:read`, `pins:read`.
- Events: `app_mention`, `message.im`, `message.channels`.
- `@slack/bolt` in Socket Mode.
- Phase 1: replaces the four pollers in `lib/slack.ts`, `lib/chum.ts`, `lib/quotes.ts`, `lib/songs.ts`.

## Voice
Fully local, no per-request cost except the LLM call.
- Wake word: openWakeWord, pretrained `hey_jarvis` model (Python).
- Speech-to-text: whisper.cpp with Metal, `small.en`.
- Daemon POSTs the transcript to the agent's local endpoint.
- TTS: macOS `say` in Phase 1; Piper (local, free) in Phase 2.
- Ducking: reuse `duck()` / `restore()` from `lib/coin-flip-sound.ts`, moved to `lib/duck.ts`.
- Mic muted while Jarvis talks, so it doesn't hear itself.
- Confidence threshold on the wake word to cut false triggers (TV audio saying "Jarvis").

## Visitor identification
Order Jarvis tries:
1. **Someone tells it.** "Jarvis, this is Jane from Stripe." Name plus any hints (company, school, who brought them).
2. **Context.** If no name was given:
   - Calendar: the club calendar the wall already reads (`lib/events.ts:1`, Google Calendar as an iCal feed via `EVENTS_ICS_URL`, `lib/events.ts:403`). Jarvis reuses that download and parse, plus a new export that returns events around now with guests and description for the agent only. Today only title and location leave the module (`lib/events.ts:12`); the wall keeps that.
   - Slack: recent messages ("bringing a friend from X"), check-ins, profiles.
   - Memory: past visitors and who brought them.
3. **Internet search.** Exa, using name + hints. We need a search API because the model can't browse the web.

Then:
- Summarize public info into a short card: who they are, what they work on, links.
- **Confidence check.** If the match is ambiguous (common name, conflicting results), Jarvis says who it thinks it is and asks before putting anyone on the TV. Better to ask than show the wrong person.
- `show_person` puts the card on the TV. Jarvis can say a line about them.
- Cache in SQLite. Repeat visitors cost nothing.

## Memory
SQLite via `better-sqlite3` at `.data/jarvis.db`.
- `members`: slack_id, name, interests, running jokes.
- `visitors`: name, hints, summary, links, sources, last_seen, brought_by.
- `memories`: about, text, created_by, created_at.
- `checkins`: who, when, source.
- `events_log`: every tool call and who asked.
- `spend`: Fireworks + Exa cost per day.
- Relevant rows go into the prompt. No vector DB at this size.

## Env
In `.env.local`, chmod 600.
- `FIREWORKS_API_KEY`, `FIREWORKS_MODEL`, `FIREWORKS_MODEL_HEAVY`
- `EXA_API_KEY`
- `SLACK_APP_TOKEN` (xapp-), `SLACK_BOT_TOKEN` (xoxb-)
- `EVENTS_ICS_URL`: existing, reused for visitor context. No new Google credentials.
- `SCREEN_SECRET` (shared secret for `POST /api/screen`)
- `JARVIS_DAILY_SPEND_CAP`
- Existing Spotify vars stay; token in `.data/spotify.json`.

## Phases

### Phase 0
- `launchd/` plists + `scripts/install.sh`: built app, kiosk, agent. Songs loop starts at boot.
- New Slack app on Socket Mode, `@jarvis` and DMs.
- Fireworks tool loop + rules fast path with `queue_track`, `say`, `overlay_message`, `lookup_person`, `show_person`.
- `POST /api/screen` + SSE. Banner and person card on the TV.
- Spend cap.

### Phase 1
- Voice daemon.
- Memory: `remember`, `recall`, check-ins, visitor cache.
- Calendar guests/descriptions for visitor context (`lib/events.ts`).
- Widget registry + presets (`JARVIS.md` §1).
- Fold the four Slack pollers into the Socket Mode listener.
- Scheduler: pin busy threads, market moves.
- Full playback control, requested-songs playlist.

### Phase 2
- Games: leaderboard, poker, Mafia (roles via Slack DM).
- Interest-biased feed: pass member interests into `lib/feed-agent.ts`.
- Better TTS voice, persona tuning.

## Risks
- **TCC permissions.** Must be granted once in the GUI; headless setups fail silently.
- **Spotify.** No Jam API, so "start a new Jam" can't be done via API. Dev Mode has a 5-user limit and needs Premium.
- **GLM tool calls.** Open models can fumble tool schemas. Keep tool schemas small and flat; the rules fast path covers the common commands.
- **Wrong person.** Common names, stale results. Confidence check + ask first.
- **Two writers.** Next intervals and the agent both writing `.data/*.json`. Each file gets one owner process.

## Decisions
- LLM: Fireworks, GLM 5.3 Flash default, GLM-5.3 for visitor ID.
- Search: Exa.
- Calendar: existing iCal feed (`lib/events.ts`), no new credentials.
- Inputs: Slack (new app, Socket Mode) and voice.
- TTS: macOS `say`, then Piper.
- Secrets: `.env.local`, chmod 600.
- Visitors: named by whoever introduces them, else inferred from calendar, Slack and memory, then Exa. Ask before showing when unsure.
