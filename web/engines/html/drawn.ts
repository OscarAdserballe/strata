import { TOUCH } from "../../platform/device.js";

// A live page is a laptop format: on a touch device it reads as its text twin, like any article.
export const drawnAs = (kind: string): string => (kind === "html" && TOUCH ? "text" : kind);
