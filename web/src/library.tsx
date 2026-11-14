import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";
import { AccountBar } from "./auth";

type Book = { id: number; title: string; authors: string[] };

type Outcome = { ok: boolean; text: string };

async function fetchBooks(): Promise<Book[]> {
  const res = await fetch("/api/books");
  if (!res.ok) {
    throw new Error(`/api/books answered ${res.status}`);
  }
  return res.json();
}

// Uploads one EPUB and returns what to tell the user.
async function importBook(file: File): Promise<Outcome> {
  const res = await fetch("/api/books", {
    method: "POST",
    headers: { "Content-Type": "application/epub+zip" },
    body: file,
  });
  const body = await res.json().catch(() => null);
  if (res.ok) {
    return { ok: true, text: `Imported ${body.title}.` };
  }
  return {
    ok: false,
    text:
      body?.error ?? `Something went wrong (${res.status}). Please try again.`,
  };
}

// Deletes one book and returns what to tell the user. A 404 means the book
// is already gone, which is what the user asked for.
async function deleteBook(book: Book): Promise<Outcome> {
  const res = await fetch(`/api/books/${book.id}`, { method: "DELETE" });
  if (res.ok || res.status === 404) {
    return { ok: true, text: `Deleted ${book.title}.` };
  }
  return {
    ok: false,
    text: `${book.title} could not be deleted (${res.status}). Please try again.`,
  };
}

// Asks to confirm deleting book while it is set. Cancel, Escape and a
// click outside close it without deleting.
function DeleteDialog({
  book,
  onClose,
  onConfirm,
}: {
  book: Book | null;
  onClose: () => void;
  onConfirm: (book: Book) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (book && !dialog?.open) {
      dialog?.showModal();
    } else if (!book && dialog?.open) {
      dialog.close();
    }
  }, [book]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog natively.
    <dialog
      ref={ref}
      aria-labelledby={`${id}-heading`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          event.currentTarget.close();
        }
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded bg-(--panel-bg) p-4 text-(--page-fg) shadow-xl backdrop:bg-black/40"
    >
      {book && (
        <div className="flex flex-col gap-4">
          <h2 id={`${id}-heading`} className="text-lg font-semibold">
            Delete book
          </h2>
          <p className="wrap-anywhere">
            Delete <strong>{book.title}</strong> from your library? This cannot
            be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="rounded border border-stone-300 px-3 py-1.5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirm(book)}
              className="rounded bg-red-700 px-3 py-1.5 text-white"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

// The book's cover thumbnail, or its title when the server has no usable
// cover for it. The thumbnail repeats the title next to it, so it has no alt
// text.
function Cover({ book }: { book: Book }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="aspect-[2/3] w-full overflow-hidden rounded bg-stone-200">
      {failed ? (
        <div
          data-testid="cover-placeholder"
          aria-hidden="true"
          className="flex h-full items-center justify-center p-2 text-center text-sm font-medium text-stone-700 wrap-anywhere"
        >
          {book.title}
        </div>
      ) : (
        <img
          src={`/api/books/${book.id}/thumbnail`}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}

export function LibraryPage() {
  const queryClient = useQueryClient();
  const books = useQuery({ queryKey: ["books"], queryFn: fetchBooks });
  const id = useId();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<Book | null>(null);

  async function onDeleteConfirmed(book: Book) {
    setConfirming(null);
    setOutcome(null);
    let result: Outcome;
    try {
      result = await deleteBook(book);
    } catch {
      result = {
        ok: false,
        text: "tomeshelf could not be reached. Please try again.",
      };
    }
    setOutcome(result);
    if (result.ok) {
      queryClient.setQueryData<Book[]>(["books"], (list) =>
        list?.filter((b) => b.id !== book.id),
      );
    }
    await queryClient.invalidateQueries({ queryKey: ["books"] });
  }

  async function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    setOutcome(null);
    setPending(true);
    try {
      setOutcome(await importBook(file));
    } catch {
      setOutcome({
        ok: false,
        text: "tomeshelf could not be reached. Please try again.",
      });
    } finally {
      input.value = "";
      setPending(false);
      await queryClient.invalidateQueries({ queryKey: ["books"] });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <AccountBar />
      <section className="flex flex-col gap-3">
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          Library
        </h2>
        <label htmlFor={`${id}-file`} className="flex flex-col gap-1">
          Import an EPUB
          <input
            id={`${id}-file`}
            type="file"
            accept=".epub,application/epub+zip"
            disabled={pending}
            onChange={onFileChosen}
          />
        </label>
        {outcome?.ok && <p role="status">{outcome.text}</p>}
        {outcome && !outcome.ok && (
          <p role="alert" className="text-red-700">
            {outcome.text}
          </p>
        )}
        {books.isError && (
          <p role="alert" className="text-red-700">
            The library could not be loaded. Please reload the page.
          </p>
        )}
        {books.data?.length === 0 && <p>No books yet.</p>}
        {books.data && books.data.length > 0 && (
          <ul
            aria-labelledby={`${id}-heading`}
            className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
          >
            {books.data.map((book) => (
              <li key={book.id} className="flex min-w-0 flex-col gap-1">
                <Link
                  to="/books/$id/read/$n"
                  params={{ id: String(book.id), n: "1" }}
                  className="flex flex-col gap-1"
                >
                  <Cover book={book} />
                  <span className="font-medium wrap-anywhere">
                    {book.title}
                  </span>
                  {book.authors.length > 0 && (
                    <span className="text-sm text-stone-600 wrap-anywhere">
                      {" "}
                      by {book.authors.join(", ")}
                    </span>
                  )}
                </Link>
                <button
                  type="button"
                  aria-label={`Delete ${book.title}`}
                  onClick={() => setConfirming(book)}
                  className="self-start text-sm text-stone-600 underline"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <DeleteDialog
        book={confirming}
        onClose={() => setConfirming(null)}
        onConfirm={onDeleteConfirmed}
      />
    </div>
  );
}
