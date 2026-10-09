// What a person means when they ask for a different Spotify volume, in words: "volume 20", "set the volume
// to 40%", "louder", "decrease volume", "turn it down". The whole message has to be the request, so a
// question that happens to mention the volume ("why is the volume 20?") is not one. Shared by the Slack
// commands in the songs channel (lib/commands.ts) and the agent's fast path (agent/rules.ts).

export type VolumeRequest = { kind: "set"; volume: number } | { kind: "step"; direction: 1 | -1 };

/** How far one "louder" or "quieter" moves Spotify's 0 to 100 volume. */
export const VOLUME_STEP = 15;

const MUSIC = "(?:the )?(?:music|volume|spotify)";
const UP = new RegExp(`^(?:volume up|louder|make it louder|turn it up|crank it(?: up)?|pump it up|turn ${MUSIC} up|turn up ${MUSIC}|(?:increase|raise|boost) ${MUSIC})$`);
const DOWN = new RegExp(`^(?:volume down|quieter|softer|make it quieter|turn it down|turn ${MUSIC} down|turn down ${MUSIC}|(?:decrease|lower|reduce|drop) ${MUSIC})$`);
const SET = /^(?:(?:set|turn|put) (?:the )?)?volume (?:to |at )?(\d{1,3})\s*%?$/;

/** Lower case, with politeness and end punctuation taken off. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please|pls|can you|could you)\s+/, "")
    .replace(/[\s,]*(?:please|pls|thanks|thank you)?[.!?\s]*$/, "")
    .trim();
}

export function parseVolumeRequest(text: string): VolumeRequest | null {
  const said = plain(text);
  const set = SET.exec(said);
  if (set) return { kind: "set", volume: Math.min(100, Number(set[1])) };
  if (UP.test(said)) return { kind: "step", direction: 1 };
  if (DOWN.test(said)) return { kind: "step", direction: -1 };
  return null;
}

export function clampVolume(volume: number): number {
  return Math.max(0, Math.min(100, Math.round(volume)));
}

/** The volume a request asks for, given the one Spotify is at now. */
export function targetVolume(request: VolumeRequest, current: number): number {
  return clampVolume(request.kind === "set" ? request.volume : current + request.direction * VOLUME_STEP);
}
