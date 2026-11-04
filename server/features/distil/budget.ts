import { BUDGET_TOKENS } from "../../platform/config.ts";
import { sourceTokens } from "../../../shared/imports/budget.ts";
import { pagesOf, sectionSource, sectionsCount } from "../sources/blobs.ts";
import { distilRepo as q } from "./repo.ts";
import { now } from "../../platform/db/sql.ts";
import type { ResourceRow, SectionRow } from "../../platform/db/rows.ts";

export function distilBudgetError(resource: ResourceRow, section: SectionRow): string | null {
  const tokens = sourceTokens({ tokens: resource.tokens, text: resource.text, bytes: resource.bytes_len ?? 0,
    pages: resource.tokens ? undefined : pagesOf(resource.id) });
  if (tokens > BUDGET_TOKENS && !section.content_ranges) {
    return `This source exceeds the ${BUDGET_TOKENS.toLocaleString("en-US")}-token budget. Add the file again and confirm its study groups before distilling.`;
  }
  // Inspect the actual slice: legacy sections without extracted pages fall back to the whole PDF.
  const total = sectionsCount(resource.id);
  if (!section.content_ranges && (total <= 1 || !pagesOf(resource.id).length)) return null;
  const source = sectionSource(resource, section, total);
  if ((source.file ? tokens : Math.ceil((source.text ?? "").length / 4)) > BUDGET_TOKENS) {
    return `This study group exceeds the ${BUDGET_TOKENS.toLocaleString("en-US")}-token budget. Add the file again with smaller groups.`;
  }
  return null;
}

export function holdOversizedSection(resource: ResourceRow, section: SectionRow): boolean {
  const error = distilBudgetError(resource, section);
  if (!error) return false;
  const tree = q.tree.get(section.id);
  // Completed work remains available; an old queued job must never restart without a plan.
  if (tree?.status !== "ready") {
    if (tree) q.setTreeStatus.run("error", error, now(), section.id);
    else q.upsertTree.run(section.id, resource.id, resource.board_id, section.label, "", null, null, "error", error, 0, now());
  }
  return true;
}
