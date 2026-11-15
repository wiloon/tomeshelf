// Reading position as a Readium Locator: capture from the viewport and
// resolve a stored Locator back to a scroll target (ADR-0005).

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

function isVisible(box: DOMRect, viewportHeight: number): boolean {
  return box.bottom > 0 && box.top < viewportHeight;
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

function articleOffset(
  content: HTMLElement,
  target: Text,
  offset: number,
): number {
  return offsetWithin(content, target, offset);
}

function firstVisibleCharacter(
  content: HTMLElement,
): { node: Text; offset: number } | null {
  const vh = window.innerHeight;
  for (const node of textNodes(content)) {
    const text = node.data;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      if (ch === "" || /\s/.test(ch)) {
        continue;
      }
      const box = charBox(node, i);
      if (box.width === 0 && box.height === 0) {
        continue;
      }
      if (isVisible(box, vh)) {
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
  const start = articleOffset(content, node, offset);
  const highlight = text.slice(start, start + highlightMax);
  const before = text.slice(Math.max(0, start - contextMax), start);
  const after = text.slice(
    start + highlight.length,
    start + highlight.length + contextMax,
  );
  return { before, highlight, after };
}

// Progression within the document (ADR-0005): scroll past the article's top
// over the scrollable height, or 1 when the article fits in the viewport.
export function documentProgression(content: HTMLElement): number {
  return progressionAtScroll(content, window.scrollY);
}

function progressionAtScroll(content: HTMLElement, scrollY: number): number {
  const rect = content.getBoundingClientRect();
  const absoluteTop = window.scrollY + rect.top;
  const past = scrollY - absoluteTop;
  const range = rect.height - window.innerHeight;
  if (range <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, past / range));
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

function cssSelectorFor(block: Element): string {
  return `[data-tomeshelf-block="${block.getAttribute("data-tomeshelf-block")}"]`;
}

export function captureLocator(content: HTMLElement, href: string): Locator {
  const progression = documentProgression(content);
  const anchor = firstVisibleCharacter(content);
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
): number {
  const box = charBox(occ.node, occ.offset);
  const desired = window.scrollY + box.top;
  const maxScroll = Math.max(
    0,
    document.documentElement.scrollHeight - window.innerHeight,
  );
  const clamped = Math.min(Math.max(0, desired), maxScroll);
  return progressionAtScroll(content, clamped);
}

function pickOccurrence(
  content: HTMLElement,
  occurrences: Occurrence[],
  locator: Locator,
): Occurrence | null {
  if (occurrences.length === 0) {
    return null;
  }
  const first = occurrences[0];
  if (occurrences.length === 1 && first) {
    return first;
  }
  const storedBlock = locator.locations.cssSelector
    ? blockNumber(content.querySelector(locator.locations.cssSelector))
    : null;
  const storedProgression = locator.locations.progression;

  const scored = occurrences.map((occ, index) => {
    const n = blockNumber(occ.block);
    const blockDist =
      storedBlock === null
        ? 0
        : n === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(n - storedBlock);
    const prog = progressionForOccurrence(content, occ);
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
): ResolvedPosition | null {
  if (!locator.text?.highlight) {
    return null;
  }
  const picked = pickOccurrence(
    content,
    findQuoteOccurrences(content, locator.text),
    locator,
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
  const el = content.querySelector(cssSelector);
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
): ResolvedPosition | null {
  return (
    resolveQuote(content, locator) ??
    resolveBlock(content, locator) ??
    (locator.locations.progression !== undefined
      ? {
          kind: "progression" as const,
          progression: locator.locations.progression,
        }
      : null)
  );
}

// Scrolls so the resolved character sits at the top of the viewport, or to
// the progression when there is no character. The browser clamps the offset.
export function applyResolvedPosition(
  content: HTMLElement,
  resolved: ResolvedPosition,
): void {
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
): ResolvedPosition | null {
  const resolved = resolveLocator(content, locator);
  if (resolved) {
    applyResolvedPosition(content, resolved);
  }
  return resolved;
}
