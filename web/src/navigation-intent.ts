import type { NavigationKind } from "./use-reading-position";

// How the next document placement should treat its arrival (ADR-0005).
let intent: NavigationKind = "address";

export function setNavigationIntent(kind: NavigationKind) {
  intent = kind;
}

export function takeNavigationIntent(): NavigationKind {
  const kind = intent;
  intent = "address";
  return kind;
}
