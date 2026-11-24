// The guide agents read, one topic at a time: the shipped text or the reader's own, each written whole over the rev it was based on.
import { mutate, type Op } from "../mutate.ts";
import { store as roomStore, useQuery, type Fetcher, type Store } from "../store.ts";
import { fetched } from "../api.ts";

export interface Prompt { topic: string; text: string; shipped: string; own: boolean; rev: number; updatedAt: number | null; shippedChanged: boolean }
export interface Prompts { topics: Prompt[] }
export const PROMPTS_KEY = "agent-prompts";
const read: Fetcher<Prompts> = () => fetched<Prompts>("/api/agent/prompts");
export const usePrompts = (on: boolean): Prompts | undefined =>
  useQuery<Prompts>(on ? PROMPTS_KEY : "agent-prompts-off", on ? read : async () => ({ value: { topics: [] }, rev: 0, epoch: "", origin: "wire", stamp: 0 }), { tags: [PROMPTS_KEY] });

const put = (v: Prompts | undefined, p: Prompt): Prompts | undefined => v && { topics: v.topics.map((t) => (t.topic === p.topic ? p : t)) };
const confirmed = (s: Store, topic: string): Prompt | undefined => s.entry<Prompts>(PROMPTS_KEY)?.base?.topics.find((t) => t.topic === topic);

export const promptOps = {
  /** text null puts the shipped guide back. A 409 means another tab wrote it: theirs is shown and yours is not sent over it. */
  save(topic: string, text: string | null, s: Store = roomStore): Op<Prompt> {
    return {
      label: `save the ${topic} prompt`,
      lanes: [`prompt:${topic}`],
      method: "PUT",
      path: `/api/agent/prompts/${topic}`,
      body: { text },
      base: () => confirmed(s, topic)?.rev ?? 0,
      optimistic: [{ key: PROMPTS_KEY, apply: (held: Prompts | undefined) => {
        const was = held?.topics.find((t) => t.topic === topic);
        return was ? put(held, { ...was, text: text ?? was.shipped, own: text !== null && text.trim() !== was.shipped.trim() }) : held;
      } }],
      // ordered by this topic's own rev: the list's rev is the room's, which a topic's never reaches
      takeConflict: { key: PROMPTS_KEY, fold: (held, c) => put(held as Prompts | undefined, c.value as Prompt),
        rev: (held: Prompts | undefined) => held?.topics.find((t) => t.topic === topic)?.rev },
      confirm: (res, meta) => { s.patch<Prompts>(PROMPTS_KEY, meta.rev, (v) => put(v, res)!, { epoch: meta.epoch, stamp: meta.rev }); },
    };
  },
};

export const prompts = { save: (topic: string, text: string | null) => mutate(promptOps.save(topic, text)) };
