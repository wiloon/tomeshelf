// savedAt and now are Unix milliseconds. Keep the date in UTC so the
// fallback is stable across browsers in different time zones.
export function formatProgressLine(
  progress: number | undefined,
  savedAt: number | undefined,
  now: number,
): string {
  const percentage = progress === undefined ? "" : `${progress}%`;
  if (savedAt === undefined) return percentage;
  const elapsed = now - savedAt;
  const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  let time: string;
  if (elapsed < 60_000) time = "just now";
  else if (elapsed < 3_600_000)
    time = relative.format(-Math.floor(elapsed / 60_000), "minute");
  else if (elapsed < 86_400_000)
    time = relative.format(-Math.floor(elapsed / 3_600_000), "hour");
  else if (elapsed < 2_592_000_000)
    time = relative.format(-Math.floor(elapsed / 86_400_000), "day");
  else
    time = new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(savedAt);
  return [percentage, time].filter(Boolean).join(" · ");
}
