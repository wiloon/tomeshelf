// What keeps the reading place while a settings change reflows the article:
// the element at the top edge of the viewport and how far it is scrolled past
// that edge. With the edge above the article there is none, and below its
// last element the article's bottom stands in.
export type Anchor =
  | { kind: "none" }
  | { kind: "element"; element: Element; fraction: number }
  | { kind: "end"; distance: number };

const mediaElements = new Set(["img", "svg", "video", "table", "pre", "hr"]);

function isCandidate(el: Element): boolean {
  return (
    el.hasAttribute("data-tomeshelf-block") ||
    mediaElements.has(el.localName) ||
    [...el.childNodes].some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== "",
    )
  );
}

// The outermost candidates, in document order: a candidate's descendants
// never count, and containers count only through what they hold.
function candidates(parent: Element, found: Element[] = []): Element[] {
  for (const child of parent.children) {
    if (isCandidate(child)) {
      found.push(child);
    } else {
      candidates(child, found);
    }
  }
  return found;
}

export function findAnchor(content: HTMLElement): Anchor {
  const edge = 0;
  const article = content.getBoundingClientRect();
  if (article.top > edge) {
    return { kind: "none" };
  }
  const boxes = candidates(content).map(
    (element) => [element, element.getBoundingClientRect()] as const,
  );
  const crossing = boxes.find(
    ([, box]) => box.top <= edge && box.bottom > edge,
  );
  if (crossing) {
    const [element, box] = crossing;
    return {
      kind: "element",
      element,
      fraction: (edge - box.top) / box.height,
    };
  }
  const below = boxes.find(([, box]) => box.top > edge);
  if (below) {
    return { kind: "element", element: below[0], fraction: 0 };
  }
  return { kind: "end", distance: article.bottom - edge };
}

// Runs apply, which reflows the article, and scrolls so that the anchor found
// before it sits at the top edge as it did. The browser clamps the offset to
// the page's scroll range.
export function keepingAnchor(content: HTMLElement | null, apply: () => void) {
  const before = window.scrollY;
  const anchor: Anchor = content ? findAnchor(content) : { kind: "none" };
  apply();
  let top = before;
  if (anchor.kind === "element") {
    const box = anchor.element.getBoundingClientRect();
    top = window.scrollY + box.top + anchor.fraction * box.height;
  } else if (anchor.kind === "end" && content) {
    const box = content.getBoundingClientRect();
    top = window.scrollY + box.bottom - anchor.distance;
  }
  window.scrollTo({ top, behavior: "instant" });
}
