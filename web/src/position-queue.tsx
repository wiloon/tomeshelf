import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Locator } from "./position";
import { type PositionSave, savePosition } from "./position-api";
import { createSaveQueue, type SaveQueue } from "./save-queue";

const debounceMs = 500;

type PositionQueue = {
  // Records a move and schedules a debounced save.
  change: (bookId: string, locator: Locator) => void;
  // A pending save skips the rest of its debounce (departing, Library, hide).
  hidden: () => void;
  // Best-effort send on unload, even beside a save in flight.
  pagehide: () => void;
};

const PositionQueueContext = createContext<PositionQueue | null>(null);

// The position save queue lives at app level, so a pending departing save
// survives the reader unmounting; the library refetches once it settles.
export function PositionQueueProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [queue] = useState<SaveQueue<PositionSave>>(() =>
    createSaveQueue<PositionSave>({
      delay: debounceMs,
      send: (value) =>
        savePosition(value, {
          keepalive: document.visibilityState === "hidden",
        }).then(() => {
          void queryClient.invalidateQueries({ queryKey: ["books"] });
        }),
    }),
  );

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        queue.hidden();
      }
    };
    const onPageHide = () => queue.pagehide();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [queue]);

  const api = useMemo<PositionQueue>(
    () => ({
      change(bookId, locator) {
        queue.change({ bookId, locator });
      },
      hidden() {
        queue.hidden();
      },
      pagehide() {
        queue.pagehide();
      },
    }),
    [queue],
  );

  return (
    <PositionQueueContext.Provider value={api}>
      {children}
    </PositionQueueContext.Provider>
  );
}

export function usePositionQueue(): PositionQueue {
  const ctx = useContext(PositionQueueContext);
  if (!ctx) {
    throw new Error("usePositionQueue needs a PositionQueueProvider");
  }
  return ctx;
}
