import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { fetchManifest, NotFoundError } from "./navigator";
import { stashPendingRestore } from "./pending-restore";
import { fetchPosition } from "./position-api";

const route = getRouteApi("/books/$id/read");

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

// The resume address: load the stored position and replace this URL with the
// stored document's address (ADR-0005).
export function ResumePage() {
  const { id } = route.useParams();
  const navigate = useNavigate();
  const manifest = useQuery({
    queryKey: ["manifest", id],
    queryFn: () => fetchManifest(id),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const position = useQuery({
    queryKey: ["position", id],
    queryFn: () => fetchPosition(id),
    retry: false,
  });

  useEffect(() => {
    if (!manifest.data || position.isFetching) {
      return;
    }
    const readingOrder = manifest.data.readingOrder;
    if (readingOrder.length === 0) {
      return;
    }

    let n = 1;
    let error = false;
    let locator = null;

    if (position.isError) {
      error = true;
    } else if (position.data) {
      const stored = position.data;
      const index = readingOrder.findIndex((link) => link.href === stored.href);
      if (index >= 0) {
        n = index + 1;
        locator = stored;
      }
    }

    stashPendingRestore({ bookId: id, locator, error });
    void navigate({
      to: "/books/$id/read/$n",
      params: { id, n: String(n) },
      replace: true,
    });
  }, [
    manifest.data,
    position.isFetching,
    position.isError,
    position.data,
    id,
    navigate,
  ]);

  if (manifest.error instanceof NotFoundError) {
    return (
      <Problem text="This book or document was not found in your library." />
    );
  }
  if (manifest.isError) {
    return <Problem text="This book could not be loaded. Please try again." />;
  }
  if (manifest.data && manifest.data.readingOrder.length === 0) {
    return (
      <Problem text="This book or document was not found in your library." />
    );
  }

  return <p role="status">Loading…</p>;
}
