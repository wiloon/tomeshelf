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
// reaches the character `target`, searched over trial layouts. lastLineOf
// lays out a spread from a start and returns its last line. A spread reaches
// the target when its last line ends at or after it, so a line reflowed
// around the target after a resize counts. When none reaches it, the last
// candidate: ending earlier would skip lines, but no line lies between it
// and the current spread.
//
// Each trial lays out the whole document, so the search starts from guess,
// the index of the likely answer, and gallops outwards from it before
// bisecting; without a guess it bisects all candidates.
export function findPreviousStart(
  candidates: readonly number[],
  target: number,
  lastLineOf: (start: number) => LineSpan | null,
  guess?: number,
): number | null {
  const n = candidates.length;
  if (n === 0) {
    return null;
  }
  const known = new Map<number, boolean>();
  const reaches = (i: number) => {
    let hit = known.get(i);
    if (hit === undefined) {
      const last = lastLineOf(candidates[i]);
      hit = last !== null && last.end >= target;
      known.set(i, hit);
    }
    return hit;
  };
  // The earliest index in [lo, hi] that reaches, given hi + 1 reaches or is
  // past the end; hi + 1 when none in [lo, hi] does.
  const bisect = (lo: number, hi: number) => {
    let found = hi + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (reaches(mid)) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return found;
  };
  let earliest: number;
  if (guess === undefined) {
    earliest = bisect(0, n - 1);
  } else {
    const g = Math.min(n - 1, Math.max(0, guess));
    if (reaches(g)) {
      // Back from the guess until a start falls short.
      let hi = g;
      let step = 1;
      let lo = g - step;
      while (lo >= 0 && reaches(lo)) {
        hi = lo;
        step *= 2;
        lo = g - step;
      }
      earliest = bisect(Math.max(0, lo + 1), hi - 1);
    } else {
      // Forward from the guess until a start reaches.
      let lo = g;
      let step = 1;
      let hi = g + step;
      while (hi < n && !reaches(hi)) {
        lo = hi;
        step *= 2;
        hi = g + step;
      }
      earliest = bisect(lo + 1, Math.min(hi, n) - 1);
    }
  }
  return earliest < n ? candidates[earliest] : candidates[n - 1];
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
