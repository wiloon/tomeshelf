// Selects the latest accepted save, with import order breaking equal times.
export function continueReadingBook<
  T extends { id: number; importedAt: number; savedAt?: number },
>(books: readonly T[]): T | undefined {
  let latest: T | undefined;
  for (const book of books) {
    if (book.savedAt === undefined) continue;
    if (
      latest?.savedAt === undefined ||
      book.savedAt > latest.savedAt ||
      (book.savedAt === latest.savedAt &&
        (book.importedAt > latest.importedAt ||
          (book.importedAt === latest.importedAt && book.id > latest.id)))
    ) {
      latest = book;
    }
  }
  return latest;
}
