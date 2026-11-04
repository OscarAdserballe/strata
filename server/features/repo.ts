import { boardsRepo } from "./boards/repo.ts";
import { sourcesRepo } from "./sources/repo.ts";
import { registerRepo } from "./register/repo.ts";
import { planRepo } from "./plan/repo.ts";
import { authorRepo } from "./author/repo.ts";
import { decksRepo } from "./decks/repo.ts";
import { keepsRepo } from "./keeps/repo.ts";
import { reviewRepo } from "./review/repo.ts";
import { marksRepo } from "./marks/repo.ts";
import { distilRepo } from "./distil/repo.ts";
import { askRepo } from "./ask/repo.ts";
import { progressRepo } from "./progress/repo.ts";
import { feedbackRepo } from "./feedback/repo.ts";

export const q = {
  ...boardsRepo,
  ...sourcesRepo,
  ...registerRepo,
  ...planRepo,
  ...authorRepo,
  ...decksRepo,
  ...keepsRepo,
  ...reviewRepo,
  ...marksRepo,
  ...distilRepo,
  ...askRepo,
  ...progressRepo,
  ...feedbackRepo,
};
