// kept for the tab's life: the same bytes always go under one key, so the server's receipt replays them

/** 16 bytes from getRandomValues, hex: never randomUUID, which the plain-http tailnet lacks */
const mint = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export const LIMIT = 16;
const held = new Map<string, { key: string; body: object }>();
const said = new Set<string>();

export async function press<T, B extends object>(route: string, board: string, same: object, body: B, send: (key: string, body: B) => Promise<T>, gone: (r: unknown) => boolean): Promise<{ r: T; key: string; body: B }> {
  const what = `${route} ${board} ${JSON.stringify(same)}`;
  for (let renewed = false; ; renewed = true) {
    const sent = held.get(what) ?? { key: mint(), body };
    held.delete(what);
    held.set(what, sent);
    if (held.size > LIMIT) held.delete(held.keys().next().value as string);
    const r = await send(sent.key, sent.body as B);
    if (!gone(r)) return { r, key: sent.key, body: sent.body as B };
    if (renewed) throw new Error("that source was deleted while it was being added — press again to add it");
    // a new capture, unless another press of it has already found it gone and renewed it
    if (held.get(what) === sent) held.delete(what);
  }
}

export const tell = (key: string): boolean => !said.has(key) && !!said.add(key);
