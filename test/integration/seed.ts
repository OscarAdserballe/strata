import type { TestServer } from "../support/server.ts";

export const MD = "# Duration hedging\n\nA DV01-neutral hedge protects only against small, parallel shifts. Convexity is the failure mode.\n";

export async function newBoard(server: TestServer, made: { question: string } | { title: string }): Promise<string> {
  const { status, body } = await server.api("/api/boards", { method: "POST", body: JSON.stringify(made) });
  if (status !== 201) throw new Error(`seeding a board failed: ${status} ${JSON.stringify(body)}`);
  return body.board.id as string;
}

export async function addMarkdown(server: TestServer, board: string, filename: string, text: string): Promise<string> {
  const base64 = Buffer.from(text, "utf-8").toString("base64");
  const { status, body } = await server.api(`/api/boards/${board}/resources`, { method: "POST", body: JSON.stringify({ filename, base64 }) });
  if (status !== 201) throw new Error(`seeding a source failed: ${status} ${JSON.stringify(body)}`);
  return body.id as string;
}
