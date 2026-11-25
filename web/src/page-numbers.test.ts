import { describe, expect, test } from "vitest";
import { PageNumbers } from "./page-numbers";

const text = (characters: number, pictures = 0) => ({ characters, pictures });

describe("page numbers (ADR-0010 Page numbers)", () => {
  test("a book whose every document is measured needs no estimate", () => {
    const book = new PageNumbers([text(10)]);
    book.measure(0, 5);
    expect(book.label(0, 1, 2)).toBe("1–2 of 5");
  });

  test("a two-page spread whose second page holds none of the document shows one number", () => {
    const book = new PageNumbers([text(10)]);
    book.measure(0, 5);
    expect(book.label(0, 5, 2)).toBe("5 of 5");
  });

  test("a document not measured is estimated from its characters per page", () => {
    const book = new PageNumbers([text(2000), text(1000)]);
    book.measure(0, 4);
    expect(book.label(0, 1, 2)).toBe("1–2 of 6");
  });

  test("each picture counts as half a page, in the ratio and in an estimate", () => {
    // 6 pages less 4 pictures is 4 text pages: 375 characters a page.
    const book = new PageNumbers([text(1500, 4), text(1500, 2)]);
    book.measure(0, 6);
    // 1500 / 375 + 2 / 2 = 5 pages.
    expect(book.label(0, 1, 2)).toBe("1–2 of 11");
  });

  test("the ratio waits for 4 text pages, pooled across measured documents", () => {
    const book = new PageNumbers([text(600), text(600), text(3000)]);
    book.measure(0, 2);
    expect(book.label(0, 1, 2)).toBeNull();
    book.measure(1, 2);
    // 1200 characters on 4 pages: 300 a page, so the last is 10 pages.
    expect(book.label(1, 1, 2)).toBe("3–4 of 14");
  });

  test("documents of pictures alone give no ratio", () => {
    // 10 pages less 5 plates is 7.5 text pages, but no characters.
    const book = new PageNumbers([text(0, 5), text(1000)]);
    book.measure(0, 10);
    expect(book.label(0, 1, 2)).toBeNull();
  });

  test("a document with no text pages stays out of the ratio but keeps its pages", () => {
    // 2 pages with 10 ornaments: -3 text pages, left out of the pool.
    const book = new PageNumbers([text(2000), text(40, 10), text(1000)]);
    book.measure(0, 4);
    book.measure(1, 2);
    // 500 characters a page from the first document alone: 4 + 2 + 2.
    expect(book.label(1, 1, 2)).toBe("5–6 of 8");
  });

  test("an estimate is at least one page", () => {
    const book = new PageNumbers([text(2000), text(0)]);
    book.measure(0, 4);
    expect(book.label(0, 1, 2)).toBe("1–2 of 5");
  });

  test("reading forward, a document's first page follows the last page of the one before", () => {
    const book = new PageNumbers([text(2000), text(2000)]);
    book.measure(0, 4);
    // The marker reflows the document while it is read: the last spread
    // shows a fifth page, and that latest count is kept.
    book.measure(0, 5);
    expect(book.label(0, 5, 1)).toBe("5 of 10");
    book.measure(1, 4);
    expect(book.label(1, 1, 1)).toBe("6 of 9");
  });

  test("re-layout forgets the measured documents", () => {
    const book = new PageNumbers([text(2000), text(2000)]);
    book.measure(0, 4);
    book.forget();
    expect(book.label(0, 1, 2)).toBeNull();
  });
});
