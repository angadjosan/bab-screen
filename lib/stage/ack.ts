// What Worm says the moment a question ends, while the answer is being written. Picked from the question's words
// rather than asked of a model, so it is said at once: a model took 0.8 to 1.3 s to write one, which was most of the
// wait before Worm started talking.

const ACKS: [RegExp, string][] = [
  [/\b(queue|song|music|play|playing|pause|skip|volume|louder|quieter|spotify)\b/i, "Checking the music."],
  [/\b(calendar|event|events|meeting|tonight|tomorrow|this week|schedule)\b/i, "Pulling up the calendar."],
  [/\b(slack|channel|message|assign(ed|ment|ments)?|task|tasks|who said)\b/i, "Let me check Slack."],
  [/\b(price|trading|eth|btc|sol|bitcoin|ethereum|solana|hype|market|token)\b/i, "Checking the price."],
  [/\b(news|headline|headlines|happening)\b/i, "Let me look at the news."],
  [/\b(draw|diagram|show me|how does|how do|difference|differ|compare|explain|why)\b/i, "Good question, one sec."],
];
const DEFAULT_ACK = "One sec.";

export function quickAck(question: string): string {
  return ACKS.find(([pattern]) => pattern.test(question))?.[1] ?? DEFAULT_ACK;
}
