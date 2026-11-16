import { useCallback, useEffect, useRef } from "react";
import { contentId } from "./navigator";
import {
  applyResolvedPosition,
  captureLocator,
  type Locator,
  type PagesRestore,
  resolveLocator,
} from "./position";
import { usePositionQueue } from "./position-queue";
import type { Layout } from "./settings";

function contentEl(): HTMLElement | null {
  const el = document.getElementById(contentId);
  return el instanceof HTMLElement ? el : null;
}

export type NavigationKind = "restore" | "address" | "move";

// Tracks and restores the reading position for the open book (ADR-0005).
export function useReadingPosition({
  bookId,
  href,
  layout,
  enabled,
  pagesRestore,
}: {
  bookId: string;
  href: string;
  layout: Layout;
  enabled: boolean;
  pagesRestore: () => PagesRestore | null;
}) {
  const queue = usePositionQueue();
  const restoring = useRef(false);
  // Programmatic scroll/spread offset the reader last set; matching events
  // are ignored so restore, alignment and re-layout never count as a move.
  const ignoreScrollY = useRef<number | null>(null);
  const ignoreScrollLeft = useRef<number | null>(null);
  const moved = useRef(false);
  const activeLocator = useRef<Locator | null>(null);
  const hrefRef = useRef(href);
  const layoutRef = useRef(layout);
  const bookIdRef = useRef(bookId);
  const pagesRestoreRef = useRef(pagesRestore);
  hrefRef.current = href;
  layoutRef.current = layout;
  bookIdRef.current = bookId;
  pagesRestoreRef.current = pagesRestore;

  const markProgrammatic = useCallback(() => {
    ignoreScrollY.current = window.scrollY;
    const article = contentEl();
    ignoreScrollLeft.current = article ? article.scrollLeft : null;
  }, []);

  const capture = useCallback((): Locator | null => {
    const content = contentEl();
    if (!content) {
      return null;
    }
    if (layoutRef.current === "pages") {
      pagesRestoreRef.current()?.prepareProgression();
    }
    return captureLocator(content, hrefRef.current, layoutRef.current);
  }, []);

  const schedule = useCallback(
    (locator: Locator) => {
      activeLocator.current = locator;
      moved.current = true;
      queue.change(bookIdRef.current, locator);
    },
    [queue],
  );

  const recordMove = useCallback(() => {
    const locator = capture();
    if (locator) {
      schedule(locator);
    }
  }, [capture, schedule]);

  // Applies a restored Locator. Does not count as the reader moving.
  const applyRestore = useCallback(
    (content: HTMLElement, locator: Locator) => {
      restoring.current = true;
      moved.current = false;
      activeLocator.current = locator;
      const resolved = resolveLocator(content, locator);
      if (resolved) {
        applyResolvedPosition(
          content,
          resolved,
          layoutRef.current,
          pagesRestoreRef.current() ?? undefined,
        );
      }
      markProgrammatic();
      restoring.current = false;
    },
    [markProgrammatic],
  );

  // Runs fn without treating scroll as the reader moving.
  const withoutCapture = useCallback(
    (fn: () => void) => {
      restoring.current = true;
      fn();
      markProgrammatic();
      restoring.current = false;
    },
    [markProgrammatic],
  );

  const syncLocator = useCallback(() => {
    const locator = capture();
    if (locator && activeLocator.current) {
      activeLocator.current = locator;
    }
  }, [capture]);

  const reapplyLocator = useCallback((): boolean => {
    const locator = activeLocator.current;
    const content = contentEl();
    if (!locator || !content) {
      return false;
    }
    restoring.current = true;
    const resolved = resolveLocator(content, locator);
    if (resolved) {
      applyResolvedPosition(
        content,
        resolved,
        layoutRef.current,
        pagesRestoreRef.current() ?? undefined,
      );
    }
    markProgrammatic();
    restoring.current = false;
    return true;
  }, [markProgrammatic]);

  // Flush the departed document's position when href changes.
  useEffect(() => {
    const previousHref = href;
    const previousBookId = bookId;
    return () => {
      if (!moved.current || !activeLocator.current) {
        return;
      }
      if (
        hrefRef.current === previousHref &&
        bookIdRef.current === previousBookId
      ) {
        return;
      }
      queue.change(previousBookId, activeLocator.current);
      queue.hidden();
      moved.current = false;
      activeLocator.current = null;
    };
  }, [href, bookId, queue]);

  // Arrival through an explicit navigation is a move.
  const noteArrival = useCallback(
    (kind: NavigationKind) => {
      if (kind !== "move") {
        moved.current = false;
        return;
      }
      // Capture after layout paints the arrival place.
      requestAnimationFrame(() => {
        recordMove();
      });
    },
    [recordMove],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onScroll = () => {
      if (restoring.current) {
        return;
      }
      if (
        ignoreScrollY.current !== null &&
        ignoreScrollY.current === window.scrollY
      ) {
        ignoreScrollY.current = null;
        return;
      }
      ignoreScrollY.current = null;
      if (layoutRef.current === "pages") {
        return;
      }
      recordMove();
    };

    const onArticleScroll = (event: Event) => {
      if (restoring.current || layoutRef.current !== "pages") {
        return;
      }
      const article = event.target;
      if (!(article instanceof HTMLElement)) {
        return;
      }
      if (
        ignoreScrollLeft.current !== null &&
        ignoreScrollLeft.current === article.scrollLeft
      ) {
        ignoreScrollLeft.current = null;
        return;
      }
      ignoreScrollLeft.current = null;
      // Alignment snaps are ignored via pages-controller's snapping flag
      // (onMove is only fired for real turns). Article scroll alone is not
      // a move in pages layout.
    };

    const flushPending = (mode: "hidden" | "pagehide") => {
      if (!moved.current) {
        return;
      }
      const locator = capture() ?? activeLocator.current;
      if (locator) {
        queue.change(bookIdRef.current, locator);
      }
      if (mode === "hidden") {
        queue.hidden();
      } else {
        queue.pagehide();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        flushPending("hidden");
      }
    };
    const onPageHide = () => flushPending("pagehide");

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    const article = contentEl();
    article?.addEventListener("scroll", onArticleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      article?.removeEventListener("scroll", onArticleScroll);
    };
  }, [enabled, queue, capture, recordMove]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onResize = () => {
      if (moved.current) {
        return;
      }
      reapplyLocator();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled, reapplyLocator]);

  return {
    applyRestore,
    withoutCapture,
    syncLocator,
    reapplyLocator,
    recordMove,
    noteArrival,
    markProgrammatic,
    flushDeparting: () => {
      if (!moved.current) {
        return;
      }
      const locator = capture() ?? activeLocator.current;
      if (locator) {
        queue.change(bookIdRef.current, locator);
      }
      queue.hidden();
    },
  };
}
