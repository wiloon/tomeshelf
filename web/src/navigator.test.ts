import { expect, test } from "vitest";
import { renderDocument, tocEntryURL } from "./navigator";

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

test("a rendered document keeps epub:type and class, and still drops the book's styles", () => {
  const target = document.createElement("article");
  renderDocument(
    target,
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><style>p { color: red; }</style></head>
<body>
<section epub:type="z3998:poem">
<p style="color: red"><span>The first line</span><br/><span class="i1">an indented line</span></p>
</section>
<style>span { color: red; }</style>
</body>
</html>`,
    { bookId: "7", readingOrder, n: 1 },
  );
  expect(target.querySelector("section")?.getAttribute("epub:type")).toBe(
    "z3998:poem",
  );
  expect(target.querySelector("span.i1")?.textContent).toBe("an indented line");
  expect(target.querySelectorAll("style, [style]")).toHaveLength(0);
});
