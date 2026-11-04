import { readFileSync } from "node:fs";

// The same sandbox in the header as on the iframe, so opening the URL directly is just as locked.
export const LIVE_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms",
  "default-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval' https:", "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:", "font-src data: https:", "media-src data: blob: https:", "connect-src 'none'",
  "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'",
].join("; ");

let bridge: string | null = null;
const bridgeJs = (): string => (bridge ??= readFileSync(new URL("../../../dist/html-bridge.js", import.meta.url), "utf-8"));

export function withBridge(html: string): string {
  const tag = `<script>${bridgeJs().replace(/<\/script/gi, "<\\/script")}</script>`;
  // the last </body>: an earlier one can sit inside the page's own script, as text it writes
  const at = Math.max(-1, ...[...html.matchAll(/<\/body\s*>/gi)].map((m) => m.index ?? -1));
  return at < 0 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}
