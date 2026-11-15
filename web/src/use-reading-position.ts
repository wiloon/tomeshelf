import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { contentId } from "./navigator";
import {
  applyResolvedPosition,
  captureLocator,
  type Locator,
  resolveLocator,
} from "./position";
import { savePosition } from "./position-api";
import { createSaveQueue } from "./save-queue";

const debounceMs = 500;

function contentEl(): HTMLElement | null {
  const el = document.getElementById(contentId);
  return el instanceof HTMLElement ? el : null;
}

// Tracks and restores the reading position for the open book (ADR-0005).
export function useReadingPosition({
  bookId,
  href,
  enabled,
  restore,
}: {
  bookId: string;
  href: string;
  enabled: boolean;
  restore: Locator | null;
}) {
  const restoring = useRef(false);
  const restoredScrollY = useRef<number | null>(null);
  const moved = useRef(false);
  const activeLocator = useRef<Locator | null>(null);
  const hrefRef = useRef(href);
  const queueRef = useRef<ReturnType<typeof createSaveQueue<Locator>> | null>(
    null,
  );
  hrefRef.current = href;

  const reapplyLocator = useCallback((): boolean => {
    const locator = activeLocator.current;
    const content = contentEl();
    if (!locator || !content) {
      return false;
    }
    restoring.current = true;
    const resolved = resolveLocator(content, locator);
    if (resolved) {
      applyResolvedPosition(content, resolved);
    }
    restoredScrollY.current = window.scrollY;
    restoring.current = false;
    return true;
  }, []);

  // Applies a restored Locator after the document is in the DOM. Does not
  // count as the reader moving, so nothing is saved until they scroll.
  const applyRestore = useCallback((content: HTMLElement, locator: Locator) => {
    restoring.current = true;
    moved.current = false;
    activeLocator.current = locator;
    const resolved = resolveLocator(content, locator);
    if (resolved) {
      applyResolvedPosition(content, resolved);
    }
    restoredScrollY.current = window.scrollY;
    restoring.current = false;
  }, []);

  // Runs fn without treating scroll events as the reader moving (initial
  // placement at the top, a fragment, or a restored Locator).
  const withoutCapture = useCallback((fn: () => void) => {
    restoring.current = true;
    fn();
    restoredScrollY.current = window.scrollY;
    restoring.current = false;
  }, []);

  // Refresh the active Locator from the viewport without counting as a move
  // (after a settings reflow kept the place with keepingAnchor).
  const syncLocator = useCallback(() => {
    const content = contentEl();
    if (!content || !activeLocator.current) {
      return;
    }
    activeLocator.current = captureLocator(content, hrefRef.current);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const queue = createSaveQueue<Locator>({
      delay: debounceMs,
      send: (locator) =>
        savePosition(bookId, locator, {
          keepalive: document.visibilityState === "hidden",
        }),
    });
    queueRef.current = queue;
    return () => {
      queue.pagehide();
      queue.dispose();
      queueRef.current = null;
    };
  }, [enabled, bookId]);

  // When the document changes, flush the departed position first.
  useEffect(() => {
    const previous = href;
    return () => {
      if (hrefRef.current === previous) {
        return;
      }
      const queue = queueRef.current;
      if (!queue || !moved.current || !activeLocator.current) {
        return;
      }
      queue.change(activeLocator.current);
      queue.hidden();
      moved.current = false;
      activeLocator.current = null;
    };
  }, [href]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    if (restore) {
      activeLocator.current = restore;
      moved.current = false;
    }
  }, [enabled, restore]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onScroll = () => {
      if (restoring.current || restoredScrollY.current === window.scrollY) {
        restoredScrollY.current = null;
        return;
      }
      restoredScrollY.current = null;
      const content = contentEl();
      if (!content) {
        return;
      }
      moved.current = true;
      const locator = captureLocator(content, hrefRef.current);
      activeLocator.current = locator;
      queueRef.current?.change(locator);
    };

    const flushPending = (mode: "hidden" | "pagehide") => {
      if (!moved.current) {
        return;
      }
      const queue = queueRef.current;
      if (!queue) {
        return;
      }
      if (queue.status() === "failed") {
        queue.retry();
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
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onResize = () => {
      // Re-apply only when the reader has not moved since restore/open; after
      // they scroll, keepingAnchor on settings changes owns the place, and a
      // mid-reflow resize must not jump to a stale Locator.
      if (moved.current) {
        return;
      }
      reapplyLocator();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled, reapplyLocator]);

  return {
    reapplyLocator,
    applyRestore,
    withoutCapture,
    syncLocator,
  };
}
