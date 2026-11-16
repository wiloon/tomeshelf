import type { NavigationKind } from "./use-reading-position";

// How the next document placement should treat its arrival (ADR-0005).
let intent: NavigationKind = "address";
let target: string | null = null;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function place(href: string): string {
  const url = new URL(href, window.location.href);
  return `${safeDecode(url.pathname)}${safeDecode(url.hash)}`;
}

// Marks the next placement as arriving through an explicit navigation to
// `href`. The mark is dropped when the navigation goes nowhere (the address
// already is `href`) and when the placement that takes it is at another
// address, so a later re-layout never reads it as an arrival.
export function setNavigationIntent(kind: NavigationKind, href?: string) {
  if (href !== undefined && place(href) === place(window.location.href)) {
    intent = "address";
    target = null;
    return;
  }
  intent = kind;
  target = href === undefined ? null : place(href);
}

export function takeNavigationIntent(): NavigationKind {
  const kind =
    target !== null && target !== place(window.location.href)
      ? "address"
      : intent;
  intent = "address";
  target = null;
  return kind;
}
