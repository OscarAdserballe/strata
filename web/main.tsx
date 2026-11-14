import "./vendor/fonts/fonts.css";
import "katex/dist/katex.min.css";
import "./shell/layers.css";
// Stylesheet order is the cascade, so it is fixed here rather than left to the import graph.
import "./styles/tokens.css";
import "./styles/base.css";
import "./capabilities/offline/offline.css";
import "./shell/status.css";
import "./surfaces/reader/reader.css";
import "./capabilities/live/live.css";
import "./capabilities/card/card.css";
import "./engines/tree/tree.css";
import "./engines/prose/prose.css";
import "./surfaces/board/board-home.css";
import "./capabilities/annotate/annotate.css";
import "./engines/find/find.css";
import "./engines/pdf/pdf.css";
import "./engines/tree/claims.css";
import "./surfaces/board/shelf.css";
import "./surfaces/board/desk.css";
import "./capabilities/progress/kept-chart.css";
import "./capabilities/ask/ask.css";
import "./engines/prose/blocks.css";
import "./capabilities/keys/keys.css";
import "./capabilities/sources/sources.css";
import "./surfaces/library/launcher.css";
import "./surfaces/review/review.css";
import "./surfaces/keeps/keeps.css";
import "./surfaces/dispatch/dispatch.css";
import "./styles/phone.css";
import "./shell/toast.css";
import "./capabilities/card/composer.css";
import "./capabilities/feedback/feedback.css";
import "./capabilities/card/card-form.css";
import "./styles/glass.css";
import "./surfaces/library/library.css";
import { createRoot } from "react-dom/client";
import App from "./shell/App.tsx";
import { beacon, stampSession, StrataPath } from "./data/api.ts";
import { sendSamplesWith } from "./platform/rum.ts";
import { watchTaps } from "./platform/taps.ts";
import { watchSnapshots } from "./data/snapshot.ts";

stampSession();
watchSnapshots();
sendSamplesWith(beacon);

// Fire-and-forget: without a service worker the app simply stays online-only.
if ("serviceWorker" in navigator) { void navigator.serviceWorker.register(StrataPath("/sw.js"), { scope: StrataPath("/"), updateViaCache: "none" }).catch(() => {}); }

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

watchTaps();

// Load the heavier font weights up front; a late web font forces a full relayout mid-open.
try { for (const face of ["600 1em Spectral", "700 1em Spectral", "600 1em 'IBM Plex Sans'"]) void document.fonts.load(face).catch(() => {}); }
catch { /* no font loading API: the faces load when first drawn, as before */ }
