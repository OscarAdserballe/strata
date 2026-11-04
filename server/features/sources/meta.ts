import type { ResourceMeta } from "../../../shared/types/index.ts";
import { q } from "../repo.ts";
import { estTokens, isPdf, kindOf } from "./blobs.ts";

export function resourceMeta(boardId: string): ResourceMeta[] {
  const prog = new Map((q.readProgressOf.all(boardId) as { resource: string | null; deepest: number | null; ms: number | null; at: number | null }[])
    .filter((p) => p.resource).map((p) => [p.resource as string, { deepest: p.deepest ?? 0, ms: p.ms ?? 0, at: p.at ?? 0 }]));
  const viewed = new Map((q.readViewsOf.all(boardId) as { resource: string | null; at: number | null }[])
    .filter((v) => v.resource).map((v) => [v.resource as string, v.at ?? 0]));
  return q.resourceSummariesOf.all(boardId).map((r) => {
    const p = prog.get(r.id);
    const read = p && p.deepest >= 90 ? "read" as const : (p || viewed.has(r.id)) ? "opened" as const : "unread" as const;
    const lastReadAt = Math.max((p && p.at) || 0, viewed.get(r.id) || 0) || null;
    return {
      id: r.id, filename: r.filename ?? "resource", mime: r.mime ?? (isPdf(r) ? "application/pdf" : "text/plain"),
      kind: kindOf(r), tokens: estTokens(r), included: r.included !== 0, originUrl: r.origin_url ?? null,
      read, readPct: p ? Math.min(100, Math.round(p.deepest)) : 0, readMs: p ? p.ms : 0,
      createdAt: r.created_at, lastReadAt, doneAt: r.done_at ?? null, ...(r.generation ? { generation: r.generation } : {}),
    };
  });
}
