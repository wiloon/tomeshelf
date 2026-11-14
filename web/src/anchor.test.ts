import { expect, test } from "vitest";
import { findAnchor } from "./anchor";
import { renderDocument } from "./navigator";

// Renders a document as the reader does, and gives elements the boxes the
// test names, top and height in viewport pixels. Unnamed elements get an
// empty box at the top edge, as hidden elements do.
function layout(body: string, boxes: Record<string, [number, number]>) {
  const content = document.createElement("article");
  content.id = "tomeshelf-content";
  renderDocument(
    content,
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`,
    { bookId: "7", readingOrder: [{ href: "OEBPS/text/one.xhtml" }], n: 1 },
  );
  for (const el of [content, ...content.querySelectorAll("*")]) {
    const [top, height] = boxes[el.id] ?? [0, 0];
    el.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: top, width: 300, height });
  }
  return content;
}

test("with the top edge above the article, there is no anchor", () => {
  const content = layout(`<p id="a">One.</p>`, {
    "tomeshelf-content": [40, 500],
    a: [56, 30],
  });
  expect(findAnchor(content)).toEqual({ kind: "none" });
});

test("at the top of the article, its first block is the anchor", () => {
  const content = layout(`<section><h2 id="h">A heading</h2></section>`, {
    "tomeshelf-content": [0, 500],
    h: [0, 40],
  });
  expect(findAnchor(content)).toMatchObject({
    kind: "element",
    element: content.querySelector("#h"),
    fraction: 0,
  });
});

test("the block crossing the top edge is the anchor, with the fraction scrolled past it", () => {
  const content = layout(
    `<section id="s"><p id="a">One.</p><p id="b">Two.</p><p id="c">Three.</p></section>`,
    {
      "tomeshelf-content": [-900, 2000],
      s: [-900, 1900],
      a: [-120, 80],
      b: [-30, 100],
      c: [86, 100],
    },
  );
  expect(findAnchor(content)).toMatchObject({
    kind: "element",
    element: content.querySelector("#b"),
    fraction: 0.3,
  });
});

test("a table is the anchor, never one of its cells or the paragraphs in them", () => {
  const content = layout(
    `<table id="t"><tbody><tr id="r"><td id="d"><p id="p">A cell.</p></td></tr></tbody></table>`,
    {
      "tomeshelf-content": [-900, 2000],
      t: [-100, 400],
      r: [-20, 40],
      d: [-20, 40],
      p: [-10, 20],
    },
  );
  expect(findAnchor(content)).toMatchObject({
    element: content.querySelector("#t"),
    fraction: 0.25,
  });
});

test("a stanza is the anchor, never one of its line spans", () => {
  const content = layout(
    `<section epub:type="z3998:poem"><p id="stanza"><span id="l1">The first line</span><br/><span id="l2">the second</span></p></section>`,
    {
      "tomeshelf-content": [-900, 2000],
      stanza: [-50, 100],
      l1: [-50, 50],
      l2: [0, 50],
    },
  );
  expect(findAnchor(content)).toMatchObject({
    element: content.querySelector("#stanza"),
    fraction: 0.5,
  });
});

test("an image is the anchor rather than its figure, and a caption or a div with bare text can be one", () => {
  const body = `<figure id="f"><img id="i" src="tall.png" alt=""/><figcaption id="c">A caption.</figcaption></figure><div id="d">Bare text.</div>`;
  let content = layout(body, {
    "tomeshelf-content": [-900, 2000],
    f: [-200, 600],
    i: [-200, 500],
    c: [310, 30],
    d: [350, 30],
  });
  expect(findAnchor(content)).toMatchObject({
    element: content.querySelector("#i"),
    fraction: 0.4,
  });

  content = layout(body, {
    "tomeshelf-content": [-900, 2000],
    f: [-500, 540],
    i: [-500, 480],
    c: [-10, 40],
    d: [50, 30],
  });
  expect(findAnchor(content)).toMatchObject({
    element: content.querySelector("#c"),
    fraction: 0.25,
  });

  content = layout(body, {
    "tomeshelf-content": [-900, 2000],
    f: [-600, 540],
    i: [-600, 480],
    c: [-110, 40],
    d: [-20, 40],
  });
  expect(findAnchor(content)).toMatchObject({
    element: content.querySelector("#d"),
    fraction: 0.5,
  });
});

test("with the top edge in a gap between blocks, the next block is the anchor at its start", () => {
  const content = layout(
    `<section id="s"><p id="a">One.</p><p id="b">Two.</p></section>`,
    {
      "tomeshelf-content": [-900, 2000],
      s: [-900, 1900],
      a: [-100, 90],
      b: [8, 90],
    },
  );
  expect(findAnchor(content)).toMatchObject({
    kind: "element",
    element: content.querySelector("#b"),
    fraction: 0,
  });
});

test("with the top edge below the last block, the article's bottom is the anchor", () => {
  const content = layout(`<section id="s"><p id="a">One.</p></section>`, {
    "tomeshelf-content": [-900, 940],
    s: [-900, 920],
    a: [-100, 90],
  });
  expect(findAnchor(content)).toEqual({ kind: "end", distance: 40 });
});
