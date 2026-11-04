// node tools/perf/survey.mjs [base] > targets.json: pick scenario targets by size only (ids, never text)
const base = (process.argv[2] || "http://127.0.0.1:8899").replace(/\/$/, "");
const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r; };
const { boards } = await (await get("/api/boards")).json();
const rows = [], resources = [], states = new Map();
for (const b of boards) {
  const text = await (await get(`/api/boards/${b.id}`)).text();
  const s = JSON.parse(text);
  states.set(b.id, s);
  const marksBy = {};
  for (const m of s.marks) marksBy[m.resourceId] = (marksBy[m.resourceId] || 0) + 1;
  let pdfs = 0;
  for (const res of s.resources) {
    const isPdf = /pdf/.test(res.mime || "") || /\.pdf$/i.test(res.filename || "");
    if (isPdf) pdfs++;
    const head = await fetch(`${base}/api/boards/${b.id}/resources/${res.id}/raw`, { headers: { Range: "bytes=0-0" } });
    const cr = head.headers.get("content-range"); await head.arrayBuffer();
    const bytes = cr ? Number(cr.split("/")[1]) : Number(head.headers.get("content-length"));
    resources.push({ board: b.id, id: res.id, pdf: isPdf, kind: res.kind, bytes, marks: marksBy[res.id] || 0,
      pairs: s.pairs.filter((p) => p.resourceId === res.id).map((p) => p.id) });
  }
  rows.push({ id: b.id, resources: s.resources.length, pdfs, marks: s.marks.length, messages: b.msgCount, stateBytes: text.length, pairs: s.pairs.length });
}
console.error("board                               res pdfs marks msgs stateKB");
for (const r of [...rows].sort((a, b) => b.stateBytes - a.stateBytes)) {
  console.error(`${r.id.padEnd(36)} ${String(r.resources).padStart(3)} ${String(r.pdfs).padStart(4)} ${String(r.marks).padStart(5)} ${String(r.messages).padStart(4)} ${(r.stateBytes / 1024).toFixed(0).padStart(6)}`);
}
const top = (arr, k) => [...arr].sort((a, b) => b[k] - a[k])[0];
const withPair = (arr) => arr.filter((r) => r.pairs.length);
const otherOn = (r) => {
  const cands = resources.filter((x) => x.board === r.board && x.id !== r.id && x.pairs.length).sort((a, b) => (b.pdf - a.pdf) || (a.bytes - b.bytes));
  return cands[0] ? { board: r.board, id: cands[0].id, pair: cands[0].pairs[0] } : null;
};
const pick = (r) => ({ board: r.board, id: r.id, pair: r.pairs[0], bytes: r.bytes, marks: r.marks, other: otherOn(r) });

const pdfs = withPair(resources.filter((r) => r.pdf)), prose = withPair(resources.filter((r) => !r.pdf));
const largestPdf = pick(top(pdfs, "bytes"));
const markedRes = top(pdfs, "marks");
const markedPdf = pick(markedRes);
{
  const st = states.get(markedRes.board);
  const ms = st.marks.filter((m) => m.resourceId === markedRes.id && m.page);
  let best = null;
  for (const p of st.pairs.filter((x) => x.resourceId === markedRes.id)) {
    const sec = st.sections.find((x) => x.id === p.sectionId);
    const inSec = sec ? ms.filter((m) => m.page >= sec.firstPage && m.page <= (sec.lastPage || Infinity)) : ms;   // lastPage 0 = to the end
    if (!best || inSec.length > best.n) best = { pair: p.id, n: inSec.length, inSec };
  }
  if (best) {
    markedPdf.pair = best.pair;
    const byPage = {};
    for (const m of best.inSec) byPage[m.page] = (byPage[m.page] || 0) + 1;
    const [page, n] = Object.entries(byPage).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    markedPdf.page = page ? Number(page) : null; markedPdf.marksOnPage = n; markedPdf.marksInSection = best.n;
  }
}
const largestProse = pick(top(prose, "bytes"));
const chattiest = top(rows, "messages");
let chat = null;
for (const r of resources.filter((x) => x.board === chattiest.id && x.pairs.length)) {
  const j = await (await get(`/api/boards/${r.board}/messages?resource=${r.id}`)).json();
  const n = (j.messages || []).length;
  if (!chat || n > chat.messages) chat = { board: r.board, id: r.id, pair: r.pairs[0], messages: n, more: j.before != null };
}
const biggest = [...rows].sort((a, b) => (b.resources - a.resources) || (b.stateBytes - a.stateBytes))[0];
const out = { base, surveyedAt: new Date().toISOString(), boards: rows.length, resources: resources.length,
  pdfs: resources.filter((r) => r.pdf).length, marks: rows.reduce((p, r) => p + r.marks, 0),
  biggestBoard: biggest, largestPdf, markedPdf, largestProse, chat };
console.log(JSON.stringify(out, null, 2));
