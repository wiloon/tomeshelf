import type { Locator } from "./position";

export type PendingRestore = {
  bookId: string;
  locator: Locator | null;
  error: boolean;
};

const key = "tomeshelf-pending-restore";

export function stashPendingRestore(pending: PendingRestore): void {
  sessionStorage.setItem(key, JSON.stringify(pending));
}

export function takePendingRestore(bookId: string): PendingRestore | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) {
    return null;
  }
  sessionStorage.removeItem(key);
  try {
    const pending = JSON.parse(raw) as PendingRestore;
    return pending.bookId === bookId ? pending : null;
  } catch {
    return null;
  }
}
