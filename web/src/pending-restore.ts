import type { Locator } from "./position";

export type PendingRestore = {
  bookId: string;
  locator: Locator | null;
  error: boolean;
};

// In-memory only: a resume replace happens in the same page load.
let pending: PendingRestore | null = null;

export function stashPendingRestore(next: PendingRestore): void {
  pending = next;
}

export function takePendingRestore(bookId: string): PendingRestore | null {
  if (!pending || pending.bookId !== bookId) {
    return null;
  }
  const out = pending;
  pending = null;
  return out;
}
