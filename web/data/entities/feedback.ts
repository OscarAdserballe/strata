import { mutator as roomMutator, type Mutator, type Op } from "../mutate.ts";

export const FEEDBACK_LANE = "feedback";

export const feedbackOps = {
  send(body: Record<string, unknown>): Op<{ id: string }> {
    return {
      label: "save that note",
      lanes: [FEEDBACK_LANE],
      method: "POST",
      path: "/api/feedback",
      body,
      flush: true,
    };
  },
};

export const feedback = {
  send: (body: Record<string, unknown>, m: Mutator = roomMutator) => m.release(feedbackOps.send(body)),
};
