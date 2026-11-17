import { describe, expect, it } from "vitest";
import { continueReadingBook } from "./continue-reading";

const book = (id: number, savedAt?: number) => ({
  id,
  title: `Book ${id}`,
  authors: [],
  savedAt,
});

describe("continueReadingBook", () => {
  it("picks the newest save without reordering the library", () => {
    const books = [book(3, 1000), book(1, 1001), book(2)];
    expect(continueReadingBook(books)).toBe(books[1]);
    expect(books.map((b) => b.id)).toEqual([3, 1, 2]);
  });
  it("breaks equal newest times by highest book id in either list order", () => {
    expect(
      continueReadingBook([book(1, 100), book(3, 100), book(5, 99)])?.id,
    ).toBe(3);
    expect(continueReadingBook([book(3, 100), book(1, 100)])?.id).toBe(3);
  });
  it("has no card without save times, including an empty library", () => {
    expect(continueReadingBook([])).toBeUndefined();
    expect(continueReadingBook([book(1), book(2)])).toBeUndefined();
  });
  it("accepts a save at the Unix epoch", () => {
    expect(continueReadingBook([book(1, 0)])?.id).toBe(1);
  });
});
