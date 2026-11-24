// Reading position as a Readium Locator: capture from the visible area and
// resolve a stored Locator back to a target (ADR-0005).

import type { Layout } from "./settings";

export type LocatorText = {
  before?: string;
  highlight?: string;
  after?: string;
};

export type LocatorLocations = {
  progression: number;
  totalProgression?: number;
  cssSelector?: string;
  characterOffset?: number;
};

export type Locator = {
  href: string;
  locations: LocatorLocations;
  text?: LocatorText;
};

export type ResolvedPosition =
  | { kind: "character"; node: Text; offset: number }
  | { kind: "progression"; progression: number };

const highlightMax = 64;
const contextMax = 32;
const blockSelectorRe = /\[data-tomeshelf-block="(\d+)"\]/;
const exactBlockSelectorRe = /^\[data-tomeshelf-block="\d+"\]$/;

function* textNodes(root: Node): Generator<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    yield node as Text;
  }
}

function charBox(node: Text, offset: number): DOMRect {
  const range = document.createRange();
  if (node.data.length === 0) {
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  }
  const start = Math.min(offset, node.data.length - 1);
  range.setStart(node, start);
  range.setEnd(node, start + 1);
  return range.getBoundingClientRect();
}

function isVisibleInViewport(box: DOMRect): boolean {
  return box.bottom > 0 && box.top < window.innerHeight;
}

function isVisibleInSpread(box: DOMRect, article: DOMRect): boolean {
  return (
    box.right > article.left + 1 &&
    box.left < article.right - 1 &&
    box.bottom > article.top + 1 &&
    box.top < article.bottom - 1
  );
}

function innermostBlock(node: Node, root: Element): Element | null {
  let el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  while (el && el !== root) {
    if (el.hasAttribute("data-tomeshelf-block")) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function offsetWithin(root: Element, target: Text, offset: number): number {
  let n = 0;
  for (const node of textNodes(root)) {
    if (node === target) {
      return n + offset;
    }
    n += node.data.length;
  }
  return n + offset;
}

function atOffset(
  root: Element,
  offset: number,
): { node: Text; offset: number } | null {
  let n = 0;
  let last: Text | null = null;
  for (const node of textNodes(root)) {
    last = node;
    const next = n + node.data.length;
    if (offset < next) {
      return { node, offset: offset - n };
    }
    n = next;
  }
  if (last && offset === n && n > 0) {
    return { node: last, offset: last.data.length - 1 };
  }
  return null;
}

function firstVisibleCharacter(
  content: HTMLElement,
  layout: Layout,
): { node: Text; offset: number } | null {
  const articleBox = content.getBoundingClientRect();
  for (const node of textNodes(content)) {
    const text = node.data;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text.charAt(i))) {
        continue;
      }
      const box = charBox(node, i);
      if (box.width === 0 && box.height === 0) {
        continue;
      }
      const visible =
        layout === "pages"
          ? isVisibleInSpread(box, articleBox)
          : isVisibleInViewport(box);
      if (visible) {
        return { node, offset: i };
      }
    }
  }
  return null;
}

function quoteAround(
  content: HTMLElement,
  node: Text,
  offset: number,
): LocatorText {
  const text = content.textContent ?? "";
  const start = offsetWithin(content, node, offset);
  const highlight = text.slice(start, start + highlightMax);
  const before = text.slice(Math.max(0, start - contextMax), start);
  const after = text.slice(
    start + highlight.length,
    start + highlight.length + contextMax,
  );
  return { before, highlight, after };
}

function scrollProgressionAt(content: HTMLElement, scrollY: number): number {
  const rect = content.getBoundingClientRect();
  const absoluteTop = window.scrollY + rect.top;
  const past = scrollY - absoluteTop;
  const range = rect.height - window.innerHeight;
  if (range <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, past / range));
}

function pagesProgression(content: HTMLElement): number {
  const range = content.scrollWidth - content.clientWidth;
  if (range <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, content.scrollLeft / range));
}

// Progression within the document (ADR-0005). In the pages layout the caller
// must have extended the final spread first.
export function documentProgression(
  content: HTMLElement,
  layout: Layout,
): number {
  if (layout === "pages") {
    return pagesProgression(content);
  }
  return scrollProgressionAt(content, window.scrollY);
}

function scrollYForProgression(
  content: HTMLElement,
  progression: number,
): number {
  const rect = content.getBoundingClientRect();
  const absoluteTop = window.scrollY + rect.top;
  const range = rect.height - window.innerHeight;
  if (range <= 0) {
    return Math.max(0, absoluteTop);
  }
  const p = Math.min(1, Math.max(0, progression));
  return absoluteTop + p * range;
}

function blockNumber(el: Element | null): number | null {
  if (!el) {
    return null;
  }
  const n = el.getAttribute("data-tomeshelf-block");
  return n ? Number(n) : null;
}

// Parses the block number from a stored selector even when it matches nothing
// (ADR-0005 quote tie-break).
export function parseBlockNumber(selector: string | undefined): number | null {
  if (!selector) {
    return null;
  }
  const match = blockSelectorRe.exec(selector);
  return match ? Number(match[1]) : null;
}

function cssSelectorFor(block: Element): string {
  return `[data-tomeshelf-block="${block.getAttribute("data-tomeshelf-block")}"]`;
}

// pagesProgression, when given, is the controller's measure of the shown
// spread (1 when no line follows it, ADR-0005).
export function captureLocator(
  content: HTMLElement,
  href: string,
  layout: Layout,
  pagesProgression?: number,
): Locator {
  const progression =
    layout === "pages" && pagesProgression !== undefined
      ? pagesProgression
      : documentProgression(content, layout);
  const anchor = firstVisibleCharacter(content, layout);
  if (!anchor) {
    return { href, locations: { progression } };
  }
  const block = innermostBlock(anchor.node, content);
  const text = quoteAround(content, anchor.node, anchor.offset);
  const locations: LocatorLocations = { progression };
  if (block) {
    locations.cssSelector = cssSelectorFor(block);
    locations.characterOffset = offsetWithin(block, anchor.node, anchor.offset);
  }
  return { href, locations, text };
}

type Occurrence = {
  node: Text;
  offset: number;
  block: Element | null;
};

function findQuoteOccurrences(
  content: HTMLElement,
  text: LocatorText,
): Occurrence[] {
  const highlight = text.highlight;
  if (highlight === undefined || highlight === "") {
    return [];
  }
  const before = text.before ?? "";
  const after = text.after ?? "";
  const haystack = content.textContent ?? "";
  const needle = before + highlight + after;
  const found: Occurrence[] = [];
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (haystack.slice(i, i + needle.length) !== needle) {
      continue;
    }
    const start = i + before.length;
    const at = atOffset(content, start);
    if (!at) {
      continue;
    }
    found.push({
      node: at.node,
      offset: at.offset,
      block: innermostBlock(at.node, content),
    });
  }
  return found;
}

function progressionForOccurrence(
  content: HTMLElement,
  occ: Occurrence,
  layout: Layout,
): number {
  const box = charBox(occ.node, occ.offset);
  if (layout === "pages") {
    // The spread offset that holds the character, as a share of the range
    // (the final spread is already extended).
    const range = content.scrollWidth - content.clientWidth;
    if (range <= 0) {
      return 1;
    }
    const x =
      content.scrollLeft + box.left - content.getBoundingClientRect().left;
    return Math.min(1, Math.max(0, x / range));
  }
  const desired = window.scrollY + box.top;
  const maxScroll = Math.max(
    0,
    document.documentElement.scrollHeight - window.innerHeight,
  );
  const clamped = Math.min(Math.max(0, desired), maxScroll);
  return scrollProgressionAt(content, clamped);
}

function pickOccurrence(
  content: HTMLElement,
  occurrences: Occurrence[],
  locator: Locator,
  layout: Layout,
  pages?: PagesRestore,
): Occurrence | null {
  if (occurrences.length === 0) {
    return null;
  }
  const first = occurrences[0];
  if (occurrences.length === 1 && first) {
    return first;
  }
  // Prefer the number parsed from the selector, even when it matches nothing.
  const storedBlock = parseBlockNumber(locator.locations.cssSelector);
  const storedProgression = locator.locations.progression;

  const scored = occurrences.map((occ, index) => {
    const n = blockNumber(occ.block);
    const blockDist =
      storedBlock === null
        ? 0
        : n === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(n - storedBlock);
    // In the pages layout, where restoring it would scroll: its line made
    // the spread start, since the marker can push it into the next column.
    const prog =
      layout === "pages" && pages
        ? pages.progressionOf(occ.node, occ.offset)
        : progressionForOccurrence(content, occ, layout);
    const progDist = Math.abs(prog - storedProgression);
    return { occ, blockDist, progDist, index };
  });

  scored.sort((a, b) => {
    if (storedBlock !== null && a.blockDist !== b.blockDist) {
      return a.blockDist - b.blockDist;
    }
    if (a.progDist !== b.progDist) {
      return a.progDist - b.progDist;
    }
    return a.index - b.index;
  });
  return scored[0]?.occ ?? null;
}

function resolveQuote(
  content: HTMLElement,
  locator: Locator,
  layout: Layout,
  pages?: PagesRestore,
): ResolvedPosition | null {
  if (!locator.text?.highlight) {
    return null;
  }
  const picked = pickOccurrence(
    content,
    findQuoteOccurrences(content, locator.text),
    locator,
    layout,
    pages,
  );
  if (!picked) {
    return null;
  }
  return { kind: "character", node: picked.node, offset: picked.offset };
}

function resolveBlock(
  content: HTMLElement,
  locator: Locator,
): ResolvedPosition | null {
  const { cssSelector, characterOffset } = locator.locations;
  if (cssSelector === undefined || characterOffset === undefined) {
    return null;
  }
  // Scoped to #tomeshelf-content: content is that article.
  // Parse the number and query it ourselves: a stored selector is arbitrary
  // text, and anything but a block selector counts as a missing block.
  const n = exactBlockSelectorRe.test(cssSelector)
    ? parseBlockNumber(cssSelector)
    : null;
  const el =
    n === null ? null : content.querySelector(`[data-tomeshelf-block="${n}"]`);
  if (!el) {
    return null;
  }
  const at = atOffset(el, characterOffset);
  if (!at) {
    return null;
  }
  return { kind: "character", node: at.node, offset: at.offset };
}

export function resolveLocator(
  content: HTMLElement,
  locator: Locator,
  layout: Layout = "scroll",
  pages?: PagesRestore,
): ResolvedPosition | null {
  if (layout === "pages") {
    // Measure occurrences against the extended final spread.
    pages?.prepareProgression();
  }
  return (
    resolveQuote(content, locator, layout, pages) ??
    resolveBlock(content, locator) ??
    (locator.locations.progression !== undefined
      ? {
          kind: "progression" as const,
          progression: locator.locations.progression,
        }
      : null)
  );
}

export type PagesRestore = {
  // The shown spread's progression; 1 when no line follows it.
  progression: () => number;
  // Extends the final spread so progression measures are stable (ADR-0005).
  prepareProgression: () => void;
  // The progression restoring the character would give (ADR-0005 Quote).
  progressionOf: (node: Text, offset: number) => number;
  // Shows the spread holding the character.
  showCharacter: (node: Text, offset: number) => void;
  showProgression: (progression: number) => void;
};

// Scrolls so the resolved character sits at the top of the viewport (scroll)
// or on the visible spread (pages). The browser clamps the offset.
export function applyResolvedPosition(
  content: HTMLElement,
  resolved: ResolvedPosition,
  layout: Layout,
  pages?: PagesRestore,
): void {
  if (layout === "pages" && pages) {
    if (resolved.kind === "character") {
      pages.showCharacter(resolved.node, resolved.offset);
    } else {
      pages.showProgression(resolved.progression);
    }
    return;
  }
  if (resolved.kind === "character") {
    const box = charBox(resolved.node, resolved.offset);
    window.scrollTo({
      top: window.scrollY + box.top,
      behavior: "instant",
    });
    return;
  }
  window.scrollTo({
    top: scrollYForProgression(content, resolved.progression),
    behavior: "instant",
  });
}

export function restoreLocator(
  content: HTMLElement,
  locator: Locator,
  layout: Layout,
  pages?: PagesRestore,
): ResolvedPosition | null {
  const resolved = resolveLocator(content, locator, layout, pages);
  if (resolved) {
    applyResolvedPosition(content, resolved, layout, pages);
  }
  return resolved;
}
