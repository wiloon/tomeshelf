import { useQuery } from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { keepingAnchor } from "./anchor";
import { setNavigationIntent, takeNavigationIntent } from "./navigation-intent";
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
import type { Turn } from "./pages";
import {
  attachPagesController,
  type PagesController,
  setPagesArrive,
  takePagesArrive,
} from "./pages-controller";
import { takePendingRestore } from "./pending-restore";
import type { Locator, PagesRestore } from "./position";
import {
  applyToPage,
  changesLayout,
  clearFromPage,
  type Layout,
  type ReadingSettings,
  SettingsPanel,
  useReadingSettings,
} from "./settings";
import { useReadingPosition } from "./use-reading-position";

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

function availableArticleWidth(article: HTMLElement): number {
  const host = article.parentElement;
  return host?.clientWidth ?? window.innerWidth;
}

function sameHref(a: string, b: string): boolean {
  try {
    return decodeURIComponent(a) === decodeURIComponent(b);
  } catch {
    return a === b;
  }
}

// The document's text, rendered into the page's own DOM (ADR-0001). It
// starts at its top, at the URL's fragment, or at a restored Locator.
function BookDocument({
  html,
  place,
  layout,
  pagesRef,
  restore,
  applyRestore,
  withoutCapture,
  markProgrammatic,
  noteArrival,
  onMove,
  onEdges,
  onExhausted,
}: {
  html: string;
  place: DocumentPlace;
  layout: Layout;
  pagesRef: RefObject<PagesController | null>;
  restore: Locator | null;
  applyRestore: (content: HTMLElement, locator: Locator) => void;
  withoutCapture: (fn: () => void) => void;
  markProgrammatic: () => void;
  noteArrival: (kind: "restore" | "address" | "move") => void;
  onMove: () => void;
  onEdges: (edges: { start: boolean; end: boolean }) => void;
  onExhausted: (direction: Turn) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const { bookId, readingOrder, n } = place;
  const { settings } = useReadingSettings();
  const textWidthRem = useRef(settings.width);
  textWidthRem.current = settings.width;
  const onExhaustedRef = useRef(onExhausted);
  onExhaustedRef.current = onExhausted;
  const onEdgesRef = useRef(onEdges);
  onEdgesRef.current = onEdges;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useLayoutEffect(() => markReadingPage(bookId), [bookId]);

  useLayoutEffect(() => {
    const article = ref.current;
    if (!article) {
      return;
    }
    renderDocument(article, html, { bookId, readingOrder, n });

    const pending = restoreRef.current;
    const kind = pending ? "restore" : takeNavigationIntent();

    if (layout !== "pages") {
      if (pending) {
        applyRestore(article, pending);
      } else {
        withoutCapture(() => {
          const target = hash
            ? document.getElementById(decodeFragment(hash))
            : undefined;
          if (target) {
            target.scrollIntoView();
          } else {
            window.scrollTo(0, 0);
          }
        });
      }
      noteArrival(kind);
      return;
    }

    const controller = attachPagesController({
      article,
      availableWidth: () => availableArticleWidth(article),
      textWidthRem: () => textWidthRem.current,
      onExhausted: (direction) => onExhaustedRef.current(direction),
      onMove: () => onMoveRef.current(),
    });
    pagesRef.current = controller;

    withoutCapture(() => {
      if (pending) {
        applyRestore(article, pending);
      } else {
        const arrive = takePagesArrive();
        const target = hash
          ? document.getElementById(decodeFragment(hash))
          : undefined;
        if (target) {
          target.scrollIntoView();
          controller.relayout();
        } else if (arrive === "end") {
          article.scrollLeft = article.scrollWidth;
          controller.relayout();
        } else {
          article.scrollLeft = 0;
        }
      }
      markProgrammatic();
      onEdgesRef.current({
        start: controller.atStart(),
        end: controller.atEnd(),
      });
    });
    noteArrival(kind);

    const onScroll = () =>
      onEdgesRef.current({
        start: controller.atStart(),
        end: controller.atEnd(),
      });
    article.addEventListener("scroll", onScroll, { passive: true });
    const onResize = () => controller.relayout();
    window.addEventListener("resize", onResize);

    return () => {
      article.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      controller.destroy();
      if (pagesRef.current === controller) {
        pagesRef.current = null;
      }
    };
  }, [
    html,
    bookId,
    readingOrder,
    n,
    hash,
    layout,
    pagesRef,
    applyRestore,
    withoutCapture,
    markProgrammatic,
    noteArrival,
  ]);

  // Links to other documents (or fragments) move within the app and count as
  // an explicit navigation arrival (ADR-0005).
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
      if (link?.target || !href) {
        return;
      }
      if (href.startsWith("#")) {
        setNavigationIntent("move", href);
        return;
      }
      if (!href.startsWith("/books/")) {
        return;
      }
      event.preventDefault();
      setNavigationIntent("move", href);
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
    setNavigationIntent("move", href);
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
// reflows the text keeps the place; a theme change does not scroll.
function useSettingsOnPage(
  settings: ReadingSettings,
  pagesRef: RefObject<PagesController | null>,
  withoutCapture: (fn: () => void) => void,
  syncLocator: () => void,
  reapplyLocator: () => boolean,
) {
  const applied = useRef<ReadingSettings | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const previous = applied.current;
    applied.current = settings;
    if (settings.layout === "pages") {
      if (pagesRef.current && previous && changesLayout(previous, settings)) {
        withoutCapture(() => {
          pagesRef.current?.relayout(() => applyToPage(settings));
        });
        if (previous.layout !== settings.layout) {
          reapplyLocator();
        } else {
          syncLocator();
        }
      } else {
        applyToPage(settings);
      }
    } else if (previous && changesLayout(previous, settings)) {
      withoutCapture(() => {
        keepingAnchor(document.getElementById(contentId), () =>
          applyToPage(settings),
        );
      });
      if (previous.layout !== settings.layout) {
        reapplyLocator();
      } else {
        syncLocator();
      }
    } else {
      applyToPage(settings);
    }
    setReady(true);
  }, [settings, pagesRef, withoutCapture, syncLocator, reapplyLocator]);

  useLayoutEffect(
    () => () => {
      applied.current = null;
      clearFromPage();
    },
    [],
  );
  return ready;
}

function ScrollOrderNav({
  id,
  n,
  length,
  onNavigate,
}: {
  id: string;
  n: number;
  length: number;
  onNavigate: () => void;
}) {
  return (
    <nav
      aria-label="Reading order"
      className="reading-column flex justify-between gap-4"
    >
      {n > 1 ? (
        <Link
          to="/books/$id/read/$n"
          params={{ id, n: String(n - 1) }}
          className="underline"
          onClick={onNavigate}
        >
          Previous
        </Link>
      ) : (
        <span />
      )}
      {n < length && (
        <Link
          to="/books/$id/read/$n"
          params={{ id, n: String(n + 1) }}
          className="underline"
          onClick={onNavigate}
        >
          Next
        </Link>
      )}
    </nav>
  );
}

function PagesOrderNav({
  n,
  length,
  edges,
  onTurn,
}: {
  n: number;
  length: number;
  edges: { start: boolean; end: boolean };
  onTurn: (direction: Turn) => void;
}) {
  const showPrevious = !(edges.start && n <= 1);
  const showNext = !(edges.end && n >= length);
  return (
    <nav
      aria-label="Reading order"
      className="reading-column flex justify-between gap-4"
    >
      {showPrevious ? (
        <button
          type="button"
          onClick={() => onTurn("previous")}
          className="underline"
        >
          Previous
        </button>
      ) : (
        <span />
      )}
      {showNext ? (
        <button
          type="button"
          onClick={() => onTurn("next")}
          className="underline"
        >
          Next
        </button>
      ) : (
        <span />
      )}
    </nav>
  );
}

export function ReaderPage() {
  const { id, n: param } = route.useParams();
  const n = /^[1-9]\d*$/.test(param) ? Number(param) : 0;
  const navigate = useNavigate();
  const [pending] = useState(() => takePendingRestore(id));
  const [restore, setRestore] = useState<Locator | null>(
    () => pending?.locator ?? null,
  );
  const [positionError] = useState(() => pending?.error ?? false);
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
  const pagesRef = useRef<PagesController | null>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const { settings, load, loadSettled } = useReadingSettings();
  const pagesRestore = useCallback((): PagesRestore | null => {
    const controller = pagesRef.current;
    if (!controller) {
      return null;
    }
    return {
      prepareProgression: () => controller.prepareProgression(),
      showCharacter: (node, offset) => controller.showCharacter(node, offset),
      showProgression: (progression) => controller.showProgression(progression),
    };
  }, []);
  const {
    applyRestore,
    withoutCapture,
    syncLocator,
    reapplyLocator,
    recordMove,
    noteArrival,
    markProgrammatic,
    flushDeparting,
  } = useReadingPosition({
    bookId: id,
    href: href ?? "",
    layout: settings.layout,
    enabled: Boolean(href),
    pagesRestore,
  });
  const applyRestoreOnce = useCallback(
    (content: HTMLElement, locator: Locator) => {
      applyRestore(content, locator);
      setRestore(null);
    },
    [applyRestore],
  );
  const settingsReady = useSettingsOnPage(
    settings,
    pagesRef,
    withoutCapture,
    syncLocator,
    reapplyLocator,
  );
  useEffect(() => load(), [load]);
  const closeSettings = () => {
    setSettingsOpen(false);
    settingsButton.current?.focus({ preventScroll: true });
  };

  const onExhausted = (direction: Turn) => {
    if (direction === "next" && n < readingOrder.length) {
      setPagesArrive("start");
      setNavigationIntent("move");
      void navigate({
        to: "/books/$id/read/$n",
        params: { id, n: String(n + 1) },
      });
    } else if (direction === "previous" && n > 1) {
      setPagesArrive("end");
      setNavigationIntent("move");
      void navigate({
        to: "/books/$id/read/$n",
        params: { id, n: String(n - 1) },
      });
    }
  };

  const turn = (direction: Turn) => {
    pagesRef.current?.turn(direction);
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

  const pages = settings.layout === "pages";
  const restoreToApply =
    restore && sameHref(restore.href, href ?? "") ? restore : null;
  // A resume restore waits for settings to settle so a saved scroll layout is
  // not painted as pages first (ADR-0005). Ordinary opens do not wait.
  const waitingForRestore = Boolean(restoreToApply) && !loadSettled;
  const showDocument =
    settingsReady && doc.data !== undefined && !waitingForRestore;

  return (
    <div className={pages ? "reading-pages" : "flex flex-col gap-6"}>
      <div className={`flex flex-col gap-1 ${pages ? "reading-chrome" : ""}`}>
        <div className="flex justify-between gap-4 text-sm">
          <Link to="/" className="underline" onClick={() => flushDeparting()}>
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
      {positionError && (
        <p role="alert" className="text-red-700">
          The reading position could not be loaded.
        </p>
      )}
      {doc.isError && (
        <Problem text="This document could not be loaded. Please try again." />
      )}
      {doc.isPending && <p role="status">Loading…</p>}
      {showDocument && (
        <BookDocument
          html={doc.data}
          place={{ bookId: id, readingOrder: manifest.data.readingOrder, n }}
          layout={settings.layout}
          pagesRef={pagesRef}
          restore={restoreToApply}
          applyRestore={applyRestoreOnce}
          withoutCapture={withoutCapture}
          markProgrammatic={markProgrammatic}
          noteArrival={noteArrival}
          onMove={recordMove}
          onEdges={setEdges}
          onExhausted={onExhausted}
        />
      )}
      {pages ? (
        <PagesOrderNav
          n={n}
          length={readingOrder.length}
          edges={edges}
          onTurn={turn}
        />
      ) : (
        <ScrollOrderNav
          id={id}
          n={n}
          length={readingOrder.length}
          onNavigate={() => setNavigationIntent("move")}
        />
      )}
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
