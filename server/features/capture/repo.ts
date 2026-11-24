import { stmt } from "../../platform/db/sql.ts";

export const captureRepo = {
  // covered by resources_metadata (board_id first, origin_url in it): no row is read past the index
  linked: stmt<{ id: string; filename: string | null; origin_url: string }>("SELECT id, filename, origin_url FROM resources WHERE board_id = ? AND origin_url IS NOT NULL"),
};
