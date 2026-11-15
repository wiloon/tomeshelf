// Paginated reading: pages that fit the window, one or two per spread
// (ADR-0010). Pure geometry and input helpers; the reader wires them.

export const columnGapPx = 24;

export type SpreadMetrics = {
  pageWidth: number;
  pagesPerSpread: 1 | 2;
  spreadWidth: number;
  gap: number;
};

// availableWidth is the space the article may occupy; textWidthPx is the
// reading width setting in pixels. Two pages when that space holds two at
// the setting plus the gap; otherwise one, capped by the space.
export function spreadMetrics(
  availableWidth: number,
  textWidthPx: number,
  gap: number = columnGapPx,
): SpreadMetrics {
  const pagesPerSpread: 1 | 2 = availableWidth >= 2 * textWidthPx + gap ? 2 : 1;
  if (pagesPerSpread === 2) {
    return {
      pageWidth: textWidthPx,
      pagesPerSpread,
      spreadWidth: 2 * textWidthPx + gap,
      gap,
    };
  }
  const pageWidth = Math.min(textWidthPx, availableWidth);
  return { pageWidth, pagesPerSpread, spreadWidth: pageWidth, gap };
}

// One spread's scroll pitch: each page is followed by a column gap in the
// multicol flow, including after the last page of the spread.
export function spreadStep(metrics: SpreadMetrics): number {
  return metrics.pagesPerSpread * (metrics.pageWidth + metrics.gap);
}

export function snapSpreadOffset(scrollLeft: number, step: number): number {
  if (step <= 0) {
    return 0;
  }
  return Math.round(scrollLeft / step) * step;
}

export type Turn = "next" | "previous";

export function keyTurnsSpread(event: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): Turn | null {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return null;
  }
  if (event.shiftKey && event.key !== " ") {
    return null;
  }
  switch (event.key) {
    case "ArrowRight":
    case "PageDown":
      return "next";
    case "ArrowLeft":
    case "PageUp":
      return "previous";
    case " ":
      return event.shiftKey ? "previous" : "next";
    default:
      return null;
  }
}

// Focus that owns the arrow keys or typing: leave those keys to it.
export function isEditableTarget(
  target: {
    tagName: string;
    type?: string;
    isContentEditable?: boolean;
  } | null,
): boolean {
  if (!target) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName.toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "BUTTON" ||
    tag === "A"
  );
}

export function eventTargetIsEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const el = target as HTMLElement;
  return isEditableTarget({
    tagName: el.tagName,
    type: el instanceof HTMLInputElement ? el.type : undefined,
    isContentEditable: el.isContentEditable,
  });
}

// Wheel and trackpad momentum belong to one gesture until the wheel has
// been quiet for quietMs (ADR-0010).
export class WheelBurst {
  private lastEvent = Number.NEGATIVE_INFINITY;

  constructor(private readonly quietMs: number) {}

  consume(nowMs: number): boolean {
    const fresh = nowMs - this.lastEvent >= this.quietMs;
    this.lastEvent = nowMs;
    return fresh;
  }
}
