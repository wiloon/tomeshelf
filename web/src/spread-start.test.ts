import { describe, expect, test } from "vitest";
import {
  findPreviousStart,
  nextSpreadStart,
  previousTarget,
  SpreadMemory,
} from "./spread-start";

// Lines as character ranges of the article's text: line i holds [10i, 10i+9].
const line = (i: number) => ({ start: 10 * i, end: 10 * i + 9 });
const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => line(from + k));

describe("spread memory (ADR-0010)", () => {
  test("Next then Previous returns the spread start turned away from", () => {
    const memory = new SpreadMemory<string>();
    expect(memory.turn("next", "a")).toBeUndefined();
    expect(memory.turn("previous", "b")).toBe("a");
  });

  test("a computed Previous then Next returns the spread start turned away from", () => {
    const memory = new SpreadMemory<string>();
    expect(memory.turn("previous", "c")).toBeUndefined();
    expect(memory.turn("next", "b")).toBe("c");
  });

  test("goes back and forth through several turns like browser history", () => {
    const memory = new SpreadMemory<string>();
    memory.turn("next", "a");
    memory.turn("next", "b");
    memory.turn("next", "c");
    expect(memory.turn("previous", "d")).toBe("c");
    expect(memory.turn("previous", "c")).toBe("b");
    expect(memory.turn("next", "b")).toBe("c");
    expect(memory.turn("next", "c")).toBe("d");
    expect(memory.turn("next", "d")).toBeUndefined();
    expect(memory.turn("previous", "e")).toBe("d");
  });

  test("a computed Previous past the remembered ones keeps the way forward", () => {
    const memory = new SpreadMemory<string>();
    memory.turn("next", "a");
    memory.turn("next", "b");
    expect(memory.turn("previous", "c")).toBe("b");
    expect(memory.turn("previous", "b")).toBe("a");
    expect(memory.turn("previous", "a")).toBeUndefined();
    // Previous computed "z" before "a"; Next returns to "a", then "b".
    expect(memory.turn("next", "z")).toBe("a");
  });

  test("clearing forgets both directions", () => {
    const memory = new SpreadMemory<string>();
    memory.turn("next", "a");
    memory.turn("previous", "b");
    memory.clear();
    expect(memory.turn("next", "a")).toBeUndefined();
    memory.clear();
    expect(memory.turn("previous", "b")).toBeUndefined();
  });
});

describe("Next (ADR-0010 Repeated lines)", () => {
  const visible = lines(0, 9);
  const after = line(10);

  test.each([
    [1, line(9)],
    [2, line(8)],
    [3, line(7)],
  ])(
    "with N = %i the line N lines before the spread's end starts the next spread",
    (n, want) => {
      expect(nextSpreadStart(visible, after, n)).toEqual(want);
    },
  );

  test("with N = 0 the line after the spread starts the next spread", () => {
    expect(nextSpreadStart(visible, after, 0)).toEqual(after);
  });

  test("a spread with no more than N lines still moves forward by one line", () => {
    expect(nextSpreadStart(lines(4, 5), line(6), 3)).toEqual(line(5));
    expect(nextSpreadStart(lines(4, 6), line(7), 3)).toEqual(line(5));
  });

  test("a spread of one line (a tall picture) moves to the line after it", () => {
    expect(nextSpreadStart([line(4)], line(5), 2)).toEqual(line(5));
  });

  test("there is no next spread start in the document after its last spread", () => {
    expect(nextSpreadStart(visible, null, 1)).toBeNull();
  });
});

describe("Previous target (ADR-0010 Repeated lines)", () => {
  const visible = lines(20, 29);

  test.each([
    [1, line(20)],
    [2, line(21)],
    [3, line(22)],
  ])(
    "with N = %i the previous spread ends with the current spread's N-th line",
    (n, want) => {
      expect(previousTarget(visible, line(19), n)).toEqual(want);
    },
  );

  test("with N = 0 it ends with the line before the spread", () => {
    expect(previousTarget(visible, line(19), 0)).toEqual(line(19));
  });

  test("a spread with fewer than N lines targets its last line", () => {
    expect(previousTarget(lines(20, 21), line(19), 3)).toEqual(line(21));
  });

  test("with N = 0 at the document's start there is no target", () => {
    expect(previousTarget(visible, null, 0)).toBeNull();
  });
});

describe("computed Previous (ADR-0010)", () => {
  // A layout where a spread holds `per` lines: the spread from line i ends
  // with line i + per - 1.
  const layout = (per: number) => (start: number) =>
    line(Math.floor(start / 10) + per - 1);

  test("takes the earliest start whose spread reaches the target, so it ends with it", () => {
    const candidates = lines(0, 19).map((l) => l.start);
    // Target line 20 (N = 1 from a spread starting at 20), 10 lines a spread.
    expect(findPreviousStart(candidates, line(20).start, layout(10))).toBe(
      line(11).start,
    );
  });

  test("never skips a line: when no spread ends exactly there, it repeats more", () => {
    // Spreads from even lines hold 10 lines, from odd lines 8 (a picture).
    const uneven = (start: number) => {
      const i = Math.floor(start / 10);
      return line(i + (i % 2 === 0 ? 10 : 8) - 1);
    };
    const candidates = lines(0, 19).map((l) => l.start);
    // From 11 the spread ends at 18, short of 20; from 12 it ends at 21.
    expect(findPreviousStart(candidates, line(20).start, uneven)).toBe(
      line(12).start,
    );
  });

  test("a reflowed line holding the target counts as reaching it", () => {
    // After a resize the target character 205 sits mid-line in a line
    // [200, 209] that starts before it.
    const candidates = lines(0, 19).map((l) => l.start);
    expect(findPreviousStart(candidates, 205, layout(10))).toBe(line(11).start);
  });

  test("near the document's start it shows the first spread", () => {
    const candidates = lines(0, 3).map((l) => l.start);
    expect(findPreviousStart(candidates, line(4).start, layout(10))).toBe(0);
  });

  test("when no candidate reaches the target it takes the last one, skipping nothing", () => {
    const candidates = lines(0, 9).map((l) => l.start);
    expect(findPreviousStart(candidates, line(30).start, layout(10))).toBe(
      line(9).start,
    );
  });

  test("tries few layouts", () => {
    const candidates = lines(0, 999).map((l) => l.start);
    let probes = 0;
    const counted = (start: number) => {
      probes++;
      return layout(10)(start);
    };
    findPreviousStart(candidates, line(1000).start, counted);
    expect(probes).toBeLessThanOrEqual(11);
  });
});
