// Every tool the model can call. Nothing else: no shell, filesystem, browser or fetch tools.

import checkin from "./checkin";
import lookupPerson from "./lookup_person";
import mafia from "./mafia";
import overlayMessage from "./overlay_message";
import pinSlackThread from "./pin_slack_thread";
import playback from "./playback";
import poker from "./poker";
import queueTrack from "./queue_track";
import recall from "./recall";
import remember from "./remember";
import reply from "./reply";
import say from "./say";
import setLeaderboard from "./set_leaderboard";
import setPreset from "./set_preset";
import showPerson from "./show_person";
import showWidget from "./show_widget";
import type { AnyTool } from "./types";

export const TOOLS: AnyTool[] = [
  queueTrack,
  playback,
  say,
  overlayMessage,
  showWidget,
  setPreset,
  lookupPerson,
  showPerson,
  remember,
  recall,
  checkin,
  pinSlackThread,
  reply,
  setLeaderboard,
  poker,
  mafia,
];
