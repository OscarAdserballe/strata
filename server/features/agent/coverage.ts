// What an agent can do of what the reader does. Every write route the room serves is a thing the reader can do, so each one
// is listed here with how an agent does the same: a board op (apply), a dashboard op (dashboard_apply), a tool, or a reason
// it is the reader's alone. NOT_YET names what an agent should be able to do and can't yet; it only shrinks.
// test/agent-coverage.test.ts fails on a write route that isn't listed, so a new route has to decide.

/** apply: an op of the board's apply. dash: an op of dashboard_apply. tool: an MCP tool. */
export type Way = { apply: string } | { dash: string } | { tool: string };

// Keys are the route's method and path, with each captured id written :id.
export const AGENT_WAY: Record<string, Way | Way[]> = {
  "POST /api/boards": { tool: "create_board" },
  "PUT /api/boards/:id/notes": { apply: "append_log" },
  "POST /api/imports": { tool: "request_upload" },
  "PUT /api/imports/:id/bytes": { tool: "request_upload" },
  "POST /api/imports/:id/complete": { tool: "request_upload" },
  "POST /api/imports/:id/retry": { tool: "request_upload" },
  "POST /api/imports/:id/groups": { apply: "place" },
  "POST /api/boards/:id/minted": { apply: "add_question" },
  "POST /api/boards/:id/capture": { tool: "capture" },
  "POST /api/boards/:id/capture/finish": { tool: "capture" },
  "POST /api/boards/:id/resources/:id/distil": { apply: "add_deck" },
  "PUT /api/boards/:id/resources/:id/tree": { apply: "add_deck" },
  "PATCH /api/decks/:id/cards/:id": { apply: "edit_cards" },
  "POST /api/decks/:id/ignore": { apply: "delete_deck" },
  "POST /api/boards/:id/marks/:id/replies": { apply: "reply_note" },
  "POST /api/boards/:id/resources/:id/primer": { apply: "set_primer" },
  "POST /api/boards/:id/resources": { tool: "request_upload" },
  "PUT /api/boards/:id/plan/purpose": { apply: "set_purpose" },
  "PATCH /api/boards/:id/plan/project": { apply: "set_project" },
  "POST /api/boards/:id/plan/groups": { apply: "add_group" },
  "PATCH /api/boards/:id/plan/groups/:id": { apply: "set_group" },
  "POST /api/boards/:id/plan/milestones": { apply: "add_milestone" },
  "PATCH /api/boards/:id/plan/milestones/:id": { apply: "set_milestone" },
  "PATCH /api/boards/:id/plan/places/:id": { apply: "place" },

  "POST /api/dashboard/inbox": { dash: "add" },
  "PATCH /api/dashboard/inbox/:id": { dash: "edit" },
  "POST /api/dashboard/inbox/:id/keep": { dash: "move" },
  "POST /api/dashboard/inbox/:id/drop": { dash: "move" },
  "POST /api/dashboard/tasks": { dash: "add" },
  "PATCH /api/dashboard/tasks/:id": [{ dash: "edit" }, { dash: "move" }],
  "PUT /api/dashboard/pad": { dash: "pad" },
  "POST /api/dashboard/tasks/:id/send": { dash: "send" },
};

/** The reader's alone, and why. */
export const HUMAN_ONLY: Record<string, string> = {
  "DELETE /api/boards/:id": "deletes for good; agents never do",
  "DELETE /api/boards/:id/resources/:id": "deletes a source for good; agents never do",
  "DELETE /api/boards/:id/minted/:id": "deletes for good; agents never do",
  "DELETE /api/boards/:id/marks/:id": "deletes the reader's highlight and note",
  "PATCH /api/boards/:id/marks/:id": "a note is the reader's own words; an agent replies under it",
  "PATCH /api/boards/:id/minted/:id": "answering a question is the reader's; agents never answer questions",
  "POST /api/decks/:id/keeps": "keeping a card is the reader's choice of what to hold onto",
  "POST /api/decks/:id/keeps/minted": "keeping a card is the reader's choice of what to hold onto",
  "POST /api/library/cards": "a library card is one the reader writes and keeps",
  "POST /api/decks/:id/cards/:id/restore": "the reader's undo of setting a card aside",
  "POST /api/decks/:id/restore": "the reader's undo of setting a deck aside",
  "POST /api/review/grade": "a grade is the reader recalling",
  "POST /api/review/chat": "the reader talking to Strata's own model in review",
  "DELETE /api/review/chat": "the reader clearing their review chat",
  "POST /api/boards/:id/chat": "the reader talking to Strata's own model on a board",
  "DELETE /api/boards/:id/messages": "the reader clearing their board chat",
  "PUT /api/boards/:id/resources/:id/state": "a live page saves its own state as the reader uses it",
  "POST /api/images": "an image the reader pastes into their own writing",
  "POST /api/feedback": "the reader's feedback to whoever builds Strata",
  "PATCH /api/feedback/:id": "the reader's feedback to whoever builds Strata",
  "POST /api/register/inbox": "the room makes its inbox board itself, on first open",
  "POST /api/logout": "ends the reader's browser session",
  "POST /api/perf": "timings the page reports about itself",
  "POST /api/log": "errors the page reports about itself",
  "POST /api/agent/tokens": "a token is how an agent gets in; an agent never mints its own",
  "DELETE /api/agent/tokens/:id": "a token is how an agent gets in; only the reader revokes one",
  "POST /api/dashboard/tasks/:id/press": "Send and Reopen on a page are the reader's voice",
  "PUT /api/dashboard/routine": "the routine can't reconnect or repoint itself",
  "POST /api/dashboard/routine/run": "the routine can't wake itself",
};

/** What an agent should be able to do and can't yet: each is a gap to close with an op. Only shrinks. */
export const NOT_YET: Record<string, string> = {
  "PATCH /api/boards/:id": "rename a board",
  "DELETE /api/imports/:id": "cancel an upload in progress",
  "POST /api/boards/:id/minted/file": "file open questions into a deck",
  "POST /api/boards/:id/pairs": "pair a source with a deck on the shelf",
  "PATCH /api/boards/:id/pairs/:id": "rename or re-pair a shelf entry",
  "DELETE /api/boards/:id/pairs/:id": "take an entry off the shelf",
  "POST /api/boards/:id/pairs/:id/move": "move a shelf entry to another board",
  "PUT /api/boards/:id/resources/:id/sections": "redraw a source's sections",
  "DELETE /api/decks/:id/cards/:id": "set one card aside (delete_deck sets a whole deck aside)",
  "POST /api/boards/:id/marks": "highlight a passage",
  "PATCH /api/boards/:id/resources/:id": "rename a source, mark it read, or leave it out",
  "DELETE /api/boards/:id/plan/groups/:id": "remove a group from the plan",
  "DELETE /api/boards/:id/plan/milestones/:id": "remove a milestone",
  "PUT /api/boards/:id/plan/order": "reorder the plan",
};
