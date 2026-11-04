import { compileImportPlan, rangeText } from "../imports/import-plan.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPdfPage, detectChapterSections, isChapterLabel, sectionAtPage } from "./pdf-chapters.ts";
import { batchSections } from "./sections.ts";

const page = (...lines: string[]) => extractPdfPage(lines.map((str) => ({ str, hasEOL: true })));

test("line offsets use the same normalized page text as highlights", () => {
  const items = [{ str: " Some  text " }, { str: "continues", hasEOL: true }, { str: "\tChapter I  Origins", hasEOL: true }];
  const extracted = extractPdfPage(items);
  assert.equal(extracted.text, items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim());
  assert.equal(extracted.text.slice(extracted.lines[1].offset), "Chapter I Origins");
});

test("chapters exclude contents, cross references, neighboring text, and the index", () => {
  const pages = [
    page("Chapter I Origins", "3", "Chapter II Change", "8"),
    page("INTRODUCTION", "Why this book exists.", "CHAPTER I Origins", "ALPHA starts here."),
    page("Chapter II, as discussed elsewhere, has another meaning.", "Chapter XXII his estimate was different", "ALPHA ends here.", "CHAPTER II Change", "BETA starts here."),
    page("BETA ends here.", "INDEX", "Origins, 3"),
  ];
  const sections = detectChapterSections(pages);
  const chapters = sections.filter((s) => isChapterLabel(s.label));
  assert.equal(chapters.length, 2);
  assert.deepEqual(batchSections(sections, pages.map((p) => p.text)), sections, "short chapters remain separate under the production word floor");
  const units = compileImportPlan({
    outline: sections.map((s, id) => ({ id, label: s.label, page: s.firstPage, offset: s.firstOffset ?? 0, depth: 0, parent: null })),
    starts: sections.slice(1).map((_s, i) => i + 1), excluded: [],
  }, pages.map(p => p.text));
  const texts = units.filter(s => isChapterLabel(s.label)).map(s => rangeText(s.ranges, pages.map(p => p.text)));
  assert.match(texts[0], /ALPHA starts here/);
  assert.match(texts[0], /ALPHA ends here/);
  assert.doesNotMatch(texts[0], /BETA|INTRODUCTION|INDEX/);
  assert.match(texts[1], /BETA starts here/);
  assert.match(texts[1], /BETA ends here/);
  assert.doesNotMatch(texts[1], /ALPHA|INDEX/);
});

test("chapter numbering can restart in a new book and titles can be on the next line", () => {
  const pages = [page("CHAPTER I", "Origins", "First."), page("CHAPTER II Change", "Second."),
    page("Part I. Another age", "CHAPTER I Return", "Third."), page("CHAPTER II Beyond", "Fourth.")];
  const sections = detectChapterSections(pages);
  assert.equal(sections.length, 4);
  assert.equal(sections[0].label, "Chapter I Origins");
  assert.equal(sections[2].firstOffset, 0, "part heading belongs with the following chapter");
});

test("ambiguous, unnumbered, and scanned sources keep the undivided fallback", () => {
  assert.deepEqual(detectChapterSections([page("CHAPTER I Origins"), page("CHAPTER III Missing chapter")]), []);
  assert.deepEqual(detectChapterSections([page("Chapter I Origins ..... 3"), page("Chapter II Change 8")]), []);
  assert.deepEqual(detectChapterSections([page("An ordinary article"), page("Its conclusion")]), []);
  assert.deepEqual(detectChapterSections([page(""), page("")]), []);
});

test("a pair of explicit chapter bookmarks is never merged by word count", () => {
  const sections = [{ label: "Chapter 1 Origins", firstPage: 1, lastPage: 1 }, { label: "Chapter 2 Change", firstPage: 2, lastPage: 2 }];
  assert.deepEqual(batchSections(sections, ["short", "also short"]), sections);
});

test("opening either chapter on a shared page keeps its deck until the reader moves past it", () => {
  const sections = [{ id: "a", label: "Origins", firstPage: 1, lastPage: 3 }, { id: "b", label: "Change", firstPage: 3, lastPage: 5 }];
  assert.equal(sectionAtPage(sections, 3, "a")?.id, "a");
  assert.equal(sectionAtPage(sections, 3, "b")?.id, "b");
  assert.equal(sectionAtPage(sections, 4, "a")?.id, "b");
  assert.equal(sectionAtPage(sections, 2, "b")?.id, "a");
});
