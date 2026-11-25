// Attaches paginated reading behaviour to #tomeshelf-content (ADR-0010).

import {
  columnGapPx,
  eventTargetIsEditable,
  keyTurnsSpread,
  spreadMetrics,
  type Turn,
  WheelBurst,
} from "./pages";
import {
  createSpreadLayout,
  type Line,
  type SpreadStart,
} from "./spread-layout";
import {
  findPreviousStart,
  nextSpreadStart,
  previousTarget,
  SpreadMemory,
} from "./spread-start";

export type PagesController = {
  destroy: () => void;
  // Re-lays out after apply (a resize, a setting, a late font), keeping the
  // spread start as the first line of the first page (ADR-0010 Re-layout).
  relayout: (apply?: () => void) => void;
  turn: (direction: Turn) => boolean;
  atStart: () => boolean;
  atEnd: () => boolean;
  // Removes the marker, so restoring measures progressions on the document
  // without one (ADR-0005).
  prepareProgression: () => void;
  // The shown spread's progression (ADR-0005): 1 when no line follows it,
  // whatever blank margin overflows past it.
  progression: () => number;
  // The progression showing the character would give: its line is placed as
  // the spread start and measured, then the marker is removed again.
  progressionOf: (node: Text, offset: number) => number;
  // Makes the line holding the character the spread start.
  showCharacter: (node: Text, offset: number) => void;
  // Makes the first line of the page at that progression the spread start.
  showProgression: (progression: number) => void;
  // Makes the element's first line the spread start (a contents entry or a
  // fragment link).
  showElement: (el: Element) => void;
  // Shows the document's last spread: the one ending with its last line.
  showEnd: () => void;
  // Forgets the turned spreads (a Repeated lines change).
  forget: () => void;
  // The shown spread's first page in the document's current column flow,
  // from 1, the document's pages up to its last line, and the pages a spread
  // holds (ADR-0010 Page numbers). Reads the existing layout only.
  spreadPages: () => { page: number; pages: number; perSpread: number };
};

export type PagesControllerOptions = {
  article: HTMLElement;
  // The space the article may occupy, in CSS pixels.
  availableWidth: () => number;
  // The text width setting in rem.
  textWidthRem: () => number;
  wheelTurnsPages: () => boolean;
  repeatedLines: () => number;
  // Called when a turn would leave the document.
  onExhausted: (direction: Turn) => void;
  // Called after a spread turn, or once a scroll the reader did not make
  // has been aligned to a spread start (not restore or re-layout).
  onMove?: () => void;
  // Called after every re-layout, which can change atStart and atEnd
  // without a scroll event.
  onRelayout?: () => void;
};

const wheelQuietMs = 300;
const swipeMinPx = 40;
const wheelBurst = new WheelBurst(wheelQuietMs);

function remPx(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

function applyMetrics(
  article: HTMLElement,
  availableWidth: number,
  textWidthRem: number,
) {
  const metrics = spreadMetrics(
    availableWidth,
    textWidthRem * remPx(),
    columnGapPx,
  );
  article.style.setProperty("--reading-page-width", `${metrics.pageWidth}px`);
  article.parentElement?.style.setProperty(
    "--reading-spread-width",
    `${metrics.spreadWidth}px`,
  );
  article.style.setProperty("--reading-column-gap", `${metrics.gap}px`);
  // Cap media to the page box; % max-height inside a figure has no definite CB.
  article.style.setProperty(
    "--reading-page-height",
    `${article.clientHeight}px`,
  );
  return metrics;
}

function nestedScrollable(
  start: EventTarget | null,
  article: HTMLElement,
  deltaX: number,
): Element | null {
  if (!(start instanceof Element)) {
    return null;
  }
  let el: Element | null = start;
  while (el && el !== article) {
    if (el instanceof HTMLElement) {
      const style = getComputedStyle(el);
      const canX =
        /(auto|scroll)/.test(style.overflowX) &&
        el.scrollWidth > el.clientWidth + 1;
      if (canX) {
        const atStart = el.scrollLeft <= 0;
        const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
        if ((deltaX < 0 && !atStart) || (deltaX > 0 && !atEnd)) {
          return el;
        }
      }
    }
    el = el.parentElement;
  }
  return null;
}

// The first character whose box lies in the article's visible area. Text in
// a nested scroll area (a wide table, pre) counts only where that area shows
// it: its clipped overflow can lie over the next page.
function firstVisibleCharacter(article: HTMLElement): {
  node: Text;
  offset: number;
} | null {
  const root = article.getBoundingClientRect();
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    const area = node.parentElement?.closest("table, pre");
    const clip =
      area && article.contains(area) ? area.getBoundingClientRect() : root;
    for (let i = 0; i < node.length; i++) {
      if (/\s/.test(node.data[i])) {
        continue;
      }
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }
      if (
        rect.right > Math.max(root.left, clip.left) + 1 &&
        rect.left < Math.min(root.right, clip.right) - 1 &&
        rect.bottom > root.top + 1 &&
        rect.top < root.bottom - 1
      ) {
        return { node, offset: i };
      }
    }
  }
  return null;
}

// The horizontal offset, in the article's flow, of its last non-whitespace
// character or last picture, whichever comes later; 0 when it has neither.
function lastContentOffset(article: HTMLElement): number {
  const origin = article.getBoundingClientRect().left - article.scrollLeft;
  let offset = 0;
  let deepest: Node = article;
  while (deepest.lastChild) {
    deepest = deepest.lastChild;
  }
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  walker.currentNode = deepest;
  const range = document.createRange();
  for (
    let node: Node | null =
      deepest instanceof Text ? deepest : walker.previousNode();
    node;
    node = walker.previousNode()
  ) {
    const text = node as Text;
    const i = text.data.search(/\S\s*$/);
    if (i < 0) {
      continue;
    }
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    const rect = range.getClientRects()[0];
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      continue;
    }
    offset = rect.left - origin;
    break;
  }
  const media = article.querySelectorAll("img, svg, video");
  const rects = media[media.length - 1]?.getClientRects();
  const last = rects?.[rects.length - 1];
  if (last) {
    offset = Math.max(offset, last.left - origin);
  }
  return offset;
}

const startOf = (line: Line): SpreadStart =>
  line.el ? { key: line.start, el: line.el } : { key: line.start };

export function attachPagesController(
  options: PagesControllerOptions,
): PagesController {
  const {
    article,
    availableWidth,
    textWidthRem,
    onExhausted,
    onMove,
    onRelayout,
  } = options;
  const burst = wheelBurst;
  let colStep = 0;
  let pagesPerSpread = 1;
  let measuredWidth = 0;
  // The spread start: null is the document's first spread (ADR-0010).
  let current: SpreadStart | null = null;
  // The scroll offset this controller last set, so its own scroll events
  // are not taken for a scroll the reader did not make.
  let ownLeft: number | null = null;
  let touchStartX: number | null = null;
  let touchStartY: number | null = null;
  let touchOwner: "page" | "nested" | null = null;
  let alignTimer = 0;
  let alignPending = false;
  const memory = new SpreadMemory<SpreadStart | null>();
  const layout = createSpreadLayout(article, () => ({
    colStep,
    pagesPerSpread,
  }));

  const measure = () => {
    const width = availableWidth();
    const metrics = applyMetrics(article, width, textWidthRem());
    colStep = metrics.pageWidth + metrics.gap;
    pagesPerSpread = metrics.pagesPerSpread;
    measuredWidth = width;
  };

  // Remeasure when the article's width has changed but a resize event has not
  // been delivered yet (common right after setViewportSize in tests).
  const measureIfStale = () => {
    if (colStep <= 0 || availableWidth() !== measuredWidth) {
      measure();
      return true;
    }
    return false;
  };
  const ensureMeasured = () => {
    if (measureIfStale()) {
      layout.show(current);
      ownLeft = article.scrollLeft;
    }
  };

  const show = (start: SpreadStart | null) => {
    current = start;
    layout.show(start);
    ownLeft = article.scrollLeft;
  };

  // The document's first line is its first spread start, shown without a
  // marker.
  const isDocumentStart = (start: number) => {
    const first = layout.lines(0, 0, 1)[0];
    return !first || start <= first.start;
  };
  const toStart = (line: Line | null): SpreadStart | null =>
    !line || isDocumentStart(line.start) ? null : startOf(line);

  // The article-text offset where el begins.
  const keyBefore = (el: Element) => {
    const range = document.createRange();
    range.setStart(article, 0);
    range.setEndBefore(el);
    return range.toString().length;
  };

  const atStart = () => current === null;
  const atEnd = () => {
    ensureMeasured();
    return layout.after() === null;
  };
  const progression = () => {
    if (atEnd()) {
      return 1;
    }
    const range = article.scrollWidth - article.clientWidth;
    return range <= 0
      ? 1
      : Math.min(1, Math.max(0, article.scrollLeft / range));
  };

  // The earliest spread start before the current one whose spread reaches
  // target (ADR-0010 Repeated lines), searched by trial layouts.
  // Candidates are the lines a few spreads back from column fromCol, and
  // before the spread start `before` when one is given.
  const searchBack = (
    target: Line,
    fromCol = layout.column,
    before: number | null = current?.key ?? null,
  ) => {
    const k = pagesPerSpread;
    const back = 3 * k;
    let cands = layout
      .lines(Math.max(0, fromCol - back), fromCol + k - 1)
      .filter(
        (l) => l.start <= target.start && (before === null || l.start < before),
      );
    // The likely answer: the line just below the target's height a spread's
    // width of columns back, since a spread from there fills k columns.
    const at = cands.findIndex(
      (l) =>
        l.col > target.col - k ||
        (l.col === target.col - k && l.top > target.top + 1),
    );
    let guess = at < 0 ? cands.length - 1 : at;
    // Candidates that start less than a spread's width before the target may
    // all reach it (pictures move lines): then look further back.
    for (;;) {
      const first = cands[0];
      if (
        !first ||
        isDocumentStart(first.start) ||
        first.col < target.col - k
      ) {
        break;
      }
      show(startOf(first));
      const last = layout.lastVisible();
      if (!last || last.end < target.start) {
        break;
      }
      const more = layout
        .lines(Math.max(0, layout.column - back), layout.column - 1)
        .filter((l) => l.start < first.start);
      if (more.length === 0) {
        break;
      }
      cands = more.concat(cands);
      guess += more.length;
    }
    const byKey = new Map(cands.map((l) => [l.start, l]));
    const found = findPreviousStart(
      cands.map((l) => l.start),
      target.start,
      (key) => {
        const line = byKey.get(key);
        show(line ? toStart(line) : null);
        return layout.lastVisible();
      },
      guess,
    );
    const line = found === null ? null : (byKey.get(found) ?? null);
    show(line ? toStart(line) : null);
  };

  const go = (direction: Turn): boolean => {
    // A scroll the reader did not make comes first: re-showing the old
    // spread start for a new width would undo it.
    settle();
    ensureMeasured();
    if (direction === "next") {
      const after = layout.after();
      if (!after) {
        onExhausted("next");
        return false;
      }
      const remembered = memory.turn("next", current);
      if (remembered !== undefined) {
        show(remembered);
      } else {
        const next = nextSpreadStart(
          layout.visible(),
          after,
          options.repeatedLines(),
        );
        show(next ? toStart(next) : null);
      }
    } else {
      if (atStart()) {
        onExhausted("previous");
        return false;
      }
      const remembered = memory.turn("previous", current);
      if (remembered !== undefined) {
        show(remembered);
      } else {
        const target = previousTarget(
          layout.visible(),
          layout.before(),
          options.repeatedLines(),
        );
        if (target) {
          searchBack(target);
        } else {
          show(null);
        }
      }
    }
    queueMicrotask(() => onMove?.());
    return true;
  };

  // The line holding the character, in the current layout.
  const lineHolding = (node: Text, offset: number): Line | null => {
    const key = layout.keyOf(node, offset);
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, Math.min(node.length, offset + 1));
    const rect = range.getBoundingClientRect();
    const col = layout.columnAt(
      rect.left - article.getBoundingClientRect().left + article.scrollLeft,
    );
    let found: Line | null = null;
    for (const line of layout.lines(Math.max(0, col - 1), col)) {
      if (line.start <= key) {
        found = line;
      } else {
        break;
      }
    }
    return found;
  };

  // After a scroll the reader did not make, the line holding the first
  // visible character (or the first visible block) becomes the spread
  // start (ADR-0010).
  const align = () => {
    alignPending = false;
    // The scroll was made on the layout as it is: find its line there, then
    // measure a width that changed meanwhile and show that line.
    const ch = firstVisibleCharacter(article);
    let line = ch ? lineHolding(ch.node, ch.offset) : null;
    // A block with no text to start at (a picture) that is visible before
    // that line is the first visible line.
    const box = article.getBoundingClientRect();
    const c0 = layout.columnAt(article.scrollLeft);
    const c1 = layout.columnAt(article.scrollLeft + article.clientWidth - 1);
    const block = layout.lines(c0, c1).find((l) => {
      if (!l.el || (line && l.start >= line.start)) {
        return false;
      }
      const r = l.el.getBoundingClientRect();
      return r.right > box.left + 1 && r.left < box.right - 1;
    });
    line = block ?? line;
    const start = toStart(line);
    if (measureIfStale()) {
      layout.removeMarker();
      layout.clearScrollEnd();
    }
    memory.clear();
    show(start);
    queueMicrotask(() => onMove?.());
  };

  // A scroll the reader did not make, not aligned yet, is aligned before
  // anything is measured from the spread start.
  const settle = () => {
    if (ownLeft === null || Math.abs(article.scrollLeft - ownLeft) > 1) {
      window.clearTimeout(alignTimer);
      align();
    }
  };

  // Whether something scrolled the article since this controller last did.
  // A scroll the browser clamped because the content shrank only moves it
  // back to the end.
  const scrolledByOthers = () => {
    if (alignPending) {
      return true;
    }
    if (ownLeft === null) {
      return false;
    }
    const left = article.scrollLeft;
    const clamped =
      left < ownLeft && left >= article.scrollWidth - article.clientWidth - 1;
    return Math.abs(left - ownLeft) > 1 && !clamped;
  };

  const relayout = (apply?: () => void) => {
    // A scroll that arrives in the same frame as a resize is kept: the line
    // holding its first visible character becomes the spread start.
    const ch = scrolledByOthers() ? firstVisibleCharacter(article) : null;
    const key = ch ? layout.keyOf(ch.node, ch.offset) : null;
    apply?.();
    layout.removeMarker();
    layout.clearScrollEnd();
    measure();
    memory.clear();
    show(current);
    const point = key === null ? null : layout.textPoint(key);
    if (point) {
      window.clearTimeout(alignTimer);
      alignPending = false;
      show(toStart(lineHolding(point.node, point.offset)));
      queueMicrotask(() => onMove?.());
    }
    onRelayout?.();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (eventTargetIsEditable(event.target)) {
      return;
    }
    const turn = keyTurnsSpread(event);
    if (!turn) {
      return;
    }
    event.preventDefault();
    go(turn);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !options.wheelTurnsPages()) {
      return;
    }
    const deltaX =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    if (deltaX === 0) {
      return;
    }
    if (nestedScrollable(event.target, article, deltaX)) {
      return;
    }
    event.preventDefault();
    if (!burst.consume(performance.now())) {
      return;
    }
    go(deltaX > 0 ? "next" : "previous");
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      return;
    }
    touchOwner = null;
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
  };

  const onTouchMove = (event: TouchEvent) => {
    if (
      touchStartX === null ||
      touchStartY === null ||
      event.touches.length !== 1
    )
      return;
    const dx = event.touches[0].clientX - touchStartX;
    const dy = event.touches[0].clientY - touchStartY;
    if (!touchOwner && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 3) {
      touchOwner = nestedScrollable(event.target, article, -dx)
        ? "nested"
        : "page";
    }
    if (touchOwner === "page") event.preventDefault();
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (touchStartX === null || touchStartY === null) {
      return;
    }
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    touchStartX = null;
    touchStartY = null;
    if (Math.abs(dx) < swipeMinPx || Math.abs(dx) < Math.abs(dy)) {
      return;
    }
    if (
      touchOwner === "nested" ||
      (!touchOwner && nestedScrollable(event.target, article, -dx))
    ) {
      return;
    }
    go(dx < 0 ? "next" : "previous");
  };

  const onScroll = () => {
    if (ownLeft !== null && Math.abs(article.scrollLeft - ownLeft) <= 1) {
      return;
    }
    window.clearTimeout(alignTimer);
    alignPending = true;
    alignTimer = window.setTimeout(align, 50);
  };

  // A picture that loads late moves what follows it: keep the spread start
  // (ADR-0010 Re-layout). load does not bubble, so listen in the capture
  // phase, and re-lay out once per frame.
  let loadFrame = 0;
  const onLoad = (event: Event) => {
    if (!(event.target instanceof HTMLImageElement)) {
      return;
    }
    cancelAnimationFrame(loadFrame);
    loadFrame = requestAnimationFrame(() => {
      // A scroll waiting to be aligned is aligned on the new layout.
      if (!alignPending) {
        relayout();
      }
    });
  };

  measure();
  show(null);
  article.addEventListener("load", onLoad, true);
  document.addEventListener("keydown", onKeyDown);
  article.addEventListener("wheel", onWheel, { passive: false });
  article.addEventListener("touchstart", onTouchStart, { passive: true });
  article.addEventListener("touchmove", onTouchMove, { passive: false });
  article.addEventListener("touchend", onTouchEnd, { passive: true });
  article.addEventListener("scroll", onScroll, { passive: true });

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKeyDown);
      article.removeEventListener("wheel", onWheel);
      article.removeEventListener("touchstart", onTouchStart);
      article.removeEventListener("touchmove", onTouchMove);
      article.removeEventListener("touchend", onTouchEnd);
      article.removeEventListener("scroll", onScroll);
      article.removeEventListener("load", onLoad, true);
      cancelAnimationFrame(loadFrame);
      window.clearTimeout(alignTimer);
      layout.removeMarker();
      article.style.removeProperty("--reading-page-width");
      article.parentElement?.style.removeProperty("--reading-spread-width");
      article.style.removeProperty("--reading-column-gap");
      article.style.removeProperty("--reading-page-height");
      article.style.removeProperty("--reading-scroll-end");
    },
    relayout,
    turn: go,
    atStart,
    atEnd,
    prepareProgression: () => {
      ensureMeasured();
      layout.removeMarker();
      layout.clearScrollEnd();
    },
    progression,
    progressionOf: (node, offset) => {
      ensureMeasured();
      const kept = current;
      show(toStart(lineHolding(node, offset)));
      const p = progression();
      current = kept;
      layout.removeMarker();
      layout.clearScrollEnd();
      return p;
    },
    showCharacter: (node, offset) => {
      ensureMeasured();
      layout.removeMarker();
      layout.clearScrollEnd();
      memory.clear();
      show(toStart(lineHolding(node, offset)));
    },
    showProgression: (progression) => {
      ensureMeasured();
      layout.removeMarker();
      layout.clearScrollEnd();
      memory.clear();
      const range = Math.max(0, article.scrollWidth - article.clientWidth);
      const col = layout.columnAt(progression * range);
      const line =
        layout.lines(col, Number.POSITIVE_INFINITY, 1)[0] ??
        layout.lines(0, Number.POSITIVE_INFINITY).at(-1) ??
        null;
      show(toStart(line));
    },
    showElement: (el) => {
      ensureMeasured();
      memory.clear();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode() as Text | null;
      while (text && text.data.trim() === "") {
        text = walker.nextNode() as Text | null;
      }
      const media = el.matches("img, svg, video, hr, table, pre")
        ? el
        : el.querySelector("img, svg, video");
      if (
        media &&
        (!text ||
          media.compareDocumentPosition(text) &
            Node.DOCUMENT_POSITION_FOLLOWING)
      ) {
        // A block without text is keyed just before the text that follows
        // it (spread-layout lines).
        const key = keyBefore(media) - 0.5;
        show(isDocumentStart(key) ? null : { key, el: media });
        return;
      }
      if (!text) {
        // An empty anchor (EPUB 2 books link to <a id> before a heading):
        // the first line after it.
        const key = keyBefore(el) - 0.5;
        const origin = article.getBoundingClientRect().left;
        const col = layout.columnAt(
          el.getBoundingClientRect().left - origin + article.scrollLeft,
        );
        const line = layout
          .lines(Math.max(0, col - 1), Number.POSITIVE_INFINITY)
          .find((l) => l.start >= key);
        // The marker goes before the anchor itself, so the anchor shares
        // the spread start's column: a browser scrolling to the fragment
        // then finds it already shown.
        if (line) {
          show(
            isDocumentStart(line.start) ? null : { key: line.start - 0.5, el },
          );
        }
        return;
      }
      const offset = text.data.search(/\S/);
      const key = layout.keyOf(text, Math.max(0, offset));
      show(isDocumentStart(key) ? null : { key });
    },
    showEnd: () => {
      ensureMeasured();
      memory.clear();
      show(null);
      // The last line, found from the last column back past any blank ones.
      let last: Line | null = null;
      for (
        let c = layout.columnAt(article.scrollWidth - 1);
        c >= 0 && !last;
        c--
      ) {
        last = layout.lines(c, c).at(-1) ?? null;
      }
      if (last) {
        searchBack(last, last.col, null);
      }
    },
    forget: () => memory.clear(),
    spreadPages: () => {
      ensureMeasured();
      const page = layout.column + 1;
      const last = layout.columnAt(lastContentOffset(article)) + 1;
      return { page, pages: Math.max(page, last), perSpread: pagesPerSpread };
    },
  };
}

export const pagesArriveKey = "tomeshelf-pages-arrive";

export function setPagesArrive(at: "start" | "end") {
  sessionStorage.setItem(pagesArriveKey, at);
}

export function takePagesArrive(): "start" | "end" | null {
  const value = sessionStorage.getItem(pagesArriveKey);
  sessionStorage.removeItem(pagesArriveKey);
  return value === "end" || value === "start" ? value : null;
}
