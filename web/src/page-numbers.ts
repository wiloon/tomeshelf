// Estimated page numbers for one book in one layout (ADR-0010 Page numbers).
// Measured documents count the pages they showed; the others are estimated
// from their text counts. Pure logic: the reader feeds it measures.

// Fewer text pages give a meaningless ratio (a cover, a few short documents).
const minTextPages = 4;

export type DocumentText = { characters: number; pictures: number };

export class PageNumbers {
  private readonly docs: DocumentText[];
  private readonly measured = new Map<number, number>();

  constructor(docs: DocumentText[]) {
    this.docs = docs;
  }

  // Records the latest page count of the document at index.
  measure(index: number, pages: number): void {
    this.measured.set(index, pages);
  }

  // Re-layout changes every document's pages.
  forget(): void {
    this.measured.clear();
  }

  // "12–13 of 340" for a spread starting on the document's page `page`
  // (from 1) that shows up to `perSpread` pages, or null with no estimate.
  label(index: number, page: number, perSpread: number): string | null {
    const pages = this.pages();
    if (!pages) {
      return null;
    }
    const before = pages.slice(0, index).reduce((a, b) => a + b, 0);
    const total = pages.reduce((a, b) => a + b, 0);
    const first = before + page;
    const last = before + Math.min(page + perSpread - 1, pages[index]);
    return last > first
      ? `${first}–${last} of ${total}`
      : `${first} of ${total}`;
  }

  // Every document's page count, measured or estimated, or null when an
  // estimate is needed and there is no characters-per-page ratio.
  private pages(): number[] | null {
    const ratio = this.charactersPerPage();
    const pages: number[] = [];
    for (const [i, doc] of this.docs.entries()) {
      const measured = this.measured.get(i);
      if (measured !== undefined) {
        pages.push(measured);
      } else if (ratio === null) {
        return null;
      } else {
        pages.push(
          Math.max(1, Math.round(doc.characters / ratio + doc.pictures / 2)),
        );
      }
    }
    return pages;
  }

  private charactersPerPage(): number | null {
    let characters = 0;
    let textPages = 0;
    for (const [i, measured] of this.measured) {
      const doc = this.docs[i];
      const own = measured - doc.pictures / 2;
      // Ornaments or icons can outnumber the pages: such a document says
      // nothing about how much text fits on a page.
      if (own > 0) {
        characters += doc.characters;
        textPages += own;
      }
    }
    return textPages >= minTextPages && characters > 0
      ? characters / textPages
      : null;
  }
}
