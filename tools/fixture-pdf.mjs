// Hand-written PDFs (a bookmarked book, an outline-less deck, a scan) with real text, no dependencies.

import { deflateSync } from "node:zlib";

const A4 = [612, 792];
const SLIDE = [720, 540];

// ( ) and \ are the only things that can break a PDF string literal
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// Helvetica is roughly half its point size per character, which is close enough to wrap a fixture
function wrap(text, size, width) {
  const max = Math.max(8, Math.floor(width / (size * 0.5)));
  const out = [];
  let cur = "";
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (!cur) { cur = w; continue; }
    if (cur.length + 1 + w.length <= max) cur += " " + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out;
}

// one rendered line is one Tj, so the fixture knows the page text pdf.js would extract
function contentStream(blocks, [pw, ph], margin) {
  const width = pw - margin * 2;
  let y = ph - margin;
  let out = "";
  const lines = [];
  for (const b of blocks) {
    const size = b.size ?? 11;
    const font = b.bold ? "/F2" : "/F1";
    const lead = b.lead ?? size * 1.55;
    y -= b.above ?? 0;
    for (const line of wrap(b.text, size, width)) {
      if (y < margin) break;
      out += `BT ${font} ${size} Tf 1 0 0 1 ${margin.toFixed(1)} ${y.toFixed(1)} Tm (${esc(line)}) Tj ET\n`;
      lines.push(line);
      y -= lead;
    }
    y -= b.below ?? 0;
  }
  return { stream: out, text: lines.join(" ").replace(/\s+/g, " ").trim() };
}

// objects are numbered up front so an outline entry can name a page before it is written
function buildPdf(pages, { size = A4, outline = [], images = [] } = {}) {
  const n = pages.length;
  const pageObj = (i) => 5 + i;
  const streamObj = (i) => 5 + n + i;
  const outlineRoot = 5 + 2 * n;
  const outlineItem = (i) => outlineRoot + 1 + i;
  const imageObj = (i) => outlineItem(outline.length) + i;
  const objs = [];
  const put = (num, body) => { objs[num - 1] = body; };
  // pictures follow the outline's numbers, so an outline-less file still needs its root or the xref breaks
  if (images.some(Boolean) && !outline.length) put(outlineRoot, "<< /Type /Outlines /Count 0 >>");

  put(1, `<< /Type /Catalog /Pages 2 0 R${outline.length ? ` /Outlines ${outlineRoot} 0 R /PageMode /UseOutlines` : ""} >>`);
  put(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`);
  put(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  put(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  pages.forEach((stream, i) => {
    const im = images[i];
    const xobject = im ? ` /XObject << /Im0 ${imageObj(i)} 0 R >>` : "";
    put(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size[0]} ${size[1]}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobject} >> /Contents ${streamObj(i)} 0 R >>`);
    put(streamObj(i), `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
    if (im) put(imageObj(i), `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${im.data.length} >>\nstream\n${im.data.toString("latin1")}\nendstream`);
  });

  if (outline.length) {
    put(outlineRoot, `<< /Type /Outlines /First ${outlineItem(0)} 0 R /Last ${outlineItem(outline.length - 1)} 0 R /Count ${outline.length} >>`);
    outline.forEach((o, i) => {
      const sib = (j) => (j >= 0 && j < outline.length ? ` /${j < i ? "Prev" : "Next"} ${outlineItem(j)} 0 R` : "");
      put(outlineItem(i), `<< /Title (${esc(o.title)}) /Parent ${outlineRoot} 0 R`
        + sib(i - 1) + sib(i + 1)
        + ` /Dest [${pageObj(o.page - 1)} 0 R /Fit] >>`);
    });
  }

  let body = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const PARAS = [
  "The difficulty with any account of market structure is that the structure is not a fact about the world so much as a fact about the question being asked. A market defined by the substitutability of products will not be the market defined by the reach of a distribution network, and the two definitions will disagree about who competes with whom.",
  "Firms do not maximise profit in the way the textbook says they do, but they do something close enough that the prediction survives, and the interesting work lies in charting exactly where the approximation fails. It fails, characteristically, where the time horizon is long and the information is poor.",
  "Consider the case of an industry with three producers of roughly equal size. Each knows the others' costs approximately and their capacity almost exactly. Nothing in that arrangement compels cooperation, and yet cooperation is what one observes, sustained without a word being exchanged between them.",
  "The mechanism is not conspiracy but repetition. A price cut today is a price cut that will be met tomorrow, and a firm that can count reliably on being met has no reason to cut at all. What looks from outside like an agreement is, from inside, a series of unilateral decisions each of which is individually sensible.",
  "This is why the empirical literature has such trouble. The observable outcome of tacit coordination and the observable outcome of vigorous competition under high fixed costs are very nearly the same outcome, and no amount of price data alone will separate them.",
  "The obvious response is to look for the fingerprints of coordination rather than for coordination itself: sudden alignment after a period of dispersion, prices that move together on the way up and apart on the way down, an insensitivity to cost shocks that ought to have bitten.",
  "None of these is conclusive. Each is consistent with a competitive story told slightly differently, and the history of the field is in large part a history of stories told slightly differently until the data stopped objecting.",
  "What changes the picture is entry. An arrangement that survives among three firms rarely survives among six, not because six is harder to coordinate but because the gain from defecting rises as each participant's share of the collusive profit falls.",
  "The same logic explains why the arrangement is fragile at the edges of a recession. Demand falling means capacity idle, and capacity idle means the cost of taking a rival's customer is lower than it has ever been. The discipline holds exactly as long as the alternative to holding is unattractive.",
  "It is worth pausing on how much of this rests on the assumption that firms can observe one another. Remove the observation and the whole structure collapses into ordinary competition, which suggests that the relevant policy instrument may be information rather than price.",
  "The counterargument is that information is also what makes markets efficient, and a rule that degrades the information environment to prevent coordination will degrade a great deal else besides. There is no clean instrument here, only a trade whose terms depend on the industry.",
  "Where the trade has been made explicitly, the results are mixed. Exchange bans have worked in some settings and been circumvented trivially in others, and the difference appears to lie in whether the exchanged information had any use besides coordination.",
  "A more promising line attacks the arrangement from inside. If one participant can be given a reason to defect that the others cannot punish, the whole edifice becomes unstable in a way that no external monitoring could achieve.",
  "That is the theory behind leniency, and its record is better than anything that came before it. The reason is structural: it works on the one payoff the arrangement has no instrument against, which is the payoff to being the first to confess.",
  "The design details matter enormously and are easy to get wrong. Leniency for the second confessor undoes most of the effect; leniency granted after an investigation opens undoes the rest. The programme works by making the race to confess winner-take-all.",
  "One should be careful about generalising from the cases that were caught. Everything known about the internal life of these arrangements comes from the ones that failed, which is a sample selected on precisely the variable of interest.",
  "This is the standard difficulty of studying anything covert, and it has no solution, only mitigations. The most useful of these is to look at markets where the arrangement ended for a reason unrelated to enforcement, since those endings are closer to random.",
  "Such natural experiments are rare and the inferences from them are correspondingly precious. Where they exist, they tend to suggest that the effect on price was larger than the retrospective estimates from prosecuted cases would imply.",
  "It follows that the deterrence calculation is probably understated in most jurisdictions, though by how much is exactly the quantity nobody can estimate without the sample that does not exist.",
  "The practical conclusion is modest. Coordination is easier than the competitive model suggests and harder than the conspiratorial account assumes, and the instruments that work are the ones that change what an individual participant stands to gain by breaking ranks.",
];

const CHAPTERS = [
  "One: What a market is, and who decides",
  "Two: Repetition and the discipline it buys",
  "Three: The identification problem",
  "Four: Entry, and why three is not six",
  "Five: Demand shocks and the fragile edge",
  "Six: Information as an instrument",
  "Seven: Attacking the arrangement from inside",
  "Eight: What the caught cases cannot tell us",
];

// a real book's bookmarks include apparatus (dedication, notes, index), not only chapters
export function book({ chapters = CHAPTERS, pagesPerChapter = 8, title: bookTitle = "The Discipline of Repetition" } = {}) {
  const pages = [];
  const pageText = [];
  const outline = [];
  const M = 64;
  const page = (blocks) => {
    const { stream, text } = contentStream(blocks, A4, M);
    pages.push(stream); pageText.push(text);
    return pages.length;
  };
  const mark = (title) => outline.push({ title, page: pages.length + 1 });

  mark("Title page");
  page([
    { text: bookTitle, size: 26, bold: true, above: 180 },
    { text: "An essay on coordination in concentrated markets", size: 13, above: 16 },
    { text: "A preview fixture. The text is original and deliberately repetitive; it exists to be read from, scrolled through, and marked up.", size: 10, above: 260 },
  ]);

  mark("Dedication");
  page([{ text: "For anyone who has tried to test a reader without a book to read.", size: 13, above: 300 }]);

  let para = 0;
  chapters.forEach((title, ci) => {
    mark(title);
    const first = [{ text: title, size: 19, bold: true, above: 40, below: 18 }];
    for (let i = 0; i < 3; i++) first.push({ text: PARAS[para++ % PARAS.length], below: 9 });
    page(first);
    for (let p = 0; p < pagesPerChapter; p++) {
      const blocks = [{ text: `${title.split(":")[0]}, page ${p + 2}`, size: 8, below: 14 }];
      for (let i = 0; i < 5; i++) blocks.push({ text: PARAS[para++ % PARAS.length], below: 9 });
      page(blocks);
    }
  });

  mark("Notes");
  for (let p = 0; p < 11; p++) {
    const blocks = [{ text: `Notes to chapters ${Math.max(1, p)}-${p + 1}`, size: 9, bold: true, below: 12 }];
    for (let i = 0; i < 9; i++) {
      blocks.push({ text: `${i + 1}. ${PARAS[(para + i * 3) % PARAS.length].slice(0, 150)}`, size: 9, lead: 12, below: 5 });
    }
    para += 4;
    page(blocks);
  }

  mark("Index");
  for (let p = 0; p < 4; p++) {
    const blocks = [{ text: "Index", size: 9, bold: true, below: 12 }];
    const terms = ["capacity", "collusion", "defection", "demand shocks", "entry", "information exchange", "leniency", "market definition", "monitoring", "punishment", "repetition", "substitutability"];
    for (const t of terms) blocks.push({ text: `${t}, ${20 + ((t.length * 7 + p * 13) % 90)}`, size: 9, lead: 12 });
    page(blocks);
  }

  const sections = outline.map((o, i) => ({
    label: o.title,
    firstPage: o.page,
    lastPage: i + 1 < outline.length ? Math.max(o.page, outline[i + 1].page - 1) : pages.length,
  }));
  return { bytes: buildPdf(pages, { size: A4, outline }), pages: pages.length, sections, pageText };
}

export function slides() {
  const DECK = [
    ["Collusion", ["Advanced Industrial Organisation", "Lecture 4"]],
    ["Where we are", ["One-shot oligopoly leaves profit on the table", "Repetition is what changes the game", "Today: when does the arrangement hold?"]],
    ["The one-shot problem", ["Industry profit sits below the monopoly level", "Business-stealing externality", "Every firm wants the cartel", "No firm wants to be the one holding to it"]],
    ["A prisoner's dilemma", ["Defect / hold, both firms", "The unique equilibrium is mutual defection", "Nothing about this is fixed by talking"]],
    ["What an infinite horizon buys", ["No known last period", "Deviation can be punished", "A punishment never reached is still doing work"]],
    ["The grim trigger", ["Defect once, and the rest of the game is static", "Crude, and enough to make the point", "Weaker punishments need more patience"]],
    ["The sustainability condition", ["Present value of holding beats one round of defection", "Everything downstream enlarges one term or another"]],
    ["Reading the condition", ["Raise the collusive profit: holding is worth more", "Raise the defection profit: holding is worth less", "Raise the discount factor: the future bites"]],
    ["Bertrand versus Cournot", ["Bertrand punishment drives price to marginal cost", "The deviator earns zero forever", "Cournot punishment leaves positive profit"]],
    ["So Bertrand punishes harder", ["Harsher punishment, lower critical discount factor", "Collusion is easier to sustain under Bertrand", "Counterintuitive on first meeting"]],
    ["Frequency of interaction", ["Shortens the lag between defection and punishment", "Equivalent to raising patience", "Same parameter, second hat"]],
    ["Multimarket contact", ["Punishment pools across markets", "Slack in one market covers tightness in another", "Bernheim and Whinston"]],
    ["Demand fluctuations", ["Deviation is attractive exactly in the boom", "Price wars in booms, not busts", "Rotemberg and Saloner"]],
    ["Number of firms", ["Collusive share falls as n rises", "Defection gain does not", "Concentration matters for this reason"]],
    ["Capacity constraints", ["Cannot serve the whole market by defecting", "Limits the defection payoff", "Cuts both ways on punishment"]],
    ["Detection", ["Collusive and competitive pricing look alike", "Parallel pricing is evidence of nothing alone", "Plus factors in the case law"]],
    ["The identification problem", ["Same observable outcome, two stories", "Price data alone will not separate them", "This is the central empirical difficulty"]],
    ["Leniency", ["Changes the payoff to confessing", "A payoff the cartel cannot punish", "Attacks the arrangement from inside"]],
    ["Designing leniency", ["Winner-take-all or it does not work", "Second confessor gets nothing", "Timing relative to investigation matters"]],
    ["Evidence", ["Detection rates rose after introduction", "Selection on prosecuted cases", "Effects probably understated"]],
    ["Screening", ["Variance-based screens", "Sudden alignment after dispersion", "Insensitivity to cost shocks"]],
    ["What to take away", ["One inequality, many terms", "Detection lag and impatience are the same thing", "Leniency works structurally, not morally"]],
    ["Next lecture", ["Advertising and product differentiation", "Read chapters four and five"]],
  ];
  const built = DECK.map(([title, bullets]) => contentStream([
    { text: title, size: 30, bold: true, above: 40, below: 26 },
    ...bullets.map((b) => ({ text: "- " + b, size: 17, below: 12 })),
  ], SLIDE, 56));
  // no sections: the reader divides only long, bookmarked files; the page text travels anyway
  return { bytes: buildPdf(built.map((b) => b.stream), { size: SLIDE }), pages: built.length, sections: [], pageText: built.map((b) => b.text) };
}

// a scanned book: grey-texture pages with invisible OCR-style text (render mode 3)
export function scan({ pages: count = 45, width = 850, height = 1100, title = "A Scanned Course Reader" } = {}) {
  const streams = [], pageText = [], images = [];
  let seed = 7;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  for (let p = 0; p < count; p++) {
    const raw = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      const ink = (y % 22) < 3 ? 70 : 0;
      for (let x = 0; x < width; x++) raw[y * width + x] = 235 - (ink && x > 60 && x < width - 60 ? ink : 0) - (next() >>> 28);
    }
    images.push({ w: width, h: height, data: deflateSync(raw) });
    const { stream, text } = contentStream([
      { text: `${title}, page ${p + 1}`, size: 9, below: 12 },
      ...[0, 1, 2, 3].map((i) => ({ text: PARAS[(p * 4 + i) % PARAS.length], below: 9 })),
    ], A4, 64);
    streams.push(`q ${A4[0]} 0 0 ${A4[1]} 0 0 cm /Im0 Do Q\n` + stream.replace(/BT /g, "BT 3 Tr "));
    pageText.push(text);
  }
  return { bytes: buildPdf(streams, { size: A4, images }), pages: count, sections: [], pageText };
}
