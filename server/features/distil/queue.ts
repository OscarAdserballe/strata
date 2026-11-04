import { holdOversizedSection } from "./budget.ts";
import { geminiAvailable } from "../../platform/llm/gemini.ts";
import { logEvent } from "../../platform/events/events.ts";
import { runJob, jobFailed } from "../../platform/jobs.ts";
import { buildTree, buildCards, buildSourceTree, classifyApparatus, proseAnchors, treeToAscii, flattenTree, ladderReport, DISTIL_MODEL, type AnchorInfo, type ConceptTree } from "./distil.ts";
import { APP, deps } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { SECTION_TO_END } from "../../platform/db/schema.ts";
import { tx } from "../../platform/db/tx.ts";
import { q } from "../repo.ts";
import { now, parseJson } from "../../platform/db/sql.ts";
import type { SectionRow, ResourceRow, PairRow } from "../../platform/db/rows.ts";
import { kindOf, pagesOf, sectionSource, sectionsCount } from "../sources/blobs.ts";
import { genSlug, installDeck } from "../decks/decks.ts";
import { sourceFence } from "../sources/fence.ts";

const running = new Set<string>();
export const isDistilRunning = (sid: string): boolean => running.has(sid);
const clearTreeDraft = q.clearTreeDraft;

// thoughtsTokens bill as output; cachedTokens are the discounted slice of promptTokens.
interface UsageAcc { calls: number; promptTokens: number; outputTokens: number; thoughtsTokens: number; cachedTokens: number }
const newUsage = (): UsageAcc => ({ calls: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, cachedTokens: 0 });
const metered = (acc: UsageAcc): typeof deps => ({
  ...deps,
  callGeminiJson: (o: Parameters<typeof deps.callGeminiJson>[0]) => deps.callGeminiJson({
    ...o,
    onUsage: (u) => { acc.calls++; acc.promptTokens += u.prompt; acc.outputTokens += u.output; acc.thoughtsTokens += u.thoughts; acc.cachedTokens += u.cached; },
  }),
});

// One job at a time so a burst never puts the whole shelf on the wire; the boot sweep rebuilds a lost queue.
const queue: { boardId: string; sid: string; ssn: string | null; why: string; first: boolean }[] = [];
let pumping = false;
// thrown inside the final transaction when the section is no longer `carding`, to roll the deck back
const SUPERSEDED = new Error("the section stopped carding while its cards were written");

// `first` jumps the queue but still goes through the same claim, so it never runs beside a queued copy.
export function enqueueDistil(boardId: string, sid: string, ssn: string | null, why: string, force = false, first = false): boolean {
  if (!geminiAvailable) return false;
  if (running.has(sid)) return false;
  const waiting = queue.find((j) => j.sid === sid);
  if (waiting) {
    if (!first || waiting.first) return false;
    waiting.first = true;
    if (force) clearTreeDraft.run(sid);
    return true;
  }
  const section = q.section.get(sid);
  const resource = section && q.resource.get(boardId, section.resource_id);
  if (!section || !resource || section.board_id !== boardId || holdOversizedSection(resource, section)) return false;
  const t = q.tree.get(sid) as { status: string } | undefined;
  if (t && (t.status === "running" || t.status === "carding")) return false;
  if (!force && t && t.status === "ready") return false;
  if (force) clearTreeDraft.run(sid);
  queue.push({ boardId, sid, ssn, why, first });
  // A 'queued' row is persisted so home can show it and the boot sweep can resume it.
  if (t) q.setTreeStatus.run("queued", null, now(), sid);
  else {
    const s = q.section.get(sid) as SectionRow | undefined;
    if (s) q.upsertTree.run(sid, s.resource_id, boardId, s.label, "", null, null, "queued", null, 0, now());
  }
  startPump();
  return true;
}

// An unclassified section (kind null) counts as work: silently skipping a chapter is the worse failure.
export const isWork = (s: SectionRow): boolean => s.kind !== "apparatus";

export async function classifySections(rid: string, title: string): Promise<void> {
  const all = q.sectionsOf.all(rid) as SectionRow[];
  const resource = all[0] && q.resource.get(all[0].board_id, rid);
  if (!resource) return;
  const current = sourceFence(db, rid, resource.board_id);
  const held = all.map(section => holdOversizedSection(resource, section));
  if (held.some(Boolean)) return;
  if (all.length < 2) { for (const s of all) q.setSectionKind.run("work", s.id); return; }
  if (all.every((s) => s.kind)) return;
  const pagesOf = (s: SectionRow) => (s.last_page === SECTION_TO_END ? 0 : s.last_page - s.first_page + 1);
  const work = await classifyApparatus({ title, sections: all.map((s) => ({ label: s.label, pages: pagesOf(s) })) }, deps);
  if (!current()) return;
  all.forEach((s, i) => q.setSectionKind.run(work[i] === false ? "apparatus" : "work", s.id));
  const dropped = all.filter((_s, i) => work[i] === false).map((s) => s.label);
  if (dropped.length) console.log(`  ${title}: apparatus, kept but not carded — ${dropped.join(", ")}`);
}

export function enqueueDistilSource(boardId: string, rid: string, ssn: string | null, why: string, force = false): number {
  let n = 0;
  for (const s of q.sectionsOf.all(rid) as SectionRow[]) {
    if (isWork(s) && enqueueDistil(boardId, s.id, ssn, why, force)) n++;
  }
  return n;
}

// Fire-and-forget: the upload must not wait; a failed classification queues every section (the safe side).
export function classifyThenQueue(boardId: string, rid: string, title: string, ssn: string | null, why: string): void {
  for (const s of q.sectionsOf.all(rid)) if (!q.tree.get(s.id)) {
    q.upsertTree.run(s.id,rid,boardId,s.label,"",null,null,geminiAvailable ? "preparing" : "disabled",null,0,now());
  }
  if (!geminiAvailable) return;
  // If queueing fails, mark the sections rather than leave them "preparing" forever.
  void runJob("classify", rid, async () => {
    try { await classifySections(rid, title); }
    catch (e) { console.error(`[classify ${rid}]`, e instanceof Error ? e.message : e); }
    finally {
      const owner = db.prepare("SELECT board_id FROM resources WHERE id = ?").get(rid);
      for (const s of q.sectionsOf.all(rid)) if (!isWork(s) && q.tree.get(s.id)?.status === "preparing") q.setTreeStatus.run("skipped",null,now(),s.id);
      if (owner) enqueueDistilSource(String(owner.board_id), rid, ssn, why);
    }
  }, { onFail: (e) => {
    for (const s of q.sectionsOf.all(rid)) if (q.tree.get(s.id)?.status === "preparing") q.setTreeStatus.run("error", readableError(e).slice(0, 300), now(), s.id);
  } });
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    // Short sources need not wait behind a large book; a section asked for by name (`first`) goes first.
    const next = () => {
      queue.sort((a,b) => Number(b.first) - Number(a.first) || (q.section.get(a.sid)?.tokens ?? 0) - (q.section.get(b.sid)?.tokens ?? 0));
      return queue.shift();
    };
    for (let j = next(); j; j = next()) {
      const owner = q.section.get(j.sid)?.board_id;
      if (!owner) continue;
      // runJob never rejects: an unhandled rejection exits Node, which would end the pump.
      const sid = j.sid, ssn = j.ssn;
      await runJob("distil", sid, () => distilSection(owner, sid, ssn), { onFail: (e) => distilFailed(sid, e) });
      if (queue.length) console.log(`[distil] ${queue.length} queued`);
      await sourceTreeJob(owner, sid, ssn);
    }
  } finally { pumping = false; }
}
// Not a runJob: `pumping` must drop in the same tick the loop ends, or a startPump in between is lost.
export function startPump(): void {
  const t0 = Date.now();
  pump().catch((e: unknown) => jobFailed("distil-pump", "pump", e, Date.now() - t0));
}

function distilFailed(sid: string, e: unknown): void {
  running.delete(sid);
  const status = q.tree.get(sid)?.status;
  if (status && ["queued", "preparing", "running", "carding"].includes(status)) q.setTreeStatus.run("error", readableError(e).slice(0, 300), now(), sid);
}

function sourceTreeJob(boardId: string, sid: string, ssn: string | null): Promise<void | undefined> {
  const rid = q.section.get(sid)?.resource_id;
  if (!rid) return Promise.resolve();
  return runJob("source-tree", rid, () => maybeBuildSourceTree(boardId, sid, ssn), { onFail: (e) => {
    db.prepare("UPDATE source_trees SET status='error',error=? WHERE resource_id=? AND status='running'").run(readableError(e).slice(0, 300), rid);
  } });
}

export function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e || "distil failed");
  const brace = raw.indexOf("{");
  if (brace < 0) return raw;
  try {
    const body = JSON.parse(raw.slice(brace)) as { error?: { message?: string; status?: string } };
    const inner = body.error?.message;
    if (inner) return `${raw.slice(0, brace).trim().replace(/:$/, "")} — ${inner}`;
  } catch { /* not JSON, or truncated: fall through to the raw text */ }
  return raw.slice(0, brace).trim().replace(/:$/, "") || raw;
}

function hasChosenDeck(boardId: string, sid: string): boolean {
  const slug = genSlug(sid);
  return (q.pairsOf.all(boardId) as PairRow[]).some((p) => p.section_id === sid && p.deck && p.deck !== slug);
}

function anchorInfoFor(r: ResourceRow, s: SectionRow, total: number): AnchorInfo {
  const kind = kindOf(r);
  if (kind === "pdf") {
    const pages = pagesOf(r.id), n = pages.length;
    if (total > 1 || s.content_ranges) {
      const last = s.last_page === SECTION_TO_END ? (n || undefined) : s.last_page;
      return { kind, firstPage: s.first_page, lastPage: last, pages };
    }
    return { kind, firstPage: 1, lastPage: n || undefined, pages };
  }
  return { kind, text: r.text ?? "", ...proseAnchors(r.text ?? "") };
}

export async function distilSection(boardId: string, sid: string, ssn: string | null, opts?: { cards?: boolean }): Promise<void> {
  if (running.has(sid)) return;
  running.add(sid);
  const t0 = Date.now();
  const s = q.section.get(sid) as SectionRow | undefined;
  if (!s) { running.delete(sid); return; }
  const r = q.resource.get(boardId, s.resource_id) as ResourceRow | undefined;
  if (!r || s.board_id !== boardId || holdOversizedSection(r, s)) { running.delete(sid); return; }
  const current = sourceFence(db, s.resource_id, boardId, sid);
  const total = sectionsCount(s.resource_id);
  const title = total > 1 ? s.label : (r.filename ?? "source").replace(/\.[^.]+$/, "");
  const wantCards = opts?.cards ?? !hasChosenDeck(boardId, sid);
  // A saved tree is a completed stage: retries and restarts only repeat card generation.
  const checkpoint = q.tree.get(sid);
  const parsed = checkpoint?.json && checkpoint.status !== 'ready' ? parseJson<ConceptTree | null>(checkpoint.json,null) : null;
  const savedTree = Array.isArray(parsed?.nodes) && parsed.nodes.length ? parsed : null;
  // The claim: a second runner finds the section running or built, changes nothing and spends nothing.
  if (!q.claimTree.run(s.resource_id, boardId, title, savedTree ? JSON.stringify(savedTree) : null, now(), sid).changes) { running.delete(sid); return; }
  const use = newUsage();
  const mdeps = metered(use);
  try {
    const src = sectionSource(r, s, total);
    const anchors = anchorInfoFor(r, s, total);
    const tree = savedTree ?? await buildTree({ title, ...src, anchors }, mdeps);
    if (!current() || q.tree.get(sid)?.status !== "running") return;
    if (!tree.nodes.length) throw new Error("the tree came back empty");
    const ascii = treeToAscii(tree);
    if (!wantCards) {
      if (!q.advanceTree.run(tree.title, tree.question, JSON.stringify(tree), ascii, "ready", 0, now(), sid, "running").changes) return;
      logEvent(db, APP, "distil_done", { board: boardId, nodes: flattenTree(tree).length, cards: 0, treeOnly: true, ms: Date.now() - t0, model: DISTIL_MODEL, ...use }, ssn);
      return;
    }
    if (!q.advanceTree.run(tree.title, tree.question, JSON.stringify(tree), ascii, "carding", 0, now(), sid, "running").changes) return;
    const cards = await buildCards({ title, tree, ...src, anchors }, mdeps);
    if (!current() || q.tree.get(sid)?.status !== "carding") return;
    // Deck and `carding -> ready` in one transaction; rolled back if the section stopped carding.
    let n: number;
    try {
      n = tx(() => {
        const n = installDeck(boardId, sid, tree.title || title, cards as never);
        if (!q.advanceTree.run(tree.title, tree.question, JSON.stringify(tree), treeToAscii(tree), "ready", n, now(), sid, "carding").changes) throw SUPERSEDED;
        return n;
      });
    } catch (e) { if (e === SUPERSEDED) return; throw e; }
    const lad = ladderReport(tree, cards);
    logEvent(db, APP, "distil_done", {
      board: boardId, nodes: flattenTree(tree).length, cards: n, ms: Date.now() - t0, model: DISTIL_MODEL,
      terms: lad.terms, defined: lad.defined, undefined: lad.undefined_.length,
      ...(lad.missing.length ? { missing: lad.missing.slice(0, 10) } : {}),
      ...use,
    }, ssn);
    if (lad.missing.length) console.warn(`[distil ${sid}] ${lad.missing.length} glossary term(s) got no card: ${lad.missing.slice(0, 6).join(", ")}`);
  } catch (e) {
    if (!current()) return;
    const msg = readableError(e);
    console.error(`[distil ${sid}]`, msg);
    // Fail only from the stage this run holds: a tree put by hand meanwhile keeps what it has.
    q.failTree.run(msg.slice(0, 300), now(), sid);
    // Log tokens even on failure: a retry loop burning money should be visible.
    logEvent(db, APP, "distil_error", { board: boardId, error: msg.slice(0, 120), ...use }, ssn);
  } finally {
    running.delete(sid);
    const owner = q.section.get(sid)?.board_id;
    if (!current() && owner && q.tree.get(sid)?.status === "queued") enqueueDistil(owner, sid, ssn, "source-moved");
  }
}

async function maybeBuildSourceTree(boardId: string, sid: string, ssn: string | null): Promise<void> {
  const s = q.section.get(sid) as SectionRow | undefined;
  if (!s) return;
  const rid = s.resource_id;
  const sections = q.sectionsOf.all(rid) as SectionRow[];
  if (sections.length <= 1) return;
  const wanted = sections.filter(isWork);
  const trees = q.treesOfResource.all(rid) as { section_id: string; status: string; title: string; question: string; json: string | null }[];
  const done = trees.filter((t) => t.status === "ready" || t.status === "error");
  if (done.length < wanted.length) return;
  const ready = trees.filter((t) => t.status === "ready" && t.json);
  if (!ready.length) return;
  if (queue.some((j) => (q.section.get(j.sid) as SectionRow | undefined)?.resource_id === rid)) return;
  const existing = q.sourceTree.get(rid) as { status: string } | undefined;
  if (existing && (existing.status === "ready" || existing.status === "running")) return;

  const r = q.resource.get(boardId, rid) as ResourceRow | undefined;
  if (!r) return;
  const current = sourceFence(db, rid, boardId);
  const treeVersion = JSON.stringify(q.treesOfResource.all(rid));
  const unchanged = () => current() && JSON.stringify(q.treesOfResource.all(rid)) === treeVersion;
  const title = (r.filename ?? "source").replace(/\.[^.]+$/, "");
  q.upsertSourceTree.run(rid, boardId, title, "", null, null, "running", null, now());
  const use = newUsage();
  try {
    const byId = new Map(sections.map((x) => [x.id, x]));
    const parts = ready
      .map((t) => ({ s: byId.get(t.section_id), tree: parseJson<ConceptTree | null>(t.json, null) }))
      .filter((p): p is { s: SectionRow; tree: ConceptTree } => !!p.s && !!p.tree)
      .sort((a, b) => a.s.ord - b.s.ord);
    const tree = await buildSourceTree({ title, parts }, metered(use));
    if (!unchanged()) return;
    q.upsertSourceTree.run(rid, boardId, tree.title || title, tree.question, JSON.stringify(tree), treeToAscii(tree, { questions: false }), "ready", null, now());
    console.log(`[distil] ${title}: book tree from ${parts.length} sections`);
    logEvent(db, APP, "source_tree_done", { board: boardId, sections: parts.length, nodes: flattenTree(tree).length, ...use }, ssn);
  } catch (e) {
    if (!unchanged()) return;
    const msg = readableError(e);
    console.error(`[distil source-tree ${rid}]`, msg);
    q.upsertSourceTree.run(rid, boardId, title, "", null, null, "error", msg.slice(0, 300), now());
  } finally {
    // Chapter edits can supersede a reduction while ownership remains unchanged.
    if (current() && !unchanged()) {
      db.prepare("UPDATE source_trees SET status='pending' WHERE resource_id=? AND status='running'").run(rid);
    }
  }
}

function bindOrphanedDecks(): void {
  let n = 0;
  for (const t of db.prepare("SELECT section_id, board_id FROM trees WHERE status = 'ready' AND cards > 0").all() as { section_id: string; board_id: string }[]) {
    const slug = genSlug(t.section_id);
    if (!(q.cardsOf.all(slug) as unknown[]).length) continue;
    const p = (q.pairsOf.all(t.board_id) as PairRow[]).find((x) => x.section_id === t.section_id);
    if (!p || p.deck) continue;
    q.updPair.run(p.label, p.resource_id, slug, t.board_id, p.id);
    n++;
  }
  if (n) console.log(`  decks: bound ${n} deck${n === 1 ? "" : "s"} that had been built but never attached`);
}

export async function backfillDistil(): Promise<void> {
  bindOrphanedDecks();
  q.resetOrphanTrees.run();
  db.exec("UPDATE source_trees SET status='pending' WHERE status='running'");
  if (!geminiAvailable) {
    db.exec("UPDATE trees SET status='disabled' WHERE status IN ('queued','preparing')");
    return;
  }
  const rows = q.undistilled.all() as { id: string; resource_id: string; board_id: string }[];
  // Classify (awaited) before queueing, or an index would be carded as work by default.
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.resource_id)) continue;
    seen.add(r.resource_id);
    const res = q.resource.get(r.board_id, r.resource_id) as ResourceRow | undefined;
    if (!res) continue;
    try { await classifySections(r.resource_id, (res.filename ?? "source").replace(/\.[^.]+$/, "")); }
    catch (e) { console.error("[classify]", e instanceof Error ? e.message : e); }
  }
  let n = 0;
  for (const r of rows) {
    const s = q.section.get(r.id) as SectionRow | undefined;
    if (s && isWork(s) && enqueueDistil(r.board_id, r.id, null, "backfill")) n++;
  }
  // Recover reductions interrupted after their last chapter finished.
  for (const r of db.prepare(`SELECT s.resource_id,s.board_id,MIN(s.id) AS id FROM sections s
    LEFT JOIN source_trees t ON t.resource_id=s.resource_id
    WHERE t.resource_id IS NULL OR t.status='pending' GROUP BY s.resource_id`).all() as {resource_id:string;board_id:string;id:string}[]) await sourceTreeJob(r.board_id,r.id,null);
  if (n) {
    console.log(`  distil: backfilling ${n} section${n === 1 ? "" : "s"} with ${DISTIL_MODEL}, one at a time`);
    logEvent(db, APP, "distil_backfill", { queued: n, model: DISTIL_MODEL }, null);
  }
}

export async function retrySourceTree(boardId: string, rid: string): Promise<void> {
  db.prepare("UPDATE source_trees SET status='pending',error=NULL WHERE resource_id=? AND status='error'").run(rid);
  const section = q.sectionsOf.all(rid)[0];
  if (section) await maybeBuildSourceTree(boardId,section.id,null);
}
