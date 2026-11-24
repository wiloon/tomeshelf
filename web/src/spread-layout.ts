// The DOM side of spread starts (ADR-0010): measures the article's lines,
// places the one marker that begins a column at the spread start, and
// scrolls the article to that column. Covered by Playwright only: jsdom has
// no layout.

import type { LineSpan } from "./spread-start";

export const markerAttribute = "data-tomeshelf-page-start";

// A spread start: the first character of a line as an offset into the
// article's textContent, which the marker never changes. A block with no
// text of its own to start at (a picture, a nested scroll area) is held by
// element, with key just before its first character.
export type SpreadStart = { key: number; el?: Element };

// A measured line: its character span, its column and, for a block that
// cannot split, the block.
// top is its distance below the article's top edge.
export type Line = LineSpan & { col: number; top: number; el?: Element };

const monolithicSelector = "img, svg, video, hr, table, pre";

// Blocks a column never splits: pictures and other replaced content, and
// nested scroll areas (CSS Fragmentation: scroll containers are monolithic).
function isMonolithic(el: Element): boolean {
  switch (el.tagName) {
    case "IMG":
    case "SVG":
    case "svg":
    case "VIDEO":
    case "HR":
    case "TABLE":
    case "PRE":
      return true;
    default:
      return false;
  }
}

const isSpace = (c: string) =>
  c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";

function isBlockLevel(el: Element): boolean {
  const display = getComputedStyle(el).display;
  return !display.startsWith("inline") && display !== "contents";
}

export type SpreadLayout = ReturnType<typeof createSpreadLayout>;

export function createSpreadLayout(
  article: HTMLElement,
  geometry: () => { colStep: number; pagesPerSpread: number },
) {
  let marker: HTMLElement | null = null;
  // The text node split for the marker, merged again when it moves.
  let split: { head: Text; tail: Text } | null = null;
  let column = 0;

  const colOf = (rect: DOMRect, origin: number) =>
    Math.floor(
      (rect.left - origin + article.scrollLeft + 1) / geometry().colStep,
    );

  // Lines whose first character (or block) lies in columns c0..c1, in
  // document order, at most `limit` of them.
  function lines(c0: number, c1: number, limit = Number.POSITIVE_INFINITY) {
    const box = article.getBoundingClientRect();
    const origin = box.left;
    const out: Line[] = [];
    const containers = new WeakMap<Node, Element>();
    const range = document.createRange();
    let prev: {
      col: number;
      top: number;
      bottom: number;
      container: Element;
    } | null = null;
    let off = 0;
    // Blocks with no text between them (a run of pictures) share an offset;
    // their order in the document keeps their starts apart.
    const order = new Map<Element, number>();
    for (const el of article.querySelectorAll(monolithicSelector)) {
      order.set(el, order.size);
    }
    const blockStart = (el: Element) => off - 0.5 + (order.get(el) ?? 0) * 1e-6;

    const containerOf = (node: Text): Element => {
      const parent = node.parentElement ?? article;
      let found = containers.get(parent);
      if (!found) {
        let el: Element = parent;
        while (el !== article && !isBlockLevel(el)) {
          el = el.parentElement ?? article;
        }
        found = el;
        containers.set(parent, found);
      }
      return found;
    };

    // True when none of the element's boxes reach columns c0..c1.
    const outside = (el: Element) => {
      const rects = el.getClientRects();
      if (rects.length === 0) {
        return false;
      }
      for (const r of rects) {
        const first = colOf(r, origin);
        const last = Math.floor(
          (r.right - origin + article.scrollLeft - 1) / geometry().colStep,
        );
        if (last >= c0 && first <= c1) {
          return false;
        }
      }
      return true;
    };

    const visit = (node: Node): boolean => {
      if (out.length >= limit) {
        return false;
      }
      if (node instanceof Text) {
        const container = containerOf(node);
        // Within a text node, characters only move on to later lines and
        // columns, so line ends and the first column in range are found by
        // binary search instead of measuring every character.
        const chars: number[] = [];
        for (let i = 0; i < node.length; i++) {
          if (!isSpace(node.data[i])) {
            chars.push(i);
          }
        }
        const rectAt = (k: number) => {
          range.setStart(node, chars[k]);
          range.setEnd(node, chars[k] + 1);
          const r = range.getClientRects()[0];
          return !r || (r.width === 0 && r.height === 0) ? null : r;
        };
        // The last k in [lo, hi) for which test holds, given it holds at lo
        // and, once false, stays false.
        const lastWhere = (
          lo: number,
          hi: number,
          test: (k: number) => boolean,
        ) => {
          let a = lo;
          let b = hi - 1;
          while (a < b) {
            const mid = (a + b + 1) >> 1;
            if (test(mid)) {
              a = mid;
            } else {
              b = mid - 1;
            }
          }
          return a;
        };
        let k = 0;
        while (k < chars.length) {
          const r = rectAt(k);
          if (!r) {
            k++;
            continue;
          }
          const col = colOf(r, origin);
          if (col > c1) {
            return false;
          }
          if (col < c0) {
            // Skip to the first character in a column in range.
            const before = (j: number) => {
              const q = rectAt(j);
              return !q || colOf(q, origin) < c0;
            };
            const last = lastWhere(k, chars.length, before);
            prev = null;
            k = last + 1;
            continue;
          }
          const sameLine = (j: number) => {
            const q = rectAt(j);
            return (
              q !== null &&
              colOf(q, origin) === col &&
              q.top < r.bottom - 2 &&
              q.bottom > r.top + 2
            );
          };
          const end = lastWhere(k, chars.length, sameLine);
          const newLine =
            !prev ||
            prev.container !== container ||
            prev.col !== col ||
            r.top >= prev.bottom - 2 ||
            r.bottom <= prev.top + 2;
          if (newLine) {
            if (out.length >= limit) {
              return false;
            }
            out.push({
              start: off + chars[k],
              end: off + chars[end],
              col,
              top: r.top - box.top,
            });
          } else if (out.length > 0) {
            out[out.length - 1].end = off + chars[end];
          }
          prev = { col, top: r.top, bottom: r.bottom, container };
          k = end + 1;
        }
        off += node.length;
        return true;
      }
      if (!(node instanceof Element) || node === marker) {
        return true;
      }
      const text = node.textContent?.length ?? 0;
      if (node !== article && isMonolithic(node)) {
        const r = node.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          const col = colOf(r, origin);
          if (col > c1) {
            return false;
          }
          if (col >= c0) {
            const start = blockStart(node);
            out.push({
              start,
              end: text > 0 ? off + text - 1 : start,
              col,
              top: r.top - box.top,
              el: node,
            });
          }
        }
        prev = null;
        off += text;
        return true;
      }
      if (node !== article && outside(node)) {
        const r = node.getBoundingClientRect();
        if (colOf(r, origin) > c1) {
          return false;
        }
        off += text;
        prev = null;
        return true;
      }
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (!visit(child)) {
          return false;
        }
      }
      return true;
    };
    visit(article);
    return out;
  }

  function textPoint(key: number): { node: Text; offset: number } | null {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let off = 0;
    for (
      let n = walker.nextNode() as Text | null;
      n;
      n = walker.nextNode() as Text | null
    ) {
      if (key < off + n.length) {
        return { node: n, offset: key - off };
      }
      off += n.length;
    }
    return null;
  }

  // The offset into the article's text of a character.
  function keyOf(node: Text, offset: number): number {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let off = 0;
    for (
      let n = walker.nextNode() as Text | null;
      n;
      n = walker.nextNode() as Text | null
    ) {
      if (n === node) {
        return off + offset;
      }
      off += n.length;
    }
    return off;
  }

  function removeMarker() {
    if (!marker) {
      return;
    }
    marker.remove();
    marker = null;
    if (
      split?.head.isConnected &&
      split.tail.isConnected &&
      split.head.nextSibling === split.tail
    ) {
      split.head.appendData(split.tail.data);
      split.tail.remove();
    }
    split = null;
  }

  // Nothing visible (text or a picture) between the start of el and the
  // point.
  function nothingBefore(el: Element, node: Node, offset: number) {
    const r = document.createRange();
    r.setStart(el, 0);
    if (node instanceof Element) {
      // The point is the start of an element: stop before it.
      r.setEndBefore(node);
    } else {
      r.setEnd(node, offset);
    }
    if (r.toString().trim() !== "") {
      return false;
    }
    return !r.cloneContents().querySelector(monolithicSelector);
  }

  // The outermost block below the article that this point is the first
  // visible content of, if any.
  function outermostBlockStartingAt(
    start: Element,
    node: Node,
    offset: number,
  ) {
    let found: Element | null = null;
    for (
      let el: Element | null = start;
      el && el !== article;
      el = el.parentElement
    ) {
      if (el !== node && !nothingBefore(el, node, offset)) {
        break;
      }
      if (isBlockLevel(el)) {
        found = el;
      }
    }
    return found;
  }

  function placeMarker(start: SpreadStart) {
    const m = document.createElement("span");
    m.setAttribute(markerAttribute, "");
    if (start.el?.isConnected) {
      const block = outermostBlockStartingAt(start.el, start.el, 0) ?? start.el;
      block.before(m);
      marker = m;
      return;
    }
    const point = textPoint(Math.ceil(start.key));
    if (!point) {
      return;
    }
    const { node, offset } = point;
    const block = outermostBlockStartingAt(
      node.parentElement ?? article,
      node,
      offset,
    );
    if (block) {
      block.before(m);
    } else if (offset === 0) {
      node.before(m);
    } else {
      const tail = node.splitText(offset);
      tail.before(m);
      split = { head: node, tail };
    }
    marker = m;
  }

  // Shows the spread whose first line is start; with null, the document's
  // first spread, which needs no marker.
  function show(start: SpreadStart | null) {
    removeMarker();
    if (start) {
      placeMarker(start);
    }
    const { colStep } = geometry();
    let col = 0;
    if (marker) {
      const origin = article.getBoundingClientRect().left;
      col = Math.max(0, colOf(marker.getBoundingClientRect(), origin));
    }
    // The scroll end reaches the end of the shown spread, so the spread
    // start's column never clamps (ADR-0010 Scroll end).
    article.style.setProperty(
      "--reading-scroll-end",
      `${col * colStep + article.clientWidth - 1}px`,
    );
    column = col;
    article.scrollLeft = col * colStep;
  }

  const spreadColumns = () => geometry().pagesPerSpread;

  return {
    show,
    removeMarker,
    lines,
    keyOf,
    textPoint,
    get column() {
      return column;
    },
    hasMarker: () => marker !== null,
    visible: () => lines(column, column + spreadColumns() - 1),
    // The last line of the shown spread, measured from its last column back.
    lastVisible: (): Line | null => {
      for (let c = column + spreadColumns() - 1; c >= column; c--) {
        const found = lines(c, c);
        if (found.length > 0) {
          return found[found.length - 1];
        }
      }
      return null;
    },
    after: (): Line | null =>
      lines(column + spreadColumns(), Number.POSITIVE_INFINITY, 1)[0] ?? null,
    before: (): Line | null =>
      column > 0
        ? (lines(Math.max(0, column - 2), column - 1).at(-1) ?? null)
        : null,
    // The column holding a horizontal offset into the article's flow.
    columnAt: (x: number) =>
      Math.max(0, Math.floor((x + 1) / geometry().colStep)),
    clearScrollEnd: () => article.style.removeProperty("--reading-scroll-end"),
  };
}
