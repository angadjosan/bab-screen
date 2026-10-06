// Commands said to the Slack bot in the songs channel, read by the same poll as song requests and the Jam QR
// (lib/songs.ts). Each is a mention of the bot with one word:
//
//   @bot focus    focus mode: the screen shows only the ticker tape, the featured market and the calendar, and
//                 Spotify is paused if it was playing.
//   @bot unfocus  back to the full screen (also "focus off"); the music starts again if focus mode paused it.
//   @bot pause    pauses Spotify (also "stop").
//   @bot play     starts Spotify again (also "resume").
//
// Focus mode is kept in .data/focus.json so it survives a restart; the page reads it from /api/focus. A pause or
// play said during focus mode is what counts: unfocus then leaves the music as it is.

import { execFile } from "node:child_process";
import { readJson, writeJson } from "./songs-store";

const STATE_FILE = "focus.json";
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;
const OFF_WORDS = /\b(off|stop|end|done|exit)\b/i;

export type Command = "focus" | "unfocus" | "pause" | "play";

type FocusState = {
  version: 1;
  on: boolean;
  /** When it was last switched, and by whom (Slack user ID). */
  changedAt: string | null;
  changedBy: string | null;
  /** Set when turning focus on paused the music, so turning it off starts it again. */
  pausedMusic: boolean;
};

export type FocusView = { on: boolean; since: string | null };

/** The message with mentions, links and other <...> tokens taken out: what the person typed as words. */
function words(text: string): string {
  return (text ?? "").replace(/<[^<>]*>/g, " ").replace(/https?:\/\/\S+/g, " ");
}

/** Cheap first look that needs no bot ID: someone is mentioned and one of the command words is there. */
export function looksLikeCommand(text: string | undefined): boolean {
  return typeof text === "string" && text.includes("<@") && /\b(un)?focus\b|\b(pause|stop|play|resume)\b/i.test(words(text));
}

/**
 * The command a message gives: it mentions the bot (<@BOTID>) and has a command word (any case, as a whole
 * word, not inside a link). Focus words win over playback words, so "focus off" and "focus stop" are unfocus.
 * Null when it is not a command.
 */
export function parseCommand(text: string | undefined, botUserId: string | null): Command | null {
  if (typeof text !== "string" || !botUserId || !SLACK_USER_ID.test(botUserId)) return null;
  if (!new RegExp(`<@${botUserId}(?:\\|[^<>]*)?>`).test(text)) return null;
  const said = words(text);
  if (/\bunfocus\b/i.test(said)) return "unfocus";
  if (/\bfocus\b/i.test(said)) return OFF_WORDS.test(said) ? "unfocus" : "focus";
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

async function loadState(): Promise<FocusState> {
  const stored = await readJson<Partial<FocusState>>(STATE_FILE);
  const valid = stored && stored.version === 1;
  return {
    version: 1,
    on: valid ? stored.on === true : false,
    changedAt: valid && typeof stored.changedAt === "string" ? stored.changedAt : null,
    changedBy: valid && typeof stored.changedBy === "string" ? stored.changedBy : null,
    pausedMusic: valid ? stored.pausedMusic === true : false,
  };
}

/** Carries out a command. Focus or unfocus while already in that mode does nothing. Never throws. */
export async function runCommand(command: Command, user: string | null): Promise<void> {
  try {
    const state = await loadState();
    if (command === "pause" || command === "play") {
      await spotify(command);
      // Said by a person, so unfocus must not undo it.
      if (state.pausedMusic) {
        state.pausedMusic = false;
        await writeJson(STATE_FILE, state, 0o600);
      }
      return;
    }
    const on = command === "focus";
    if (state.on === on) return;
    state.on = on;
    state.changedAt = new Date().toISOString();
    state.changedBy = user;
    if (on) {
      state.pausedMusic = (await spotify("get player state as string")) === "playing";
      if (state.pausedMusic) await spotify("pause");
    } else {
      if (state.pausedMusic) await spotify("play");
      state.pausedMusic = false;
    }
    await writeJson(STATE_FILE, state, 0o600);
  } catch (error) {
    console.error(`Bot command "${command}" failed:`, error instanceof Error ? error.message : String(error));
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
