import { useCallback, useEffect, useRef } from "react";
import { contentId } from "./navigator";
import {
  applyLocator,
  captureLocator,
  type Locator,
  type PagesRestore,
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

  const suppressUntil = useRef(0);

  const markProgrammatic = useCallback(() => {
    ignoreScrollY.current = window.scrollY;
  }, []);

  const capture = useCallback((): Locator | null => {
    const content = contentEl();
    if (!content) {
      return null;
    }
    // In the pages layout the controller has already placed the spread
    // start's marker and set the scroll end (ADR-0005).
    const pages =
      layoutRef.current === "pages" ? pagesRestoreRef.current() : null;
    return captureLocator(
      content,
      hrefRef.current,
      layoutRef.current,
      pages?.progression(),
      pages?.clicked(),
    );
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
      applyLocator(
        content,
        locator,
        layoutRef.current,
        pagesRestoreRef.current() ?? undefined,
      );
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
    applyLocator(
      content,
      locator,
      layoutRef.current,
      pagesRestoreRef.current() ?? undefined,
    );
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
      // Fragment scrollIntoView is synchronous; capture now so a follow-up
      // placement effect (hash settling) cannot race an empty article.
      recordMove();
    },
    [recordMove],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onScroll = () => {
      if (restoring.current || performance.now() < suppressUntil.current) {
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

    // In the pages layout the controller reports moves itself: a turn, or a
    // scroll the reader did not make once it is aligned (ADR-0010).

    // Hide and pagehide are handled by the app-level queue, which sends only
    // what is still pending; nothing is re-captured here.
    // The article may not exist yet (the document is still loading), and
    // scroll does not bubble, so listen in the capture phase.
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, [enabled, recordMove]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onResize = () => {
      // Re-layout never counts as a move, before or after the first one.
      suppressUntil.current = performance.now() + 400;
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
