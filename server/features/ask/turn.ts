import type { GeminiContext, GeminiFile, GeminiTurn, GeminiUsage } from "../../platform/llm/gemini.ts";
import { SYSTEM } from "./prompts.ts";

export interface StrataDeps {
  geminiAvailable: boolean;
  callGeminiJson: (opts: { system: string; context?: GeminiContext; history?: GeminiTurn[]; user: string; files?: GeminiFile[]; model?: string; timeoutMs?: number; thinkingBudget?: number; onUsage?: (u: GeminiUsage) => void }) => Promise<unknown>;
  streamGemini?: (opts: { system: string; context?: GeminiContext; history?: GeminiTurn[]; user: string; files?: GeminiFile[]; model?: string; timeoutMs?: number; thinkingBudget?: number; onUsage?: (u: GeminiUsage) => void }, onDelta: (t: string) => void) => Promise<string>;
}

// STRATA_CHAT_MODEL names the Gemini model that answers asks and tidies cards.
export const CHAT_MODEL = process.env.STRATA_CHAT_MODEL || "gemini-3.8-flash";
// STRATA_CHAT_THINKING takes a Gemini budget, or a non-number for no thinkingConfig.
const rawThink = (process.env.STRATA_CHAT_THINKING ?? "").trim();
export const CHAT_THINKING: number | undefined =
  rawThink === "" ? 512 : /^\d+$/.test(rawThink) ? Number(rawThink) : undefined;
export const FAKE_MODEL = process.env.STRATA_FAKE_MODEL === "1";
// A backstop, not a policy; measured in chars (~4/token) because counting tokens is a network call.
export const THREAD_CHARS = Number(process.env.STRATA_THREAD_CHARS ?? 600_000);
// A screenshot costs a thousand or two tokens whatever its bytes, so it counts as a page of text.
export const IMAGE_CHARS = 6_000;

export interface TurnResult { reply: string; usage?: GeminiUsage }

export interface TurnInput {
  history?: GeminiTurn[];
  userMsg: string;
  system?: string;
  files?: GeminiFile[];
  sources?: string;
  where?: string;
  // Images ride the user turn, never the context, which must stay byte-stable for the cache.
  images?: GeminiFile[];
}

const OFFLINE_REPLY = "(Offline — no GEMINI_API_KEY, so I can't actually read with you here; this is just a placeholder. Set the key and I'll engage for real.)";
const FALLBACK_REPLY = "I'm with you — say a little more and I'll keep working it through.";

// The section leads as a stable context turn so Gemini's implicit cache discounts it; per-turn data goes after.
const turnContext = (sources?: string, files?: GeminiFile[]): GeminiContext | undefined =>
  files?.length || sources
    ? {
        files: files?.length ? files : undefined,
        text: sources || "THE SOURCE THEY HAVE OPEN (attached; this is what they are reading).",
      }
    : undefined;

const turnUser = (userMsg: string, where?: string, dropped = 0): string => [
  where || "",
  dropped ? `(${dropped} earlier turn${dropped === 1 ? "" : "s"} of this conversation are no longer in your window — it ran past the context budget. Say so if they refer back to something you cannot see.)` : "",
  `USER: ${userMsg}`,
].filter(Boolean).join("\n\n");

// History must start on a user turn: Gemini rejects one opening with a model turn.
export function threadFor(history: GeminiTurn[] | undefined, maxChars = THREAD_CHARS): { turns: GeminiTurn[]; dropped: number } {
  const all = history ?? [];
  let from = 0, used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    used += all[i].text.length + 12 + (all[i].files?.length ?? 0) * IMAGE_CHARS;
    if (used > maxChars) { from = i + 1; break; }
  }
  const budgetBit = from > 0;
  let turns = all.slice(from);
  const first = turns.findIndex((t) => t.role === "user");
  turns = first <= 0 ? (first === 0 ? turns : []) : turns.slice(first);
  // Only count drops once the budget bit; trimming the canned opening line is not forgetting.
  return { turns, dropped: budgetBit ? all.length - turns.length : 0 };
}

function fakeReply(input: { history?: GeminiTurn[]; userMsg: string; sources?: string; images?: GeminiFile[] }): string {
  const asked = (input.history ?? []).filter((t) => t.role === "user").map((t) => t.text);
  const q = input.userMsg.trim();
  // The smokes read this to know a pasted image reached the model.
  const seen = input.images?.length ? `I can see the ${input.images.length === 1 ? "image" : `${input.images.length} images`} you sent.` : "";
  const before = (input.history ?? []).reduce((n, t) => n + (t.files?.length ?? 0), 0);
  const back = asked.length ? `Earlier you asked about “${asked[asked.length - 1].slice(0, 60)}” — this follows from it.` : "";
  const grounded = input.sources
    ? `The source puts it as “a business-stealing externality: each firm's competitive action reduces rivals' profits” (§2, slides 9–11).`
    : `Not in the sources on this board, but it is standard enough that I can answer it anyway.`;
  return [
    `**${q.replace(/[?.!]+$/, "")}** — the short version: it turns on the discount factor, and everything else is bookkeeping. ${back}`.trim(),
    ...(seen || before ? [`${seen}${before ? ` ${before} earlier image${before === 1 ? "" : "s"} in this thread rode along too.` : ""}`.trim()] : []),
    grounded,
    `The condition is that the present value of colluding beats one round of defection:`,
    `$$\\frac{\\pi^m}{1-\\delta} \\;\\ge\\; \\pi^d + \\frac{\\delta\\,\\pi^n}{1-\\delta}$$`,
    `Two things fall out of that:`,
    `- **Patience does the work.** Raise $\\delta$ and the left side grows without bound while the deviation payoff $\\pi^d$ is a one-off.`,
    `- **Detection lag is a discount.** If it takes $k$ periods to notice a defection, the punishment arrives $\\delta^k$ smaller — which is the same thing as being less patient.`,
    `What would sharpen this: which of the two is actually binding in the case you're reading?`,
  ].join("\n\n");
}
// Slower pace lets the race gate catch a reply mid-stream.
const FAKE_STREAM_MS = Number(process.env.STRATA_FAKE_STREAM_MS) || 22;
async function streamFake(text: string, onDelta: (t: string) => void): Promise<string> {
  const parts = text.match(/\S+\s*/g) ?? [text];
  for (let i = 0; i < parts.length; i += 3) {
    onDelta(parts.slice(i, i + 3).join(""));
    await new Promise((r) => setTimeout(r, FAKE_STREAM_MS));
  }
  return text;
}
// Test hook: fails the first ask containing this text, so a retry has a lost turn to resume.
const FAKE_FAIL = process.env.STRATA_FAKE_MODEL_FAIL ?? "";
const failedOnce = new Set<string>();
function fakeFault(userMsg: string): void {
  if (!FAKE_FAIL || !userMsg.includes(FAKE_FAIL) || failedOnce.has(userMsg)) return;
  failedOnce.add(userMsg);
  throw new Error("the model failed (STRATA_FAKE_MODEL_FAIL)");
}

export async function runTurn(input: TurnInput, deps: StrataDeps): Promise<TurnResult> {
  if (FAKE_MODEL) { fakeFault(input.userMsg); return { reply: fakeReply(input) }; }
  if (!deps.geminiAvailable) return { reply: OFFLINE_REPLY };
  if (deps.streamGemini) return runTurnStreaming(input, deps, () => {});
  const system = (input.system || SYSTEM) + `\n\nReturn ONLY a JSON object: {"reply": "<your answer>"}.`;
  const { turns, dropped } = threadFor(input.history);
  let usage: GeminiUsage | undefined;
  const out = (await deps.callGeminiJson({ system, context: turnContext(input.sources, input.files), history: turns, user: turnUser(input.userMsg, input.where, dropped), files: input.images, model: CHAT_MODEL, thinkingBudget: CHAT_THINKING, onUsage: (u) => { usage = u; } })) as { reply?: unknown };
  const reply = typeof out?.reply === "string" && out.reply.trim() ? out.reply.trim() : FALLBACK_REPLY;
  return { reply, usage };
}

export async function runTurnStreaming(
  input: TurnInput,
  deps: StrataDeps,
  onDelta: (t: string) => void,
): Promise<TurnResult> {
  if (FAKE_MODEL) { fakeFault(input.userMsg); return { reply: await streamFake(fakeReply(input), onDelta) }; }
  if (!deps.geminiAvailable || !deps.streamGemini) {
    onDelta(OFFLINE_REPLY);
    return { reply: OFFLINE_REPLY };
  }
  const { turns, dropped } = threadFor(input.history);
  let usage: GeminiUsage | undefined;
  const text = await deps.streamGemini({ system: input.system || SYSTEM, context: turnContext(input.sources, input.files), history: turns, user: turnUser(input.userMsg, input.where, dropped), files: input.images, model: CHAT_MODEL, thinkingBudget: CHAT_THINKING, onUsage: (u) => { usage = u; } }, onDelta);
  return { reply: text.trim() || FALLBACK_REPLY, usage };
}
