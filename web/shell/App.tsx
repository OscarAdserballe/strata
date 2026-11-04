import { memo } from "react";
import ConnectionBanner from "../capabilities/offline/ConnectionBanner.tsx";
import BoardRoute from "./BoardRoute.tsx";
import LibraryScreen from "../surfaces/library/LibraryScreen.tsx";
import ReviewScreen from "../surfaces/review/ReviewScreen.tsx";
import CramScreen from "../surfaces/cram/CramScreen.tsx";
import KeepsScreen from "../surfaces/keeps/KeepsScreen.tsx";
import { CRAM, KEEPS, LIBRARY, REVIEW, useScreensUp } from "./screens.ts";

// The room stays mounted under every screen and is memoised, so App renders only when screens come or go.
const Room = memo(BoardRoute);

export default function App() {
  const up = useScreensUp();
  return <>
    <ConnectionBanner />
    <Room />
    {up & LIBRARY ? <LibraryScreen /> : null}
    {up & REVIEW ? <ReviewScreen /> : null}
    {up & CRAM ? <CramScreen /> : null}
    {up & KEEPS ? <KeepsScreen /> : null}
  </>;
}
