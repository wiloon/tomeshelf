import { useQuery } from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { keepingAnchor } from "./anchor";
import {
  contentId,
  type DocumentPlace,
  fetchDocument,
  fetchManifest,
  type Link as ManifestLink,
  markReadingPage,
  NotFoundError,
  renderDocument,
  tocEntryURL,
} from "./navigator";
import {
  applyToPage,
  changesLayout,
  clearFromPage,
  type ReadingSettings,
  SettingsPanel,
  useReadingSettings,
} from "./settings";

const route = getRouteApi("/books/$id/read/$n");

function Problem({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p role="alert" className="text-red-700">
        {text}
      </p>
      <Link to="/" className="underline">
        Back to the library
      </Link>
    </div>
  );
}

// A plain left click, which the app may take over; any other click keeps the
// browser's own behaviour, such as opening a new tab.
function isPlainClick(event: MouseEvent | ReactMouseEvent): boolean {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

function decodeFragment(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

// The document's text, rendered into the page's own DOM (ADR-0001). It
// starts at its top, or at the URL's fragment.
function BookDocument({ html, place }: { html: string; place: DocumentPlace }) {
  const ref = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const { bookId, readingOrder, n } = place;

  useLayoutEffect(() => markReadingPage(bookId), [bookId]);

  useLayoutEffect(() => {
    if (!ref.current) {
      return;
    }
    renderDocument(ref.current, html, { bookId, readingOrder, n });
    const target = hash
      ? document.getElementById(decodeFragment(hash))
      : undefined;
    if (target) {
      target.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
  }, [html, bookId, readingOrder, n, hash]);

  // Links to other documents move within the app instead of reloading it.
  useEffect(() => {
    const article = ref.current;
    if (!article) {
      return;
    }
    const onClick = (event: MouseEvent) => {
      if (!isPlainClick(event)) {
        return;
      }
      const link = (event.target as Element).closest("a");
      const href = link?.getAttribute("href");
      if (link?.target || !href?.startsWith("/books/")) {
        return;
      }
      event.preventDefault();
      void navigate({ href });
    };
    article.addEventListener("click", onClick);
    return () => article.removeEventListener("click", onClick);
  }, [navigate]);

  return <article id={contentId} ref={ref} />;
}

// The book's table of contents, in a panel over the page and outside the
// article. An entry whose href names no document in the reading order is
// plain text; its children stay usable.
function TableOfContents({
  open,
  onClose,
  bookId,
  readingOrder,
  toc,
}: {
  open: boolean;
  onClose: () => void;
  bookId: string;
  readingOrder: ManifestLink[];
  toc: ManifestLink[];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) {
      dialog?.showModal();
    } else if (!open && dialog?.open) {
      dialog.close();
    }
  }, [open]);

  const choose = (event: ReactMouseEvent, href: string) => {
    if (!isPlainClick(event)) {
      return;
    }
    event.preventDefault();
    ref.current?.close();
    void navigate({ href });
  };

  const list = (entries: ManifestLink[], nested = false) => (
    <ol className={`flex flex-col gap-1 ${nested ? "mt-1 pl-4" : ""}`}>
      {entries.map((entry, i) => {
        const href = tocEntryURL(bookId, readingOrder, entry.href);
        const title = entry.title ?? entry.href;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries never move, and their hrefs may repeat.
          <li key={i}>
            {href ? (
              <a
                href={href}
                onClick={(event) => choose(event, href)}
                className="underline"
              >
                {title}
              </a>
            ) : (
              <span>{title}</span>
            )}
            {entry.children?.length ? list(entry.children, true) : null}
          </li>
        );
      })}
    </ol>
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog natively.
    <dialog
      ref={ref}
      aria-label="Contents"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          event.currentTarget.close();
        }
      }}
      className="h-full max-h-full w-full max-w-sm overflow-y-auto bg-(--page-bg) text-(--page-fg) shadow-xl backdrop:bg-black/40"
    >
      <div className="flex min-h-full flex-col gap-4 p-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Contents</h2>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="underline"
          >
            Close
          </button>
        </div>
        <nav aria-label="Table of contents" className="break-words">
          {toc.length > 0 ? (
            list(toc)
          ) : (
            <p>This book has no table of contents.</p>
          )}
        </nav>
      </div>
    </dialog>
  );
}

// Applies the reading settings while the reader is open. A change that
// reflows the text keeps the element at the top of the viewport in place; a
// theme change does not scroll.
function useSettingsOnPage(settings: ReadingSettings) {
  const applied = useRef<ReadingSettings | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const previous = applied.current;
    applied.current = settings;
    if (previous && changesLayout(previous, settings)) {
      keepingAnchor(document.getElementById(contentId), () =>
        applyToPage(settings),
      );
    } else {
      applyToPage(settings);
    }
    setReady(true);
  }, [settings]);

  useLayoutEffect(
    () => () => {
      applied.current = null;
      clearFromPage();
    },
    [],
  );
  return ready;
}

export function ReaderPage() {
  const { id, n: param } = route.useParams();
  const n = /^[1-9]\d*$/.test(param) ? Number(param) : 0;
  const manifest = useQuery({
    queryKey: ["manifest", id],
    queryFn: () => fetchManifest(id),
    enabled: n > 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const readingOrder = manifest.data?.readingOrder ?? [];
  const href = readingOrder[n - 1]?.href;
  const doc = useQuery({
    queryKey: ["document", id, href],
    queryFn: () => fetchDocument(id, href ?? ""),
    enabled: href !== undefined,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [contentsOpen, setContentsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const { settings, load } = useReadingSettings();
  const settingsReady = useSettingsOnPage(settings);
  useEffect(() => load(), [load]);
  const closeSettings = () => {
    setSettingsOpen(false);
    settingsButton.current?.focus({ preventScroll: true });
  };

  const notFound = (
    <Problem text="This book or document was not found in your library." />
  );
  if (n === 0 || manifest.error instanceof NotFoundError) {
    return notFound;
  }
  if (manifest.isError) {
    return <Problem text="This book could not be loaded. Please try again." />;
  }
  if (!manifest.data) {
    return <p role="status">Loading…</p>;
  }
  if (href === undefined) {
    return notFound;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="flex justify-between gap-4 text-sm">
          <Link to="/" className="underline">
            Library
          </Link>
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => setContentsOpen(true)}
              className="underline"
            >
              Contents
            </button>
            <button
              ref={settingsButton}
              type="button"
              aria-expanded={settingsOpen}
              aria-controls={settingsOpen ? "reading-settings" : undefined}
              onClick={() => setSettingsOpen(!settingsOpen)}
              className="underline"
            >
              Settings
            </button>
          </div>
        </div>
        {settingsOpen && (
          <SettingsPanel id="reading-settings" onClose={closeSettings} />
        )}
        <h2 className="text-lg font-semibold">
          {typeof manifest.data.metadata.title === "string"
            ? manifest.data.metadata.title
            : Object.values(manifest.data.metadata.title)[0]}
        </h2>
      </div>
      {doc.isError && (
        <Problem text="This document could not be loaded. Please try again." />
      )}
      {doc.isPending && <p role="status">Loading…</p>}
      {settingsReady && doc.data !== undefined && (
        <BookDocument
          html={doc.data}
          place={{ bookId: id, readingOrder: manifest.data.readingOrder, n }}
        />
      )}
      <nav
        aria-label="Reading order"
        className="reading-column flex justify-between gap-4"
      >
        {n > 1 ? (
          <Link
            to="/books/$id/read/$n"
            params={{ id, n: String(n - 1) }}
            className="underline"
          >
            Previous
          </Link>
        ) : (
          <span />
        )}
        {n < readingOrder.length && (
          <Link
            to="/books/$id/read/$n"
            params={{ id, n: String(n + 1) }}
            className="underline"
          >
            Next
          </Link>
        )}
      </nav>
      <TableOfContents
        open={contentsOpen}
        onClose={() => setContentsOpen(false)}
        bookId={id}
        readingOrder={manifest.data.readingOrder}
        toc={manifest.data.toc ?? []}
      />
    </div>
  );
}
