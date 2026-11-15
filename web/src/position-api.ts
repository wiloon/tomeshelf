import type { Locator } from "./position";

const tabKey = "tomeshelf-tab-id";
const seqKey = "tomeshelf-position-seq";

export function tabId(): string {
  let id = sessionStorage.getItem(tabKey);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(tabKey, id);
  }
  return id;
}

export function nextSequence(): number {
  const current = Number(sessionStorage.getItem(seqKey) ?? "0");
  const next = current + 1;
  sessionStorage.setItem(seqKey, String(next));
  return next;
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

export async function savePosition(
  bookId: string,
  locator: Locator,
  opts: { keepalive?: boolean } = {},
): Promise<void> {
  const body: SavePositionBody = {
    ...locator,
    tabId: tabId(),
    sequence: nextSequence(),
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
