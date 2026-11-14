import "./vendor/fonts/fonts.css";
// Stylesheet order is the cascade: the room's tokens, the reader's pieces the dashboard reads pages with, then its own.
import "./styles/tokens.css";
import "./shell/layers.css";
import "./capabilities/annotate/annotate.css";
import "./capabilities/live/live.css";
import "./surfaces/dashboard/dashboard.css";
import { createRoot } from "react-dom/client";
import { stampSession } from "./data/api.ts";
import Dashboard from "./surfaces/dashboard/Dashboard.tsx";
import { navNow } from "./surfaces/dashboard/nav.ts";

stampSession();
document.title = navNow().mode === "focus" ? "Focus" : "Dispatch";
createRoot(document.getElementById("dash")!).render(<Dashboard />);
