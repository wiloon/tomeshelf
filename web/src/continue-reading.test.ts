import { describe, expect, it } from "vitest";
import { continueReadingBook } from "./continue-reading";

const book = (id: string, savedAt?: number, importedAt = 0) => ({
  id,
  title: `Book ${id}`,
  authors: [],
  savedAt,
  importedAt,
});

describe("continueReadingBook", () => {
  it("picks the newest save without reordering the library", () => {
    const books = [book("3", 1000), book("1", 1001), book("2")];
    expect(continueReadingBook(books)).toBe(books[1]);
    expect(books.map((b) => b.id)).toEqual(["3", "1", "2"]);
  });
  it("breaks equal newest times by newest import before id in either list order", () => {
    const older = book("3", 100, 1000);
    const newer = book("1", 100, 1001);
    const earlierSave = book("5", 99, 1002);
    expect(continueReadingBook([older, newer, earlierSave])).toBe(newer);
    expect(continueReadingBook([newer, older])).toBe(newer);
  });
  it("breaks equal save and import times by highest id in either list order", () => {
    const lower = book("a".repeat(64), 100, 1000);
    const higher = book("b".repeat(64), 100, 1000);
    expect(continueReadingBook([lower, higher])).toBe(higher);
    expect(continueReadingBook([higher, lower])).toBe(higher);
  });
  it("has no card without save times, including an empty library", () => {
    expect(continueReadingBook([])).toBeUndefined();
    expect(continueReadingBook([book("1"), book("2")])).toBeUndefined();
  });
  it("accepts a save at the Unix epoch", () => {
    expect(continueReadingBook([book("1", 0)])?.id).toBe("1");
  });
});
