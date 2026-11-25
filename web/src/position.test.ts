import { afterEach, expect, test, vi } from "vitest";
import { renderDocument } from "./navigator";
import {
  captureLocator,
  documentProgression,
  type Locator,
  resolveClicked,
  resolveLocator,
} from "./position";

const place = {
  bookId: "7",
  readingOrder: [{ href: "OEBPS/text/one.xhtml" }],
  n: 1,
};

// Renders a document as the reader does.
function article(body: string): HTMLElement {
  const content = document.createElement("article");
  content.id = "tomeshelf-content";
  document.body.append(content);
  renderDocument(
    content,
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`,
    place,
  );
  return content;
}

const rangeProto = Range.prototype as {
  getBoundingClientRect?: () => DOMRect;
};
let previousRangeBox: (() => DOMRect) | undefined;

afterEach(() => {
  document.body.replaceChildren();
  rangeProto.getBoundingClientRect = previousRangeBox;
  previousRangeBox = undefined;
  vi.restoreAllMocks();
});

// Gives each named element a viewport box [top, height]. Characters inherit
// their parent's top unless charTops names per-character tops by parent id.
function layout(
  content: HTMLElement,
  boxes: Record<string, [number, number]>,
  charTops: Record<string, number[]> = {},
) {
  for (const el of [content, ...content.querySelectorAll("*")]) {
    const [top, height] = boxes[el.id] ?? [0, 0];
    el.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: top, width: 300, height });
  }
  previousRangeBox = rangeProto.getBoundingClientRect;
  rangeProto.getBoundingClientRect = function (this: Range) {
    const node = this.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    }
    const parent = node.parentElement;
    if (!parent) {
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    }
    const id = parent.id;
    const [top, height] = boxes[id] ?? [0, 0];
    const tops = charTops[id];
    const y = tops?.[this.startOffset] ?? top;
    const h = tops ? 20 : Math.max(height, 20);
    return DOMRect.fromRect({ x: 0, y, width: 10, height: h });
  };
}

function block(content: HTMLElement, n: number): Element {
  const el = content.querySelector(`[data-tomeshelf-block="${n}"]`);
  if (!el) {
    throw new Error(`no block ${n}`);
  }
  return el;
}

function offsetInBlock(el: Element, target: { node: Text; offset: number }) {
  let n = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text === target.node) {
      return n + target.offset;
    }
    n += text.data.length;
  }
  throw new Error("target not in block");
}

test("character offsets count UTF-16 units across nested markup", () => {
  const content = article(`<p id="p">ab<span id="s">c&#x1F4A1;</span>d</p>`);
  Object.defineProperty(window, "innerHeight", {
    value: 800,
    configurable: true,
  });
  layout(content, {
    "tomeshelf-content": [0, 400],
    p: [-10, 40],
    s: [-10, 40],
  });
  const span = content.querySelector("#s") as HTMLElement;
  const text = span.firstChild as Text;
  expect(text.data.length).toBe(3); // c + surrogate pair
  rangeProto.getBoundingClientRect = function (this: Range) {
    if (this.startContainer === text && this.startOffset === 1) {
      return DOMRect.fromRect({ x: 0, y: 5, width: 10, height: 20 });
    }
    return DOMRect.fromRect({ x: 0, y: -40, width: 10, height: 20 });
  };
  const captured = captureLocator(
    content,
    place.readingOrder[0].href,
    "scroll",
  );
  expect(captured.locations.cssSelector).toBe('[data-tomeshelf-block="1"]');
  expect(captured.locations.characterOffset).toBe(3);
  expect(captured.text?.highlight?.startsWith("\uD83D\uDCA1")).toBe(true);

  const resolved = resolveLocator(content, {
    href: place.readingOrder[0].href,
    locations: {
      progression: 0,
      cssSelector: '[data-tomeshelf-block="1"]',
      characterOffset: 3,
    },
  });
  expect(resolved?.kind).toBe("character");
  if (resolved?.kind === "character") {
    expect(resolved.node).toBe(text);
    expect(resolved.offset).toBe(1);
  }
});

test("a repeated quote picks the occurrence nearest the stored block", () => {
  const content = article(
    `<p id="a">Hello world again.</p><p id="b">Hello world again.</p><p id="c">Hello world again.</p>`,
  );
  layout(content, {
    "tomeshelf-content": [0, 900],
    a: [0, 100],
    b: [100, 100],
    c: [200, 100],
  });
  const locator: Locator = {
    href: place.readingOrder[0].href,
    locations: {
      progression: 0.5,
      cssSelector: '[data-tomeshelf-block="2"]',
      characterOffset: 0,
    },
    text: { before: "", highlight: "Hello world", after: " again." },
  };
  const resolved = resolveLocator(content, locator);
  expect(resolved?.kind).toBe("character");
  if (resolved?.kind === "character") {
    expect(resolved.node.parentElement).toBe(block(content, 2));
  }
});

test("a repeated quote with no stored block picks the occurrence nearest the stored progression", () => {
  const content = article(
    `<p id="a">Same phrase here.</p><p id="b">Same phrase here.</p><p id="c">Same phrase here.</p>`,
  );
  Object.defineProperty(window, "innerHeight", {
    value: 200,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    value: 600,
    configurable: true,
  });
  layout(content, {
    "tomeshelf-content": [0, 600],
    a: [0, 200],
    b: [200, 200],
    c: [400, 200],
  });
  vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
  const locator: Locator = {
    href: place.readingOrder[0].href,
    locations: { progression: 0.5 },
    text: { before: "", highlight: "Same phrase", after: " here." },
  };
  const resolved = resolveLocator(content, locator);
  expect(resolved?.kind).toBe("character");
  if (resolved?.kind === "character") {
    expect(resolved.node.parentElement).toBe(block(content, 2));
  }
});

test("two occurrences equally near the stored block are decided by progression", () => {
  const content = article(
    `<p id="a">Tie phrase xx.</p><p id="mid">Middle.</p><p id="c">Tie phrase xx.</p>`,
  );
  Object.defineProperty(window, "innerHeight", {
    value: 200,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    value: 600,
    configurable: true,
  });
  layout(content, {
    "tomeshelf-content": [0, 600],
    a: [0, 200],
    mid: [200, 200],
    c: [400, 200],
  });
  vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
  const locator: Locator = {
    href: place.readingOrder[0].href,
    locations: {
      progression: 1,
      cssSelector: '[data-tomeshelf-block="2"]',
      characterOffset: 0,
    },
    text: { before: "", highlight: "Tie phrase", after: " xx." },
  };
  const resolved = resolveLocator(content, locator);
  expect(resolved?.kind).toBe("character");
  if (resolved?.kind === "character") {
    expect(resolved.node.parentElement).toBe(block(content, 3));
  }
});

test("occurrences tied on block and progression pick the first in document order", () => {
  const content = article(`<p id="a">Exact same.</p><p id="b">Exact same.</p>`);
  Object.defineProperty(window, "innerHeight", {
    value: 500,
    configurable: true,
  });
  layout(content, {
    "tomeshelf-content": [0, 100],
    a: [0, 40],
    b: [40, 40],
  });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    value: 100,
    configurable: true,
  });
  vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
  const locator: Locator = {
    href: place.readingOrder[0].href,
    locations: { progression: 0 },
    text: { before: "", highlight: "Exact same", after: "." },
  };
  const resolved = resolveLocator(content, locator);
  expect(resolved?.kind).toBe("character");
  if (resolved?.kind === "character") {
    expect(resolved.node.parentElement).toBe(block(content, 1));
  }
});

test("a selector that matches nothing still yields its block number for quote tie-break", () => {
  const content = article(
    `<p id="a">Hello world again.</p><p id="b">Hello world again.</p><p id="c">Hello world again.</p>`,
  );
  Object.defineProperty(window, "innerHeight", {
    value: 200,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    value: 600,
    configurable: true,
  });
  layout(content, {
    "tomeshelf-content": [0, 600],
    a: [0, 200],
    b: [200, 200],
    c: [400, 200],
  });
  vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
  // Selector matches nothing (extra attribute), but its block number 3 still
  // prefers the last occurrence over progression alone (0 → first).
  const locator: Locator = {
    href: place.readingOrder[0].href,
    locations: {
      progression: 0,
      cssSelector: '[data-tomeshelf-block="3"][data-missing]',
      characterOffset: 0,
    },
    text: { before: "", highlight: "Hello world", after: " again." },
  };
  const selector = locator.locations.cssSelector;
  expect(selector).toBeDefined();
  expect(content.querySelector(selector ?? "")).toBeNull();
  const resolved = resolveLocator(content, locator);
  expect(resolved?.kind).toBe("character");
  if (resolved?.kind === "character") {
    expect(resolved.node.parentElement?.id).toBe("c");
  }
});

test("when the quote is missing, the block and offset resolve", () => {
  const content = article(
    `<p id="a">First paragraph.</p><p id="b">Second <em id="e">paragraph</em> here.</p>`,
  );
  layout(content, {
    "tomeshelf-content": [0, 400],
    a: [0, 40],
    b: [40, 40],
    e: [40, 40],
  });
  const resolved = resolveLocator(content, {
    href: place.readingOrder[0].href,
    locations: {
      progression: 0.9,
      cssSelector: '[data-tomeshelf-block="2"]',
      characterOffset: 7,
    },
  });
  expect(resolved?.kind).toBe("character");
  if (resolved?.kind === "character") {
    expect(offsetInBlock(block(content, 2), resolved)).toBe(7);
    expect(resolved.node.parentElement?.id).toBe("e");
  }
});

test("when quote and block are missing, progression resolves", () => {
  const content = article(`<p id="a">Only progression.</p>`);
  layout(content, {
    "tomeshelf-content": [0, 1000],
    a: [0, 40],
  });
  const resolved = resolveLocator(content, {
    href: place.readingOrder[0].href,
    locations: { progression: 0.4 },
  });
  expect(resolved).toEqual({ kind: "progression", progression: 0.4 });
});

test("when the selector matches nothing, block resolve is skipped", () => {
  const content = article(`<p id="a">Only progression.</p>`);
  layout(content, {
    "tomeshelf-content": [0, 1000],
    a: [0, 40],
  });
  const resolved = resolveLocator(content, {
    href: place.readingOrder[0].href,
    locations: {
      progression: 0.4,
      cssSelector: '[data-tomeshelf-block="99"]',
      characterOffset: 0,
    },
  });
  expect(resolved).toEqual({ kind: "progression", progression: 0.4 });
});

test("capture uses the innermost numbered block for a nested paragraph", () => {
  const content = article(
    `<ul><li id="li">Lead <p id="p">Inner paragraph text.</p></li></ul>`,
  );
  Object.defineProperty(window, "innerHeight", {
    value: 800,
    configurable: true,
  });
  const pText = () => content.querySelector("#p")?.firstChild as Text;
  layout(content, {
    "tomeshelf-content": [-50, 500],
    li: [-50, 200],
    p: [10, 40],
  });
  rangeProto.getBoundingClientRect = function (this: Range) {
    if (this.startContainer === pText() && this.startOffset === 0) {
      return DOMRect.fromRect({ x: 0, y: 10, width: 10, height: 20 });
    }
    return DOMRect.fromRect({ x: 0, y: -80, width: 10, height: 20 });
  };
  const captured = captureLocator(
    content,
    place.readingOrder[0].href,
    "scroll",
  );
  expect(captured.locations.cssSelector).toBe('[data-tomeshelf-block="2"]');
  expect(captured.locations.characterOffset).toBe(0);
  expect(captured.text?.highlight?.startsWith("Inner")).toBe(true);
});

test("text outside any numbered block stores no block", () => {
  const content = article(
    `<div id="d">Loose div text here.</div><p id="p">A paragraph.</p>`,
  );
  Object.defineProperty(window, "innerHeight", {
    value: 800,
    configurable: true,
  });
  const divText = () => content.querySelector("#d")?.firstChild as Text;
  layout(content, {
    "tomeshelf-content": [0, 400],
    d: [0, 40],
    p: [40, 40],
  });
  rangeProto.getBoundingClientRect = function (this: Range) {
    if (this.startContainer === divText()) {
      return DOMRect.fromRect({ x: 0, y: 5, width: 10, height: 20 });
    }
    return DOMRect.fromRect({ x: 0, y: 100, width: 10, height: 20 });
  };
  const captured = captureLocator(
    content,
    place.readingOrder[0].href,
    "scroll",
  );
  expect(captured.locations.cssSelector).toBeUndefined();
  expect(captured.locations.characterOffset).toBeUndefined();
  expect(captured.text?.highlight?.startsWith("Loose")).toBe(true);
});

test("a viewport with no visible text stores progressions alone", () => {
  const content = article(
    `<p id="p">Hidden.</p><img id="i" src="tall.png" alt=""/>`,
  );
  Object.defineProperty(window, "innerHeight", {
    value: 400,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    value: 2000,
    configurable: true,
  });
  vi.spyOn(window, "scrollY", "get").mockReturnValue(500);
  layout(content, {
    "tomeshelf-content": [-500, 2000],
    p: [-500, 40],
    i: [0, 400],
  });
  rangeProto.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 0, y: -500, width: 10, height: 20 });
  const progression = documentProgression(content, "scroll");
  const captured = captureLocator(
    content,
    place.readingOrder[0].href,
    "scroll",
  );
  expect(captured.locations.cssSelector).toBeUndefined();
  expect(captured.text).toBeUndefined();
  expect(captured.locations.progression).toBe(progression);
});

test("pages capture anchors on the first visible character in the spread", () => {
  const content = article(
    `<p id="a">Left page text.</p><p id="b">Right page text.</p>`,
  );
  Object.defineProperty(content, "scrollWidth", {
    value: 1200,
    configurable: true,
  });
  Object.defineProperty(content, "clientWidth", {
    value: 600,
    configurable: true,
  });
  Object.defineProperty(content, "scrollLeft", {
    value: 0,
    configurable: true,
    writable: true,
  });
  content.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 400 });
  const aText = () => content.querySelector("#a")?.firstChild as Text;
  const bText = () => content.querySelector("#b")?.firstChild as Text;
  rangeProto.getBoundingClientRect = function (this: Range) {
    if (this.startContainer === aText()) {
      // Off the left of the visible spread.
      return DOMRect.fromRect({ x: -200, y: 10, width: 10, height: 20 });
    }
    if (this.startContainer === bText() && this.startOffset === 0) {
      return DOMRect.fromRect({ x: 50, y: 10, width: 10, height: 20 });
    }
    return DOMRect.fromRect({ x: 700, y: 10, width: 10, height: 20 });
  };
  const captured = captureLocator(content, place.readingOrder[0].href, "pages");
  expect(captured.locations.cssSelector).toBe('[data-tomeshelf-block="2"]');
  expect(captured.text?.highlight?.startsWith("Right")).toBe(true);
  expect(captured.locations.progression).toBe(0);
});

test("an invalid or non-block selector counts as a missing block", () => {
  const content = article(`<p id="a">Only progression.</p>`);
  layout(content, { "tomeshelf-content": [0, 1000], a: [0, 40] });
  for (const cssSelector of ["p[[", "p", "*", 'p [data-tomeshelf-block="1"]']) {
    const resolved = resolveLocator(content, {
      href: place.readingOrder[0].href,
      locations: { progression: 0.4, cssSelector, characterOffset: 0 },
    });
    expect(resolved).toEqual({ kind: "progression", progression: 0.4 });
  }
});

test("in the pages layout a repeated quote is tied by where restoring it would scroll", () => {
  const content = article(`<p id="a">Echo line.</p><p id="b">Echo line.</p>`);
  const prepareProgression = vi.fn();
  // Without a marker both sit near 0.5; showing each one gives 0.5 for a
  // and 0.9 for b.
  const progressionOf = (node: Text) =>
    node.parentElement?.id === "b" ? 0.9 : 0.5;
  const resolved = resolveLocator(
    content,
    {
      href: place.readingOrder[0].href,
      locations: { progression: 0.9 },
      text: { before: "", highlight: "Echo line.", after: "" },
    },
    "pages",
    {
      clicked: () => null,
      applyClicked: vi.fn(),
      progression: () => 0,
      progressionOf,
      prepareProgression,
      showCharacter: vi.fn(),
      showProgression: vi.fn(),
    },
  );
  expect(prepareProgression).toHaveBeenCalled();
  expect(resolved?.kind).toBe("character");
  if (resolved?.kind === "character") {
    expect(resolved.node.parentElement?.id).toBe("b");
  }
});

function pointAt(content: HTMLElement, id: string, offset: number) {
  const node = content.querySelector(`#${id}`)?.firstChild as Text;
  return { node, offset };
}

test("a clicked character is stored with its block pair and its quote", () => {
  const content = article(
    `<p id="a">First line.</p><p id="b">Second line.</p>`,
  );
  layout(content, { "tomeshelf-content": [0, 400], a: [0, 40], b: [40, 40] });
  const point = pointAt(content, "b", 7);
  const locator = captureLocator(
    content,
    place.readingOrder[0].href,
    "scroll",
    undefined,
    point,
  );
  expect(locator.clicked).toEqual({
    cssSelector: '[data-tomeshelf-block="2"]',
    characterOffset: 7,
    text: { before: "First line.Second ", highlight: "line.", after: "" },
  });
  const without = captureLocator(content, place.readingOrder[0].href, "scroll");
  expect(without.clicked).toBeUndefined();
});

test("a clicked character resolves by its quote, then by its block", () => {
  const content = article(`<p id="a">One two.</p><p id="b">Three four.</p>`);
  const href = place.readingOrder[0].href;
  const byQuote = resolveClicked(content, {
    href,
    locations: { progression: 0 },
    clicked: {
      cssSelector: '[data-tomeshelf-block="1"]',
      characterOffset: 0,
      text: { before: "One two.", highlight: "Three four.", after: "" },
    },
  });
  expect(byQuote?.node.parentElement?.id).toBe("b");
  expect(byQuote?.offset).toBe(0);

  const byBlock = resolveClicked(content, {
    href,
    locations: { progression: 0 },
    clicked: {
      cssSelector: '[data-tomeshelf-block="2"]',
      characterOffset: 6,
      text: { highlight: "gone from the book" },
    },
  });
  expect(byBlock?.node.parentElement?.id).toBe("b");
  expect(byBlock?.offset).toBe(6);

  expect(
    resolveClicked(content, {
      href,
      locations: { progression: 0 },
      clicked: { text: { highlight: "nowhere" } },
    }),
  ).toBeNull();
  expect(
    resolveClicked(content, { href, locations: { progression: 0 } }),
  ).toBeNull();
});

test("a repeated clicked quote goes to the nearer block, then to the spread start", () => {
  const content = article(
    `<p id="a">x</p><p id="b">same</p><p id="c">y</p><p id="d">same</p>`,
  );
  const href = place.readingOrder[0].href;
  const clicked = (n: number) => ({
    cssSelector: `[data-tomeshelf-block="${n}"]`,
    characterOffset: 0,
    text: { highlight: "same" },
  });
  const near = (n: number, from?: number) =>
    resolveClicked(
      content,
      { href, locations: { progression: 0 }, clicked: clicked(n) },
      from,
    )?.node.parentElement?.id;
  expect(near(4)).toBe("d");
  expect(near(2)).toBe("b");
  // Block 3 is as near to b as to d: the first at or after the spread start.
  expect(near(3, 0)).toBe("b");
  expect(near(3, 2)).toBe("d");
  // Past the last occurrence: document order.
  expect(near(3, 99)).toBe("b");
});
