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
  // The clicked character (ADR-0005 Clicked character), or null.
  clicked: () => { node: Text; offset: number } | null;
  // Restores a clicked character after the spread start: it becomes the
  // clicked character and its line is kept on the spread as re-layout does.
  applyClicked: (node: Text, offset: number) => void;
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
  // Called after a spread turn, once a scroll the reader did not make has
  // been aligned to a spread start, or when a click or selection stores a new
  // clicked character (not restore or re-layout).
  onMove?: () => void;
  // Called after every re-layout, which can change atStart and atEnd
  // without a scroll event. bookWide is false when only this document
  // reflowed (a late-loading picture), true when the window, a reading
  // setting or a font changed every document's pages.
  onRelayout?: (bookWide: boolean) => void;
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
    // Text in a nested scroll area (a wide table, pre) overflows past its
    // column; the area's own box is where it shows.
    const area = text.parentElement?.closest("table, pre");
    const box =
      area && article.contains(area) ? area.getBoundingClientRect() : rect;
    offset = box.left - origin;
    break;
  }
  const media = article.querySelectorAll("img, svg, video");
  for (let k = media.length - 1; k >= 0; k--) {
    const rects = media[k].getClientRects();
    const last = rects[rects.length - 1];
    if (last && (last.width > 0 || last.height > 0)) {
      offset = Math.max(offset, last.left - origin);
      break;
    }
  }
  return offset;
}

type CharacterPoint = { node: Text; offset: number };

function charRect(node: Text, offset: number): DOMRect {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(node.length, offset + 1));
  return range.getBoundingClientRect();
}

const isSpaceChar = (c: string) => /\s/.test(c);

// The non-whitespace characters between two points, in document order, with
// their boxes; characters with no box are left out.
function charactersBetween(
  start: CharacterPoint,
  end: CharacterPoint,
): { point: CharacterPoint; rect: DOMRect }[] {
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, Math.min(end.node.length, end.offset + 1));
  const out: { point: CharacterPoint; rect: DOMRect }[] = [];
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  if (root instanceof Text) {
    walker.currentNode = root;
  }
  for (
    let node: Node | null = root instanceof Text ? root : walker.nextNode();
    node;
    node = walker.nextNode()
  ) {
    const text = node as Text;
    if (!range.intersectsNode(text)) {
      continue;
    }
    const from = text === range.startContainer ? range.startOffset : 0;
    const to = text === range.endContainer ? range.endOffset : text.length;
    for (let i = from; i < to; i++) {
      if (isSpaceChar(text.data[i])) {
        continue;
      }
      const rect = charRect(text, i);
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }
      out.push({ point: { node: text, offset: i }, rect });
    }
  }
  return out;
}

// Pictures and rules: a click level with one marks nothing.
const pictureSelector = "img, svg, video, hr";
// Elements a click on which belongs to themselves, not to the reading mark.
const ownClickSelector =
  "a[href], button, input, select, textarea, label, summary, [contenteditable]";
// How far a press may move and still be a click.
const clickSlopPx = 5;
const markWidthPx = 10;
const markHeightPx = 12;
const markOffsetPx = 3;

// The non-whitespace characters of an element, with their boxes.
function charactersIn(el: Element) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let first: Text | null = null;
  let last: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    first ??= n as Text;
    last = n as Text;
  }
  return first && last && last.length > 0
    ? charactersBetween(
        { node: first, offset: 0 },
        { node: last, offset: last.length - 1 },
      )
    : [];
}

const distanceTo = (rect: DOMRect, y: number) =>
  y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;

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
  let pageWidth = 0;
  let gap = 0;
  let pagesPerSpread = 1;
  // The clicked character as an offset into the article's text, which the
  // marker never changes (ADR-0005 Clicked character).
  let clickedKey: number | null = null;
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

  // The reading mark (ADR-0010): one arrow outside the article, beside the
  // clicked character's line, or else the spread start.
  const readingMark = (() => {
    const svgNS = "http://www.w3.org/2000/svg";
    const el = document.createElement("div");
    el.setAttribute("data-tomeshelf-reading-mark", "");
    el.setAttribute("aria-hidden", "true");
    el.hidden = true;
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", String(markWidthPx));
    svg.setAttribute("height", String(markHeightPx));
    svg.setAttribute("viewBox", `0 0 ${markWidthPx} ${markHeightPx}`);
    const arrow = document.createElementNS(svgNS, "polygon");
    arrow.setAttribute("fill", "currentColor");
    svg.append(arrow);
    el.append(svg);
    article.parentElement?.append(el);
    let frame = 0;

    // Where the mark goes: the page and the vertical extent it sits beside.
    const target = (): { page: number; top: number; bottom: number } | null => {
      const point = clickedPoint();
      if (point) {
        const page = pageOf(point);
        if (page >= 0) {
          const r = charRect(point.node, point.offset);
          return { page, top: r.top, bottom: r.bottom };
        }
      }
      const first = layout.lines(layout.column, layout.column, 1)[0];
      if (!first) {
        return null;
      }
      if (first.el) {
        const top = first.el.getBoundingClientRect().top;
        return { page: 0, top, bottom: top + markHeightPx };
      }
      const at = layout.textPoint(first.start);
      if (!at) {
        return null;
      }
      const r = charRect(at.node, at.offset);
      return { page: 0, top: r.top, bottom: r.bottom };
    };

    const place = () => {
      frame = 0;
      const host = el.parentElement;
      const at = colStep > 0 ? target() : null;
      if (!host || !at) {
        el.hidden = true;
        return;
      }
      const box = article.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      const right = pagesPerSpread === 2 && at.page === 1;
      const left = right
        ? box.right + markOffsetPx
        : box.left - markOffsetPx - markWidthPx;
      const middle = (at.top + at.bottom) / 2;
      el.style.left = `${left - hostBox.left}px`;
      el.style.top = `${middle - markHeightPx / 2 - hostBox.top}px`;
      el.dataset.side = right ? "right" : "left";
      // It points at the text.
      arrow.setAttribute(
        "points",
        right
          ? `${markWidthPx},0 0,${markHeightPx / 2} ${markWidthPx},${markHeightPx}`
          : `0,0 ${markWidthPx},${markHeightPx / 2} 0,${markHeightPx}`,
      );
      el.hidden = false;
    };

    return {
      schedule: () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(place);
      },
      destroy: () => {
        cancelAnimationFrame(frame);
        el.remove();
      },
    };
  })();

  const measure = () => {
    const width = availableWidth();
    const metrics = applyMetrics(article, width, textWidthRem());
    colStep = metrics.pageWidth + metrics.gap;
    pageWidth = metrics.pageWidth;
    gap = metrics.gap;
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
    readingMark.schedule();
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
    const clickedBefore = clickedKey;
    clickedKey = null;
    if (direction === "next") {
      const after = layout.after();
      if (!after) {
        clickedKey = clickedBefore;
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
        clickedKey = clickedBefore;
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
    const col = columnOf(node, offset);
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

  // The column showing a character. Text in a nested scroll area (a wide
  // table, pre) counts where the area's box is: its clipped overflow can lie
  // over the next column.
  const columnOf = (node: Text, offset: number) => {
    const area = node.parentElement?.closest("table, pre");
    const rect =
      area && article.contains(area)
        ? area.getBoundingClientRect()
        : charRect(node, offset);
    return layout.columnAt(
      rect.left - article.getBoundingClientRect().left + article.scrollLeft,
    );
  };

  // The page of the shown spread holding the column, or -1.
  const pageOfColumn = (col: number) =>
    col >= layout.column && col < layout.column + pagesPerSpread
      ? col - layout.column
      : -1;

  // The page of the shown spread holding the character, or -1.
  const pageOf = (point: CharacterPoint) =>
    pageOfColumn(columnOf(point.node, point.offset));

  const clickedPoint = (): CharacterPoint | null =>
    clickedKey === null ? null : layout.textPoint(clickedKey);

  // Keeps the clicked line on the spread after re-layout or restore
  // (ADR-0010 Re-layout): while it is on the spread the spread start stays;
  // otherwise the line Repeated lines lines before it starts the spread,
  // stepping forward one line at a time while a block that cannot split
  // keeps it off the spread.
  const keepClicked = () => {
    const point = clickedPoint();
    if (!point) {
      clickedKey = null;
      return;
    }
    if (pageOf(point) >= 0) {
      return;
    }
    const line = lineHolding(point.node, point.offset);
    if (!line) {
      return;
    }
    const n = options.repeatedLines();
    const earlier = (from: number) =>
      layout.lines(from, line.col).filter((l) => l.start < line.start);
    let before = earlier(Math.max(0, line.col - 2));
    if (before.length < n && line.col > 2) {
      before = earlier(0);
    }
    const candidates = [
      ...(n === 0 ? [] : before.slice(Math.max(0, before.length - n))),
      line,
    ];
    // Fewer lines before it than Repeated lines: the document's first line.
    const first = n > 0 && before.length < n ? null : candidates[0];
    show(toStart(first));
    for (const next of candidates.slice(first ? 1 : 0)) {
      const now = clickedPoint();
      if (!now || pageOf(now) >= 0) {
        break;
      }
      show(toStart(next));
    }
  };

  // The characters of a page line, the visual line inside a table or pre at
  // height y, in document order.
  const lineCharacters = (line: Line, y: number) => {
    if (line.el) {
      const all = charactersIn(line.el);
      if (all.length === 0) {
        return [];
      }
      const spans = all.find((c) => y >= c.rect.top && y <= c.rect.bottom);
      const nearest =
        spans ??
        all.reduce((best, c) =>
          distanceTo(c.rect, y) < distanceTo(best.rect, y) ? c : best,
        );
      return all.filter((c) => Math.abs(c.rect.top - nearest.rect.top) < 2);
    }
    const from = layout.textPoint(line.start);
    const to = layout.textPoint(line.end);
    return from && to ? charactersBetween(from, to) : [];
  };

  // The character a click at (x, y) marks (ADR-0005 Capture): on the line at
  // the pointer's height, on the page nearest the pointer, between two lines
  // the nearer one; on a line's text the character nearest the pointer,
  // beside it the line's last. null above the first line, below the last,
  // level with a picture, or on a page with nothing on it.
  const pointAt = (x: number, y: number): CharacterPoint | null => {
    const box = article.getBoundingClientRect();
    if (y < box.top || y >= box.bottom) {
      return null;
    }
    const page =
      pagesPerSpread === 2 && x >= box.left + pageWidth + gap / 2 ? 1 : 0;
    const col = layout.column + page;
    const rows = layout.lines(col, col).flatMap((line) => {
      if (line.el) {
        const r = line.el.getBoundingClientRect();
        return [{ line, top: r.top, bottom: r.bottom }];
      }
      const at = layout.textPoint(line.start);
      if (!at) {
        return [];
      }
      const r = charRect(at.node, at.offset);
      return [{ line, top: r.top, bottom: r.bottom }];
    });
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last || y < first.top || y > last.bottom) {
      return null;
    }
    let row = rows.find((r) => y >= r.top && y <= r.bottom);
    if (!row) {
      const i = rows.findIndex((r) => r.top > y);
      const above = rows[i - 1];
      const below = rows[i];
      row = y - above.bottom <= below.top - y ? above : below;
    }
    if (row.line.el?.matches(pictureSelector)) {
      return null;
    }
    const chars = lineCharacters(row.line, y);
    const lastChar = chars.at(-1);
    if (!lastChar) {
      return null;
    }
    const left = Math.min(...chars.map((c) => c.rect.left));
    const right = Math.max(...chars.map((c) => c.rect.right));
    if (x < left || x > right) {
      return lastChar.point;
    }
    let best = lastChar;
    for (const c of chars) {
      const mid = (c.rect.left + c.rect.right) / 2;
      if (Math.abs(x - mid) < Math.abs(x - (best.rect.left + best.rect.right) / 2)) {
        best = c;
      }
    }
    return best.point;
  };

  // The character a selection marks: its last non-whitespace character in
  // document order, when the selection lies in the article and that
  // character is on the shown spread. undefined when nothing is selected.
  const selectionPoint = (): CharacterPoint | null | undefined => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return undefined;
    }
    const range = selection.getRangeAt(selection.rangeCount - 1);
    if (
      !article.contains(range.startContainer) ||
      !article.contains(range.endContainer)
    ) {
      return null;
    }
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (range.intersectsNode(n)) {
        nodes.push(n as Text);
      }
    }
    for (const node of nodes.reverse()) {
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.length;
      for (let i = to - 1; i >= from; i--) {
        if (!isSpaceChar(node.data[i])) {
          const point = { node, offset: i };
          const rect = charRect(node, i);
          const box = article.getBoundingClientRect();
          const shown =
            pageOf(point) >= 0 &&
            rect.bottom > box.top + 1 &&
            rect.top < box.bottom - 1;
          return shown ? point : null;
        }
      }
    }
    return null;
  };

  const setClicked = (point: CharacterPoint) => {
    const key = layout.keyOf(point.node, point.offset);
    if (key === clickedKey) {
      return;
    }
    clickedKey = key;
    readingMark.schedule();
    onMove?.();
  };

  // A press of the primary button or one touch, remembered so a click that
  // moved further than a few pixels, or a second touch, marks nothing.
  let press: { x: number; y: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    press = event.isPrimary ? { x: event.clientX, y: event.clientY } : null;
  };
  const onPointerCancel = () => {
    press = null;
  };

  // Clicks are taken in the capture phase on the document, so an extension
  // that stops a click on the text or prevents its default (a word lookup)
  // does not hide it (issue #129).
  const onClick = (event: MouseEvent) => {
    const start = press;
    press = null;
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const target =
      event.target instanceof Element
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null;
    // Only the article and the reader's own elements around it count, not
    // anything placed over them (an extension's popup, a dialog).
    if (!target || !(article.contains(target) || target.contains(article))) {
      return;
    }
    settle();
    ensureMeasured();
    const selected = selectionPoint();
    if (selected !== undefined) {
      if (selected) {
        setClicked(selected);
      }
      return;
    }
    if (
      (article.contains(target) && target.closest(ownClickSelector)) ||
      !start ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) >
        clickSlopPx
    ) {
      return;
    }
    const point = pointAt(event.clientX, event.clientY);
    if (point) {
      setClicked(point);
    }
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
    clickedKey = null;
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

  const relayout = (apply?: () => void, bookWide = true) => {
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
      // A scroll the reader did not make sets a new spread start.
      clickedKey = null;
      show(toStart(lineHolding(point.node, point.offset)));
      queueMicrotask(() => onMove?.());
    } else {
      keepClicked();
    }
    onRelayout?.(bookWide);
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
        relayout(undefined, false);
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
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("click", onClick, true);

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKeyDown);
      article.removeEventListener("wheel", onWheel);
      article.removeEventListener("touchstart", onTouchStart);
      article.removeEventListener("touchmove", onTouchMove);
      article.removeEventListener("touchend", onTouchEnd);
      article.removeEventListener("scroll", onScroll);
      article.removeEventListener("load", onLoad, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("click", onClick, true);
      readingMark.destroy();
      cancelAnimationFrame(loadFrame);
      window.clearTimeout(alignTimer);
      layout.removeMarker();
      article.style.removeProperty("--reading-page-width");
      article.parentElement?.style.removeProperty("--reading-spread-width");
      article.style.removeProperty("--reading-column-gap");
      article.style.removeProperty("--reading-page-height");
      article.style.removeProperty("--reading-scroll-end");
    },
    relayout: (apply) => relayout(apply),
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
      clickedKey = null;
      layout.removeMarker();
      layout.clearScrollEnd();
      memory.clear();
      show(toStart(lineHolding(node, offset)));
    },
    showProgression: (progression) => {
      ensureMeasured();
      clickedKey = null;
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
      clickedKey = null;
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
      clickedKey = null;
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
    clicked: clickedPoint,
    applyClicked: (node, offset) => {
      ensureMeasured();
      clickedKey = layout.keyOf(node, offset);
      keepClicked();
      readingMark.schedule();
    },
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
