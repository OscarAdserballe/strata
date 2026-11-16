import { useEffect, useRef } from "react";
import type { HtmlEngine } from "../../engines/html/HtmlEngine.ts";

export interface HtmlSourceProps {
  engine: HtmlEngine;
  url: string;
  /** the zoom the room paints at here; the page undoes it to draw at the browser's own scale */
  scale: number;
}

// A live page: it draws itself, notes and all, in its sandbox; the reader around it only holds the frame.
export default function HtmlSource({ engine, url, scale }: HtmlSourceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (hostRef.current) engine.open(hostRef.current, url);
  }, [url]);
  useEffect(() => () => engine.close(), []);
  return (
    <div className="htmlsrc">
      <div className="htmlsrc-body">
        <div className="htmlsrc-host" ref={hostRef} style={scale !== 1 ? { zoom: String(1 / scale) } : undefined} />
      </div>
    </div>
  );
}
