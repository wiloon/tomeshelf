import { useQuery } from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  type DocumentPlace,
  fetchDocument,
  fetchManifest,
  NotFoundError,
  renderDocument,
} from "./navigator";

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
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
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

  return <article id="tomeshelf-content" ref={ref} />;
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
        <Link to="/" className="text-sm underline">
          Library
        </Link>
        <h2 className="text-lg font-semibold">
          {manifest.data.metadata.title}
        </h2>
      </div>
      {doc.isError && (
        <Problem text="This document could not be loaded. Please try again." />
      )}
      {doc.isPending && <p role="status">Loading…</p>}
      {doc.data !== undefined && (
        <BookDocument
          html={doc.data}
          place={{ bookId: id, readingOrder: manifest.data.readingOrder, n }}
        />
      )}
      <nav aria-label="Reading order" className="flex justify-between gap-4">
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
    </div>
  );
}
