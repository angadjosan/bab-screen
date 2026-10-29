// Commands said to the Slack bot in the songs channel, read by the same poll as song requests and the Jam QR
// (lib/songs.ts). Each is a mention of the bot with a few words, and the person who said it gets a private
// answer (lib/songs.ts posts the reply runCommand returns):
//
//   @bot focus    focus mode: the screen shows only the ticker tape, the featured market and the calendar. If
//                 Spotify is playing, the answer asks what the music should do: dim it to volume 10, pause it,
//                 or keep it as it is. The buttons are answered by the Slack agent (agent/slack.ts), which
//                 calls chooseFocusMusic.
//   @bot unfocus  back to the full screen (also "focus off"); a dim or pause chosen for focus mode is undone.
//   @bot dim      Spotify to volume 10, the same as the "Dim" button.
//   @bot pause    pauses Spotify (also "stop").
//   @bot play     starts Spotify again (also "resume").
//   @bot volume 20, louder, quieter, decrease volume, turn it down, ...
//                 sets Spotify's volume, or moves it by VOLUME_STEP (lib/volume-request.ts).
//   @bot spotlight <link> <who>
//                 puts a story about the club or someone in it in the feed column's spotlight for three days
//                 (lib/club-news.ts); "who" is optional, e.g. "Nicholas Chua". "@bot spotlight off" takes every
//                 shared story down again.
//
// Focus mode is kept in .data/focus.json so it survives a restart; the page reads it from /api/focus. A pause,
// play or volume said during focus mode is what counts: unfocus then leaves that as it is.

import { execFile } from "node:child_process";
import { clearShared, shareStory } from "./club-news";
import { currentVolume, setVolume } from "./duck";
import { readJson, writeJson } from "./songs-store";
import { parseVolumeRequest, targetVolume, type VolumeRequest } from "./volume-request";

const STATE_FILE = "focus.json";
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;
const OFF_WORDS = /\b(off|stop|end|done|exit)\b/i;
/** Spotify's volume after "Dim" in focus mode. */
export const DIM_VOLUME = 10;
const NOT_OPEN = "Spotify isn't open on the Mac.";

export type Spotlight = { kind: "spotlight"; url: string; about: string | null };
export type VolumeCommand = { kind: "volume"; request: VolumeRequest };
export type Command = "focus" | "unfocus" | "pause" | "play" | "dim" | "spotlight-off" | Spotlight | VolumeCommand;

/** What to tell the person who gave the command. `blocks` (Slack Block Kit) carries buttons. */
export type CommandReply = { text: string; blocks?: unknown[] };

export const FOCUS_MUSIC_CHOICES = ["dim", "pause", "keep"] as const;
export type FocusMusicChoice = (typeof FOCUS_MUSIC_CHOICES)[number];
/** The action_id of each button on the focus mode question is this prefix and the choice. */
export const FOCUS_MUSIC_ACTION = "focus_music:";

type FocusState = {
  version: 1;
  on: boolean;
  /** When it was last switched, and by whom (Slack user ID). */
  changedAt: string | null;
  changedBy: string | null;
  /** Set when focus mode paused the music, so turning it off starts it again. */
  pausedMusic: boolean;
  /** The volume before focus mode dimmed the music, which turning it off brings back. */
  dimmedFrom: number | null;
};

export type FocusView = { on: boolean; since: string | null };

/** The message with mentions, links and other <...> tokens taken out: what the person typed as words. */
function words(text: string): string {
  return (text ?? "").replace(/<[^<>]*>/g, " ").replace(/https?:\/\/\S+/g, " ");
}

/** Cheap first look that needs no bot ID: someone is mentioned and one of the command words is there. */
export function looksLikeCommand(text: string | undefined): boolean {
  return (
    typeof text === "string" &&
    text.includes("<@") &&
    /\b(un)?focus\b|\b(pause|stop|play|resume|spotlight|dim|volume|louder|quieter|softer|turn|crank|pump)\b/i.test(words(text))
  );
}

/** The first web link in a Slack message, which Slack writes as <https://…> or <https://…|label>. */
function firstLink(text: string): string | null {
  const match = /<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/.exec(text);
  return match ? match[1] : null;
}

/** "@bot spotlight <link> <who>" shares the link; "@bot spotlight off" with no link takes shared stories down. */
function spotlightCommand(text: string, said: string): Command | null {
  const url = firstLink(text);
  if (!url) return OFF_WORDS.test(said) ? "spotlight-off" : null;
  const about = said.replace(/\bspotlight\b/i, " ").replace(/\s+/g, " ").trim();
  return { kind: "spotlight", url, about: about || null };
}

/**
 * The command a message gives: it mentions the bot (<@BOTID>) and has a command word (any case, as a whole
 * word, not inside a link). Focus words win over the music's, so "focus off" and "focus stop" are unfocus.
 * Null when it is not a command.
 */
export function parseCommand(text: string | undefined, botUserId: string | null): Command | null {
  if (typeof text !== "string" || !botUserId || !SLACK_USER_ID.test(botUserId)) return null;
  if (!new RegExp(`<@${botUserId}(?:\\|[^<>]*)?>`).test(text)) return null;
  const said = words(text);
  if (/\bspotlight\b/i.test(said)) return spotlightCommand(text, said);
  return focusCommand(said) ?? musicCommand(said);
}

function focusCommand(said: string): Command | null {
  if (/\bunfocus\b/i.test(said)) return "unfocus";
  if (/\bfocus\b/i.test(said)) return OFF_WORDS.test(said) ? "unfocus" : "focus";
  return null;
}

function musicCommand(said: string): Command | null {
  const volume = parseVolumeRequest(said);
  if (volume) return { kind: "volume", request: volume };
  if (/^\s*dim\b/i.test(said)) return "dim";
  if (/\b(pause|stop)\b/i.test(said)) return "pause";
  if (/\b(play|resume)\b/i.test(said)) return "play";
  return null;
}

const spotify = (script: string) =>
  new Promise<string>((resolve) => {
    execFile("osascript", ["-e", `if application "Spotify" is running then tell application "Spotify" to ${script}`], { timeout: 3_000 }, (error, out) =>
      resolve(error ? "" : String(out).trim()),
    );
  });

/** "playing", "paused" or "stopped"; "" when Spotify is not running or would not say. */
const playerState = () => spotify("get player state as string");

async function loadState(): Promise<FocusState> {
  const stored = await readJson<Partial<FocusState>>(STATE_FILE);
  const valid = stored && stored.version === 1;
  return {
    version: 1,
    on: valid ? stored.on === true : false,
    changedAt: valid && typeof stored.changedAt === "string" ? stored.changedAt : null,
    changedBy: valid && typeof stored.changedBy === "string" ? stored.changedBy : null,
    pausedMusic: valid ? stored.pausedMusic === true : false,
    dimmedFrom: valid && typeof stored.dimmedFrom === "number" ? stored.dimmedFrom : null,
  };
}

const saveState = (state: FocusState) => writeJson(STATE_FILE, state, 0o600);

/** Said by a person, so unfocus must not undo it. */
async function forgetFocusMusic(field: "pausedMusic" | "dimmedFrom"): Promise<void> {
  const state = await loadState();
  if (field === "pausedMusic" ? !state.pausedMusic : state.dimmedFrom === null) return;
  if (field === "pausedMusic") state.pausedMusic = false;
  else state.dimmedFrom = null;
  await saveState(state);
}

async function runSpotlight(command: Spotlight | "spotlight-off", user: string | null): Promise<null> {
  if (command === "spotlight-off") await clearShared();
  else if (!(await shareStory(command.url, command.about, user))) console.warn(`Spotlight: nothing could be read from ${command.url}`);
  return null;
}

async function runPlayback(command: "pause" | "play"): Promise<CommandReply> {
  if (!(await playerState())) return { text: NOT_OPEN };
  await spotify(command);
  await forgetFocusMusic("pausedMusic");
  return { text: command === "pause" ? "Paused." : "Playing." };
}

async function runVolume(request: VolumeRequest): Promise<CommandReply> {
  const current = await currentVolume();
  if (current === null) return { text: NOT_OPEN };
  const target = targetVolume(request, current);
  await setVolume(target);
  await forgetFocusMusic("dimmedFrom");
  return { text: target === current ? `The volume is already ${target}.` : `Volume ${target} (it was ${current}).` };
}

function button(choice: FocusMusicChoice, label: string, primary = false) {
  return { type: "button", action_id: `${FOCUS_MUSIC_ACTION}${choice}`, text: { type: "plain_text", text: label }, ...(primary ? { style: "primary" } : {}) };
}

function focusMusicQuestion(): CommandReply {
  const text = "Focus mode is on. What should the music do?";
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements: [button("dim", `Dim to volume ${DIM_VOLUME}`, true), button("pause", "Pause music"), button("keep", "Nah, keep it")] },
    ],
  };
}

async function focusOnReply(): Promise<CommandReply> {
  return (await playerState()) === "playing" ? focusMusicQuestion() : { text: "Focus mode is on." };
}

/** Undoes a dim or pause that focus mode asked for. */
async function restoreFocusMusic(state: FocusState): Promise<CommandReply> {
  const volume = state.dimmedFrom;
  const resume = state.pausedMusic;
  state.dimmedFrom = null;
  state.pausedMusic = false;
  if (volume !== null) await setVolume(volume);
  if (resume) await spotify("play");
  if (resume) return { text: `Back to the full screen. The music is playing again${volume !== null ? ` at volume ${volume}` : ""}.` };
  return { text: volume !== null ? `Back to the full screen. The volume is back to ${volume}.` : "Back to the full screen." };
}

async function runFocus(on: boolean, user: string | null): Promise<CommandReply> {
  const state = await loadState();
  if (state.on === on) return { text: on ? "Focus mode is already on." : "Focus mode is already off." };
  state.on = on;
  state.changedAt = new Date().toISOString();
  state.changedBy = user;
  const reply = on ? await focusOnReply() : await restoreFocusMusic(state);
  await saveState(state);
  return reply;
}

async function dimForFocus(state: FocusState): Promise<string> {
  const current = await currentVolume();
  if (current === null) return NOT_OPEN;
  const target = Math.min(current, DIM_VOLUME);
  if (state.on && current > target) state.dimmedFrom ??= current;
  await setVolume(target);
  if (state.on && state.dimmedFrom !== null) return `Dimmed to ${target}. It goes back to ${state.dimmedFrom} when focus mode ends.`;
  return `Volume ${target}.`;
}

async function pauseForFocus(state: FocusState): Promise<string> {
  if (!(await playerState())) return NOT_OPEN;
  await spotify("pause");
  if (!state.on) return "Paused.";
  state.pausedMusic = true;
  return "Paused. It starts again when focus mode ends.";
}

const FOCUS_MUSIC: Record<FocusMusicChoice, (state: FocusState) => Promise<string>> = {
  dim: dimForFocus,
  pause: pauseForFocus,
  keep: async () => "Leaving the music as it is.",
};

/** Carries out an answer to the focus mode question ("Dim", "Pause", "Keep"). Never throws. */
export async function chooseFocusMusic(choice: FocusMusicChoice): Promise<string> {
  try {
    const state = await loadState();
    const reply = await FOCUS_MUSIC[choice](state);
    await saveState(state);
    return reply;
  } catch (error) {
    console.error(`Focus music "${choice}" failed:`, error instanceof Error ? error.message : String(error));
    return "That didn't work. Try again in a moment.";
  }
}

function commandReply(command: Command, user: string | null): Promise<CommandReply | null> {
  if (typeof command === "object") return command.kind === "spotlight" ? runSpotlight(command, user) : runVolume(command.request);
  if (command === "spotlight-off") return runSpotlight(command, user);
  if (command === "pause" || command === "play") return runPlayback(command);
  if (command === "dim") return chooseFocusMusic("dim").then((text) => ({ text }));
  return runFocus(command === "focus", user);
}

/** Carries out a command and returns what to tell the person, or null for nothing. Never throws. */
export async function runCommand(command: Command, user: string | null): Promise<CommandReply | null> {
  try {
    return await commandReply(command, user);
  } catch (error) {
    const name = typeof command === "object" ? command.kind : command;
    console.error(`Bot command "${name}" failed:`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Whether the screen is in focus mode. Reads one small local file. Never throws. */
export async function getFocusView(): Promise<FocusView> {
  try {
    const state = await loadState();
    return { on: state.on, since: state.on ? state.changedAt : null };
  } catch {
    return { on: false, since: null };
  }
}
