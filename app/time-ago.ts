/** How long ago something was published, short enough for a source line: "just now", "12m ago", "3h ago", "2d ago", "Sep 28". */
export function age(publishedAt: string, now: number) {
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published)) return null;
  const minutes = Math.floor((now - published) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d ago`;
  return new Date(published).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
