// apply's operations: each is checked for shape before the commit, then run inside it, in order.
import { q } from "../repo.ts";
import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { genId, now } from "../../platform/db/sql.ts";
import { HANDLE, idOf, parseRef } from "../../../shared/agent/ids.ts";
import { dropDeck, genSlug, installDeck, quoteTextOf, quoteTextOfDeck, writeCardEdit } from "../decks/decks.ts";
import { compileQuote, quoteAnchor } from "../../../shared/reading/compile-quote.ts";
import { normalizeTree, treeToAscii } from "../distil/distil.ts";
import { agentRepo as a } from "./repo.ts";
import { AgentError, type Board } from "./kinds.ts";

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

const text = (max: number, about: string) => ({ type: "string", maxLength: max, description: about });
const flag = (about: string) => ({ type: "boolean", description: about });
const orNull = (about: string) => ({ type: ["string", "null"], description: about });
const CARDS_MAX = 200, FACE_MAX = 4000;
const AT = text(600, "Where the card sits: 4 to 40 consecutive words of the source, copied verbatim, that occur once in its passage (on one page, for a PDF): the words the card asks about.");
const BUSY = ["queued", "preparing", "running", "carding"];

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
      "title?": text(160, "The deck's name; the section's own by default."),
      cards: { type: "array", minItems: 1, maxItems: CARDS_MAX, description: "The whole deck, in order.",
        items: { type: "object", additionalProperties: false, required: ["front", "back", "at"],
          properties: { front: text(FACE_MAX, "The question."), back: text(FACE_MAX, "The answer."), at: AT } } },
    },
    does: "Gives a section a deck of your cards, replacing the cards it has. Each card sits at a verbatim quote of the words it asks about (at). A card whose front is unchanged keeps its reviews and keep. A quote that doesn't compile is an error naming why, and nothing is written.",
    check: (o) => {
      str(o.section, "section", 200);
      if (!Array.isArray(o.cards) || !o.cards.length || o.cards.length > CARDS_MAX) fail(`cards is a list of 1 to ${CARDS_MAX} cards.`);
      (o.cards as Record<string, unknown>[]).forEach((c, i) => { str(c?.front, `cards[${i}].front`, FACE_MAX); str(c?.back, `cards[${i}].back`, FACE_MAX); str(c?.at, `cards[${i}].at`, 600); });
    },
    run(b, o) {
      const sid = sectionOf(b, String(o.section));
      const t = q.tree.get(sid);
      if (t && BUSY.includes(t.status)) fail(`cards for ${idOf("section", sid)} are being made right now; try again when that is done.`);
      const sec = q.section.get(sid)!;
      const title = str(o.title, "title", 160, false) || t?.title || sec.label;
      const src = quoteTextOf(b.id, sec.resource_id, sid);
      const errors: string[] = [];
      const cards = (o.cards as Record<string, unknown>[]).map((c, i) => {
        const r = src ? compileQuote(c.at, src) : { ok: false as const, error: "this source has no text to quote from" };
        if (!r.ok) errors.push(`cards[${i}]: ${r.error}.`);
        return { type: "flashcard", front: str(c.front, "front", FACE_MAX), back: str(c.back, "back", FACE_MAX), source: r.ok ? quoteAnchor(String(c.at), r.at) : "" };
      });
      if (errors.length) fail(`${errors.length} of ${cards.length} card${cards.length === 1 ? "" : "s"} did not compile:\n${errors.join("\n")}`);
      const n = installDeck(b.id, sid, title, cards, true);
      // the room shows a section's deck once its tree is ready; one the agent made has no concept map
      const tree = t?.json ? normalizeTree(JSON.parse(t.json), title) : normalizeTree({ title, nodes: [] }, title);
      q.upsertTree.run(sid, sec.resource_id, b.id, title, tree.question ?? "", JSON.stringify(tree), treeToAscii(tree), "ready", null, n, now());
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
};

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
