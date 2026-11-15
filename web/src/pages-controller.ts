// Attaches paginated reading behaviour to #tomeshelf-content (ADR-0010).

import {
  columnGapPx,
  eventTargetIsEditable,
  keyTurnsSpread,
  snapSpreadOffset,
  spreadMetrics,
  spreadStep,
  type Turn,
  WheelBurst,
} from "./pages";

export type PagesController = {
  destroy: () => void;
  relayout: (apply?: () => void) => void;
  turn: (direction: Turn) => boolean;
  atStart: () => boolean;
  atEnd: () => boolean;
};

export type PagesControllerOptions = {
  article: HTMLElement;
  // The space the article may occupy, in CSS pixels.
  availableWidth: () => number;
  // The text width setting in rem.
  textWidthRem: () => number;
  // Called when a turn would leave the document.
  onExhausted: (direction: Turn) => void;
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
  return metrics;
}

function maxScroll(article: HTMLElement): number {
  return Math.max(0, article.scrollWidth - article.clientWidth);
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

// The first character whose box intersects the article's visible area, used
// to keep place across a re-layout (ADR-0010).
export function firstVisibleCharacter(article: HTMLElement): {
  node: Text;
  offset: number;
} | null {
  const root = article.getBoundingClientRect();
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const text = node;
    const length = text.length;
    for (let i = 0; i < length; i++) {
      const range = document.createRange();
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }
      if (
        rect.right > root.left + 1 &&
        rect.left < root.right - 1 &&
        rect.bottom > root.top + 1 &&
        rect.top < root.bottom - 1
      ) {
        return { node: text, offset: i };
      }
    }
    node = walker.nextNode() as Text | null;
  }
  return null;
}

function scrollCharIntoSpread(
  article: HTMLElement,
  step: number,
  ch: {
    node: Text;
    offset: number;
  },
) {
  const range = document.createRange();
  range.setStart(ch.node, ch.offset);
  range.setEnd(ch.node, ch.offset + 1);
  const rect = range.getBoundingClientRect();
  const root = article.getBoundingClientRect();
  const delta = rect.left - root.left;
  const target = snapSpreadOffset(article.scrollLeft + delta, step);
  article.scrollLeft = Math.min(maxScroll(article), Math.max(0, target));
}

export function attachPagesController(
  options: PagesControllerOptions,
): PagesController {
  const { article, availableWidth, textWidthRem, onExhausted } = options;
  const burst = wheelBurst;
  let step = 0;
  let twoPages = false;
  let snapping = false;
  let touchStartX: number | null = null;
  let touchStartY: number | null = null;

  const measure = () => {
    const metrics = applyMetrics(article, availableWidth(), textWidthRem());
    step = spreadStep(metrics);
    twoPages = metrics.pagesPerSpread === 2;
    return metrics;
  };

  const atStart = () => article.scrollLeft <= 1;
  const atEnd = () => article.scrollLeft >= maxScroll(article) - 1;

  function extendFinalSpread() {
    if (!twoPages || article.style.getPropertyValue("--reading-scroll-end"))
      return;
    const max = maxScroll(article);
    const final = Math.ceil((max - 1) / step) * step;
    if (final > max + 1) {
      article.style.setProperty(
        "--reading-scroll-end",
        `${final + article.clientWidth - 1}px`,
      );
    }
  }

  const go = (direction: Turn): boolean => {
    if (step <= 0) {
      measure();
    }
    extendFinalSpread();
    const next =
      direction === "next"
        ? article.scrollLeft + step
        : article.scrollLeft - step;
    if (direction === "next" && atEnd()) {
      onExhausted("next");
      return false;
    }
    if (direction === "previous" && atStart()) {
      onExhausted("previous");
      return false;
    }
    snapping = true;
    article.scrollLeft = Math.min(
      maxScroll(article),
      Math.max(0, snapSpreadOffset(next, step)),
    );
    queueMicrotask(() => {
      snapping = false;
    });
    return true;
  };

  const snap = () => {
    if (step <= 0) {
      return;
    }
    snapping = true;
    article.scrollLeft = Math.min(
      maxScroll(article),
      Math.max(0, snapSpreadOffset(article.scrollLeft, step)),
    );
    queueMicrotask(() => {
      snapping = false;
    });
  };

  const relayout = (apply?: () => void) => {
    const place = firstVisibleCharacter(article);
    apply?.();
    article.style.removeProperty("--reading-scroll-end");
    measure();
    extendFinalSpread();
    if (place) {
      scrollCharIntoSpread(article, step, place);
    } else {
      snap();
    }
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
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
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
    if (nestedScrollable(event.target, article, -dx)) {
      return;
    }
    go(dx < 0 ? "next" : "previous");
  };

  let snapTimer = 0;
  const onScroll = () => {
    if (snapping) {
      return;
    }
    window.clearTimeout(snapTimer);
    snapTimer = window.setTimeout(snap, 50);
  };

  measure();
  document.addEventListener("keydown", onKeyDown);
  article.addEventListener("wheel", onWheel, { passive: false });
  article.addEventListener("touchstart", onTouchStart, { passive: true });
  article.addEventListener("touchend", onTouchEnd, { passive: true });
  article.addEventListener("scroll", onScroll, { passive: true });

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKeyDown);
      article.removeEventListener("wheel", onWheel);
      article.removeEventListener("touchstart", onTouchStart);
      article.removeEventListener("touchend", onTouchEnd);
      article.removeEventListener("scroll", onScroll);
      window.clearTimeout(snapTimer);
      article.style.removeProperty("--reading-page-width");
      article.parentElement?.style.removeProperty("--reading-spread-width");
      article.style.removeProperty("--reading-column-gap");
      article.style.removeProperty("--reading-scroll-end");
    },
    relayout,
    turn: go,
    atStart,
    atEnd,
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
