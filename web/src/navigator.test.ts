import { expect, test } from "vitest";
import { tocEntryURL } from "./navigator";

const readingOrder = [
  { href: "OEBPS/text/book.xhtml" },
  { href: "OEBPS/text/notes.xhtml" },
];

test("a table of contents entry in the reading order becomes its reading URL, fragment kept", () => {
  expect(tocEntryURL("7", readingOrder, "OEBPS/text/book.xhtml")).toBe(
    "/books/7/read/1",
  );
  expect(tocEntryURL("7", readingOrder, "OEBPS/text/notes.xhtml#note-1")).toBe(
    "/books/7/read/2#note-1",
  );
});

test("a table of contents entry outside the reading order has no URL", () => {
  for (const href of [
    "OEBPS/text/plates.xhtml",
    "OEBPS/nav.xhtml#toc",
    "../OEBPS/text/elsewhere.xhtml",
    "https://example.com/OEBPS/text/book.xhtml",
    "#chapter-1",
    "",
  ]) {
    expect(tocEntryURL("7", readingOrder, href), href).toBeNull();
  }
});
