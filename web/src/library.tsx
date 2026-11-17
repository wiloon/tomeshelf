import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";

import { continueReadingBook } from "./continue-reading";

type Book = {
  id: number;
  title: string;
  authors: string[];
  progress?: number;
  savedAt?: number;
  importedAt: number;
};

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

// Keep the trigger mounted while the menu and confirmation come and go.
function CardMenu({
  book,
  onDelete,
}: {
  book: Book;
  onDelete: (button: HTMLButtonElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    item.current?.focus();
    const close = () => {
      setOpen(false);
      button.current?.focus();
    };
    const outside = (event: MouseEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      // Clicking another control (e.g. another card's ⋯) moves focus there;
      // only restore our trigger when the click landed on inert content.
      const target = event.target as Element;
      if (target.closest?.("a, button, input, select, textarea, [tabindex]")) {
        setOpen(false);
      } else {
        close();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("click", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={root} className="relative self-end">
      <button
        ref={button}
        type="button"
        aria-label={`More actions for ${book.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="rounded px-3 py-1 text-xl focus-visible:outline-2 focus-visible:outline-[var(--action-accent)] [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        ⋯
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={`Actions for ${book.title}`}
          className="absolute right-0 z-10 min-w-32 rounded border border-stone-300 bg-(--panel-bg) p-1 shadow-lg"
        >
          <button
            ref={item}
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              if (button.current) onDelete(button.current);
            }}
            className="w-full rounded px-3 py-2 text-left text-red-700 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-[var(--action-accent)]"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// The book's cover thumbnail, or its title when the server has no usable
// cover for it. The thumbnail repeats the title next to it, so it has no alt
// text.
function Cover({ book }: { book: Book }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden rounded bg-stone-200 shadow-sm group-hover:shadow-lg">
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
      {book.progress !== undefined && (
        <div
          role="progressbar"
          aria-label={`Reading progress: ${book.progress}%`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={book.progress}
          aria-valuetext={`${book.progress}%`}
          className="absolute inset-x-0 bottom-0 h-1.5 bg-white shadow-[0_0_0_1px_#1c1917]"
        >
          <div
            className="h-full bg-[var(--action-accent)]"
            style={{ width: `${book.progress}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function LibraryPage() {
  const queryClient = useQueryClient();
  const books = useQuery({ queryKey: ["books"], queryFn: fetchBooks });
  const continuing = continueReadingBook(books.data ?? []);
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);
  const importing = useRef(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) reset();
    };
    const reset = () => {
      depth = 0;
      setDragging(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") reset();
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", reset);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", reset);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", reset);
    };
  }, []);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
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

  async function runImport(file: File) {
    if (importing.current) return;
    importing.current = true;
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
      if (fileInput.current) fileInput.current.value = "";
      importing.current = false;
      setPending(false);
      await queryClient.invalidateQueries({ queryKey: ["books"] });
    }
  }

  function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) void runImport(file);
  }

  const onDrop = useEffectEvent((event: DragEvent) => {
    if (importing.current) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const file = files.find(
      (file) =>
        /\.epub$/i.test(file.name) || file.type === "application/epub+zip",
    );
    if (file) void runImport(file);
    else setOutcome({ ok: false, text: "Please choose an EPUB file." });
  });
  useEffect(() => {
    const drop = (event: DragEvent) => onDrop(event);
    window.addEventListener("drop", drop);
    return () => window.removeEventListener("drop", drop);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[1536px] flex-col gap-6">
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-4 border-dashed border-[var(--action-accent)] bg-(--page-bg) text-xl font-semibold">
          Drop an EPUB to import it
        </div>
      )}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${id}-heading`} className="text-lg font-semibold">
            Library
          </h2>
          <button
            type="button"
            className="rounded bg-[var(--action-accent)] px-4 py-2 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action-accent)] disabled:cursor-wait"
            disabled={pending}
            onClick={() => fileInput.current?.click()}
          >
            {pending ? "Importing…" : "Import EPUB"}
          </button>
        </div>
        <label htmlFor={`${id}-file`} className="sr-only">
          Import an EPUB
        </label>
        <input
          ref={fileInput}
          id={`${id}-file`}
          className="sr-only"
          tabIndex={-1}
          type="file"
          accept=".epub,application/epub+zip"
          disabled={pending}
          onChange={onFileChosen}
        />
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
        {books.data?.length === 0 && (
          <p>No books yet. Import an EPUB to start reading.</p>
        )}
        {continuing && (
          <section
            aria-labelledby={`${id}-continue`}
            className="rounded-lg border border-stone-300 bg-(--panel-bg) p-4"
          >
            <h2 id={`${id}-continue`} className="mb-3 text-lg font-semibold">
              Continue reading
            </h2>
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
              <Link
                to="/books/$id/read"
                params={{ id: String(continuing.id) }}
                aria-label="Resume from cover"
                className="w-24 shrink-0 sm:w-32"
              >
                <Cover key={continuing.id} book={continuing} />
              </Link>
              <div className="flex min-w-0 flex-col items-start gap-2">
                <h3
                  className="line-clamp-2 text-xl font-semibold wrap-anywhere"
                  title={continuing.title}
                >
                  {continuing.title}
                </h3>
                {continuing.authors.length > 0 && (
                  <p
                    className="line-clamp-2 text-sm wrap-anywhere"
                    title={continuing.authors.join(", ")}
                  >
                    {continuing.authors.join(", ")}
                  </p>
                )}
                <Link
                  to="/books/$id/read"
                  params={{ id: String(continuing.id) }}
                  className="rounded bg-[var(--action-accent)] px-5 py-2 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action-accent)]"
                >
                  Resume
                </Link>
              </div>
            </div>
          </section>
        )}
        {books.data && books.data.length > 0 && (
          <ul
            aria-labelledby={`${id}-heading`}
            className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4"
          >
            {books.data.map((book) => (
              <li
                key={book.id}
                className="group flex min-w-0 max-w-[180px] flex-col gap-1"
              >
                <Link
                  to="/books/$id/read"
                  params={{ id: String(book.id) }}
                  className="flex flex-col gap-1 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action-accent)]"
                >
                  <Cover book={book} />
                  <span
                    title={book.title}
                    className="line-clamp-2 font-medium wrap-anywhere"
                  >
                    {book.title}
                  </span>
                  {book.authors.length > 0 && (
                    <span
                      title={book.authors.join(", ")}
                      className="truncate text-sm text-stone-600"
                    >
                      {" "}
                      <span className="sr-only">by </span>
                      {book.authors.join(", ")}
                    </span>
                  )}
                </Link>
                <CardMenu
                  book={book}
                  onDelete={(button) => {
                    deleteTrigger.current = button;
                    setConfirming(book);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <DeleteDialog
        book={confirming}
        onClose={() => {
          setConfirming(null);
          deleteTrigger.current?.focus();
        }}
        onConfirm={onDeleteConfirmed}
      />
    </div>
  );
}
