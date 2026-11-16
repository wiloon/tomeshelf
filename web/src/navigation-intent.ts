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

function placePath(href: string): string {
  return safeDecode(new URL(href, window.location.href).pathname);
}

// Marks the next placement as arriving through an explicit navigation to
// `href`. The mark is dropped when the navigation goes nowhere (the address
// already is `href`) and when the placement that takes it is at another
// document, so a later re-layout never reads it as an arrival. Pathname
// alone decides "another document": a cross-document link's hash may land
// after the first placement run.
//
// `force` keeps the mark when the router has already updated the address
// before the click handler runs (article links in capture/bubble order).
export function setNavigationIntent(
  kind: NavigationKind,
  href?: string,
  opts?: { force?: boolean },
) {
  if (
    !opts?.force &&
    href !== undefined &&
    place(href) === place(window.location.href)
  ) {
    intent = "address";
    target = null;
    return;
  }
  intent = kind;
  target = href === undefined ? null : place(href);
}

export function takeNavigationIntent(): NavigationKind {
  // Placement on another document leaves the mark for the real arrival.
  if (
    target !== null &&
    placePath(target) !== placePath(window.location.href)
  ) {
    return "address";
  }
  const kind = intent;
  intent = "address";
  target = null;
  return kind;
}
