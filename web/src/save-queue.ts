export type SaveStatus = "saved" | "saving" | "failed";

export type SaveQueue<T> = {
  // Records the current value and saves it once the debounce has passed.
  change: (value: T) => void;
  // The page became hidden: a pending save skips the rest of its debounce,
  // but still waits for a save in flight.
  hidden: () => void;
  // The page may be going away: a pending save is sent at once, even with
  // another save in flight.
  pagehide: () => void;
  // Saves the current value again after a failed save.
  retry: () => void;
  status: () => SaveStatus;
};

// Saves the latest value, debounced, with one save in flight at most, so the
// last save that arrives carries the latest value. The one exception is
// pagehide, which may send a second save beside one in flight. Once such
// overlapping saves have all finished, in whatever order, the queue saves
// the current value once more, so a page that lives on ends with it stored.
export function createSaveQueue<T>({
  delay,
  send,
  onStatus,
}: {
  delay: number;
  send: (value: T) => Promise<void>;
  onStatus?: (status: SaveStatus) => void;
}): SaveQueue<T> {
  let current: T | undefined;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;
  let overlapped = false;
  let failed = false;
  let reported: SaveStatus = "saved";

  const status = (): SaveStatus => {
    if (pending || inFlight > 0) {
      return "saving";
    }
    return failed ? "failed" : "saved";
  };

  const report = () => {
    const now = status();
    if (now !== reported) {
      reported = now;
      onStatus?.(now);
    }
  };

  const stopTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const finished = (ok: boolean) => {
    inFlight--;
    failed = !ok;
    if (inFlight === 0 && overlapped) {
      overlapped = false;
      pending = true;
      stopTimer();
    }
    if (timer === undefined) {
      sendIfFree();
    }
    report();
  };

  const sendNow = () => {
    pending = false;
    inFlight++;
    send(current as T).then(
      () => finished(true),
      () => finished(false),
    );
  };

  const sendIfFree = () => {
    if (pending && inFlight === 0) {
      sendNow();
    }
  };

  return {
    change(value) {
      current = value;
      pending = true;
      stopTimer();
      timer = setTimeout(() => {
        timer = undefined;
        sendIfFree();
        report();
      }, delay);
      report();
    },
    hidden() {
      if (timer !== undefined) {
        stopTimer();
        sendIfFree();
        report();
      }
    },
    pagehide() {
      stopTimer();
      if (!pending) {
        return;
      }
      if (inFlight > 0) {
        overlapped = true;
      }
      sendNow();
      report();
    },
    retry() {
      if (status() !== "failed") {
        return;
      }
      pending = true;
      sendIfFree();
      report();
    },
    status,
  };
}
