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
  capturePlace: () => void;
  restorePlace: () => void;
  turn: (direction: Turn) => boolean;
  atStart: () => boolean;
  atEnd: () => boolean;
  // Ensures the final spread is extended so progression is stable (ADR-0005).
  prepareProgression: () => void;
  showCharacter: (node: Text, offset: number) => void;
  showProgression: (progression: number) => void;
};

export type PagesControllerOptions = {
  article: HTMLElement;
  // The space the article may occupy, in CSS pixels.
  availableWidth: () => number;
  // The text width setting in rem.
  textWidthRem: () => number;
  wheelTurnsPages: () => boolean;
  // Called when a turn would leave the document.
  onExhausted: (direction: Turn) => void;
  // Called after a real spread turn (not alignment, restore or re-layout).
  onMove?: () => void;
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
  const { article, availableWidth, textWidthRem, onExhausted, onMove } =
    options;
  const burst = wheelBurst;
  let savedPlace: ReturnType<typeof firstVisibleCharacter> = null;
  let step = 0;
  let measuredWidth = 0;
  let twoPages = false;
  let snapping = false;
  let touchStartX: number | null = null;
  let touchStartY: number | null = null;
  let touchOwner: "page" | "nested" | null = null;

  const measure = () => {
    const width = availableWidth();
    const metrics = applyMetrics(article, width, textWidthRem());
    step = spreadStep(metrics);
    measuredWidth = width;
    twoPages = metrics.pagesPerSpread === 2;
    return metrics;
  };

  // Remeasure when the article's width has changed but a resize event has not
  // been delivered yet (common right after setViewportSize in tests).
  const ensureMeasured = () => {
    if (step <= 0 || availableWidth() !== measuredWidth) {
      measure();
    }
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
    ensureMeasured();
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
      // After the snap, so capture measures the settled spread (ADR-0005).
      onMove?.();
    });
    return true;
  };

  const snap = () => {
    ensureMeasured();
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
      window.clearTimeout(snapTimer);
      article.style.removeProperty("--reading-page-width");
      article.parentElement?.style.removeProperty("--reading-spread-width");
      article.style.removeProperty("--reading-column-gap");
      article.style.removeProperty("--reading-page-height");
      article.style.removeProperty("--reading-scroll-end");
    },
    relayout,
    capturePlace: () => {
      savedPlace = firstVisibleCharacter(article);
    },
    restorePlace: () => {
      article.style.removeProperty("--reading-scroll-end");
      measure();
      extendFinalSpread();
      if (savedPlace?.node.isConnected) {
        scrollCharIntoSpread(article, step, savedPlace);
      } else {
        snap();
      }
    },
    turn: go,
    atStart,
    atEnd,
    prepareProgression: () => {
      ensureMeasured();
      extendFinalSpread();
    },
    showCharacter: (node, offset) => {
      ensureMeasured();
      extendFinalSpread();
      snapping = true;
      scrollCharIntoSpread(article, step, { node, offset });
      queueMicrotask(() => {
        snapping = false;
      });
    },
    showProgression: (progression) => {
      ensureMeasured();
      extendFinalSpread();
      const range = maxScroll(article);
      snapping = true;
      article.scrollLeft =
        range <= 0
          ? 0
          : Math.min(
              range,
              Math.max(0, snapSpreadOffset(progression * range, step)),
            );
      queueMicrotask(() => {
        snapping = false;
      });
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
