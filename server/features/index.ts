// Order matters: the first matching route wins, so specific paths must come before broader patterns.

import { importRoutes } from "./imports/routes.ts";
import type { Route } from "../platform/router/router.ts";
import { publicRoutes as systemPublicRoutes, systemRoutes } from "./system/routes.ts";
import { agentPublicRoutes, agentRoutes } from "./agent/routes.ts";
import { boardRoutes } from "./boards/routes.ts";
import { progressRoutes } from "./progress/routes.ts";
import { mintRoutes } from "./author/routes.ts";
import { pairRoutes } from "./boards/pairs.ts";
import { captureRoutes } from "./capture/routes.ts";
import { distilRoutes } from "./distil/routes.ts";
import { deckRoutes } from "./decks/routes.ts";
import { keepRoutes } from "./keeps/routes.ts";
import { chatRoutes } from "./ask/routes.ts";
import { resourceRoutes } from "./sources/routes.ts";
import { markRoutes } from "./marks/routes.ts";
import { feedbackRoutes } from "./feedback/routes.ts";
import { reviewRoutes } from "./review/routes.ts";
import { registerRoutes } from "./register/routes.ts";
import { tidyRoutes } from "./author/tidy.ts";
import { libraryRoutes } from "./library/routes.ts";
import { planRoutes } from "./plan/routes.ts";
import { imageRoutes } from "./images/routes.ts";
import { dashboardRoutes } from "./dashboard/routes.ts";

export const publicRoutes: Route[] = [...systemPublicRoutes, ...agentPublicRoutes];

export const apiRoutes: Route[] = [
  ...boardRoutes,
  ...progressRoutes,
  ...importRoutes,
  ...systemRoutes,
  ...mintRoutes,
  ...pairRoutes,
  ...captureRoutes,
  ...distilRoutes,
  // Keeps must precede the deck routes so /api/decks/:slug/keeps is not caught by a looser pattern.
  ...keepRoutes,
  ...deckRoutes,
  ...chatRoutes,
  ...markRoutes,
  ...resourceRoutes,
  ...feedbackRoutes,
  ...registerRoutes,
  ...libraryRoutes,
  ...reviewRoutes,
  ...tidyRoutes,
  ...planRoutes,
  ...imageRoutes,
  ...dashboardRoutes,
  ...agentRoutes,
];
