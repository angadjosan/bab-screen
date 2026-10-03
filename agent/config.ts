// Agent settings, read from env on every call so a test can change them.

export const DEFAULT_MODEL = "accounts/fireworks/models/glm-5p3-flash";
export const DEFAULT_MODEL_HEAVY = "accounts/fireworks/models/glm-5p3";
export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const NEXT_URL = "http://127.0.0.1:3000";
export const TIME_ZONE = "America/Los_Angeles";

const env = (key: string) => process.env[key]?.trim() || "";

function number(key: string, fallback: number): number {
  const value = Number(env(key));
  return env(key) && Number.isFinite(value) ? value : fallback;
}

export const config = {
  port: () => number("JARVIS_PORT", 3001),
  fireworksKey: () => env("FIREWORKS_API_KEY"),
  model: () => env("FIREWORKS_MODEL") || DEFAULT_MODEL,
  heavyModel: () => env("FIREWORKS_MODEL_HEAVY") || DEFAULT_MODEL_HEAVY,
  exaKey: () => env("EXA_API_KEY"),
  slackAppToken: () => env("SLACK_APP_TOKEN"),
  slackBotToken: () => env("SLACK_BOT_TOKEN"),
  /** The busy-thread channel, and where voice "tell Slack ..." goes. */
  slackChannel: () => env("SLACK_CHANNEL_ID"),
  /** The other Slack-backed tiles' channels, read by the Next app; the listener nudges it when they change. */
  chumChannel: () => env("SLACK_CHUM_CHANNEL_ID"),
  quotesChannel: () => env("SLACK_QUOTES_CHANNEL_ID"),
  songsChannel: () => env("SLACK_SONGS_CHANNEL_ID"),
  spotbotUserId: () => env("SLACK_SPOTBOT_USER_ID"),
  screenSecret: () => env("SCREEN_SECRET"),
  nextUrl: () => env("JARVIS_NEXT_URL") || NEXT_URL,
  /** USD per day, Fireworks and Exa together, in TIME_ZONE days. */
  dailyCap: () => number("JARVIS_DAILY_SPEND_CAP", 2),
  maxSteps: () => Math.max(1, Math.min(12, number("JARVIS_MAX_STEPS", 6))),
  voice: () => env("JARVIS_VOICE"),
  /** 1: no side effects (Spotify, say, screen, Slack posts); every action is logged instead. */
  dryRun: () => env("JARVIS_DRY_RUN") === "1",
  /** 0 turns the scheduler off. */
  schedulerSeconds: () => number("JARVIS_SCHEDULER_SECONDS", 120),
  pinMinReplies: () => number("JARVIS_PIN_MIN_REPLIES", 5),
  /** Channels a thread may be pinned from: SLACK_CHANNEL_ID plus this comma list (public channels only). */
  pinChannels: () => [env("SLACK_CHANNEL_ID"), ...env("JARVIS_PIN_CHANNELS").split(",")].map((id) => id.trim()).filter(Boolean),
};

/** What is missing, as lines for the startup log and /health. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.fireworksKey()) missing.push("FIREWORKS_API_KEY: no model calls, rules fast path only");
  if (!config.exaKey()) missing.push("EXA_API_KEY: lookup_person works without web search");
  if (!config.slackBotToken()) missing.push("SLACK_BOT_TOKEN: no Slack replies, pins or busy-thread checks");
  if (!config.slackAppToken()) missing.push("SLACK_APP_TOKEN (xapp-): no Slack listener; the HTTP endpoint still runs");
  if (!config.screenSecret()) missing.push("SCREEN_SECRET: the TV will refuse screen changes");
  if (!config.slackChannel()) missing.push("SLACK_CHANNEL_ID: no busy-thread pinning");
  return missing;
}
