import { describe, expect, it } from "vitest";
import { formatProgressLine } from "./progress-line";

const now = Date.UTC(2026, 10, 17, 12);

describe("formatProgressLine", () => {
  it.each([
    [undefined, now - 172_800_000, "2 days ago"],
    [23, undefined, "23%"],
    [0, undefined, "0%"],
    [undefined, undefined, ""],
  ])("omits missing parts (%s, %s)", (progress, savedAt, expected) => {
    expect(formatProgressLine(progress, savedAt, now)).toBe(expected);
  });
  it.each([
    [0, "just now"],
    [59_999, "just now"],
    [60_000, "1 minute ago"],
    [60_001, "1 minute ago"],
    [120_000, "2 minutes ago"],
    [3_599_999, "59 minutes ago"],
    [3_600_000, "1 hour ago"],
    [3_600_001, "1 hour ago"],
    [7_200_000, "2 hours ago"],
    [86_399_999, "23 hours ago"],
    [86_400_000, "1 day ago"],
    [86_400_001, "1 day ago"],
    [172_800_000, "2 days ago"],
    [2_591_999_999, "29 days ago"],
    [2_592_000_000, "Oct 18, 2026"],
    [2_592_000_001, "Oct 18, 2026"],
  ])("formats a save %i ms ago as %s", (elapsed, relative) => {
    expect(formatProgressLine(23, now - elapsed, now)).toBe(
      `23% · ${relative}`,
    );
  });
});
