import { expect, test } from "vitest";
import {
  columnGapPx,
  isEditableTarget,
  keyTurnsSpread,
  snapSpreadOffset,
  spreadMetrics,
  spreadStep,
  WheelBurst,
} from "./pages";

test("a page is as wide as the text width, or the space available when that is narrower", () => {
  expect(spreadMetrics(800, 608, columnGapPx)).toEqual({
    pageWidth: 608,
    pagesPerSpread: 1,
    spreadWidth: 608,
    gap: columnGapPx,
  });
  expect(spreadMetrics(343, 608, columnGapPx)).toEqual({
    pageWidth: 343,
    pagesPerSpread: 1,
    spreadWidth: 343,
    gap: columnGapPx,
  });
});

test("a spread is two pages when the space holds two at the text width plus the gap", () => {
  const gap = columnGapPx;
  const textWidth = 608;
  const two = 2 * textWidth + gap;
  expect(spreadMetrics(two, textWidth, gap).pagesPerSpread).toBe(2);
  expect(spreadMetrics(two, textWidth, gap)).toEqual({
    pageWidth: textWidth,
    pagesPerSpread: 2,
    spreadWidth: two,
    gap,
  });
  expect(spreadMetrics(two - 1, textWidth, gap).pagesPerSpread).toBe(1);
  expect(spreadMetrics(two + 100, textWidth, gap).pagesPerSpread).toBe(2);
});

test("turning a spread scrolls by one page pitch times the pages in the spread", () => {
  const gap = 24;
  expect(
    spreadStep({ pageWidth: 400, pagesPerSpread: 1, spreadWidth: 400, gap }),
  ).toBe(424);
  expect(
    spreadStep({ pageWidth: 400, pagesPerSpread: 2, spreadWidth: 824, gap }),
  ).toBe(848);
});

test("scroll offsets snap to the containing spread start", () => {
  expect(snapSpreadOffset(0, 848)).toBe(0);
  expect(snapSpreadOffset(100, 848)).toBe(0);
  expect(snapSpreadOffset(500, 848)).toBe(0);
  expect(snapSpreadOffset(849, 848)).toBe(848);
  expect(snapSpreadOffset(1300, 848)).toBe(848);
});

test("arrow and page keys turn a spread, modifiers and form controls do not", () => {
  expect(keyTurnsSpread({ key: "ArrowRight" })).toBe("next");
  expect(keyTurnsSpread({ key: "ArrowLeft" })).toBe("previous");
  expect(keyTurnsSpread({ key: "PageDown" })).toBe("next");
  expect(keyTurnsSpread({ key: "PageUp" })).toBe("previous");
  expect(keyTurnsSpread({ key: " " })).toBe("next");
  expect(keyTurnsSpread({ key: " ", shiftKey: true })).toBe("previous");
  expect(keyTurnsSpread({ key: "ArrowRight", ctrlKey: true })).toBe(null);
  expect(keyTurnsSpread({ key: "ArrowRight", altKey: true })).toBe(null);
  expect(keyTurnsSpread({ key: "ArrowRight", metaKey: true })).toBe(null);
  expect(keyTurnsSpread({ key: "ArrowRight", shiftKey: true })).toBe(null);
  expect(keyTurnsSpread({ key: "a" })).toBe(null);
});

test("keys with focus in an editable or radio group target are left alone", () => {
  expect(isEditableTarget({ tagName: "INPUT", type: "radio" })).toBe(true);
  expect(isEditableTarget({ tagName: "INPUT", type: "text" })).toBe(true);
  expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
  expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
  expect(isEditableTarget({ tagName: "BUTTON" })).toBe(true);
  expect(isEditableTarget({ tagName: "A" })).toBe(true);
  expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(
    true,
  );
  expect(isEditableTarget({ tagName: "P" })).toBe(false);
  expect(isEditableTarget(null)).toBe(false);
});

test("one wheel burst turns one spread until a quiet gap", () => {
  const burst = new WheelBurst(300);
  expect(burst.consume(0)).toBe(true);
  expect(burst.consume(50)).toBe(false);
  expect(burst.consume(200)).toBe(false);
  // Still in the same burst: quiet is measured from the last event.
  expect(burst.consume(400)).toBe(false);
  expect(burst.consume(700)).toBe(true);
  expect(burst.consume(750)).toBe(false);
});
