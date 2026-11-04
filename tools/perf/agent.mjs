// The agent's reads against the production-sized fixture: each call's median over five, end to end on localhost.
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

export async function agentReads(base, T) {
  const made = await (await fetch(`${base}/api/agent/tokens`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "perf", write: false }) })).json();
  let n = 0;
  const call = async (name, args) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${made.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
    const body = await r.json();
    if (!body.result || body.result.isError) throw new Error(`${name}: ${JSON.stringify(body).slice(0, 200)}`);
    return body.result.content[0].text;
  };
  const timed = async (variant, name, args) => {
    const ms = [];
    let text = "";
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); text = await call(name, args); ms.push(performance.now() - t0); }
    return { scenario: "agent", variant, t: { ms: Math.round(median(ms) * 10) / 10 }, w: {}, extra: { tokens: Math.ceil(text.length / 4) } };
  };
  const board = T.biggestBoard.id;
  // the kept read is of the board with the most kept cards: which board's state is biggest is a near tie that moves
  const kept = [...(await call("whoami", {})).matchAll(/^- (?:\S+ \()?(b-[0-9a-f]+)\)? .*· (\d+) kept/gm)].sort((x, y) => +y[2] - +x[2])[0]?.[1] ?? board;
  const source = await call("get_context", { id: `src_${T.largestPdf.id}` });
  const section = /\bsec_\S+/.exec(source)?.[0];
  return [
    await timed("outline", "get_outline", { board }),
    await timed("overview", "get_context", { id: board }),
    await timed("kept", "get_context", { id: `${kept}/kept`, max_tokens: 24000 }),
    await timed("changes", "get_changes", { board, since: "2000-01-01", limit: 200 }),
    await timed("search", "search", { queries: [{ kind: "card", query: "the" }, { kind: "highlight", query: "the" }] }),
    ...(section ? [await timed("text-section", "get_text", { id: section })] : []),
    ...(T.chat ? [
      await timed("chat", "get_context", { id: `${T.chat.board}/chat`, max_tokens: 24000 }),
      await timed("search-chat", "search", { board: T.chat.board, queries: [{ kind: "chat", query: "the" }] }),
    ] : []),
  ];
}
