export type SaveStatus = "saved" | "saving" | "failed";

export type SaveQueue<T> = {
  // Records the current value and saves it once the debounce has passed.
  change: (value: T) => void;
  // The page became hidden: a pending save skips the rest of its debounce,
  // but still waits for a save in flight.
  hidden: () => void;
  // Sends the latest unsent value and waits for every send to settle,
  // without retrying a value that has already failed.
  flush: () => Promise<void>;
  // The page may be going away: a pending save is sent at once, even with
  // another save in flight.
  pagehide: () => void;
  // Saves the current value again after a failed save.
  retry: () => void;
  status: () => SaveStatus;
  dispose: () => void;
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
  let disposed = false;
  let current: T | undefined;
  let pending = false;
  // Unlike pending, this is not restored by a failed send.
  let unsent = false;
  const active = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;
  let overlapped = false;
  let failed = false;
  let reported: SaveStatus = "saved";

  const status = (): SaveStatus => {
    // A failed value stays pending for hide/pagehide, but is not "saving"
    // until a timer or send is actually running.
    if (inFlight > 0 || timer !== undefined) {
      return "saving";
    }
    if (failed) {
      return "failed";
    }
    if (pending) {
      return "saving";
    }
    return "saved";
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
    if (disposed) return;
    inFlight--;
    failed = !ok;
    if (!ok) {
      // Keep the value pending so hide/pagehide and the next change resend it,
      // without retrying in a tight loop here.
      pending = true;
    }
    if (inFlight === 0 && overlapped) {
      overlapped = false;
      pending = true;
      stopTimer();
      sendIfFree();
      report();
      return;
    }
    if (timer === undefined && ok) {
      sendIfFree();
    }
    report();
  };

  const sendNow = () => {
    pending = false;
    unsent = false;
    inFlight++;
    const sent = send(current as T).then(
      () => finished(true),
      () => finished(false),
    );
    active.add(sent);
    void sent.then(() => active.delete(sent));
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
      unsent = true;
      stopTimer();
      timer = setTimeout(() => {
        timer = undefined;
        sendIfFree();
        report();
      }, delay);
      report();
    },
    async flush() {
      stopTimer();
      while (!disposed && (unsent || active.size > 0)) {
        stopTimer();
        if (unsent && inFlight === 0) sendNow();
        await Promise.all(active);
      }
      report();
    },
    hidden() {
      if (timer === undefined && !pending) {
        return;
      }
      stopTimer();
      sendIfFree();
      report();
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
    dispose() {
      disposed = true;
      pending = false;
      stopTimer();
    },
  };
}
