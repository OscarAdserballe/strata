import { envGet, fetchWithTimeout, extractJson } from "./llm.ts";

export const GEMINI_KEY = envGet("GEMINI_API_KEY");
export const geminiAvailable = !!GEMINI_KEY;
const GEMINI_BASE = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";

// A turn's `files` are stored bytes, so the thread stays a stable cache prefix with its pictures in it.
export interface GeminiTurn { role: "user" | "model"; text: string; files?: GeminiFile[] }
export interface GeminiContext { text?: string; files?: GeminiFile[] }
export interface ToolCall { name: string; args: Record<string, unknown> }
export interface GeminiToolResult { text: string; calls: ToolCall[] }
export interface GeminiFile { mimeType: string; data: string }

/* `thoughts` bills as output; `cached` is the part of `prompt` that hit the implicit cache. */
export interface GeminiUsage { prompt: number; output: number; thoughts: number; cached: number }
interface RawUsage { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number }
const readUsage = (u?: RawUsage): GeminiUsage | null =>
  u ? { prompt: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thoughts: u.thoughtsTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0 } : null;

/* Cache order, stable first: context, history, then the current turn; one early variable byte loses the discount. */
export function buildContents(opts: { context?: GeminiContext; history?: GeminiTurn[]; user: string; files?: GeminiFile[] }): unknown[] {
  const inline = (f: GeminiFile) => ({ inlineData: { mimeType: f.mimeType, data: f.data } });
  const ctxParts = [
    ...(opts.context?.files ?? []).map(inline),
    ...(opts.context?.text ? [{ text: opts.context.text }] : []),
  ];
  return [
    ...(ctxParts.length ? [{ role: "user", parts: ctxParts }] : []),
    ...(opts.history ?? []).map((t) => ({ role: t.role, parts: [...(t.files ?? []).map(inline), { text: t.text }] })),
    { role: "user", parts: [...(opts.files ?? []).map(inline), { text: opts.user }] },
  ];
}

/* AUTO mode lets the model reply and call tools in one round trip; tool results are not fed back. */
export async function callGeminiTools(opts: {
  system: string;
  history?: GeminiTurn[];
  user: string;
  tools: unknown[];
  model?: string;
  timeoutMs?: number;
  mode?: "AUTO" | "ANY";
}): Promise<GeminiToolResult> {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set");
  const model = opts.model ?? GEMINI_MODEL;
  const contents = [
    ...(opts.history ?? []).map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: "user", parts: [{ text: opts.user }] },
  ];
  const body = {
    system_instruction: { parts: [{ text: opts.system }] },
    contents,
    tools: [{ functionDeclarations: opts.tools }],
    toolConfig: { functionCallingConfig: { mode: opts.mode ?? "AUTO" } },
  };
  const r = await fetchWithTimeout(`${GEMINI_BASE}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST", timeout: opts.timeoutMs ?? 60_000,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] } }[] };
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("").trim();
  const calls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
  return { text, calls };
}

/* Owns its AbortController: fetchWithTimeout's timer would abort mid-stream. */
export async function streamGemini(opts: {
  system: string;
  context?: GeminiContext;
  history?: GeminiTurn[];
  user: string;
  files?: GeminiFile[];
  model?: string;
  timeoutMs?: number;
  thinkingBudget?: number; // 0 = disable "thinking" (the pre-token deliberation) → far lower TTFT
  onUsage?: (u: GeminiUsage) => void;
}, onDelta: (text: string) => void): Promise<string> {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set");
  const model = opts.model ?? GEMINI_MODEL;
  const contents = buildContents(opts);
  const generationConfig: Record<string, unknown> = { temperature: 0.7 };
  if (opts.thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
  const body = { system_instruction: { parts: [{ text: opts.system }] }, contents, generationConfig };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 90_000);
  try {
    const r = await fetch(`${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`, {
      method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    let full = "", buf = "";
    let lastUsage: RawUsage | undefined;
    const decoder = new TextDecoder();
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: RawUsage };
          if (j?.usageMetadata) lastUsage = j.usageMetadata;
          const t = (j?.candidates?.[0]?.content?.parts ?? []).filter((p) => typeof p.text === "string").map((p) => p.text).join("");
          if (t) { full += t; onDelta(t); }
        } catch { /* a partial/garbled SSE frame — skip it */ }
      }
    }
    const usage = readUsage(lastUsage);
    if (usage && opts.onUsage) opts.onUsage(usage);
    if (!full.trim()) throw new Error("Gemini stream returned no content");
    return full;
  } finally { clearTimeout(timer); }
}

/* JSON mode, not function calling: function calling suppresses the prose reply. */
export async function callGeminiJson(opts: {
  system: string;
  context?: GeminiContext;
  history?: GeminiTurn[];
  user: string;
  files?: GeminiFile[];
  model?: string;
  timeoutMs?: number;
  thinkingBudget?: number; // 0 = disable "thinking" → far lower latency (mechanical tasks)
  onUsage?: (u: GeminiUsage) => void;
}): Promise<unknown> {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set");
  const model = opts.model ?? GEMINI_MODEL;
  const contents = buildContents(opts);
  const generationConfig: Record<string, unknown> = { responseMimeType: "application/json", temperature: 0.6 };
  if (opts.thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
  const body = {
    system_instruction: { parts: [{ text: opts.system }] },
    contents,
    generationConfig,
  };
  const r = await fetchWithTimeout(`${GEMINI_BASE}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST", timeout: opts.timeoutMs ?? 90_000,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: RawUsage };
  // report spend even when the reply is unusable — the tokens were billed either way
  const usage = readUsage(j?.usageMetadata);
  if (usage && opts.onUsage) opts.onUsage(usage);
  const text = (j?.candidates?.[0]?.content?.parts ?? []).filter((p) => typeof p.text === "string").map((p) => p.text).join("").trim();
  if (!text) throw new Error("Gemini returned no content");
  // Parse strictly first so escapes like \n survive; extractJson's LaTeX repair would literalize them.
  try { return JSON.parse(text); } catch { return extractJson(text); }
}

export async function countGeminiTokens(opts: { text?: string; files?: GeminiFile[]; model?: string; timeoutMs?: number }): Promise<number | null> {
  if (!GEMINI_KEY) return null;
  const model = opts.model ?? GEMINI_MODEL;
  const parts: Record<string, unknown>[] = [];
  for (const f of opts.files ?? []) parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
  if (opts.text) parts.push({ text: opts.text });
  if (!parts.length) return 0;
  try {
    const r = await fetchWithTimeout(`${GEMINI_BASE}/models/${model}:countTokens?key=${GEMINI_KEY}`, {
      method: "POST", timeout: opts.timeoutMs ?? 30_000,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { totalTokens?: number };
    return typeof j.totalTokens === "number" ? j.totalTokens : null;
  } catch { return null; }
}
