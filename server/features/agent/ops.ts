// apply's operations: each is checked for shape before the commit, then run inside it, in order.
import { q } from "../repo.ts";
import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { genId, now } from "../../platform/db/sql.ts";
import { HANDLE, idOf, parseRef } from "../../../shared/agent/ids.ts";
import { dropDeck, genSlug, installDeck, quoteTextOf, quoteTextOfDeck, writeCardEdit } from "../decks/decks.ts";
import { compileQuote, quoteAnchor } from "../../../shared/reading/compile-quote.ts";
import { KINDS, flattenTree, normalizeTree, orderByLadder, treeToAscii, type ConceptTree } from "../distil/distil.ts";
import { agentRepo as a } from "./repo.ts";
import { AgentError, type Board } from "./kinds.ts";
import { primersRepo } from "../primers/repo.ts";
import { PRIMER_MAX, primerProblem } from "../primers/primers.ts";

const fail = (msg: string): never => { throw new AgentError(msg); };
const str = (v: unknown, field: string, max: number, required = true): string | undefined => {
  if (v === undefined || v === null) return required ? fail(`${field} is required.`) : undefined;
  const s = String(v).trim();
  if (required && !s) fail(`${field} can't be empty.`);
  return s.slice(0, max);
};
const bool = (v: unknown, field: string): boolean | undefined =>
  v === undefined ? undefined : typeof v === "boolean" ? v : fail(`${field} is true or false.`);

type Op = Record<string, unknown> & { op: string };
const dayOf = (v: unknown): string => v === null || v === undefined || v === "" ? "" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fail("A date is YYYY-MM-DD.");

const text = (max: number, about: string) => ({ type: "string", maxLength: max, description: about });
const flag = (about: string) => ({ type: "boolean", description: about });
const orNull = (about: string) => ({ type: ["string", "null"], description: about });
const CARDS_MAX = 200, FACE_MAX = 4000;
const AT = text(600, "Where the card sits: 4 to 40 consecutive words of the source, copied verbatim, that occur once in its passage (on one page, for a PDF): the words the card asks about.");
const BUSY = ["queued", "preparing", "running", "carding"];
const list = (about: string) => ({ type: "array", items: { type: "string" }, description: about });
const NODE = { type: "object", required: ["label", "kind", "at", "questions"],
  properties: {
    label: text(400, "The claim: something that makes sense read cold, never a topic heading."),
    kind: { type: "string", enum: KINDS },
    at: AT,
    questions: list("What a reader who holds this claim can answer; each is one act of recall. The deck owes a card to every one."),
    children: { type: "array", description: "Claims that explain, support, qualify or apply this one, each the same shape as this node.", items: { type: "object" } },
  } };
const TREE = { type: "object", required: ["question", "nodes"],
  description: "The section's concept tree, as Strata's own card generation builds it. Required unless the section already has one.",
  properties: {
    title: text(160, "The deck's name; the section's own by default."),
    question: text(300, "The one question the whole section answers."),
    glossary: { type: "array", description: "The vocabulary the tree leans on, in dependency order. The deck opens with one definition card per term.",
      items: { type: "object", required: ["term", "kernel"], properties: { term: text(120, "The term."), kernel: text(600, "Its definition, kept short."), at: AT } } },
    nodes: { type: "array", minItems: 1, maxItems: 1, items: NODE,
      description: "Exactly one root, of kind synthesis: its label answers the question, and the claims that carry it sit beneath as children." },
  } };

/** fields are JSON Schema properties; a name ending in "?" is optional. */
export const OPS: Record<string, { fields: Record<string, object>; does: string; check(o: Op): void; run(b: Board, o: Op, ssn: string): string }> = {
  add_question: {
    fields: { front: text(2000, "The question."), "source?": text(300, "Where it came up, e.g. a source title or page.") },
    does: "An open question: a front with no answer. Only you write the answer, in the app.",
    check: (o) => { str(o.front, "front", 2000); str(o.source, "source", 300, false); },
    run(b, o) {
      const id = genId("m-"), t = now();
      q.insMinted.run(id, b.id, null, "bare", "open", str(o.front, "front", 2000)!, null, str(o.source, "source", 300, false) ?? "", "{}", 0, t, t);
      return `asked ${idOf("question", id)}`;
    },
  },
  append_log: {
    fields: { text: text(4000, "One line; newlines become spaces.") },
    does: "Adds a dated line to the end of the board's home note. Never rewrites it.",
    check: (o) => { str(o.text, "text", 4000); },
    run(b, o) {
      const cur = q.notes.get(b.id)?.text ?? "";
      const line = `- ${new Date().toISOString().slice(0, 10)} · ${str(o.text, "text", 4000)!.replace(/\n+/g, " ")}`;
      q.setNotes.run(b.id, cur.trim() ? `${cur.replace(/\s+$/, "")}\n${line}\n` : `${line}\n`, now());
      return "logged";
    },
  },
  set_purpose: {
    fields: { text: text(300, "The new purpose; empty clears it.") },
    does: "Replaces the board's purpose (at most 300 characters).",
    check: (o) => { str(o.text, "text", 300, false); },
    run(b, o) { q.setBoardPurpose.run(str(o.text, "text", 300, false) ?? "", b.id); return "purpose set"; },
  },
  set_handle: {
    fields: { handle: { type: "string", pattern: HANDLE.source, description: "e.g. thesis" } },
    does: "Gives the board a short name agents can use instead of its id: lowercase letters, digits and dashes.",
    check: (o) => { if (!HANDLE.test(String(o.handle ?? ""))) fail("A handle is 2–40 lowercase letters, digits and dashes, starting with a letter."); },
    run(b, o) {
      const h = String(o.handle);
      const taken = a.boardByHandle.get(h);
      if (taken && taken.id !== b.id) fail(`The handle "${h}" belongs to another board.`);
      a.setHandle.run(h, b.id);
      return `handle set to ${h}`;
    },
  },
  add_group: {
    fields: { name: text(80, "The group's name; an existing name is reused.") },
    does: "A new group in the board's plan.",
    check: (o) => { str(o.name, "name", 80); },
    run(b, o) {
      const name = str(o.name, "name", 80)!;
      const same = q.groupsOf.all(b.id).find((g) => g.name.toLowerCase() === name.toLowerCase());
      if (same) return `group exists: ${idOf("group", same.id)}`;
      const id = genId("g-");
      q.insGroup.run(id, b.id, name, q.nextGroupOrd.get(b.id)!.n, now());
      return `added ${idOf("group", id)}`;
    },
  },
  set_project: {
    fields: { "ends?": orNull("The project's end, YYYY-MM-DD; null or empty clears it."), "archived?": flag("true archives the project, false brings it back."),
      "starred?": flag("true stars the project (it sorts first on Today and Projects), false unstars it.") },
    does: "Sets or clears the board's end date, archives it (its kept cards still come back on Review) or brings it back, or stars or unstars it.",
    check: (o) => { dayOf(o.ends); bool(o.archived, "archived"); bool(o.starred, "starred"); },
    run(b, o) {
      const cur = q.boardPurpose.get(b.id)!;
      const ends = o.ends === undefined ? cur.ends_at ?? "" : dayOf(o.ends)!;
      const archived = bool(o.archived, "archived"), starred = bool(o.starred, "starred");
      q.setBoardProject.run(cur.purpose ?? "", ends, archived === undefined ? cur.archived_at : archived ? (cur.archived_at ?? now()) : null, b.id);
      if (starred !== undefined) q.setBoardStar.run(starred ? (cur.starred_at ?? now()) : null, b.id);
      if (starred !== undefined && archived === undefined && o.ends === undefined) return starred ? "starred" : "unstarred";
      return archived === true ? "archived" : archived === false ? "brought back" : ends ? `ends ${ends}` : "no end";
    },
  },
  set_group: {
    fields: { id: { type: "string", description: "The group's grp_ id or name." }, "name?": text(80, "A new name."),
      "by?": orNull("The date the group is meant to be done by, YYYY-MM-DD; null or empty clears it.") },
    does: "Renames a group (a unit of the project) or sets the date it is meant to be done by.",
    check: (o) => { str(o.id, "id", 120); str(o.name, "name", 80, false); dayOf(o.by); },
    run(b, o) {
      const gid = groupOf(b, String(o.id));
      const cur = q.group.get(b.id, gid)!;
      q.renGroup.run(str(o.name, "name", 80, false) || cur.name, o.by === undefined ? cur.by_date ?? "" : dayOf(o.by)!, b.id, gid);
      return `updated ${idOf("group", gid)}`;
    },
  },
  add_milestone: {
    fields: { name: text(160, "The milestone."), "due?": text(40, "Free text, e.g. \"12 Nov\"."), "note?": text(2000, "Anything more.") },
    does: "A new milestone. due is free text, such as \"12 Nov\".",
    check: (o) => { str(o.name, "name", 160); str(o.due, "due", 40, false); str(o.note, "note", 2000, false); },
    run(b, o) {
      const id = genId("ms-");
      q.insMilestone.run(id, b.id, str(o.name, "name", 160)!, q.nextMilestoneOrd.get(b.id)!.n, now());
      q.updMilestone.run(str(o.name, "name", 160)!, str(o.due, "due", 40, false) ?? "", str(o.note, "note", 2000, false) ?? "", null, b.id, id);
      return `added ${idOf("milestone", id)}`;
    },
  },
  set_milestone: {
    fields: { id: { type: "string", description: "Its ms_ id or name." }, "done?": flag("true ticks it off, false reopens it."),
      "due?": text(40, "A new date."), "note?": text(2000, "A new note."), "name?": text(160, "A new name.") },
    does: "Ticks a milestone off (done: true), reopens it, or changes its name, date or note.",
    check: (o) => { str(o.id, "id", 120); bool(o.done, "done"); str(o.due, "due", 40, false); str(o.note, "note", 2000, false); str(o.name, "name", 160, false); },
    run(b, o) {
      const mid = milestoneOf(b, String(o.id));
      const cur = q.milestone.get(b.id, mid)!;
      const done = bool(o.done, "done");
      q.updMilestone.run(str(o.name, "name", 160, false) || cur.name, str(o.due, "due", 40, false) ?? cur.due, str(o.note, "note", 2000, false) ?? cur.note,
        done === undefined ? cur.done_at : done ? (cur.done_at ?? now()) : null, b.id, mid);
      return `updated ${idOf("milestone", mid)}`;
    },
  },
  reply_note: {
    fields: { id: { type: "string", description: "The note's hl_ id, from <board>/highlights." }, text: text(4000, "Your reply, said under the reader's note.") },
    does: "Replies under a note the reader wrote on a passage. The reader sees it at once, in the fold under those words.",
    check: (o) => { str(o.id, "id", 120); str(o.text, "text", 4000); },
    run(b, o) {
      const mid = String(o.id).replace(/^hl_/, "");
      const m = q.mark.get(b.id, mid) ?? fail(`${String(o.id)} is not a highlight on ${b.ref}.`);
      if (!m.note?.trim()) fail(`${String(o.id)} is a highlight with no note; there is nothing to reply to.`);
      const t = now();
      q.insMarkReply.run(genId("mr-"), b.id, mid, m.resource_id, "agent", str(o.text, "text", 4000)!, t, t);
      return `replied under ${idOf("highlight", mid)}`;
    },
  },
  add_deck: {
    fields: {
      section: { type: "string", description: "The sec_ id the deck is for, or a src_ id when the source has one section." },
      "tree?": TREE,
      cards: { type: "array", minItems: 1, maxItems: CARDS_MAX, description: "The whole deck, in order.",
        items: { type: "object", additionalProperties: false, required: ["front", "back", "at", "node"],
          properties: {
            front: text(FACE_MAX, "The question."), back: text(FACE_MAX, "The answer."), at: AT,
            node: { type: "string", description: "The tree node the card comes from: n1 is the root, n1.2 its second child, n1.2.1 that child's first." },
            asks: list("The tree questions this card answers, e.g. [\"n1.2#1\"] for n1.2's first question. Empty on a definition card."),
            introduces: text(120, "The one glossary term this card defines, on a definition card."),
            uses: list("The glossary terms its faces lean on, each introduced by an earlier card."),
            tags: list("Short topical tags."),
          } } },
    },
    does: "Gives a section a deck of your cards, replacing the cards it has, in the shape Strata's own generation makes: a concept tree, a definition card for each glossary term, and a card for every question the tree asks. Each card names its tree node and sits at a verbatim quote of the words it asks about (at). A card whose front is unchanged keeps its reviews and keep. A deck that doesn't fit its tree, or a quote that doesn't compile, is an error naming why, and nothing is written.",
    check: (o) => {
      str(o.section, "section", 200);
      if (o.tree !== undefined) checkTree(o.tree);
      if (!Array.isArray(o.cards) || !o.cards.length || o.cards.length > CARDS_MAX) fail(`cards is a list of 1 to ${CARDS_MAX} cards.`);
      (o.cards as Record<string, unknown>[]).forEach((c, i) => {
        str(c?.front, `cards[${i}].front`, FACE_MAX); str(c?.back, `cards[${i}].back`, FACE_MAX); str(c?.at, `cards[${i}].at`, 600);
        str(c.node, `cards[${i}].node`, 80); str(c.introduces, `cards[${i}].introduces`, 120, false);
        strs(c.asks, `cards[${i}].asks`); strs(c.uses, `cards[${i}].uses`); strs(c.tags, `cards[${i}].tags`);
      });
    },
    run(b, o) {
      const sid = sectionOf(b, String(o.section));
      const t = q.tree.get(sid);
      if (t && BUSY.includes(t.status)) fail(`cards for ${idOf("section", sid)} are being made right now; try again when that is done.`);
      const sec = q.section.get(sid)!;
      const src = quoteTextOf(b.id, sec.resource_id, sid);
      const place = (at: unknown, where: string, errors: string[]): string => {
        const r = src ? compileQuote(at, src) : { ok: false as const, error: "this source has no text to quote from" };
        if (!r.ok) errors.push(`${where}: ${r.error}.`);
        return r.ok ? quoteAnchor(String(at), r.at) : "";
      };
      const unfit: string[] = [], errors: string[] = [];
      const had = t?.json ? normalizeTree(JSON.parse(t.json), t.title || sec.label) : null;
      if (o.tree === undefined && !had?.nodes.length) fail(`${idOf("section", sid)} has no concept tree yet, so send one with the deck as tree (get_guide({ topic: "apply" }) shows its shape)`);
      const tree = o.tree === undefined ? had! : placedTree(o.tree, t?.title || sec.label, (at, where) => place(at, where, unfit));
      if (tree.nodes.length !== 1 || tree.nodes[0].kind !== "synthesis") unfit.push("tree: it has exactly one top-level node, of kind synthesis, whose label answers the tree's question");
      const nodes = new Set(flattenTree(tree).map((n) => n.id));
      const owed = new Set(flattenTree(tree).flatMap((n) => n.questions.map((_q, i) => `${n.id}#${i + 1}`)));
      const terms = new Map(tree.glossary.map((g) => [g.term.toLowerCase(), g.term]));
      const defined = new Set<string>();
      const cards = (o.cards as Record<string, unknown>[]).map((c, i) => {
        const node = String(c.node).trim(), asks = strs(c.asks, "asks"), introduces = str(c.introduces, "introduces", 120, false) ?? "";
        if (!nodes.has(node)) unfit.push(`cards[${i}]: ${node} is not a node of the tree.`);
        for (const ask of asks) if (!owed.delete(ask)) unfit.push(`cards[${i}]: ${ask} is not a question of the tree, or another card already answers it.`);
        if (introduces) {
          const key = introduces.toLowerCase();
          if (!terms.has(key)) unfit.push(`cards[${i}]: "${introduces}" is not in the tree's glossary.`);
          else if (defined.has(key)) unfit.push(`cards[${i}]: "${introduces}" already has its definition card.`);
          defined.add(key);
        }
        return { type: "flashcard", node, asks, introduces, uses: strs(c.uses, "uses"), tags: strs(c.tags, "tags"),
          front: str(c.front, "front", FACE_MAX), back: str(c.back, "back", FACE_MAX), source: place(c.at, `cards[${i}]`, errors) };
      });
      if (owed.size) unfit.push(`no card answers ${[...owed].join(", ")}: every question the tree asks gets a card that lists it in asks.`);
      const undefinedTerms = [...terms].filter(([key]) => !defined.has(key)).map(([, term]) => term);
      if (undefinedTerms.length) unfit.push(`no card introduces ${undefinedTerms.join(", ")}: every glossary term gets one definition card.`);
      const said = [
        ...(unfit.length ? [`The deck does not fit its tree:\n${unfit.join("\n")}`] : []),
        ...(errors.length ? [`${errors.length} of ${cards.length} card${cards.length === 1 ? "" : "s"} did not compile:\n${errors.join("\n")}`] : []),
      ];
      if (said.length) fail(said.join("\n"));
      const n = installDeck(b.id, sid, tree.title, orderByLadder(cards, tree.glossary), true);
      q.upsertTree.run(sid, sec.resource_id, b.id, tree.title, tree.question, JSON.stringify(tree), treeToAscii(tree), "ready", null, n, now());
      return `${n} cards in ${idOf("deck", genSlug(sid))}`;
    },
  },
  edit_cards: {
    fields: {
      cards: { type: "array", minItems: 1, maxItems: CARDS_MAX, description: "The cards to change; each names what changes.",
        items: { type: "object", additionalProperties: false, required: ["id"],
          properties: {
            id: { type: "string", description: "The card_ id." },
            at: AT,
            front: text(FACE_MAX, "A new question."), back: text(FACE_MAX, "A new answer."),
          } } },
    },
    does: "Changes cards in place: where each sits (at: a verbatim quote of the words it asks about) and its question or answer. Ids, reviews and keeps stay. A quote that doesn't compile is an error naming why, and nothing is written.",
    check: (o) => {
      if (!Array.isArray(o.cards) || !o.cards.length || o.cards.length > CARDS_MAX) fail(`cards is a list of 1 to ${CARDS_MAX} cards.`);
      (o.cards as Record<string, unknown>[]).forEach((c, i) => {
        str(c?.id, `cards[${i}].id`, 400);
        if (c.at === undefined && c.front === undefined && c.back === undefined) fail(`cards[${i}] changes nothing: give at, front or back.`);
        str(c.at, `cards[${i}].at`, 600, false); str(c.front, `cards[${i}].front`, FACE_MAX, false); str(c.back, `cards[${i}].back`, FACE_MAX, false);
      });
    },
    run(b, o) {
      const decks = new Set(a.decksOf.all(b.id).map((d) => d.deck));
      const texts = new Map<string, ReturnType<typeof quoteTextOfDeck>>();
      const errors: string[] = [];
      const writes = (o.cards as Record<string, unknown>[]).map((c, i) => {
        const raw = String(c.id), id = raw.replace(/^card_/, "");
        const card = a.cardById.get(id);
        if (!card || !decks.has(card.course)) { errors.push(`cards[${i}]: ${raw} is not a card on ${b.ref}.`); return null; }
        const patch: Record<string, unknown> = {};
        if (c.front !== undefined || c.back !== undefined) {
          if (card.type !== "flashcard") { errors.push(`cards[${i}]: ${raw} is a ${card.type} card; only a flashcard's front and back are rewritten here.`); return null; }
          if (c.front !== undefined) patch.front = str(c.front, `cards[${i}].front`, FACE_MAX);
          if (c.back !== undefined) patch.back = str(c.back, `cards[${i}].back`, FACE_MAX);
        }
        if (c.at !== undefined) {
          if (!texts.has(card.course)) texts.set(card.course, quoteTextOfDeck(b.id, card.course));
          const src = texts.get(card.course);
          if (!src) { errors.push(`cards[${i}]: ${raw}'s deck reads no source on ${b.ref}, so it has nowhere to be placed.`); return null; }
          const r = compileQuote(c.at, src);
          if (!r.ok) { errors.push(`cards[${i}]: ${raw}: ${r.error}.`); return null; }
          patch.source = quoteAnchor(String(c.at), r.at);
        }
        return { card, patch, faces: c.front !== undefined || c.back !== undefined };
      });
      if (errors.length) fail(`${errors.length} of ${writes.length} card${writes.length === 1 ? "" : "s"} did not compile:\n${errors.join("\n")}`);
      for (const w of writes) writeCardEdit(w!.card.course, w!.card.id, w!.patch, w!.faces);
      logEvent(db, APP, "agent_card_edit", { board: b.id, cards: writes.length, placed: writes.filter((w) => w!.patch.source).length }, null);
      return `changed ${writes.length} card${writes.length === 1 ? "" : "s"}`;
    },
  },
  delete_deck: {
    fields: { id: { type: "string", description: "The deck_ id." } },
    does: "Sets a deck aside: its cards leave review, and the reader can put them back, keeps and all.",
    check: (o) => { str(o.id, "id", 200); },
    run(b, o) {
      const slug = String(o.id).replace(/^deck_/, "");
      if (!a.decksOf.all(b.id).some((d) => d.deck === slug)) fail(`${String(o.id)} is not a deck on ${b.ref}.`);
      return `set aside ${dropDeck(slug)} cards of ${idOf("deck", slug)}`;
    },
  },
  place: {
    fields: { id: { type: "string", description: "The source's src_ id." }, "group?": orNull("A group's name or grp_ id; null ungroups."),
      "milestone?": orNull("A milestone's name or ms_ id; null clears it."), "pinned?": flag("Pins or unpins the source.") },
    does: "Puts a source in a group (by name or grp_ id; null to ungroup), counts it toward a milestone, or pins it.",
    check: (o) => { str(o.id, "id", 200); bool(o.pinned, "pinned"); },
    run(b, o) {
      const rid = String(o.id).replace(/^src_/, "");
      if (a.resourceBoard.get(rid)?.board_id !== b.id) fail(`${String(o.id)} is not a source on ${b.ref}.`);
      if (o.group !== undefined) {
        const gid = o.group === null ? null : groupOf(b, String(o.group));
        const n = gid ? q.placesOf.all(b.id).filter((p) => p.group_id === gid).length : null;
        q.putPlaceOrder.run(b.id, rid, gid, n);
      }
      if (o.milestone !== undefined || o.pinned !== undefined) {
        const cur = q.place.get(b.id, rid);
        const ms = o.milestone === undefined ? (cur?.milestone_id ?? null) : o.milestone === null ? null : milestoneOf(b, String(o.milestone));
        q.putPlaceMark.run(b.id, rid, ms, o.pinned === undefined ? (cur?.pinned ?? 0) : o.pinned ? 1 : 0);
      }
      return `placed ${idOf("source", rid)}`;
    },
  },
  set_primer: {
    fields: { source: { type: "string", description: "The source's src_ id." },
      html: { type: "string", maxLength: PRIMER_MAX, description: "The whole primer: one self-contained, light HTML page (inline CSS and JS; scripts and fonts only from https CDNs; no fetch, no localStorage)." } },
    does: "Gives a source its primer: one page the reader opens before page 1, to see what the source is about and what to follow through it. Replaces the one it has. get_guide({ topic: \"primer\" }) says what makes a good one.",
    check: (o) => { str(o.source, "source", 200); const why = primerProblem(o.html); if (why) fail(why); },
    run(b, o) {
      const rid = String(o.source).replace(/^src_/, "");
      if (a.resourceBoard.get(rid)?.board_id !== b.id) fail(`${String(o.source)} is not a source on ${b.ref}.`);
      primersRepo.setPrimer.run(rid, b.id, String(o.html), now());
      return `primer set on ${idOf("source", rid)}`;
    },
  },
};

const strs = (v: unknown, field: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return fail(`${field} is a list.`);
  return v.map((x) => String(x).trim()).filter(Boolean);
};

function checkTree(raw: unknown): void {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null || !Array.isArray(t.nodes)) fail("tree is { question, glossary, nodes }.");
  str(t.question, "tree.question", 300); str(t.title, "tree.title", 160, false);
  if (t.glossary !== undefined && !Array.isArray(t.glossary)) fail("tree.glossary is a list of terms.");
  ((t.glossary ?? []) as Record<string, unknown>[]).forEach((g, i) => {
    str(g?.term, `tree.glossary[${i}].term`, 120); str(g.kernel, `tree.glossary[${i}].kernel`, 600); str(g.at, `tree.glossary[${i}].at`, 600, false);
  });
  const walk = (nodes: unknown, path: string): void => {
    if (nodes === undefined) return;
    if (!Array.isArray(nodes)) return fail(`${path} is a list of nodes.`);
    nodes.forEach((n, i) => {
      const x = (n ?? {}) as Record<string, unknown>, at = `${path}[${i}]`;
      str(x.label, `${at}.label`, 400); str(x.at, `${at}.at`, 600);
      if (!KINDS.includes(String(x.kind))) fail(`${at}.kind is one of ${KINDS.join(", ")}.`);
      if (!Array.isArray(x.questions)) fail(`${at}.questions is a list, empty when the node asks nothing.`);
      strs(x.questions, `${at}.questions`);
      walk(x.children, `${at}.children`);
    });
  };
  walk(t.nodes, "tree.nodes");
}

/** The tree an agent sent, with every node and term placed at its quote as a card is. */
function placedTree(raw: unknown, fallbackTitle: string, place: (at: unknown, where: string) => string): ConceptTree {
  const t = raw as Record<string, unknown>;
  const walk = (nodes: unknown, prefix: string): unknown[] => ((nodes ?? []) as Record<string, unknown>[]).map((n, i) => {
    const id = prefix ? `${prefix}.${i + 1}` : `n${i + 1}`;
    return { label: n.label, kind: n.kind, questions: n.questions, excerpt: n.at, anchor: place(n.at, `tree node ${id}`), children: walk(n.children, id) };
  });
  const glossary = ((t.glossary ?? []) as Record<string, unknown>[]).map((g) => ({ term: g.term, kernel: g.kernel, anchor: g.at ? place(g.at, `tree glossary "${String(g.term)}"`) : "" }));
  return normalizeTree({ title: t.title, question: t.question, glossary, nodes: walk(t.nodes, "") }, fallbackTitle);
}

const fieldName = (k: string): string => k.replace(/\?$/, "");

/** One schema per op, so an agent sees every op's fields in apply's own input schema. */
export const OP_SCHEMAS = Object.entries(OPS).map(([name, o]) => ({
  type: "object", description: o.does, additionalProperties: false,
  properties: { op: { type: "string", enum: [name] }, ...Object.fromEntries(Object.entries(o.fields).map(([k, v]) => [fieldName(k), v])) },
  required: ["op", ...Object.keys(o.fields).filter((k) => !k.endsWith("?"))],
}));
export const opLine = (name: string): string => `- \`${name}\` (${Object.keys(OPS[name].fields).join(", ")}): ${OPS[name].does}`;

function sectionOf(b: Board, raw: string): string {
  const ref = parseRef(raw);
  if (ref?.kind === "section") {
    const s = q.section.get(ref.id);
    if (!s || s.board_id !== b.id) fail(`${raw} is not a section on ${b.ref}.`);
    return ref.id;
  }
  if (ref?.kind !== "source" || a.resourceBoard.get(ref.id)?.board_id !== b.id) return fail(`${raw} is not a section or source on ${b.ref}.`);
  const secs = q.sectionsOf.all(ref.id);
  if (secs.length !== 1) fail(`${raw} has ${secs.length} sections; name one by its sec_ id (get_outline lists them).`);
  return secs[0].id;
}

function groupOf(b: Board, g: string): string {
  const raw = g.replace(/^grp_/, "");
  return q.groupsOf.all(b.id).find((x) => x.id === raw || x.name.toLowerCase() === g.toLowerCase())?.id
    ?? fail(`No group "${g}" on ${b.ref}. Add it first with add_group.`);
}
function milestoneOf(b: Board, m: string): string {
  const raw = m.replace(/^ms_/, "");
  return q.milestonesOf.all(b.id).find((x) => x.id === raw || x.name.toLowerCase() === m.toLowerCase())?.id
    ?? fail(`No milestone "${m}" on ${b.ref}.`);
}

/** Checks every op's shape before anything is written; names a bad one by its position. */
export function checkOps(raw: unknown): Op[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) return fail("ops is a list of 1 to 50 operations.");
  return raw.map((o, i) => {
    const op = (o ?? {}) as Op;
    const def = OPS[String(op.op)];
    if (!def) return fail(`ops[${i}]: unknown op "${String(op.op)}". The ops are ${Object.keys(OPS).join(", ")}.`);
    try { def.check(op); } catch (e) { return fail(`ops[${i}] (${op.op}): ${(e as Error).message}`); }
    return op;
  });
}

/** Runs inside the commit: a failing op throws, and the whole batch rolls back. */
export function runOps(b: Board, ops: Op[], who: string): string {
  const done = ops.map((o, i) => {
    try { return `${i + 1}. ${OPS[o.op].run(b, o, who)}`; }
    catch (e) { return fail(`ops[${i}] (${o.op}): ${(e as Error).message}. Nothing was written.`); }
  });
  logEvent(db, APP, "agent_apply", { board: b.id, ops: ops.map((o) => o.op) }, null);
  return done.join("\n");
}
