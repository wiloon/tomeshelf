// Choosing spread starts in the pages layout (ADR-0010). Pure logic: the
// pages controller measures lines and places the marker; this decides which
// line opens the next spread.

import type { Turn } from "./pages";

// A line of the laid-out article as offsets into its textContent: start is
// its first character, end its last. A block with no text (a picture) is a
// line whose start and end sit between the characters around it.
export type LineSpan = { start: number; end: number };

// Next makes the line N lines before the spread's end the new spread start,
// or with N = 0 the line after the spread, and always moves forward by at
// least one line. Null after the document's last spread.
export function nextSpreadStart<L extends LineSpan>(
  visible: readonly L[],
  after: L | null,
  n: number,
): L | null {
  if (!after) {
    return null;
  }
  if (n === 0) {
    return after;
  }
  return visible[Math.max(1, visible.length - n)] ?? after;
}

// The line a computed Previous's spread must end with: the current spread's
// N-th line, or with N = 0 the line before the spread. Null when there is
// none (N = 0 at the document's start).
export function previousTarget<L extends LineSpan>(
  visible: readonly L[],
  before: L | null,
  n: number,
): L | null {
  if (n === 0) {
    return before;
  }
  return visible[Math.min(n, visible.length) - 1] ?? before;
}

// The earliest of the candidate spread starts (ascending) whose spread
// reaches the character `target`, found by binary search over trial layouts.
// lastLineOf lays out a spread from a start and returns its last line. A
// spread reaches the target when its last line ends at or after it, so a
// line reflowed around the target after a resize counts. When none reaches
// it, the last candidate: ending earlier would skip lines, but no line lies
// between it and the current spread.
export function findPreviousStart(
  candidates: readonly number[],
  target: number,
  lastLineOf: (start: number) => LineSpan | null,
): number | null {
  let lo = 0;
  let hi = candidates.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const last = lastLineOf(candidates[mid]);
    if (last && last.end >= target) {
      best = candidates[mid];
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return best ?? candidates.at(-1) ?? null;
}

// The spread starts turned through since the last re-layout, back and
// forward, as a browser's history: Next then Previous, or Previous then
// Next, returns exactly the spread the user saw.
export class SpreadMemory<T> {
  private back: T[] = [];
  private forward: T[] = [];

  // Records a turn away from current. Returns the remembered spread start
  // in that direction, or undefined when the caller must compute one.
  turn(direction: Turn, current: T): T | undefined {
    const [from, to] =
      direction === "next"
        ? [this.forward, this.back]
        : [this.back, this.forward];
    to.push(current);
    return from.pop();
  }

  clear() {
    this.back = [];
    this.forward = [];
  }
}
