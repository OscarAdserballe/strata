// STRATA_REPO points the harness at another checkout, so the A/B job can serve main beside the branch.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const REPO = process.env.STRATA_REPO || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export { chromium, webkit, firefox, devices } from "playwright";
