import { useEffect, useRef } from "react";
import type { HtmlEngine } from "../../engines/html/HtmlEngine.ts";

export interface HtmlSourceProps {
  engine: HtmlEngine;
  url: string;
  title: string;
  /** the zoom the room paints at here; the page undoes it to draw at the browser's own scale */
  scale: number;
  /** no LIVE strip: the frame around it says what the page is */
  bare?: boolean;
}

// A live page: it draws itself, notes and all, in its sandbox; the reader around it only holds the frame.
export default function HtmlSource({ engine, url, title, scale, bare }: HtmlSourceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (hostRef.current) engine.open(hostRef.current, url);
  }, [url]);
  useEffect(() => () => engine.close(), []);
  return (
    <div className="htmlsrc">
      {bare ? null : <div className="htmlsrc-bar">
        <span className="htmlsrc-live" title="Scripts run; the page cannot reach the network or your room">live</span>
        <span className="htmlsrc-title">{title.replace(/\.html?$/i, "")}</span>
      </div>}
      <div className="htmlsrc-body">
        <div className="htmlsrc-host" ref={hostRef} style={scale !== 1 ? { zoom: String(1 / scale) } : undefined} />
      </div>
    </div>
  );
}
