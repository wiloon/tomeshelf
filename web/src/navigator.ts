import DOMPurify, { type Config } from "dompurify";

export type Link = {
  href: string;
  type?: string;
  title?: string;
  children?: Link[];
};

export type Manifest = {
  metadata: { title: string | Record<string, string> };
  readingOrder: Link[];
  toc?: Link[];
};

export class NotFoundError extends Error {}

declare const __TOMESHELF_VERSION__: string;

// The id of the article that holds the document's text (ADR-0006).
export const contentId = "tomeshelf-content";

// Manifest hrefs and the URLs inside a document are resolved against this
// base, so a URL that leaves its origin points outside the package.
const packageBase = "https://package.invalid/";
const packageOrigin = new URL(packageBase).origin;

const externalSchemes = new Set(["http:", "https:", "mailto:"]);

// URL attributes no rewrite rule covers; they are dropped wherever they are.
const droppedURLAttributes = [
  "srcset",
  "xlink:href",
  "poster",
  "background",
  "action",
  "formaction",
];

type Policy = NonNullable<Config["TRUSTED_TYPES_POLICY"]>;
type TrustedTypes = {
  createPolicy(
    name: string,
    rules: {
      createHTML: (input: string) => string;
      createScriptURL: (input: string) => string;
    },
  ): Policy;
};

// With Trusted Types enforced, the CSP allows only this policy (ADR-0004).
// It passes HTML through unchanged, so it must stay private to this module:
// only DOMPurify uses it, to parse a document and to return the sanitized
// result.
const policy = (
  window as { trustedTypes?: TrustedTypes }
).trustedTypes?.createPolicy("tomeshelf", {
  createHTML: (input) => input,
  createScriptURL: (input) => input,
});

export function packageURL(bookId: string, href: string): string {
  return `/api/books/${bookId}/package${new URL(href, packageBase).pathname}`;
}

export function readingURL(bookId: string, n: number): string {
  return `/books/${bookId}/read/${n}`;
}

// The reading URL, fragment kept, of a table of contents entry's href, or
// null when the href names no document in the reading order.
export function tocEntryURL(
  bookId: string,
  readingOrder: Link[],
  href: string,
): string | null {
  const url = resolve(href, new URL(packageBase));
  return url ? documentURL(bookId, readingOrder, url) : null;
}

// The reading URL, fragment kept, of the document url names in the package,
// or null when it names none in the reading order.
function documentURL(
  bookId: string,
  readingOrder: Link[],
  url: URL,
): string | null {
  if (url.origin !== packageOrigin) {
    return null;
  }
  const index = readingOrder.findIndex(
    (link) => new URL(link.href, packageBase).pathname === url.pathname,
  );
  return index < 0 ? null : `${readingURL(bookId, index + 1)}${url.hash}`;
}

export async function fetchManifest(bookId: string): Promise<Manifest> {
  const res = await fetch(`/api/books/${bookId}/manifest`);
  if (res.status === 404) {
    throw new NotFoundError(`book ${bookId} not found`);
  }
  if (!res.ok) {
    throw new Error(`manifest answered ${res.status}`);
  }
  return res.json();
}

export async function fetchDocument(
  bookId: string,
  href: string,
): Promise<string> {
  const res = await fetch(packageURL(bookId, href));
  if (!res.ok) {
    throw new Error(`${href} answered ${res.status}`);
  }
  return res.text();
}

export type DocumentPlace = {
  bookId: string;
  readingOrder: Link[];
  // The document's position in the reading order, counting from 1.
  n: number;
};

// Sanitizes one document of the book and renders it into target. The book's
// stylesheets and style attributes are dropped (ADR-0003), and its URLs are
// resolved against the document's path in the package.
export function renderDocument(
  target: HTMLElement,
  html: string,
  place: DocumentPlace,
) {
  const purify = DOMPurify(window);
  purify.addHook("afterSanitizeAttributes", (node) => {
    dropContractMarkup(node);
    rewriteURLs(node, place);
  });
  const clean = purify.sanitize(html, {
    FORBID_TAGS: [
      "style",
      "meta",
      "form",
      "input",
      "button",
      "select",
      "textarea",
    ],
    FORBID_ATTR: ["style"],
    RETURN_TRUSTED_TYPE: true,
    ...(policy && { TRUSTED_TYPES_POLICY: policy }),
  });
  target.innerHTML = clean as unknown as string;
  numberBlocks(target);
}

// The DOM contract for reading extensions (ADR-0006) is public: only the
// Navigator writes its markup, so the book's own is removed first.
function dropContractMarkup(el: Element) {
  for (const name of el.getAttributeNames()) {
    if (name.startsWith("data-tomeshelf-")) {
      el.removeAttribute(name);
    }
  }
  if (el.getAttribute("id") === contentId) {
    el.removeAttribute("id");
  }
}

// Numbers the blocks per document, from 1, in document order (ADR-0006).
// Changing which elements count breaks extensions and stored positions.
function numberBlocks(target: HTMLElement) {
  target
    .querySelectorAll("p, h1, h2, h3, h4, h5, h6, li")
    .forEach((block, i) => {
      block.setAttribute("data-tomeshelf-block", String(i + 1));
    });
}

// Marks the page as a tomeshelf reading page of the book (ADR-0006), and
// returns a function that removes the marks again.
export function markReadingPage(bookId: string): () => void {
  const tags = [
    ["generator", `tomeshelf ${__TOMESHELF_VERSION__}`],
    ["tomeshelf:book", bookId],
  ].map(([name, content]) => {
    const meta = document.createElement("meta");
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
    return meta;
  });
  return () => {
    for (const meta of tags) {
      meta.remove();
    }
  };
}

function rewriteURLs(el: Element, place: DocumentPlace) {
  for (const name of droppedURLAttributes) {
    el.removeAttribute(name);
  }
  const base = new URL(place.readingOrder[place.n - 1].href, packageBase);

  const href = el.getAttribute("href");
  if (href !== null) {
    el.removeAttribute("href");
    const link = el.localName === "a" ? resolveLink(href, base, place) : null;
    if (link) {
      el.setAttribute("href", link.href);
      if (link.external) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  }

  const src = el.getAttribute("src");
  if (src !== null) {
    el.removeAttribute("src");
    const url = el.localName === "img" ? resolve(src, base) : null;
    if (url?.origin === packageOrigin) {
      el.setAttribute("src", packageURL(place.bookId, url.pathname) + url.hash);
    }
  }
}

function resolveLink(
  href: string,
  base: URL,
  place: DocumentPlace,
): { href: string; external: boolean } | null {
  if (href.trim().startsWith("#")) {
    return { href: href.trim(), external: false };
  }
  const url = resolve(href, base);
  if (!url) {
    return null;
  }
  if (url.origin === packageOrigin) {
    const target = documentURL(place.bookId, place.readingOrder, url);
    return target ? { href: target, external: false } : null;
  }
  if (externalSchemes.has(url.protocol)) {
    return { href: url.href, external: true };
  }
  return null;
}

function resolve(url: string, base: URL): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}
