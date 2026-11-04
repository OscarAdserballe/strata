import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isYouTube, isHttpUrl, ytDlpCommand, parseVtt, cuesToParagraphs, transcriptToMarkdown,
  articleToMarkdown, firstHeading, captureFilename, hostname, fetchOembed, dropOverlap,
  stripSiteSuffix, healSeams, normalizeExtract, appendMissingImages,
  parseYouTubeScrape, videoToMarkdown, linesToParagraphs,
} from "./capture.ts";

const VTT = `WEBVTT

00:00:00.120 --> 00:00:03.000
so the thing about a principle

00:00:03.000 --> 00:00:05.500
so the thing about a principle is that

00:00:05.500 --> 00:00:08.000
it has to be something you can act on

00:00:52.000 --> 00:00:55.000
and that is the whole idea
`;

test("youtube links are recognised, other links are not", () => {
  assert.ok(isYouTube("https://www.youtube.com/watch?v=PUv66718DII"));
  assert.ok(isYouTube("https://youtu.be/PUv66718DII"));
  assert.ok(!isYouTube("https://patrickcollison.com/questions"));
  assert.ok(isHttpUrl("https://example.com"));
  assert.ok(!isHttpUrl("file:///etc/passwd"));
  assert.ok(!isHttpUrl("not a link"));
  assert.equal(hostname("https://www.patrickcollison.com/questions"), "patrickcollison.com");
});

test("the yt-dlp handoff carries the url and copies to the clipboard", () => {
  const cmd = ytDlpCommand("https://youtu.be/abc");
  assert.match(cmd, /yt-dlp/);
  assert.match(cmd, /--impersonate chrome/);
  assert.match(cmd, /https:\/\/youtu\.be\/abc/);
  assert.match(cmd, /pbcopy/);
});

test("caption commands quote URL data and leave failures visible on both platforms", () => {
  const url = "https://youtu.be/abc?x=';$(echo injected)`whoami`";
  const mac = ytDlpCommand(url);
  assert.ok(mac.includes("'https://youtu.be/abc?x='\\'';$(echo injected)`whoami`'"));
  assert.match(mac, /trap .* EXIT/);
  assert.ok(!mac.includes("2>&1"));
  const win = ytDlpCommand(url, "windows");
  assert.ok(win.includes("'https://youtu.be/abc?x='';$(echo injected)`whoami`'"));
  assert.match(win, /\$LASTEXITCODE -ne 0/);
  assert.match(win, /No English captions found/);
  assert.match(win, /-Raw -Encoding UTF8 \| Set-Clipboard/);
  assert.match(win, /finally \{/);
  assert.match(win, /Remove-Item -LiteralPath \$dir.FullName/);
});

test("parseVtt collapses the roll youtube's auto-subs emit", () => {
  const cues = parseVtt(VTT);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map((c) => c.at), ["0:00", "0:05", "0:52"]);
  assert.equal(cues[0].text, "so the thing about a principle is that");
  assert.equal(cues[0].seconds, 0);
  assert.equal(cues[2].seconds, 52);
});

test("cues merge into paragraphs at ~45s, each keeping its opening timestamp", () => {
  const paras = cuesToParagraphs(parseVtt(VTT));
  assert.equal(paras.length, 2);
  assert.equal(paras[0], "[0:00] so the thing about a principle is that it has to be something you can act on");
  assert.equal(paras[1], "[0:52] and that is the whole idea");
});

test("the two-line roll is un-rolled: each cue's repeat of the previous tail is dropped", () => {
  const cues = [
    ["0:00", 0, "I think if you look across his"],
    ["0:01", 1, "I think if you look across his mega-bestselling books like Sapiens and"],
    ["0:04", 4, "mega-bestselling books like Sapiens and Homo Deus,"],
    ["0:05", 5, "Homo Deus, Yuval Noah Harari really has one major"],
  ].map(([at, seconds, text]) => ({ at, seconds, text } as never));
  const clean = "[0:00] I think if you look across his mega-bestselling books like Sapiens and Homo Deus, Yuval Noah Harari really has one major";
  const paras = cuesToParagraphs(cues);
  assert.equal(paras.length, 1);
  assert.equal(paras[0], clean);
  const vtt = "WEBVTT\n\n" + cues.map((c: { text: string }, i) => `00:00:0${i}.000 --> 00:00:09.000\n${c.text}`).join("\n\n");
  assert.equal(cuesToParagraphs(parseVtt(vtt))[0], clean);
});

test("overlaps are dropped verbatim; a one-word coincidence is not an overlap", () => {
  assert.equal(
    dropOverlap("Cooperation and the ability to cooperate across scale, across time, as being the",
                "across scale, across time, as being the fundamental engine of human progress."),
    "fundamental engine of human progress.");
  assert.equal(dropOverlap("we go to the", "the tool has to show you"), "the tool has to show you");
  assert.equal(dropOverlap("across scale, across time", "across time, as being the engine"), "across time, as being the engine");
});

test("a transcript becomes markdown with its origin and nothing invented", () => {
  const { text, cues } = transcriptToMarkdown(VTT, { title: "Inventing on Principle", author: "CMU", url: "https://youtu.be/abc" });
  assert.equal(cues, 3);
  assert.match(text, /^# Inventing on Principle\n/);
  assert.match(text, /\*CMU · https:\/\/youtu\.be\/abc\*/);
  assert.match(text, /\[0:00\] so the thing/);
  assert.doesNotMatch(text, /summary|essence|theme/i);
});

test("an article keeps its own heading and gains one origin line", () => {
  const md = "# Questions\n\nA list of questions.\n";
  const out = articleToMarkdown({ title: "Questions", author: "patrickcollison.com", text: md }, "https://patrickcollison.com/questions");
  assert.equal(firstHeading(out), "Questions");
  assert.equal((out.match(/^# Questions$/gm) ?? []).length, 1, "the title must not be printed twice");
  assert.match(out, /\*patrickcollison\.com · https:\/\/patrickcollison\.com\/questions\*/);
  assert.ok(out.indexOf("# Questions") < out.indexOf("*patrickcollison.com"));
});

test("an article with no heading of its own gets one", () => {
  const out = articleToMarkdown({ title: "Machines of Loving Grace", author: "darioamodei.com", text: "Body text only." }, "https://darioamodei.com/x");
  assert.match(out, /^# Machines of Loving Grace\n/);
  assert.match(out, /Body text only\./);
});

test("a title guessed from headings takes the h1, not the promo above it", () => {
  const md = [
    "[Scott H Young](https://www.scotthyoung.com)",
    "",
    "## Ultralearning",
    "",
    "## Get Better at Anything",
    "",
    "# How Does Understanding Work?",
    "",
    "Last week, I discussed…",
  ].join("\n");
  assert.equal(firstHeading(md), "How Does Understanding Work?");
});

test("a heading that is a link loses the link, not the words", () => {
  assert.equal(firstHeading("# [Andy Matuschak](/)\n\nI'm an applied researcher."), "Andy Matuschak");
});

test("with no h1 anywhere, the first heading still stands in", () => {
  assert.equal(firstHeading("## Notes on X\n\nbody"), "Notes on X");
  assert.equal(firstHeading("no headings here at all"), undefined);
});

test("the masthead comes off a title, but a title's own dash stays", () => {
  assert.equal(stripSiteSuffix("How Does Understanding Work? - Scott H Young", "scotthyoung.com"), "How Does Understanding Work?");
  assert.equal(stripSiteSuffix("How Does Understanding Work? - Scott H Young", "Scott H Young"), "How Does Understanding Work?");
  assert.equal(stripSiteSuffix("Attention — the rarest form of generosity", "scotthyoung.com"), "Attention — the rarest form of generosity");
  assert.equal(stripSiteSuffix("A title with no tail", "example.com"), "A title with no tail");
});

test("filenames are one clean line", () => {
  assert.equal(captureFilename("  Bret Victor:\nInventing  on Principle "), "Bret Victor: Inventing on Principle");
  assert.equal(captureFilename(""), "untitled");
  assert.equal(captureFilename("x".repeat(300)).length, 120);
});

test("oembed failures degrade to an empty title rather than throwing", async () => {
  const dead = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  assert.deepEqual(await fetchOembed("https://youtu.be/abc", dead as never), {});
  const notOk = (async () => ({ ok: false })) as unknown as typeof fetch;
  assert.deepEqual(await fetchOembed("https://youtu.be/abc", notOk as never), {});
});

test("oembed lifts the title and channel", async () => {
  const ok = (async () => ({ ok: true, json: async () => ({ title: "Inventing on Principle", author_name: "CMU" }) })) as unknown as typeof fetch;
  assert.deepEqual(await fetchOembed("https://youtu.be/abc", ok as never), { title: "Inventing on Principle", author: "CMU" });
});

test("a glued sidenote seam gets its space back", () => {
  assert.equal(healSeams("supported by existing media.For more on this argument, see"), "supported by existing media. For more on this argument, see");
  assert.equal(healSeams("choose.Of course, on its own"), "choose. Of course, on its own");
});

test("healSeams leaves abbreviations, urls, links and code alone", () => {
  assert.equal(healSeams("the U.S.A. and the E.U. agreed"), "the U.S.A. and the E.U. agreed");
  assert.equal(healSeams("visit https://example.com/About for more"), "visit https://example.com/About for more");
  assert.equal(healSeams("see [books](https://andymatuschak.org/books.Foo) here"), "see [books](https://andymatuschak.org/books.Foo) here");
  assert.equal(healSeams("run `foo.Bar()` first"), "run `foo.Bar()` first");
  assert.equal(healSeams("a value of 3.14 stays"), "a value of 3.14 stays");
});

test("normalizeExtract puts an image on its own block", () => {
  const md = "![Image 1: A screenshot](https://x.com/a.png)\nBut it's not a conventional essay.";
  assert.equal(normalizeExtract(md), "![Image 1: A screenshot](https://x.com/a.png)\n\nBut it's not a conventional essay.");
  const glued = "![fig](https://x.com/a.png) But prose follows here.";
  assert.equal(normalizeExtract(glued), "![fig](https://x.com/a.png)\n\nBut prose follows here.");
  const linked = "[![fig](https://x.com/a.png)](https://x.com/post)\ntext after";
  assert.equal(normalizeExtract(linked), "[![fig](https://x.com/a.png)](https://x.com/post)\n\ntext after");
});

test("a text-only fallback retains every separately extracted image", () => {
  const md = "# Rich post\n\n![Already placed](https://img.example/already.png)\n\nThe ending.\n";
  const out = appendMissingImages(md, [
    "https://img.example/already.png",
    "https://img.example/demo.gif",
    "https://img.example/diagram.webp",
    "https://img.example/demo.gif",
    "javascript:alert(1)",
  ]);
  assert.equal((out.match(/!\[/g) ?? []).length, 3);
  assert.match(out, /The ending\.\n\n!\[\]\(https:\/\/img\.example\/demo\.gif\)/);
  assert.match(out, /!\[\]\(https:\/\/img\.example\/diagram\.webp\)\n$/);
  assert.doesNotMatch(out, /javascript/);
});

test("normalizeExtract leaves fenced code untouched", () => {
  const md = "intro line\n\n```\ncode.Line here\n![not an image line]\n```\n\nafter.The end";
  assert.equal(normalizeExtract(md), "intro line\n\n```\ncode.Line here\n![not an image line]\n```\n\nafter. The end");
});

test("a sidenote glued straight onto a link gets its space back too", () => {
  const md = "elements using a [song](https://www.youtube.com/watch?v=VgVQKCcfwnU)An enjoyable extended introduction";
  assert.equal(normalizeExtract(md), "elements using a [song](https://www.youtube.com/watch?v=VgVQKCcfwnU) An enjoyable extended introduction");
  assert.equal(normalizeExtract("see [books](https://x.com/b) for more"), "see [books](https://x.com/b) for more");
  assert.equal(normalizeExtract("the [book](https://x.com/b)s cover"), "the [book](https://x.com/b)s cover");
  assert.equal(normalizeExtract("([song](https://x.com/s)), and"), "([song](https://x.com/s)), and");
});

const scrape = (name: string): string =>
  JSON.parse(readFileSync(new URL(`../../../test/fixtures/firecrawl/${name}.json`, import.meta.url), "utf8")).data.markdown;

test("a firecrawl scrape of a watch page yields its title, channel, date and transcript lines", () => {
  const v = parseYouTubeScrape(scrape("youtube-transcript"));
  assert.equal(v.title, "Me at the zoo");
  assert.equal(v.author, "jawed");
  assert.equal(v.uploaded, "2005-04-24");
  assert.equal(v.lines.length, 6);
  assert.equal(v.lines[0], "All right, so here we are, in front of the elephants");
  assert.ok(!v.lines.some((l) => /Intro|Description/.test(l)), "the description is not transcript");
});

test("a watch page without a transcript section has no lines but keeps its header", () => {
  const v = parseYouTubeScrape(scrape("youtube-no-transcript"));
  assert.deepEqual(v.lines, []);
  assert.equal(v.title, "Me at the zoo");
  assert.equal(v.author, "jawed");
  assert.deepEqual(parseYouTubeScrape("# [t](u)\n\n## Transcript\n\n   \n").lines, []);
});

test("a video becomes the same transcript markdown pasted captions make", () => {
  const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  const text = videoToMarkdown(parseYouTubeScrape(scrape("youtube-transcript")), url);
  assert.match(text, /^# Me at the zoo\n\n\*jawed · 2005-04-24 · https:\/\/www\.youtube\.com\/watch\?v=jNQXAC9IVRw\*\n\n/);
  assert.match(text, /elephants the cool thing about these guys/);
  const pasted = transcriptToMarkdown(VTT, { title: "Me at the zoo", author: "jawed", url }).text;
  assert.equal(pasted.split("\n\n")[0], text.split("\n\n")[0]);
});

test("caption lines join into paragraphs at a sentence end once long enough, and never run on", () => {
  const sentence = "word ".repeat(30).trim() + ".";
  const paras = linesToParagraphs(Array.from({ length: 12 }, () => sentence));
  assert.ok(paras.length > 1);
  assert.ok(paras.slice(0, -1).every((p) => p.length >= 700 && p.endsWith(".")));
  const unpunctuated = linesToParagraphs(Array.from({ length: 200 }, () => "ja es ist wieder zeit für so ein video"));
  assert.ok(unpunctuated.length > 1);
  assert.ok(unpunctuated.every((p) => p.length <= 1100));
});
