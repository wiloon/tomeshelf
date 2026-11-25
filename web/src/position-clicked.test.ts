// The clicked character of a pages-layout Locator (ADR-0005 Clicked
// character): how it is captured and how it resolves. Where it is shown is
// covered by Playwright.

import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import { renderDocument } from "./navigator";
import {
  applyLocator,
  captureLocator,
  type Locator,
  type PagesRestore,
  resolveClicked,
} from "./position";

const href = "OEBPS/text/one.xhtml";

function article(body: string): HTMLElement {
  const content = document.createElement("article");
  content.id = "tomeshelf-content";
  document.body.append(content);
  renderDocument(
    content,
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`,
    { bookId: "7", readingOrder: [{ href }], n: 1 },
  );
  return content;
}

// jsdom has no layout: every character box is empty, so the anchor part of a
// capture finds no visible character and this file checks clicked alone.
const rangeProto = Range.prototype as { getBoundingClientRect?: () => DOMRect };
let previousRangeBox: (() => DOMRect) | undefined;

beforeEach(() => {
  previousRangeBox = rangeProto.getBoundingClientRect;
  rangeProto.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
});

afterEach(() => {
  document.body.replaceChildren();
  rangeProto.getBoundingClientRect = previousRangeBox;
});

function textOf(content: HTMLElement, id: string): Text {
  const node = content.querySelector(`#${id}`)?.firstChild;
  if (!(node instanceof Text)) {
    throw new Error(`no text in #${id}`);
  }
  return node;
}

function locatorWith(clicked: Locator["clicked"]): Locator {
  return { href, locations: { progression: 0 }, clicked };
}

test("capture describes the clicked character by block, offset and quote", () => {
  const content = article(
    `<p id="a">First paragraph.</p><p id="b">The old man sat by the sea.</p>`,
  );
  const node = textOf(content, "b");
  const offset = node.data.indexOf("man");

  const captured = captureLocator(content, href, "pages", 0, {
    node,
    offset,
  });

  expect(captured.clicked).toEqual({
    cssSelector: '[data-tomeshelf-block="2"]',
    characterOffset: offset,
    text: {
      before: "First paragraph.The old ",
      highlight: "man sat by the sea.",
      after: "",
    },
  });
});

test("a clicked character outside any numbered block has only its quote", () => {
  const content = article(`<div id="d">Loose words in a div.</div>`);
  const node = textOf(content, "d");

  const captured = captureLocator(content, href, "pages", 0, {
    node,
    offset: node.data.indexOf("words"),
  });

  expect(captured.clicked).toEqual({
    text: { before: "Loose ", highlight: "words in a div.", after: "" },
  });
});

test("capture without a clicked character stores none", () => {
  const content = article(`<p id="a">Text.</p>`);
  expect(captureLocator(content, href, "pages", 0).clicked).toBeUndefined();
  expect(
    captureLocator(content, href, "pages", 0, null).clicked,
  ).toBeUndefined();
});

test("the clicked character resolves by its quote", () => {
  const content = article(
    `<p id="a">Alpha beta gamma.</p><p id="b">Delta epsilon zeta.</p>`,
  );
  const resolved = resolveClicked(
    content,
    locatorWith({
      // A wrong block: the quote wins.
      cssSelector: '[data-tomeshelf-block="1"]',
      characterOffset: 0,
      text: { before: "Delta ", highlight: "epsilon", after: " zeta." },
    }),
    null,
  );
  expect(resolved?.node).toBe(textOf(content, "b"));
  expect(resolved?.offset).toBe("Delta ".length);
});

test("without a quote that resolves, the clicked character resolves by block and offset", () => {
  const content = article(
    `<p id="a">Alpha beta gamma.</p><p id="b">Delta epsilon zeta.</p>`,
  );
  const resolved = resolveClicked(
    content,
    locatorWith({
      cssSelector: '[data-tomeshelf-block="2"]',
      characterOffset: 6,
      text: { highlight: "text that the book no longer has" },
    }),
    null,
  );
  expect(resolved?.node).toBe(textOf(content, "b"));
  expect(resolved?.offset).toBe(6);
});

test("a clicked character that does not resolve is dropped", () => {
  const content = article(`<p id="a">Alpha beta gamma.</p>`);
  expect(
    resolveClicked(
      content,
      locatorWith({
        cssSelector: '[data-tomeshelf-block="99"]',
        characterOffset: 0,
        text: { highlight: "missing" },
      }),
      null,
    ),
  ).toBeNull();
  expect(resolveClicked(content, locatorWith(undefined), null)).toBeNull();
});

const refrain = `<p id="a">Sing the refrain.</p><p id="b">Sing the refrain.</p><p id="c">Sing the refrain.</p><p id="d">Sing the refrain.</p>`;
const refrainQuote = { highlight: "Sing the refrain." };

test("a repeated clicked quote picks the occurrence nearest its stored block", () => {
  const content = article(refrain);
  const resolved = resolveClicked(
    content,
    locatorWith({
      cssSelector: '[data-tomeshelf-block="3"]',
      characterOffset: 0,
      text: refrainQuote,
    }),
    // The restored spread start is earlier, but block distance comes first.
    0,
  );
  expect(resolved?.node).toBe(textOf(content, "c"));
});

test("a repeated clicked quote with no block picks the first occurrence at or after the restored spread start", () => {
  const content = article(refrain);
  const resolved = resolveClicked(
    content,
    locatorWith({ text: refrainQuote }),
    // Three characters into b.
    "Sing the refrain.".length + 3,
  );
  expect(resolved?.node).toBe(textOf(content, "c"));
});

test("a repeated clicked quote with nothing after the spread start picks the first in document order", () => {
  const content = article(`${refrain}<p id="e">The end.</p>`);
  const afterAll = resolveClicked(
    content,
    locatorWith({ text: refrainQuote }),
    (content.textContent ?? "").indexOf("The end."),
  );
  expect(afterAll?.node).toBe(textOf(content, "a"));

  const noStart = resolveClicked(
    content,
    locatorWith({ text: refrainQuote }),
    null,
  );
  expect(noStart?.node).toBe(textOf(content, "a"));
});

// A PagesRestore whose spread start, as an article-text offset, is given.
function pagesAt(spreadStartKey: number): PagesRestore & {
  applyClicked: Mock<(node: Text, offset: number) => void>;
} {
  return {
    progression: () => 0,
    prepareProgression: () => {},
    progressionOf: () => 0,
    showCharacter: () => {},
    showProgression: () => {},
    clicked: () => null,
    applyClicked: vi.fn<(node: Text, offset: number) => void>(),
    spreadStartKey: () => spreadStartKey,
  };
}

test("on restore, a repeated clicked quote is matched against the spread start the reader shows, not the restored anchor", () => {
  // The spread starts at x's first character; the stored anchor, "Then
  // more", lies after the refrain on the same line.
  const content = article(
    `<p id="w">Sing the refrain.</p><p id="x">Sing the refrain. Then more.</p><p id="y">Sing the refrain.</p>`,
  );
  const xStart = (content.textContent ?? "").indexOf("Sing the refrain. Then");
  const pages = pagesAt(xStart);
  applyLocator(
    content,
    {
      href,
      locations: { progression: 0.5 },
      text: { before: "refrain. ", highlight: "Then more.", after: "" },
      clicked: { text: refrainQuote },
    },
    "pages",
    pages,
  );
  expect(pages.applyClicked).toHaveBeenCalledTimes(1);
  // The same node, not just an equal one: every refrain reads alike.
  const [node, offset] = pages.applyClicked.mock.calls[0];
  expect(node).toBe(textOf(content, "x"));
  expect(offset).toBe(0);
});

test("on a restore by progression, a repeated clicked quote still picks the first occurrence at or after the spread start", () => {
  const content = article(refrain);
  const cStart = 2 * "Sing the refrain.".length;
  const pages = pagesAt(cStart);
  applyLocator(
    content,
    {
      href,
      locations: { progression: 0.6 },
      clicked: { text: refrainQuote },
    },
    "pages",
    pages,
  );
  expect(pages.applyClicked).toHaveBeenCalledTimes(1);
  // The same node, not just an equal one: every refrain reads alike.
  const [node, offset] = pages.applyClicked.mock.calls[0];
  expect(node).toBe(textOf(content, "c"));
  expect(offset).toBe(0);
});
