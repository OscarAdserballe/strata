import { test } from "node:test";
import assert from "node:assert/strict";
import { batchSections, MIN_SECTION_WORDS, type SectionSpan } from "./sections.ts";

const page = (n: number): string => "word ".repeat(n);
const spans = (...sizes: number[]): { sections: SectionSpan[]; pages: string[] } => ({
  sections: sizes.map((_n, i) => ({ label: `Topic ${i + 1}`, firstPage: i + 1, lastPage: i + 1 })),
  pages: sizes.map(page),
});

test("a source cannot split until it contains two minimum-sized units", () => {
  const x = spans(19_999, 20_000);
  assert.deepEqual(batchSections(x.sections, x.pages), []);
});

test("adjacent bookmarks batch into sections of at least 20,000 words", () => {
  const x = spans(8_000, 12_000, 22_000);
  assert.deepEqual(batchSections(x.sections, x.pages), [
    { label: "Topic 1 – Topic 2", firstPage: 1, lastPage: 2 },
    { label: "Topic 3", firstPage: 3, lastPage: 3 },
  ]);
});

test("an undersized final remainder merges backward", () => {
  const x = spans(21_000, 21_000, 5_000);
  assert.deepEqual(batchSections(x.sections, x.pages), [
    { label: "Topic 1", firstPage: 1, lastPage: 1 },
    { label: "Topic 2 – Topic 3", firstPage: 2, lastPage: 3 },
  ]);
});

test("scanned PDFs fall back to forty pages per minimum-sized section", () => {
  const sections = [
    { label: "Part I", firstPage: 1, lastPage: 40 },
    { label: "Part II", firstPage: 41, lastPage: 80 },
  ];
  assert.equal(MIN_SECTION_WORDS, 20_000);
  assert.deepEqual(batchSections(sections, Array.from({ length: 80 }, () => "")), sections);
});
