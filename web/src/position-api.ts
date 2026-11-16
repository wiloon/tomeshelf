import type { Locator } from "./position";

// Fresh per page load, held in memory (ADR-0005 / issue #65).
const tabId = crypto.randomUUID();
let sequence = 0;

export function readingTabId(): string {
  return tabId;
}

export function nextPositionSequence(): number {
  sequence += 1;
  return sequence;
}

export type SavePositionBody = Locator & {
  tabId: string;
  sequence: number;
};

export async function fetchPosition(bookId: string): Promise<Locator | null> {
  const res = await fetch(`/api/books/${bookId}/position`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`/api/books/${bookId}/position answered ${res.status}`);
  }
  return res.json();
}

export type PositionSave = {
  bookId: string;
  locator: Locator;
};

export async function savePosition(
  { bookId, locator }: PositionSave,
  opts: { keepalive?: boolean } = {},
): Promise<void> {
  const body: SavePositionBody = {
    ...locator,
    tabId: readingTabId(),
    sequence: nextPositionSequence(),
    locations: {
      progression: locator.locations.progression,
      cssSelector: locator.locations.cssSelector,
      characterOffset: locator.locations.characterOffset,
    },
  };
  const res = await fetch(`/api/books/${bookId}/position`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: opts.keepalive ?? false,
  });
  if (!res.ok) {
    throw new Error(`PUT position answered ${res.status}`);
  }
}
